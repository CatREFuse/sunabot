// @vitest-environment node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  it("fixes config-full in the runtime contract, schema and workspace layout", async () => {
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
