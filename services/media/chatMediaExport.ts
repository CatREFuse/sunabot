import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { MediaAssetRefV1, ParsedAttachment } from "../../packages/contracts/media/media.js";
import { resolveAgentWorkbench } from "../agents/public.js";
import type {
  ExportChatMediaInput,
  ExportedChatMedia
} from "../tools/public.js";
import type { CacheStore } from "./attachments/cache.js";
import { detectAttachmentType, type DetectedAttachmentType } from "./attachments/detect.js";
import { FILE_SIZE_LIMIT_BYTES } from "./attachments/limits.js";

export const CHAT_IMAGE_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

export type ChatMediaBoundSource =
  | {
      kind: "image";
      asset: MediaAssetRefV1;
    }
  | {
      kind: "file";
      attachment: ParsedAttachment;
    };

export interface ChatMediaExportServiceOptions {
  agentWorkspace: string;
  cache: CacheStore;
  sources: ReadonlyMap<string, ChatMediaBoundSource>;
  publisher: ChatMediaPublisher;
  isCurrent?: () => boolean;
}

export interface ChatMediaDirectoryIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

export interface ChatMediaPublishInput {
  temporaryPath: string;
  targetPath: string;
  parentIdentity: ChatMediaDirectoryIdentity;
  expectedByteLength: number;
}

export interface ChatMediaPublisher {
  publish(input: ChatMediaPublishInput): Promise<boolean>;
}

interface MaterializedSource {
  filePath: string;
  maxBytes: number;
  expectedSha256?: string;
  expectedMimeType?: string;
  originalName?: string;
  kind: ChatMediaBoundSource["kind"];
}

interface InspectedSource {
  temporaryPath: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  extension: string;
  width: number | null;
  height: number | null;
}

export class ChatMediaExportService {
  private readonly agentWorkspace: string;
  private readonly cache: CacheStore;
  private readonly sources: ReadonlyMap<string, ChatMediaBoundSource>;
  private readonly publisher: ChatMediaPublisher;
  private readonly isCurrent: () => boolean;

  constructor(options: ChatMediaExportServiceOptions) {
    this.agentWorkspace = path.resolve(options.agentWorkspace);
    this.cache = options.cache;
    this.sources = options.sources;
    this.publisher = options.publisher;
    this.isCurrent = options.isCurrent ?? (() => true);
  }

  async export(input: ExportChatMediaInput): Promise<ExportedChatMedia> {
    try {
      return await this.exportBound(input);
    } catch (error) {
      throw normalizeChatMediaError(error, "CHAT_MEDIA_EXPORT_FAILED");
    }
  }

  async readImage(handle: string, maxBytes: number) {
    try {
      return await this.readImageBound(handle, maxBytes);
    } catch (error) {
      throw normalizeChatMediaError(error, "CHAT_MEDIA_READ_FAILED");
    }
  }

  private async exportBound(input: ExportChatMediaInput): Promise<ExportedChatMedia> {
    this.assertCurrent();
    const source = this.requireSource(input.handle);
    const workbenchRoot = await resolveAgentWorkbench(this.agentWorkspace);
    const materialized = await this.materialize(source);
    this.assertCurrent();
    const inspected = await copyAndInspect(materialized, workbenchRoot);
    const rootIdentity = await directoryIdentity(workbenchRoot);
    let published = false;
    try {
      this.assertCurrent();
      await assertSameDirectory(workbenchRoot, rootIdentity);
      const fileName = `chat-media-${inspected.sha256}.${inspected.extension}`;
      const targetPath = path.join(workbenchRoot, fileName);
      const deduplicated = await publishContentAddressed(
        inspected.temporaryPath,
        targetPath,
        inspected,
        rootIdentity,
        this.publisher
      );
      published = true;
      await assertSameDirectory(workbenchRoot, rootIdentity, false);
      return {
        ok: true,
        path: fileName,
        sha256: inspected.sha256,
        mimeType: inspected.mimeType,
        extension: inspected.extension,
        byteLength: inspected.byteLength,
        width: inspected.width,
        height: inspected.height,
        deduplicated
      };
    } finally {
      if (!published) await fs.unlink(inspected.temporaryPath).catch(() => undefined);
    }
  }

  private async readImageBound(handle: string, maxBytes: number) {
    this.assertCurrent();
    const source = this.requireSource(handle);
    if (source.kind !== "image") throw chatMediaError("CHAT_MEDIA_IMAGE_REQUIRED");
    const materialized = await this.materialize(source);
    if (maxBytes < 1 || maxBytes > CHAT_IMAGE_EXPORT_MAX_BYTES) {
      throw chatMediaError("CHAT_MEDIA_LIMIT_INVALID");
    }
    if (materialized.maxBytes > maxBytes) materialized.maxBytes = maxBytes;
    const bytes = await readVerifiedSource(materialized);
    this.assertCurrent();
    return bytes;
  }

  private requireSource(handle: string) {
    const source = this.sources.get(handle);
    if (!source) throw chatMediaError("CHAT_MEDIA_HANDLE_UNAVAILABLE");
    return source;
  }

  private async materialize(source: ChatMediaBoundSource): Promise<MaterializedSource> {
    if (source.kind === "file") return this.materializeAttachment(source.attachment);
    const asset = source.asset;
    if (asset.source === "shared_file") {
      throw chatMediaError("CHAT_MEDIA_SOURCE_UNAVAILABLE");
    }
    const originalName = asset.source === "remote_url"
      ? safeRemoteName(asset.url)
      : undefined;
    const expectedMimeType = asset.source === "inline_data"
      ? inlineDataMimeType(asset.url)
      : undefined;
    const cached = asset.source === "inline_data"
      ? await this.cache.writeBase64(asset.url, { maxBytes: CHAT_IMAGE_EXPORT_MAX_BYTES })
      : await this.cache.downloadHttp(asset.url, {
        maxBytes: CHAT_IMAGE_EXPORT_MAX_BYTES
      });
    return {
      filePath: cached.filePath,
      maxBytes: CHAT_IMAGE_EXPORT_MAX_BYTES,
      expectedSha256: cached.sha256,
      expectedMimeType,
      originalName,
      kind: "image"
    };
  }

  private async materializeAttachment(attachment: ParsedAttachment): Promise<MaterializedSource> {
    if (
      (attachment.status !== "ready" && attachment.status !== "partial")
      || !attachment.cacheKey
      || !attachment.sha256
      || attachment.cacheKey !== attachment.sha256
    ) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_UNAVAILABLE");
    }
    const entry = await this.cache.getEntry(attachment.cacheKey);
    if (
      !entry
      || entry.sha256 !== attachment.sha256
      || entry.originalSizeBytes !== attachment.sizeBytes
    ) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_CHANGED");
    }
    const filePath = resolveCacheEntryPath(this.cache.rootDir, entry.originalFile);
    return {
      filePath,
      maxBytes: FILE_SIZE_LIMIT_BYTES,
      expectedSha256: attachment.sha256,
      expectedMimeType: attachment.mimeType,
      originalName: attachment.name,
      kind: "file"
    };
  }

  private assertCurrent() {
    if (!this.isCurrent()) throw chatMediaError("CHAT_MEDIA_TURN_EXPIRED");
  }
}

async function copyAndInspect(source: MaterializedSource, workbenchRoot: string): Promise<InspectedSource> {
  const sourceHandle = await fs.open(
    source.filePath,
    fsConstants.O_RDONLY | requiredFlag("O_NOFOLLOW")
  );
  const temporaryPath = path.join(workbenchRoot, `.chat-media-${randomUUID()}.part`);
  let targetHandle: fs.FileHandle | undefined;
  let keepTemporary = false;
  try {
    const sourceBefore = await regularFileIdentity(sourceHandle, source.maxBytes);
    targetHandle = await fs.open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | requiredFlag("O_NOFOLLOW"),
      0o600
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      byteLength += bytesRead;
      if (byteLength > source.maxBytes) throw chatMediaError("CHAT_MEDIA_TOO_LARGE");
      hash.update(buffer.subarray(0, bytesRead));
      await writeAll(targetHandle, buffer.subarray(0, bytesRead));
    }
    if (byteLength < 1) throw chatMediaError("CHAT_MEDIA_EMPTY");
    const sourceAfter = await regularFileIdentity(sourceHandle, source.maxBytes);
    if (!sameFileIdentity(sourceBefore, sourceAfter) || sourceAfter.size !== byteLength) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_CHANGED");
    }
    const sha256 = hash.digest("hex");
    if (source.expectedSha256 && sha256 !== source.expectedSha256) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_CHANGED");
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    const detection = await detectAttachmentType(temporaryPath, {
      fileName: source.originalName ?? "media",
      contentType: source.expectedMimeType,
      maxBytes: source.maxBytes
    });
    validateDetection(detection, source);
    const dimensions = detection.kind === "image"
      ? await imageDimensions(temporaryPath)
      : { width: null, height: null };
    keepTemporary = true;
    return {
      temporaryPath,
      sha256,
      byteLength,
      mimeType: detection.mimeType!,
      extension: detection.format!,
      ...dimensions
    };
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
    if (!keepTemporary) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function validateDetection(detection: DetectedAttachmentType, source: MaterializedSource) {
  if (
    detection.kind === "unsupported"
    || !detection.mimeType
    || !detection.format
    || detection.extensionMismatch
  ) {
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
  if (source.kind === "image" && detection.kind !== "image") {
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
  const expectedMime = normalizeMimeType(source.expectedMimeType);
  if (expectedMime && detection.mimeType !== expectedMime) {
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
}

async function imageDimensions(filePath: string) {
  try {
    const metadata = await sharp(filePath, {
      failOn: "error",
      limitInputPixels: 64_000_000
    }).metadata();
    if (
      !Number.isSafeInteger(metadata.width)
      || !Number.isSafeInteger(metadata.height)
      || Number(metadata.width) < 1
      || Number(metadata.height) < 1
    ) {
      throw new Error("Image dimensions are invalid.");
    }
    return {
      width: Number(metadata.width),
      height: Number(metadata.height)
    };
  } catch {
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
}

async function publishContentAddressed(
  temporaryPath: string,
  targetPath: string,
  expected: Pick<InspectedSource, "sha256" | "byteLength">,
  parentIdentity: ChatMediaDirectoryIdentity,
  publisher: ChatMediaPublisher
) {
  const deduplicated = await publisher.publish({
    temporaryPath,
    targetPath,
    parentIdentity,
    expectedByteLength: expected.byteLength
  });
  await assertPublishedFile(targetPath, expected);
  return deduplicated;
}

async function assertPublishedFile(
  filePath: string,
  expected: Pick<InspectedSource, "sha256" | "byteLength">
) {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | requiredFlag("O_NOFOLLOW"));
  try {
    const before = await regularFileIdentity(handle, FILE_SIZE_LIMIT_BYTES);
    if (before.size !== expected.byteLength || before.links !== 1) {
      throw chatMediaError("CHAT_MEDIA_PUBLISH_CONFLICT");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      byteLength += bytesRead;
      if (byteLength > expected.byteLength) throw chatMediaError("CHAT_MEDIA_PUBLISH_CONFLICT");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await regularFileIdentity(handle, FILE_SIZE_LIMIT_BYTES);
    if (
      !sameFileIdentity(before, after)
      || byteLength !== expected.byteLength
      || hash.digest("hex") !== expected.sha256
    ) {
      throw chatMediaError("CHAT_MEDIA_PUBLISH_CONFLICT");
    }
  } finally {
    await handle.close();
  }
}

async function readVerifiedSource(source: MaterializedSource) {
  const handle = await fs.open(source.filePath, fsConstants.O_RDONLY | requiredFlag("O_NOFOLLOW"));
  try {
    const before = await regularFileIdentity(handle, source.maxBytes);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await regularFileIdentity(handle, source.maxBytes);
    if (offset !== bytes.length || !sameFileIdentity(before, after)) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_CHANGED");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (source.expectedSha256 && digest !== source.expectedSha256) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_CHANGED");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function resolveCacheEntryPath(cacheRoot: string, originalFile: string) {
  if (!originalFile || path.isAbsolute(originalFile) || originalFile.includes("\0")) {
    throw chatMediaError("CHAT_MEDIA_SOURCE_UNAVAILABLE");
  }
  const root = path.resolve(cacheRoot);
  const candidate = path.resolve(root, originalFile);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw chatMediaError("CHAT_MEDIA_SOURCE_UNAVAILABLE");
  }
  return candidate;
}

function safeRemoteName(value: string) {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(path.posix.basename(url.pathname));
    if (!name || name === "." || name === "/" || name.length > 180 || /[\u0000-\u001f\u007f]/u.test(name)) {
      return undefined;
    }
    return name.includes(".") ? name : undefined;
  } catch {
    return undefined;
  }
}

function inlineDataMimeType(value: string) {
  const match = value.match(/^data:([^;,]+);base64,/i);
  return normalizeMimeType(match?.[1]);
}

function normalizeMimeType(value: string | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

async function writeAll(handle: fs.FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw chatMediaError("CHAT_MEDIA_WRITE_FAILED");
    offset += bytesWritten;
  }
}

interface FileIdentity {
  device: string;
  inode: string;
  changeTimeNs: string;
  modifiedTimeNs: string;
  size: number;
  links: number;
}

async function regularFileIdentity(handle: fs.FileHandle, maxBytes: number): Promise<FileIdentity> {
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw chatMediaError("CHAT_MEDIA_SOURCE_UNSAFE");
  }
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw chatMediaError(size > maxBytes ? "CHAT_MEDIA_TOO_LARGE" : "CHAT_MEDIA_EMPTY");
  }
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    changeTimeNs: String(stat.ctimeNs),
    modifiedTimeNs: String(stat.mtimeNs),
    size,
    links: Number(stat.nlink)
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return left.device === right.device
    && left.inode === right.inode
    && left.changeTimeNs === right.changeTimeNs
    && left.modifiedTimeNs === right.modifiedTimeNs
    && left.size === right.size
    && left.links === right.links;
}

async function directoryIdentity(directory: string) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw chatMediaError("CHAT_MEDIA_WORKBENCH_UNSAFE");
  return {
    realPath: await fs.realpath(directory),
    dev: stat.dev,
    ino: stat.ino,
    ctimeNs: stat.ctimeNs
  };
}

async function assertSameDirectory(
  directory: string,
  expected: Awaited<ReturnType<typeof directoryIdentity>>,
  compareChangeTime = true
) {
  const current = await directoryIdentity(directory);
  if (
    current.realPath !== expected.realPath
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || (compareChangeTime && current.ctimeNs !== expected.ctimeNs)
  ) {
    throw chatMediaError("CHAT_MEDIA_WORKBENCH_CHANGED");
  }
}

function requiredFlag(name: "O_NOFOLLOW") {
  const value = fsConstants[name];
  if (typeof value !== "number") throw chatMediaError("CHAT_MEDIA_PLATFORM_UNSUPPORTED");
  return value;
}

function chatMediaError(code: string) {
  return Object.assign(new Error(code), { code });
}

function normalizeChatMediaError(error: unknown, fallback: string) {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("CHAT_MEDIA_")
    ? error
    : chatMediaError(fallback);
}
