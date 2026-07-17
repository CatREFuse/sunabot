// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readMcpApprovedExecutableManifest,
  verifyMcpApprovedExecutable
} from "../../adapters/mcp/approvedExecutableManifest.js";

const root = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/mcp-approved-executables";
const command = "/usr/bin/true";

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("MCP approved executable manifest", () => {
  it("verifies a root-owned regular executable against a private trusted manifest", async () => {
    const file = await writeManifest(await executableDigest());
    await expect(verifyMcpApprovedExecutable({
      manifestFile: file,
      command,
      expectedManifestUid: process.getuid?.() ?? 0,
      expectedExecutableUid: 0
    })).resolves.toBeUndefined();
  });

  it("fails closed for missing approvals, digest changes, symlinks, and writable manifests", async () => {
    const missing = await writeManifest(await executableDigest(), "/usr/bin/false");
    await expect(verifyMcpApprovedExecutable({
      manifestFile: missing,
      command,
      expectedManifestUid: process.getuid?.() ?? 0,
      expectedExecutableUid: 0
    })).rejects.toThrow("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");

    const wrongDigest = await writeManifest("0".repeat(64), command, "wrong-digest.json");
    await expect(verifyMcpApprovedExecutable({
      manifestFile: wrongDigest,
      command,
      expectedManifestUid: process.getuid?.() ?? 0,
      expectedExecutableUid: 0
    })).rejects.toThrow("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");

    const valid = await writeManifest(await executableDigest(), command, "valid.json");
    const symlink = path.join(root, "manifest-link.json");
    await fs.symlink(valid, symlink);
    await expect(readMcpApprovedExecutableManifest(symlink, { expectedUid: process.getuid?.() ?? 0 }))
      .rejects.toThrow("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");

    await fs.chmod(valid, 0o644);
    await expect(readMcpApprovedExecutableManifest(valid, { expectedUid: process.getuid?.() ?? 0 }))
      .rejects.toThrow("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");
  });
});

async function writeManifest(digest: string, executable = command, name = "executables.json") {
  const file = path.join(root, name);
  await fs.writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    executables: [{ path: executable, sha256: digest }]
  })}\n`, { mode: 0o444 });
  await fs.chmod(file, 0o444);
  return file;
}

async function executableDigest() {
  return createHash("sha256").update(await fs.readFile(command)).digest("hex");
}
