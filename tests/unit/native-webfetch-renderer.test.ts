// @vitest-environment node
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linuxRendererBubblewrapPrefix,
  prepareNativeWebfetchRendererInstallation,
  rendererProcessEnvironment
} from "../../tooling/runtime/native-webfetch-renderer.mjs";
import { nativeWebfetchRendererDeployment } from "../../tooling/runtime/launcher.mjs";
import {
  readRendererAuthToken,
  rendererRequestAuthorized,
  validateRendererAuthToken
} from "../../adapters/webfetch/rendererAuth.js";
import { HttpDynamicRendererClient } from "../../adapters/webfetch/dynamicRendererClient.js";

const fixtures: string[] = [];
const token = "a".repeat(43);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, {
    recursive: true,
    force: true
  })));
});

describe("Native WebFetch Renderer security contract", () => {
  it("requires a canonical token and performs constant-shape bearer checks", () => {
    expect(validateRendererAuthToken(token)).toBe(token);
    expect(() => validateRendererAuthToken("short")).toThrow("WEBFETCH_RENDERER_AUTH_INVALID");
    expect(rendererRequestAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(rendererRequestAuthorized(undefined, token)).toBe(false);
    expect(rendererRequestAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(rendererRequestAuthorized(["Bearer duplicate"], token)).toBe(false);
  });

  it("consumes either the direct token or token descriptor and clears its transport", async () => {
    const directEnvironment = {
      SUNABOT_WEBFETCH_RENDERER_TOKEN: token
    };
    expect(readRendererAuthToken(directEnvironment)).toBe(token);
    expect(directEnvironment).not.toHaveProperty("SUNABOT_WEBFETCH_RENDERER_TOKEN");

    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-renderer-token-"));
    fixtures.push(fixture);
    const tokenPath = path.join(fixture, "token");
    await fs.writeFile(tokenPath, token, { mode: 0o600 });
    const descriptor = syncFs.openSync(tokenPath, "r");
    const descriptorEnvironment = {
      SUNABOT_WEBFETCH_RENDERER_TOKEN_FD: String(descriptor)
    };
    expect(readRendererAuthToken(descriptorEnvironment)).toBe(token);
    expect(descriptorEnvironment).not.toHaveProperty("SUNABOT_WEBFETCH_RENDERER_TOKEN_FD");
    expect(() => syncFs.fstatSync(descriptor)).toThrow();

    expect(() => readRendererAuthToken({
      SUNABOT_WEBFETCH_RENDERER_TOKEN: token,
      SUNABOT_WEBFETCH_RENDERER_TOKEN_FD: "3"
    })).toThrow("WEBFETCH_RENDERER_AUTH_INVALID");
  });

  it("authenticates render requests and keeps health unauthenticated", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return new Response('{"ok":true}', { status: 200 });
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
      return new Response(JSON.stringify({
        html: "<article>dynamic</article>",
        finalUrl: "http://93.184.216.34/"
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpDynamicRendererClient("http://127.0.0.1:8790", token);

    await expect(client.health()).resolves.toBe(true);
    await expect(client.render("http://93.184.216.34/")).resolves.toMatchObject({
      finalUrl: "http://93.184.216.34/"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("does not call an unauthenticated Renderer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpDynamicRendererClient("http://127.0.0.1:8790", "");

    await expect(client.render("https://example.com/")).rejects.toMatchObject({
      code: "DYNAMIC_RENDERER_UNAVAILABLE"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes only an allowlisted environment and requires platform sandboxes", () => {
    const environment = rendererProcessEnvironment({
      browserExecutable: "/cache/chromium",
      browserRoot: "/cache/browsers",
      cache: "/tmp/cache",
      entry: "/cache/main.js",
      home: "/tmp/home",
      port: 8790,
      runtime: "/tmp/run",
      workspaceId: "a".repeat(16)
    });
    expect(Object.keys(environment).sort()).toEqual([
      "HOME",
      "LANG",
      "NODE_ENV",
      "PATH",
      "PLAYWRIGHT_BROWSERS_PATH",
      "SUNABOT_WEBFETCH_CHROMIUM_EXECUTABLE",
      "SUNABOT_WEBFETCH_CHROMIUM_SANDBOX",
      "SUNABOT_WEBFETCH_RENDERER_ENTRY",
      "SUNABOT_WEBFETCH_RENDERER_HOST",
      "SUNABOT_WEBFETCH_RENDERER_PORT",
      "SUNABOT_WEBFETCH_RENDERER_TOKEN_FD",
      "SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_RUNTIME_DIR"
    ]);
    expect(JSON.stringify(environment)).not.toMatch(/PROVIDER|ONEBOT|CODEX|NAPCAT|workspace\//u);
    expect(nativeWebfetchRendererDeployment("darwin")).toBe("docker");
    expect(nativeWebfetchRendererDeployment("linux")).toBe("native");

    const bwrap = linuxRendererBubblewrapPrefix({
      cache: "/tmp/cache",
      home: "/tmp/home",
      projectRoot: "/repo",
      runtime: "/tmp/run",
      sensitivePaths: ["/home/user/.ssh"],
      workspace: "/repo/workspace"
    });
    expect(bwrap).toEqual(expect.arrayContaining([
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--uid",
      "65534",
      "--gid",
      "65534",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/repo",
      "/home/user/.ssh"
    ]));
    expect(bwrap).not.toContain("--new-session");
  });

  it("downloads Chromium once per Playwright installation and fails closed when it disappears", async () => {
    const root = await fixtureProject();
    const cacheRoot = path.join(path.dirname(root), "renderer-cache");
    const context = {
      root,
      workspace: path.join(root, "workspace"),
      environment: { SUNABOT_WEBFETCH_NATIVE_CACHE: cacheRoot }
    };
    const installCalls: string[][] = [];
    const command = vi.fn(async (_executable: string, args: string[], options: {
      env?: Record<string, string>;
    }) => {
      if (args.includes("install")) {
        installCalls.push(args);
        const executable = path.join(options.env!.PLAYWRIGHT_BROWSERS_PATH, "chromium");
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        return "";
      }
      return path.join(options.env!.PLAYWRIGHT_BROWSERS_PATH, "chromium");
    });

    const first = await prepareNativeWebfetchRendererInstallation(context, { command });
    const second = await prepareNativeWebfetchRendererInstallation(context, { command });
    expect(first.browserExecutable).toBe(second.browserExecutable);
    expect(installCalls).toHaveLength(1);

    await fs.rm(first.browserExecutable);
    await expect(prepareNativeWebfetchRendererInstallation(context, { command }))
      .rejects.toThrow("WEBFETCH_BROWSER_MISSING");
    expect(installCalls).toHaveLength(1);

    await prepareNativeWebfetchRendererInstallation(context, {
      command,
      repairBrowser: true
    });
    expect(installCalls).toHaveLength(2);
  });

});

async function fixtureProject() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-native-renderer-test-"));
  fixtures.push(fixture);
  const root = path.join(fixture, "project");
  await fs.mkdir(root);
  const packages: Record<string, unknown> = {
    "": { version: "0.0.0" },
    "node_modules/fastify": { version: "1.0.0", dependencies: { "fastify-dep": "1.0.0" } },
    "node_modules/fastify-dep": { version: "1.0.0" },
    "node_modules/ipaddr.js": { version: "2.2.0" },
    "node_modules/playwright": { version: "1.61.1", dependencies: { "playwright-core": "1.61.1" } },
    "node_modules/playwright-core": { version: "1.61.1" }
  };
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages
  }));
  for (const name of ["fastify", "fastify-dep", "ipaddr.js", "playwright", "playwright-core"]) {
    const directory = path.join(root, "node_modules", ...name.split("/"));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
  }
  for (const relative of [
    "dist/apps/webfetch-renderer/main.js",
    "dist/adapters/webfetch/urlPolicy.js",
    "dist/services/webfetch/contracts.js",
    "tooling/runtime/native-webfetch-renderer-supervisor.mjs",
    "node_modules/playwright/cli.js"
  ]) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "export {};\n");
  }
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  return root;
}
