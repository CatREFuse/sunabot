import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { MediaAssetRefV1, ParsedAttachment } from "../../packages/contracts/media/media.js";
import type { FrozenCodexInputV1 } from "../../packages/contracts/tools/codex.js";
import { resolveAgentWorkbench } from "../agents/public.js";
import type {
  ExportChatMediaInput,
  ExportedChatMedia
} from "../tools/public.js";
import type { CacheStore } from "./attachments/cache.js";
import { attachmentBlobRef } from "./attachments/attachmentServiceSupport.js";
import { detectAttachmentType, type DetectedAttachmentType } from "./attachments/detect.js";
import { FILE_SIZE_LIMIT_BYTES } from "./attachments/limits.js";
import {
  CODEX_TEXT_PROJECTION_MAX_BYTES,
  CODEX_TEXT_PROJECTION_TOTAL_BYTES,
  freezeCodexTextProjection
} from "./codexInputProjection.js";

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
  allowUnsupportedFiles?: boolean;
  contentAddressedNamePrefix?: string;
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
  private readonly allowUnsupportedFiles: boolean;
  private readonly contentAddressedNamePrefix: string;

  constructor(options: ChatMediaExportServiceOptions) {
    this.agentWorkspace = path.resolve(options.agentWorkspace);
    this.cache = options.cache;
    this.sources = options.sources;
    this.publisher = options.publisher;
    this.isCurrent = options.isCurrent ?? (() => true);
    this.allowUnsupportedFiles = options.allowUnsupportedFiles === true;
    this.contentAddressedNamePrefix = safeContentAddressedNamePrefix(
      options.contentAddressedNamePrefix ?? "chat-media"
    );
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

  async freezeCodexInputs(
    handles: readonly string[],
    jobDir: string
  ): Promise<FrozenCodexInputV1[]> {
    this.assertCurrent();
    if (!path.isAbsolute(jobDir)) throw chatMediaError("CODEX_INPUT_ROOT_INVALID");
    const uniqueHandles = [...new Set(handles)];
    if (
      uniqueHandles.length !== handles.length
      || uniqueHandles.length < 1
      || uniqueHandles.length > 8
    ) {
      throw chatMediaError("CODEX_INPUT_HANDLES_INVALID");
    }
    await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
    const jobStat = await fs.lstat(jobDir);
    if (!jobStat.isDirectory() || jobStat.isSymbolicLink()) {
      throw chatMediaError("CODEX_INPUT_ROOT_INVALID");
    }
    const inputRoot = path.join(jobDir, "inputs");
    await fs.mkdir(inputRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(inputRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw chatMediaError("CODEX_INPUT_ROOT_INVALID");
    }
    const frozen: FrozenCodexInputV1[] = [];
    const perInputTextBytes = Math.min(
      CODEX_TEXT_PROJECTION_MAX_BYTES,
      Math.floor(CODEX_TEXT_PROJECTION_TOTAL_BYTES / uniqueHandles.length)
    );
    try {
      for (const [index, handle] of uniqueHandles.entries()) {
        this.assertCurrent();
        const source = this.requireSource(handle);
        const materialized = await this.materialize(source);
        const inspected = await copyAndInspect(materialized, inputRoot, {
          allowUnsupportedFile: source.kind === "file"
        });
        const targetName = `input-${index + 1}-${inspected.sha256}.${inspected.extension}`;
        const targetPath = path.join(inputRoot, targetName);
        await publishFrozenInput(inspected.temporaryPath, targetPath, inspected);
        const textProjection = source.kind === "file"
          ? await freezeCodexTextProjection({
              attachment: source.attachment,
              cacheRoot: this.cache.rootDir,
              frozenRawPath: targetPath,
              inputRoot,
              inputIndex: index,
              maxBytes: perInputTextBytes
            })
          : undefined;
        frozen.push({
          schemaVersion: 1,
          handle,
          kind: source.kind,
          relativePath: path.posix.join("inputs", targetName),
          displayName: safeFrozenInputName(materialized.originalName, index, inspected.extension),
          sha256: inspected.sha256,
          sizeBytes: inspected.byteLength,
          mimeType: inspected.mimeType,
          ...(textProjection ? { textProjection } : {})
        });
      }
      this.assertCurrent();
      return frozen;
    } catch (error) {
      await fs.rm(inputRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async exportBound(input: ExportChatMediaInput): Promise<ExportedChatMedia> {
    this.assertCurrent();
    const source = this.requireSource(input.handle);
    const workbenchRoot = await resolveAgentWorkbench(this.agentWorkspace);
    const materialized = await this.materialize(source);
    this.assertCurrent();
    const inspected = await copyAndInspect(materialized, workbenchRoot, {
      allowUnsupportedFile: this.allowUnsupportedFiles && source.kind === "file"
    });
    const rootIdentity = await directoryIdentity(workbenchRoot);
    let published = false;
    try {
      this.assertCurrent();
      await assertSameDirectory(workbenchRoot, rootIdentity);
      const fileName = `${this.contentAddressedNamePrefix}-${inspected.sha256}.${inspected.extension}`;
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
    const blob = attachmentBlobRef(attachment);
    if (!blob) throw chatMediaError("CHAT_MEDIA_SOURCE_UNAVAILABLE");
    const entry = await this.cache.getEntry(blob.cacheKey);
    if (
      !entry
      || entry.sha256 !== blob.sha256
      || entry.originalSizeBytes !== blob.sizeBytes
    ) {
      throw chatMediaError("CHAT_MEDIA_SOURCE_CHANGED");
    }
    const filePath = resolveCacheEntryPath(this.cache.rootDir, entry.originalFile);
    return {
      filePath,
      maxBytes: FILE_SIZE_LIMIT_BYTES,
      expectedSha256: blob.sha256,
      expectedMimeType: blob.detectedMimeType ?? attachment.mimeType,
      originalName: attachment.name,
      kind: "file"
    };
  }

  private assertCurrent() {
    if (!this.isCurrent()) throw chatMediaError("CHAT_MEDIA_TURN_EXPIRED");
  }
}

async function copyAndInspect(
  source: MaterializedSource,
  workbenchRoot: string,
  options: { allowUnsupportedFile?: boolean } = {}
): Promise<InspectedSource> {
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
    const validated = validateDetection(
      detection,
      source,
      options.allowUnsupportedFile === true
    );
    const dimensions = validated.kind === "image"
      ? await imageDimensions(temporaryPath)
      : { width: null, height: null };
    keepTemporary = true;
    return {
      temporaryPath,
      sha256,
      byteLength,
      mimeType: validated.mimeType,
      extension: validated.extension,
      ...dimensions
    };
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
    if (!keepTemporary) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

function validateDetection(
  detection: DetectedAttachmentType,
  source: MaterializedSource,
  allowUnsupportedFile = false
) {
  if (
    detection.kind === "unsupported"
    || !detection.mimeType
    || !detection.format
    || detection.extensionMismatch
  ) {
    if (
      allowUnsupportedFile
      && source.kind === "file"
      && detection.kind === "unsupported"
      && !detection.extensionMismatch
    ) {
      return {
        kind: "unsupported" as const,
        mimeType: detection.source === "magic" && detection.mimeType
          ? detection.mimeType
          : "application/octet-stream",
        extension: detection.source === "magic" && detection.format
          ? detection.format
          : "bin"
      };
    }
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
  if (source.kind === "image" && detection.kind !== "image") {
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
  const expectedMime = normalizeMimeType(source.expectedMimeType);
  if (expectedMime && detection.mimeType !== expectedMime) {
    throw chatMediaError("CHAT_MEDIA_TYPE_INVALID");
  }
  return {
    kind: detection.kind,
    mimeType: detection.mimeType,
    extension: detection.format
  };
}

function safeContentAddressedNamePrefix(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u.test(value)) {
    throw chatMediaError("CHAT_MEDIA_PREFIX_INVALID");
  }
  return value;
}

async function publishFrozenInput(
  temporaryPath: string,
  targetPath: string,
  expected: Pick<InspectedSource, "sha256" | "byteLength">
) {
  let created = false;
  try {
    await fs.link(temporaryPath, targetPath);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
  if (created) await fs.chmod(targetPath, 0o400);
  await assertPublishedFile(targetPath, expected);
}

function safeFrozenInputName(
  originalName: string | undefined,
  index: number,
  extension: string
) {
  const cleaned = path.basename(originalName ?? "")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
    .trim();
  return cleaned.slice(0, 180) || `input-${index + 1}.${extension}`;
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
