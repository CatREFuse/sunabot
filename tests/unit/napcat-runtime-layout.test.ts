// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureNapcatCacheLink,
  ensureNapcatWritableCaches
} from "../../packages/platform/napcatRuntimeLayout.mjs";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("NapCat runtime layout", () => {
  it("fixes config-full and the QR artifact in the runtime contract, schema and workspace layout", async () => {
    const [contract, schema] = await Promise.all([
      readJson(path.join(root, "deploy/runtime-contract.json")),
      readJson(path.join(root, "deploy/runtime-contract.schema.json"))
    ]);
    const paths = asRecord(contract.paths);
    const schemaPaths = asRecord(asRecord(schema.properties).paths);
    const schemaPathProperties = asRecord(schemaPaths.properties);

    expect(paths.napcatConfig).toBe("runtime/napcat/config-full");
    expect(paths.napcatConfig).toBe(WORKSPACE_LAYOUT.napcatConfig);
    expect(schemaPaths.required).toContain("napcatConfig");
    expect(schemaPathProperties.napcatConfig).toEqual({
      const: "runtime/napcat/config-full"
    });
    expect(paths.napcatQrCode).toBe("runtime/napcat/qrcode.png");
    expect(paths.napcatQrCode).toBe(WORKSPACE_LAYOUT.napcatQrCode);
    expect(schemaPaths.required).toContain("napcatQrCode");
    expect(schemaPathProperties.napcatQrCode).toEqual({
      const: "runtime/napcat/qrcode.png"
    });
  });

  it("migrates an old component QR and links all future cache writes into workspace state", async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-napcat-cache-link-"));
    temporaryDirectories.push(rootDirectory);
    const workspace = path.join(rootDirectory, "workspace");
    const shellRoot = path.join(rootDirectory, "component", "app", "napcat");
    const legacyQr = path.join(shellRoot, "cache", "qrcode.png");
    await write(legacyQr, "legacy-qr");
    await write(path.join(shellRoot, "cache", "metadata.txt"), "preserve-me");

    const result = await ensureNapcatCacheLink({
      workspace,
      shellRoot,
      paths: {
        napcatState: "runtime/napcat",
        napcatQrCode: "runtime/napcat/qrcode.png"
      }
    });

    const stateRoot = path.join(workspace, "runtime", "napcat");
    const qrCodePath = path.join(stateRoot, "qrcode.png");
    expect(await fs.realpath(path.join(shellRoot, "cache"))).toBe(await fs.realpath(stateRoot));
    expect(await fs.readFile(qrCodePath, "utf8")).toBe("legacy-qr");
    expect(await fs.readFile(path.join(stateRoot, "legacy-cache", "metadata.txt"), "utf8"))
      .toBe("preserve-me");
    expect(result.linked).toBe(true);

    await fs.writeFile(path.join(shellRoot, "cache", "qrcode.png"), "current-qr", "utf8");
    expect(await fs.readFile(qrCodePath, "utf8")).toBe("current-qr");

    const repeated = await ensureNapcatCacheLink({
      workspace,
      shellRoot,
      paths: {
        napcatState: "runtime/napcat",
        napcatQrCode: "runtime/napcat/qrcode.png"
      }
    });
    expect(repeated.linked).toBe(false);
  });

  it("rejects a component cache link outside workspace state before migrating data", async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-napcat-cache-escape-"));
    temporaryDirectories.push(rootDirectory);
    const workspace = path.join(rootDirectory, "workspace");
    const shellRoot = path.join(rootDirectory, "component", "app", "napcat");
    const outsideCache = path.join(rootDirectory, "outside-cache");
    await write(path.join(outsideCache, "qrcode.png"), "outside-qr");
    await fs.mkdir(shellRoot, { recursive: true });
    await fs.symlink(outsideCache, path.join(shellRoot, "cache"), process.platform === "win32" ? "junction" : "dir");

    await expect(ensureNapcatCacheLink({
      workspace,
      shellRoot,
      paths: {
        napcatState: "runtime/napcat",
        napcatQrCode: "runtime/napcat/qrcode.png"
      }
    })).rejects.toThrow("points outside the runtime state");
    await expect(fs.access(path.join(workspace, "runtime", "napcat", "qrcode.png")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("provisions writable Docker font and shader cache paths for UID 1000", async () => {
    const dockerfile = await fs.readFile(path.join(root, "deploy/docker/Dockerfile"), "utf8");
    expect(dockerfile).toContain("XDG_CACHE_HOME=/app/.cache");
    expect(dockerfile).toContain("/app/.cache/fontconfig");
    expect(dockerfile).toContain("/app/.cache/mesa_shader_cache");
    expect(dockerfile).toContain("/app/.cache/mesa_shader_cache_db");
    expect(dockerfile).toContain('ln -s "$SUNABOT_WORKSPACE/$napcat_state" /app/napcat/cache');
    expect(dockerfile).toMatch(/chown -R 1000:1000[\s\S]*\/app\/\.cache/);

    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-napcat-writable-cache-"));
    temporaryDirectories.push(rootDirectory);
    const cacheRoot = path.join(rootDirectory, ".cache");
    const directories = await ensureNapcatWritableCaches(cacheRoot);
    expect(directories.map((directory) => path.basename(directory))).toEqual([
      "fontconfig",
      "mesa_shader_cache",
      "mesa_shader_cache_db"
    ]);
    await Promise.all(directories.map(async (directory) => {
      const probe = path.join(directory, "test-write");
      await fs.writeFile(probe, "ok", "utf8");
      expect(await fs.readFile(probe, "utf8")).toBe("ok");
    }));

    const supervisor = await fs.readFile(path.join(root, "deploy/docker/supervisor.mjs"), "utf8");
    expect(supervisor).toContain('ensureNapcatWritableCaches("/app/.cache")');
  });

  it("configures OneBot only in the contract NapCat config directory", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-napcat-layout-"));
    temporaryDirectories.push(workspace);
    await write(path.join(workspace, "secrets/runtime.env"), [
      "ONEBOT_ACCESS_TOKEN=unit-onebot-token",
      "NAPCAT_ACCOUNT=123456789"
    ].join("\n"));

    await execFileAsync(process.execPath, [
      path.join(root, "tooling/runtime/configure-napcat-client.mjs")
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env, SUNABOT_WORKSPACE: workspace }
    });

    const configPath = path.join(
      workspace,
      WORKSPACE_LAYOUT.napcatConfig,
      "onebot11_123456789.json"
    );
    const config = await readJson(configPath);
    const network = asRecord(config.network);
    expect(network.websocketClients).toEqual([
      expect.objectContaining({
        name: "sunabot",
        enable: true,
        url: "ws://127.0.0.1:8787/onebot/v11/ws",
        token: "unit-onebot-token"
      })
    ]);
    await expect(fs.access(path.join(workspace, "runtime/napcat/config"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

async function readJson(filePath: string) {
  return asRecord(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object fixture");
  }
  return value as Record<string, unknown>;
}

async function write(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
