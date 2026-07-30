import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedAttachment } from "../../packages/contracts/media/media.js";
import type { FrozenCodexTextProjectionV1 } from "../../packages/contracts/tools/codex.js";
import { readChunksSqlite } from "./attachments/chunks.js";

export const CODEX_TEXT_PROJECTION_MAX_BYTES = 256 * 1024;
export const CODEX_TEXT_PROJECTION_TOTAL_BYTES = 512 * 1024;

const MAX_CHUNK_INDEX_BYTES = 64 * 1024 * 1024;

export async function freezeCodexTextProjection(input: {
  attachment: ParsedAttachment;
  cacheRoot: string;
  frozenRawPath: string;
  inputRoot: string;
  inputIndex: number;
  maxBytes: number;
}): Promise<FrozenCodexTextProjectionV1 | undefined> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) return undefined;
  const parsed = input.attachment.chunkIndexPath
    ? await readParsedProjection(
        input.cacheRoot,
        input.attachment.chunkIndexPath,
        input.inputRoot,
        input.maxBytes
      )
    : undefined;
  const projection = parsed ?? await readRawTextProjection(
    input.attachment,
    input.frozenRawPath,
    input.maxBytes
  );
  if (!projection?.text.trim()) return undefined;

  const bytes = Buffer.from(projection.text, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const targetName = `input-${input.inputIndex + 1}-text-${sha256}.txt`;
  const targetPath = path.join(input.inputRoot, targetName);
  await publishProjection(targetPath, bytes);
  return {
    schemaVersion: 1,
    source: projection.source,
    relativePath: path.posix.join("inputs", targetName),
    sha256,
    sizeBytes: bytes.byteLength,
    characterCount: projection.text.length,
    truncated: projection.truncated || input.attachment.truncated === true
  };
}

async function readParsedProjection(
  cacheRoot: string,
  relativePath: string,
  inputRoot: string,
  maxBytes: number
) {
  const sourcePath = await resolveCacheArtifact(cacheRoot, relativePath);
  const snapshotPath = path.join(inputRoot, `.codex-chunks-${randomUUID()}.sqlite`);
  try {
    await copyStableRegularFile(sourcePath, snapshotPath, MAX_CHUNK_INDEX_BYTES);
    const chunks = readChunksSqlite(snapshotPath);
    const combined = chunks
      .filter((chunk) => typeof chunk.text === "string" && chunk.text.trim())
      .map((chunk) => chunk.text)
      .join("\n\n");
    const bounded = boundedUtf8(combined, maxBytes);
    return bounded.text
      ? {
          source: "parsed_text" as const,
          text: bounded.text,
          truncated: bounded.truncated
        }
      : undefined;
  } finally {
    await fs.rm(snapshotPath, { force: true }).catch(() => undefined);
  }
}

async function readRawTextProjection(
  attachment: ParsedAttachment,
  frozenRawPath: string,
  maxBytes: number
) {
  if (!isTextLikeAttachment(attachment)) return undefined;
  const source = await fs.open(
    frozenRawPath,
    requiredFlag("O_RDONLY") | requiredFlag("O_NOFOLLOW")
  );
  try {
    const before = await source.stat({ bigint: true });
    assertRegularFile(before, BigInt(256 * 1024 * 1024));
    const readLimit = Math.min(Number(before.size), maxBytes + 4);
    const bytes = Buffer.allocUnsafe(readLimit);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await source.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw projectionError("CODEX_INPUT_TEXT_CHANGED");
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      return undefined;
    }
    const bounded = boundedUtf8(decoded, maxBytes);
    return {
      source: "raw_text" as const,
      text: bounded.text,
      truncated: bounded.truncated || before.size > BigInt(offset)
    };
  } finally {
    await source.close();
  }
}

async function resolveCacheArtifact(cacheRoot: string, relativePath: string) {
  if (
    !relativePath
    || relativePath.length > 1_024
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw projectionError("CODEX_INPUT_TEXT_PATH_INVALID");
  }
  const realRoot = await fs.realpath(path.resolve(cacheRoot));
  const candidate = path.resolve(realRoot, relativePath);
  const relative = path.relative(realRoot, candidate);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw projectionError("CODEX_INPUT_TEXT_PATH_INVALID");
  }
  const realSource = await fs.realpath(candidate);
  if (realSource !== candidate) throw projectionError("CODEX_INPUT_TEXT_PATH_INVALID");
  return candidate;
}

async function copyStableRegularFile(
  sourcePath: string,
  targetPath: string,
  maxBytes: number
) {
  const source = await fs.open(
    sourcePath,
    requiredFlag("O_RDONLY") | requiredFlag("O_NOFOLLOW")
  );
  let target: fs.FileHandle | undefined;
  let complete = false;
  try {
    const before = await source.stat({ bigint: true });
    assertRegularFile(before, BigInt(maxBytes));
    target = await fs.open(
      targetPath,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | requiredFlag("O_NOFOLLOW"),
      0o600
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      copied += bytesRead;
      if (copied > maxBytes) throw projectionError("CODEX_INPUT_TEXT_TOO_LARGE");
      await writeAll(target, buffer.subarray(0, bytesRead));
    }
    const after = await source.stat({ bigint: true });
    if (!sameIdentity(before, after) || copied !== Number(before.size)) {
      throw projectionError("CODEX_INPUT_TEXT_CHANGED");
    }
    await target.sync();
    await target.close();
    target = undefined;
    complete = true;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    if (!complete) await fs.rm(targetPath, { force: true }).catch(() => undefined);
  }
}

async function publishProjection(targetPath: string, bytes: Buffer) {
  await fs.writeFile(targetPath, bytes, { flag: "wx", mode: 0o400 });
  const stat = await fs.lstat(targetPath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size !== bytes.byteLength
  ) {
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
    throw projectionError("CODEX_INPUT_TEXT_PUBLISH_FAILED");
  }
  await fs.chmod(targetPath, 0o400);
}

function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maxBytes).toString("utf8");
  if (text.endsWith("\ufffd")) text = text.slice(0, -1);
  return { text, truncated: true };
}

function isTextLikeAttachment(attachment: ParsedAttachment) {
  if (attachment.mimeType?.toLowerCase().startsWith("text/")) return true;
  return new Set([
    "csv",
    "json",
    "log",
    "md",
    "markdown",
    "rtf",
    "text",
    "tsv",
    "txt",
    "xml",
    "yaml",
    "yml"
  ]).has(attachment.format?.toLowerCase() ?? "");
}

function assertRegularFile(
  stat: BigIntStats,
  maxBytes: bigint
) {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || stat.size < 1n
    || stat.size > maxBytes
  ) {
    throw projectionError("CODEX_INPUT_TEXT_SOURCE_INVALID");
  }
}

function sameIdentity(
  before: BigIntStats,
  after: BigIntStats
) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.ctimeNs === after.ctimeNs
    && before.mtimeNs === after.mtimeNs
    && before.nlink === after.nlink;
}

async function writeAll(handle: fs.FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw projectionError("CODEX_INPUT_TEXT_WRITE_FAILED");
    offset += bytesWritten;
  }
}

function requiredFlag(name: "O_RDONLY" | "O_NOFOLLOW") {
  const value = (fsConstants as unknown as Record<string, number>)[name];
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || (name === "O_NOFOLLOW" && value === 0)
  ) {
    throw projectionError("CODEX_INPUT_TEXT_PLATFORM_UNSUPPORTED");
  }
  return value;
}

function projectionError(code: string) {
  return Object.assign(new Error(code), { code });
}
