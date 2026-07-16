import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
  type BigIntStats
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import {
  MAX_OUTBOUND_CONVERSATION_ASSET_INLINE_BYTES,
  type OutboundConversationAssetKindV1,
  type PreparedOutboundConversationAssetV1
} from "../../packages/contracts/messaging/messages.js";

export const DEFAULT_OUTBOUND_CONVERSATION_ASSET_MAX_INLINE_BYTES =
  MAX_OUTBOUND_CONVERSATION_ASSET_INLINE_BYTES;

export type OutboundConversationAssetSourceErrorCode =
  | "SEND_FILE_SOURCE_MISSING"
  | "SEND_FILE_SOURCE_FORBIDDEN"
  | "SEND_FILE_SOURCE_UNAVAILABLE"
  | "SEND_FILE_SOURCE_UNSAFE"
  | "SEND_FILE_ROOT_CHANGED";

export class OutboundConversationAssetSourceError extends Error {
  override readonly name = "OutboundConversationAssetSourceError";

  constructor(
    readonly code: OutboundConversationAssetSourceErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

export interface OutboundConversationAssetRootIdentity {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

export interface OutboundConversationAssetDeliveryOptions {
  rootDir: string;
  rootIdentity: OutboundConversationAssetRootIdentity;
  maxInlineBytes?: number;
  openFile?: typeof fs.open;
}

export interface PrepareOutboundConversationAssetInput {
  path: string;
  kind: OutboundConversationAssetKindV1 | "auto";
  name?: string;
}

export interface ExpectedOutboundConversationAssetContent {
  byteLength: number;
  sha256: string;
}

export function captureOutboundConversationAssetRootIdentity(
  rootDir: string
): OutboundConversationAssetRootIdentity {
  try {
    const requestedRoot = path.resolve(rootDir);
    const requested = lstatSync(requestedRoot, { bigint: true });
    assertRegularRootDirectory(requested);
    const canonicalPath = realpathSync(requestedRoot);
    const canonical = lstatSync(canonicalPath, { bigint: true });
    assertRegularRootDirectory(canonical);
    if (!sameRootSnapshot(requested, canonical)) throw rootChangedError();
    return Object.freeze({
      canonicalPath,
      dev: canonical.dev,
      ino: canonical.ino,
      ctimeNs: canonical.ctimeNs
    });
  } catch (error) {
    throw normalizeOutboundConversationAssetError(error);
  }
}

export function normalizeOutboundConversationAssetError(error: unknown): Error {
  if (error instanceof OutboundConversationAssetSourceError) return error;
  const filesystemError = error as (NodeJS.ErrnoException & { dest?: unknown }) | null;
  const explicitCode = String(filesystemError?.code ?? "").toUpperCase();
  const messageCode = error instanceof Error
    ? error.message.match(/^\s*(E[A-Z0-9]+)\s*:/i)?.[1]?.toUpperCase() ?? ""
    : "";
  const code = explicitCode || messageCode;
  if (["ENOENT", "ENOTDIR", "ESTALE"].includes(code)) {
    return new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_MISSING",
      "The requested workbench file is unavailable."
    );
  }
  if (["EACCES", "EPERM"].includes(code)) {
    return new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_FORBIDDEN",
      "The requested workbench file cannot be accessed."
    );
  }
  if (["ELOOP", "EMLINK"].includes(code)) {
    return new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_UNSAFE",
      "The requested workbench path contains symbolic links or changed during validation."
    );
  }
  if (looksLikeFilesystemError(filesystemError, code, error instanceof Error ? error.message : "")) {
    return new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_UNAVAILABLE",
      "The requested workbench file is unavailable due to a filesystem failure."
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function looksLikeFilesystemError(
  error: (NodeJS.ErrnoException & { dest?: unknown }) | null,
  code: string,
  message: string
) {
  if (code.startsWith("E")) return true;
  if (
    typeof error?.path === "string" ||
    typeof error?.dest === "string" ||
    typeof error?.syscall === "string" ||
    typeof error?.errno === "number" ||
    typeof error?.errno === "string"
  ) {
    return true;
  }
  return /(?:^|[\s'"(])(?:\/[^\s'"),]+|[A-Za-z]:[\\/][^\s'"),]+|\\\\[^\s'"),]+|file:\/\/[^\s'"),]+)/u.test(message);
}

export class OutboundConversationAssetDelivery {
  private readonly rootDir: string;
  private readonly rootIdentity: OutboundConversationAssetRootIdentity;
  private readonly maxInlineBytes: number;
  private readonly openFile: typeof fs.open;

  constructor(options: OutboundConversationAssetDeliveryOptions) {
    const rootIdentity = Object.freeze({ ...options.rootIdentity });
    this.rootDir = rootIdentity.canonicalPath;
    this.rootIdentity = rootIdentity;
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_OUTBOUND_CONVERSATION_ASSET_MAX_INLINE_BYTES;
    this.openFile = options.openFile ?? fs.open;
    if (!Number.isSafeInteger(this.maxInlineBytes) || this.maxInlineBytes < 1) {
      throw new Error("Outbound conversation asset inline size limit must be a positive integer.");
    }
    assertRootIdentitySync(options.rootDir, rootIdentity);
  }

  async prepare(
    input: PrepareOutboundConversationAssetInput,
    expected?: ExpectedOutboundConversationAssetContent
  ): Promise<PreparedOutboundConversationAssetV1> {
    try {
      return await this.prepareValidated(input, expected);
    } catch (error) {
      throw normalizeOutboundConversationAssetError(error);
    }
  }

  private async prepareValidated(
    input: PrepareOutboundConversationAssetInput,
    expected?: ExpectedOutboundConversationAssetContent
  ): Promise<PreparedOutboundConversationAssetV1> {
    await assertRootIdentity(this.rootIdentity);
    const relativePath = normalizeRelativePath(input.path);
    const resolvedPath = path.resolve(this.rootDir, relativePath);
    if (!isInsideRoot(this.rootDir, resolvedPath)) {
      throw new Error("Outbound conversation asset is outside the Agent workbench.");
    }

    const stats = await regularFileStats(resolvedPath);
    if (!stats) throw new Error("Outbound conversation asset is not a regular file.");
    if (stats.size > this.maxInlineBytes) throw inlineLimitError(this.maxInlineBytes);
    await assertUnredirectedPath(this.rootIdentity, resolvedPath, relativePath);

    const content = await this.readStableFile(resolvedPath, relativePath);
    const detected = await fileTypeFromBuffer(content);
    const kind = resolveKind(input.kind, detected?.mime, resolvedPath);
    const name = normalizeFileName(input.name, path.basename(resolvedPath));
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (expected && (content.byteLength !== expected.byteLength || sha256 !== expected.sha256)) {
      throw new Error("Outbound conversation asset changed after it was queued.");
    }
    return {
      kind,
      name,
      source: `base64://${content.toString("base64")}`,
      byteLength: content.byteLength,
      sha256,
      ...(detected?.mime ? { mimeType: detected.mime } : {})
    };
  }

  private async readStableFile(resolvedPath: string, relativePath: string) {
    await assertRootIdentity(this.rootIdentity);
    let handle;
    try {
      handle = await this.openFile(
        resolvedPath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
    } catch (error) {
      throw normalizeOutboundConversationAssetError(error);
    }

    try {
      const before = await handle.stat({ bigint: true });
      assertStableRegularFile(before, this.maxInlineBytes);
      await assertHandleMatchesPath(this.rootIdentity, resolvedPath, relativePath, before);
      const content = Buffer.allocUnsafe(Number(before.size));
      let offset = 0;
      while (offset < content.byteLength) {
        const { bytesRead } = await handle.read(
          content,
          offset,
          content.byteLength - offset,
          offset
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytesRead } = await handle.read(
        probe,
        0,
        1,
        content.byteLength
      );
      const after = await handle.stat({ bigint: true });
      assertStableRegularFile(after, this.maxInlineBytes);
      assertUnchangedFile(before, after);
      await assertHandleMatchesPath(this.rootIdentity, resolvedPath, relativePath, after);
      if (offset !== content.byteLength || extraBytesRead !== 0 || BigInt(content.byteLength) !== after.size) {
        throw new Error("Outbound conversation asset changed while it was being read.");
      }
      return content;
    } finally {
      await handle.close();
    }
  }
}

function normalizeRelativePath(value: string) {
  const candidate = String(value ?? "").trim();
  if (!candidate) throw new Error("Outbound conversation asset path is required.");
    if (candidate.length > 1_024 || candidate.includes("\0") || candidate.includes("\\")) {
    throw new Error("Outbound conversation asset path is invalid.");
  }
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new Error("Outbound conversation asset path must be relative to the Agent workbench.");
  }
  if (candidate.split(/[\\/]/).includes("..")) {
    throw new Error("Outbound conversation asset path must not contain traversal segments.");
  }
  return candidate;
}

function isInsideRoot(rootDir: string, filePath: string) {
  const relativePath = path.relative(rootDir, filePath);
  return Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath);
}

async function regularFileStats(filePath: string) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new OutboundConversationAssetSourceError(
        "SEND_FILE_SOURCE_UNSAFE",
        "The requested workbench path contains symbolic links or changed during validation."
      );
    }
    return stats.isFile() ? stats : null;
  } catch (error) {
    throw normalizeOutboundConversationAssetError(error);
  }
}

async function assertUnredirectedPath(
  rootIdentity: OutboundConversationAssetRootIdentity,
  filePath: string,
  relativePath: string
) {
  await assertRootIdentity(rootIdentity);
  const realFile = await fs.realpath(filePath);
  await assertRootIdentity(rootIdentity);
  if (realFile !== path.resolve(rootIdentity.canonicalPath, relativePath)) {
    throw new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_UNSAFE",
      "The requested workbench path contains symbolic links or changed during validation."
    );
  }
}

async function assertHandleMatchesPath(
  rootIdentity: OutboundConversationAssetRootIdentity,
  filePath: string,
  relativePath: string,
  handleStats: BigIntStats
) {
  await assertRootIdentity(rootIdentity);
  const [realFile, pathStats, leafStats] = await Promise.all([
    fs.realpath(filePath),
    fs.stat(filePath, { bigint: true }),
    fs.lstat(filePath, { bigint: true })
  ]);
  await assertRootIdentity(rootIdentity);
  if (leafStats.isSymbolicLink() || realFile !== path.resolve(rootIdentity.canonicalPath, relativePath)) {
    throw new OutboundConversationAssetSourceError(
      "SEND_FILE_SOURCE_UNSAFE",
      "The requested workbench path contains symbolic links or changed during validation."
    );
  }
  if (
    pathStats.dev !== handleStats.dev ||
    pathStats.ino !== handleStats.ino ||
    pathStats.size !== handleStats.size
  ) {
    throw new Error("Outbound conversation asset path changed while it was being read.");
  }
}

function assertStableRegularFile(stats: BigIntStats, maxInlineBytes: number) {
  if (!stats.isFile()) throw new Error("Outbound conversation asset is not a regular file.");
  if (stats.nlink > 1n) throw new Error("Outbound conversation asset must not be a hard link.");
  if (stats.size > BigInt(maxInlineBytes)) throw inlineLimitError(maxInlineBytes);
}

function assertUnchangedFile(before: BigIntStats, after: BigIntStats) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.nlink !== after.nlink ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("Outbound conversation asset changed while it was being read.");
  }
}

function assertRootIdentitySync(
  rootDir: string,
  expected: OutboundConversationAssetRootIdentity
) {
  try {
    const requestedRoot = path.resolve(rootDir);
    const requested = lstatSync(requestedRoot, { bigint: true });
    assertRegularRootDirectory(requested);
    const canonicalPath = realpathSync(requestedRoot);
    const current = lstatSync(canonicalPath, { bigint: true });
    assertRegularRootDirectory(current);
    if (
      canonicalPath !== expected.canonicalPath ||
      !matchesRootIdentity(current, expected) ||
      !sameRootSnapshot(requested, current)
    ) {
      throw rootChangedError();
    }
  } catch (error) {
    if (error instanceof OutboundConversationAssetSourceError) throw error;
    throw rootChangedError();
  }
}

async function assertRootIdentity(expected: OutboundConversationAssetRootIdentity) {
  try {
    const before = await fs.lstat(expected.canonicalPath, { bigint: true });
    assertRegularRootDirectory(before);
    const canonicalPath = await fs.realpath(expected.canonicalPath);
    const after = await fs.lstat(expected.canonicalPath, { bigint: true });
    assertRegularRootDirectory(after);
    if (
      canonicalPath !== expected.canonicalPath ||
      !matchesRootIdentity(before, expected) ||
      !matchesRootIdentity(after, expected) ||
      !sameRootSnapshot(before, after)
    ) {
      throw rootChangedError();
    }
  } catch (error) {
    if (error instanceof OutboundConversationAssetSourceError) throw error;
    throw rootChangedError();
  }
}

function assertRegularRootDirectory(stats: BigIntStats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw rootChangedError();
}

function matchesRootIdentity(
  stats: BigIntStats,
  expected: OutboundConversationAssetRootIdentity
) {
  return stats.dev === expected.dev &&
    stats.ino === expected.ino &&
    stats.ctimeNs === expected.ctimeNs;
}

function sameRootSnapshot(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs;
}

function rootChangedError() {
  return new OutboundConversationAssetSourceError(
    "SEND_FILE_ROOT_CHANGED",
    "The Agent workbench root changed during file validation."
  );
}

function resolveKind(
  requested: PrepareOutboundConversationAssetInput["kind"],
  mimeType: string | undefined,
  filePath: string
): OutboundConversationAssetKindV1 {
  if (requested === "auto") return mimeType?.startsWith("image/") ? "image" : "file";
  if (requested === "image" && !mimeType?.startsWith("image/")) {
    throw new Error("Outbound conversation asset is not a recognized image.");
  }
  if (requested === "voice" && !isRecognizedVoice(mimeType, filePath)) {
    throw new Error("Outbound conversation asset is not a recognized voice file.");
  }
  return requested;
}

function isRecognizedVoice(mimeType: string | undefined, filePath: string) {
  return mimeType?.startsWith("audio/") === true || /\.(?:amr|silk)$/i.test(filePath);
}

function normalizeFileName(value: string | undefined, fallback: string) {
  const candidate = String(value ?? fallback).trim();
  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    candidate.length > 255 ||
    /[\0-\x1f\x7f/\\]/.test(candidate) ||
    path.basename(candidate) !== candidate
  ) {
    throw new Error("Outbound conversation asset name is invalid.");
  }
  return candidate;
}

function inlineLimitError(limit: number) {
  return new Error(`Outbound conversation asset exceeds the inline Base64 limit of ${limit} bytes.`);
}
