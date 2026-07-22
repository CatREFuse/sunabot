// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectMcpRuntimeConfiguration,
  resolveMcpStdioRuntimeOptions
} from "../../tooling/runtime/mcp-runtime-config.mjs";
import { testTempRoot } from "./test-temp-root.js";

const root = testTempRoot("mcp-runtime-environment");
const digestImage = `registry.example/sunabot-mcp@sha256:${"a".repeat(64)}`;
const manifestSha256 = "b".repeat(64);
const serverSourceUrl = new URL("../../apps/api/server.ts", import.meta.url);

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("MCP production runtime environment", () => {
  it("keeps stdio disabled unless an explicit backend is configured", async () => {
    expect(resolveMcpStdioRuntimeOptions({}, "linux")).toBe(false);
    await expect(inspectMcpRuntimeConfiguration({ environment: {}, platform: "linux" }))
      .resolves.toEqual({
        oauth: { ok: false, configured: false, detail: "OAuth credential vault key is missing" },
        stdio: { ok: false, configured: false, backend: "disabled", detail: "stdio MCP is disabled" }
      });
  });

  it("accepts only a digest-pinned custom Docker image and a canonical vault key", async () => {
    const vaultKey = Buffer.alloc(32, 7).toString("base64url");
    const environment = {
      SUNABOT_MCP_STDIO_BACKEND: "docker",
      SUNABOT_MCP_STDIO_DOCKER_IMAGE: digestImage,
      SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST_SHA256: manifestSha256,
      SUNABOT_MCP_CREDENTIAL_VAULT_KEY: vaultKey
    };
    expect(resolveMcpStdioRuntimeOptions(environment, "darwin")).toEqual({
      backend: "docker",
      dockerImage: digestImage,
      executableManifestSha256: manifestSha256
    });
    const result = await inspectMcpRuntimeConfiguration({ environment, platform: "darwin" });
    expect(result).toEqual({
      oauth: { ok: true, configured: true, detail: "OAuth credential vault key configured" },
      stdio: { ok: true, configured: true, backend: "docker", detail: "digest-pinned Docker image configured" }
    });
    expect(JSON.stringify(result)).not.toContain(vaultKey);
    expect(() => resolveMcpStdioRuntimeOptions({
      ...environment,
      SUNABOT_MCP_STDIO_DOCKER_IMAGE: "sunabot-mcp:latest"
    }, "darwin")).toThrow("MCP_STDIO_DOCKER_IMAGE_INVALID");
    expect(() => resolveMcpStdioRuntimeOptions({
      ...environment,
      SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST_SHA256: "invalid"
    }, "darwin")).toThrow("MCP_STDIO_EXECUTABLE_MANIFEST_SHA256_INVALID");
  });

  it("requires a root-policy 0444 Native manifest and rejects unsupported platforms", async () => {
    const manifest = path.join(root, "executables.json");
    await fs.writeFile(manifest, "{}\n", { mode: 0o444 });
    await fs.chmod(manifest, 0o444);
    const environment = {
      SUNABOT_MCP_STDIO_BACKEND: "bubblewrap",
      SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST: manifest
    };
    await expect(inspectMcpRuntimeConfiguration({
      environment,
      platform: "linux",
      expectedManifestUid: process.getuid?.() ?? 0
    })).resolves.toMatchObject({
      stdio: { ok: true, configured: true, backend: "bubblewrap", path: manifest }
    });
    await fs.chmod(manifest, 0o600);
    await expect(inspectMcpRuntimeConfiguration({
      environment,
      platform: "linux",
      expectedManifestUid: process.getuid?.() ?? 0
    })).resolves.toMatchObject({
      stdio: { ok: false, detail: "MCP_STDIO_EXECUTABLE_MANIFEST_INVALID" }
    });
    expect(() => resolveMcpStdioRuntimeOptions(environment, "darwin"))
      .toThrow("MCP_STDIO_BACKEND_UNAVAILABLE");
  });

  it("passes the validated production stdio selection into the API composition root", async () => {
    const source = await fs.readFile(serverSourceUrl, "utf8");
    expect(source).toContain("mcpStdio: resolveMcpStdioRuntimeOptions(process.env, process.platform)");
    expect(source).not.toContain("mcpStdio: { backend: \"auto\"");
  });
});
