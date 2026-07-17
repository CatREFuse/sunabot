import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isSafeMcpCommandPath } from "../../packages/contracts/extensions/agentMcpDescriptorSecurity.js";

export const MCP_APPROVED_EXECUTABLE_MANIFEST_PATH = "/opt/sunabot/mcp/executables.json";
export const MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256 = "7b8e74c013b91d95981eda9baff0ee83ac5f105469a171cb3e1e5b5e32299921";

export interface McpApprovedExecutableManifest {
  schemaVersion: 1;
  executables: Array<{ path: string; sha256: string }>;
}

export async function readMcpApprovedExecutableManifest(
  file: string,
  options: { expectedUid?: number } = {}
) {
  if (!path.isAbsolute(file) || file.includes("\0")) invalid();
  const encoded = await readBoundFile(file, {
    expectedMode: 0o444,
    expectedUid: options.expectedUid ?? 0,
    maximumBytes: 1024 * 1024
  });
  try {
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
      if (text.startsWith("\uFEFF")) invalid();
      value = JSON.parse(text);
    } catch {
      invalid();
    }
    const manifest = value as Partial<McpApprovedExecutableManifest>;
    if (!exactKeys(manifest, ["executables", "schemaVersion"])
      || manifest.schemaVersion !== 1
      || !Array.isArray(manifest.executables)
      || manifest.executables.length < 1
      || manifest.executables.length > 128
      || manifest.executables.some((entry) => !exactKeys(entry, ["path", "sha256"])
        || typeof entry.path !== "string"
        || !isSafeMcpCommandPath(entry.path)
        || typeof entry.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(entry.sha256))
      || new Set(manifest.executables.map((entry) => entry.path)).size !== manifest.executables.length) {
      invalid();
    }
    return { encoded, manifest: manifest as McpApprovedExecutableManifest };
  } catch (error) {
    encoded.fill(0);
    throw error;
  }
}

export async function verifyMcpApprovedExecutable(input: {
  manifestFile: string;
  command: string;
  expectedManifestUid?: number;
  expectedExecutableUid?: number;
}) {
  const loaded = await readMcpApprovedExecutableManifest(input.manifestFile, {
    expectedUid: input.expectedManifestUid
  });
  try {
    const approved = loaded.manifest.executables.find((entry) => entry.path === input.command);
    if (!approved) invalid();
    const executable = await readBoundFile(input.command, {
      expectedUid: input.expectedExecutableUid ?? 0,
      maximumBytes: 32 * 1024 * 1024,
      executable: true
    });
    try {
      if (createHash("sha256").update(executable).digest("hex") !== approved.sha256) invalid();
    } finally {
      executable.fill(0);
    }
  } finally {
    loaded.encoded.fill(0);
  }
}

async function readBoundFile(file: string, options: {
  expectedMode?: number;
  expectedUid: number;
  maximumBytes: number;
  executable?: boolean;
}) {
  const before = await fs.lstat(file).catch(() => invalid());
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== options.expectedUid
    || before.size <= 0 || before.size > options.maximumBytes
    || (options.expectedMode !== undefined && (before.mode & 0o777) !== options.expectedMode)
    || (options.executable === true && (before.mode & 0o111) === 0)) {
    invalid();
  }
  const canonical = await fs.realpath(file).catch(() => invalid());
  if (canonical !== file) invalid();
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => invalid());
  let content: Buffer | undefined;
  let completed = false;
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) invalid();
    content = await handle.readFile();
    const [after, current] = await Promise.all([handle.stat(), fs.lstat(file)]);
    if (!sameIdentity(opened, after) || !sameIdentity(after, current)
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.isSymbolicLink()) {
      invalid();
    }
    completed = true;
    return content;
  } finally {
    let closeFailed = false;
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
    if (!completed || closeFailed) content?.fill(0);
    if (closeFailed) invalid();
  }
}

function sameIdentity(left: { dev: number; ino: number; size: number }, right: { dev: number; ino: number; size: number }) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function exactKeys(value: unknown, expected: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function invalid(): never {
  const error = new Error("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");
  error.name = "McpAdapterError";
  throw error;
}
