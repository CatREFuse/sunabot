// @vitest-environment node
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureNapcatCacheLink,
  ensureNapcatWritableCaches
} from "../../packages/platform/napcatRuntimeLayout.mjs";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("NapCat runtime layout", () => {
  it("fixes the account-scoped NapCat root in the runtime contract and isolates legacy migration paths", async () => {
    const [contract, schema] = await Promise.all([
      readJson(path.join(root, "deploy/runtime-contract.json")),
      readJson(path.join(root, "deploy/runtime-contract.schema.json"))
    ]);
    const paths = asRecord(contract.paths);
    const schemaPaths = asRecord(asRecord(schema.properties).paths);
    const schemaPathProperties = asRecord(schemaPaths.properties);

    expect(paths.napcatAccounts).toBe("runtime/napcat/accounts");
    expect(paths.napcatAccounts).toBe(WORKSPACE_LAYOUT.napcatAccounts);
    expect(schemaPaths.required).toContain("napcatAccounts");
    expect(schemaPathProperties.napcatAccounts).toEqual({ const: "runtime/napcat/accounts" });
    for (const retired of ["napcatConfig", "napcatQqState", "napcatPlugins", "napcatQrCode", "napcatManualLogin"]) {
      expect(paths).not.toHaveProperty(retired);
      expect(schemaPaths.required).not.toContain(retired);
      expect(schemaPathProperties).not.toHaveProperty(retired);
    }
    expect(WORKSPACE_LAYOUT.legacyNapcatConfig).toBe("runtime/napcat/config-full");
    expect(WORKSPACE_LAYOUT.legacyNapcatQqState).toBe("runtime/napcat/qq");
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

  it("keeps Docker exclusive to NapCat and confines account mounts to runtime state", async () => {
    const [contract, compose, entrypoint] = await Promise.all([
      readJson(path.join(root, "deploy/runtime-contract.json")),
      fs.readFile(path.join(root, "deploy/napcat/compose.yml"), "utf8"),
      fs.readFile(path.join(root, "deploy/napcat/napcat-entrypoint.sh"), "utf8")
    ]);
    await expect(fs.access(path.join(root, "deploy/docker"))).rejects.toMatchObject({ code: "ENOENT" });

    const capabilities = asRecord(contract.capabilities);
    expect(asRecord(capabilities.workspaceBash).managedBy).toBe("native");
    expect(asRecord(capabilities.mcp).managedBy).toBe("native");
    expect(asRecord(capabilities.skillScript).managedBy).toBe("native");
    expect(asRecord(contract.napcat).managedBy).toBe("docker");
    expect(asRecord(contract.napcat).composeFile).toBe("deploy/napcat/compose.yml");

    const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
    expect(services.match(/^  [a-z0-9_-]+:/gmu)).toEqual(["  napcat:"]);
    expect(services).toContain("pull_policy: never");
    expect(services).toContain("image: ${NAPCAT_IMAGE:");
    expect(services).toContain("hostname: ${NAPCAT_HOSTNAME:");
    expect(services).not.toContain("build:");
    expect(entrypoint).toContain('cp -an "$temporary_root/config/." "$config_root/"');
    expect(entrypoint).toContain('[[ ! -f "$manual_login_marker" ]] || requested_account=');
    expect(entrypoint).toContain("export ACCOUNT=");

    expect(services).not.toContain("platform: linux/amd64");
    expect(services).not.toContain("env_file:");
    expect(services).toContain("/runtime/napcat/accounts/${NAPCAT_ACCOUNT_ID:-primary}/config-full:/app/napcat/config");
    expect(services).toContain("/runtime/napcat/accounts/${NAPCAT_ACCOUNT_ID:-primary}/qq:/app/.config/QQ");
    expect(services).toContain("/runtime/napcat/accounts/${NAPCAT_ACCOUNT_ID:-primary}/plugins:/app/napcat/plugins");
    expect(services).toContain("/runtime/napcat/accounts/${NAPCAT_ACCOUNT_ID:-primary}:/app/napcat/cache");
  });

  it.skipIf(process.platform === "win32").each([
    { accountEnv: "NAPCAT_ACCOUNT=223344556\n", manual: false, expected: "223344556" },
    { accountEnv: "NAPCAT_ACCOUNT=223344556\n", manual: true, expected: "" },
    { accountEnv: "NAPCAT_ACCOUNT=\n", manual: false, expected: "" },
    { accountEnv: undefined, manual: false, expected: "112233445" }
  ])("uses current persisted login and the manual marker despite an old container ACCOUNT: %j", async ({ accountEnv, manual, expected }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-napcat-entrypoint-"));
    temporaryDirectories.push(directory);
    const appRoot = path.join(directory, "app");
    const configRoot = path.join(appRoot, "napcat/config");
    const cacheRoot = path.join(appRoot, "napcat/cache");
    const script = path.join(directory, "entrypoint.sh");
    const bin = path.join(directory, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, "jq"), `#!/usr/bin/env node
const fs = require("node:fs");
const [, , flag, key, value, expression, file] = process.argv;
if (flag !== "--arg" || key !== "account" || expression !== ".autoLoginAccount = $account") process.exit(2);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.autoLoginAccount = value;
process.stdout.write(JSON.stringify(config));
`, { mode: 0o700 });
    const source = await fs.readFile(path.join(root, "deploy/napcat/napcat-entrypoint.sh"), "utf8");
    await write(script, source.replaceAll("/app/", `${appRoot}/`));
    await write(path.join(configRoot, "napcat.json"), "{}");
    await write(path.join(configRoot, "webui.json"), JSON.stringify({ autoLoginAccount: "112233445", token: "fixture-token" }));
    await write(path.join(appRoot, ".config/QQ/login.fixture"), "retained-login-state");
    await write(path.join(appRoot, "entrypoint.sh"), 'printf "%s" "${ACCOUNT-unset}" > "$ACCOUNT_RESULT"\n');
    if (accountEnv !== undefined) await write(path.join(cacheRoot, "account.env"), accountEnv);
    if (manual) await write(path.join(cacheRoot, "manual-login-required"), "fixture");
    const accountResult = path.join(directory, "upstream-account");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ACCOUNT: "112233445", ACCOUNT_RESULT: accountResult }
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(await readJson(path.join(configRoot, "webui.json"))).toEqual({ autoLoginAccount: expected, token: "fixture-token" });
    expect(await fs.readFile(accountResult, "utf8")).toBe("");
    expect(await fs.readFile(path.join(appRoot, ".config/QQ/login.fixture"), "utf8")).toBe("retained-login-state");
    if (manual) expect(await fs.readFile(path.join(cacheRoot, "manual-login-required"), "utf8")).toBe("fixture");
  });

  it("provisions writable native component cache paths", async () => {
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
