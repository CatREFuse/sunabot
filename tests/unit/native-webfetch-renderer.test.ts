// @vitest-environment node
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linuxRendererBubblewrapPrefix,
  prepareNativeWebfetchRendererInstallation,
  rendererProcessEnvironment,
  verifyNativeWebfetchRendererIsolation
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
      cache: "/tmp/cache",
      entry: "/cache/main.js",
      home: "/tmp/home",
      lightpandaExecutable: "/cache/lightpanda",
      port: 8790,
      runtime: "/tmp/run",
      workspaceId: "a".repeat(16)
    });
    expect(Object.keys(environment).sort()).toEqual([
      "HOME",
      "LANG",
      "LIGHTPANDA_DISABLE_TELEMETRY",
      "NODE_ENV",
      "PATH",
      "SUNABOT_WEBFETCH_LIGHTPANDA_EXECUTABLE",
      "SUNABOT_WEBFETCH_RENDERER_ENTRY",
      "SUNABOT_WEBFETCH_RENDERER_HOST",
      "SUNABOT_WEBFETCH_RENDERER_PORT",
      "SUNABOT_WEBFETCH_RENDERER_TOKEN_FD",
      "SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID",
      "SUNABOT_WEBFETCH_RUNTIME_ISOLATION",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_RUNTIME_DIR"
    ]);
    expect(JSON.stringify(environment)).not.toMatch(/PROVIDER|ONEBOT|CODEX|NAPCAT|workspace\//u);
    expect(environment.LIGHTPANDA_DISABLE_TELEMETRY).toBe("true");
    expect(nativeWebfetchRendererDeployment("darwin")).toBe("unavailable");
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
      "0",
      "--gid",
      "0",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/repo",
      "/home/user/.ssh"
    ]));
    expect(bwrap).not.toContain("--new-session");
  });

  it("fails closed when the real Bubblewrap namespace probe fails", async () => {
    const command = vi.fn(async () => {
      throw new Error("Creating new namespace failed");
    });
    await expect(verifyNativeWebfetchRendererIsolation({
      root: "/opt/sunabot/current",
      workspace: "/srv/sunabot/workspace"
    }, {
      environment: { HOME: "/tmp/sunabot-home" },
      isolationProbe: {
        args: ["--unshare-user", "--"],
        executable: "/opt/sunabot/current/runtime/bubblewrap/bwrap",
        nodeExecutable: "/opt/sunabot/current/runtime/node/bin/node"
      }
    }, command)).rejects.toThrow("Creating new namespace failed");
    expect(command).toHaveBeenCalledWith(
      "/opt/sunabot/current/runtime/bubblewrap/bwrap",
      expect.arrayContaining([
        "--unshare-user",
        "/opt/sunabot/current/runtime/node/bin/node",
        "-e"
      ]),
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it("caches the locked Lightpanda and Node executables without runtime downloads", async () => {
    const root = await fixtureProject();
    const cacheRoot = path.join(path.dirname(root), "renderer-cache");
    const context = {
      root,
      workspace: path.join(root, "workspace"),
      environment: { SUNABOT_WEBFETCH_NATIVE_CACHE: cacheRoot }
    };
    const command = vi.fn(async (executable: string, args: string[], options: {
      env?: Record<string, string>;
    }) => {
      expect(path.basename(executable)).toBe("lightpanda");
      expect(args).toEqual(["version"]);
      expect(options.env).toEqual({ LIGHTPANDA_DISABLE_TELEMETRY: "true" });
      return "Lightpanda 0.3.3";
    });

    const first = await prepareNativeWebfetchRendererInstallation(context, { command });
    const second = await prepareNativeWebfetchRendererInstallation(context, { command });
    expect(first.lightpandaExecutable).toBe(second.lightpandaExecutable);
    expect(first.nodeExecutable).toBe(second.nodeExecutable);
    expect(first.entry).toBe(second.entry);
    expect(command).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(first.lightpandaExecutable, "utf8")).toContain("Lightpanda 0.3.3");

    const source = path.join(root, "runtime/lightpanda/lightpanda");
    await fs.rm(source);
    await expect(prepareNativeWebfetchRendererInstallation(context, { command }))
      .rejects.toThrow("WEBFETCH_LIGHTPANDA_MISSING");
    expect(command).toHaveBeenCalledTimes(2);

    await fs.writeFile(source, "#!/bin/sh\necho 'Lightpanda 0.3.3 repaired'\n", { mode: 0o700 });
    const repaired = await prepareNativeWebfetchRendererInstallation(context, { command });
    expect(repaired.lightpandaExecutable).not.toBe(first.lightpandaExecutable);
    expect(command).toHaveBeenCalledTimes(3);
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
    "node_modules/linkedom": { version: "1.0.0", dependencies: { "linkedom-dep": "1.0.0" } },
    "node_modules/linkedom-dep": { version: "1.0.0" }
  };
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages
  }));
  for (const name of ["fastify", "fastify-dep", "linkedom", "linkedom-dep"]) {
    const directory = path.join(root, "node_modules", ...name.split("/"));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
  }
  for (const relative of [
    "dist/apps/webfetch-renderer/main.js",
    "dist/adapters/webfetch/urlPolicy.js",
    "dist/services/webfetch/contracts.js",
    "tooling/runtime/native-webfetch-renderer-supervisor.mjs"
  ]) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "export {};\n");
  }
  const lightpanda = path.join(root, "runtime/lightpanda/lightpanda");
  await fs.mkdir(path.dirname(lightpanda), { recursive: true });
  await fs.writeFile(lightpanda, "#!/bin/sh\necho 'Lightpanda 0.3.3'\n", { mode: 0o700 });
  await fs.mkdir(path.join(root, "workspace"), { recursive: true });
  return root;
}
