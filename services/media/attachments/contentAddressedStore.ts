import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  AttachmentCacheError,
  AttachmentTooLargeError,
  InvalidBase64Error,
  type CompletedAttachmentPart,
  type ImportFileOptions,
  type WriteBase64Options
} from "./cacheTypes.js";
import { CacheIndexRepository } from "./cacheIndexRepository.js";
import { CacheJanitor } from "./cacheJanitor.js";

const DEFAULT_BASE64_CHUNK_CHARACTERS = 64 * 1024;

export interface ContentAddressedStoreOptions {
  repository: CacheIndexRepository;
  janitor: CacheJanitor;
  maxFileBytes: number;
}

export class ContentAddressedStore {
  private readonly repository: CacheIndexRepository;
  private readonly janitor: CacheJanitor;
  private readonly maxFileBytes: number;

  constructor(options: ContentAddressedStoreOptions) {
    this.repository = options.repository;
    this.janitor = options.janitor;
    this.maxFileBytes = options.maxFileBytes;
  }

  async writeBase64(encoded: string, options: WriteBase64Options = {}) {
    throwIfCancelled(options.signal, "write");
    await this.repository.initialize();
    throwIfCancelled(options.signal, "write");
    const maxBytes = boundedFileLimit(options.maxBytes, this.maxFileBytes);
    const layout = inspectBase64(encoded);
    if (layout.decodedBytes > maxBytes) {
      throw new AttachmentTooLargeError(maxBytes, layout.decodedBytes);
    }
    const releaseReservation = await this.janitor.reserveWriteBytes(layout.decodedBytes);
    const chunkCharacters = alignedBase64ChunkSize(options.chunkCharacters);
    const partPath = this.createPartPath();
    let fileHandle: FileHandle | undefined;

    try {
      throwIfCancelled(options.signal, "write");
      await mkdir(this.repository.temporaryDir, { recursive: true, mode: 0o700 });
      fileHandle = await open(partPath, "wx", 0o600);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      for (let offset = layout.contentOffset; offset < encoded.length; offset += chunkCharacters) {
        throwIfCancelled(options.signal, "write");
        const chunk = encoded.slice(offset, Math.min(encoded.length, offset + chunkCharacters));
        const bytes = Buffer.from(chunk, "base64");
        const expectedBytes = decodedBase64Length(chunk);
        if (bytes.length !== expectedBytes) throw new InvalidBase64Error();
        const nextSize = sizeBytes + bytes.length;
        if (nextSize > maxBytes) throw new AttachmentTooLargeError(maxBytes, nextSize);
        await this.janitor.ensureAvailableSpace(bytes.length);
        await writeAll(fileHandle, bytes);
        throwIfCancelled(options.signal, "write");
        hash.update(bytes);
        sizeBytes = nextSize;
      }

      if (sizeBytes !== layout.decodedBytes) throw new InvalidBase64Error();
      await fileHandle.close();
      fileHandle = undefined;
      throwIfCancelled(options.signal, "write");
      return await this.commitCompletedPart({
        partPath,
        sha256: hash.digest("hex"),
        sizeBytes
      }, options.retainActiveTask === true);
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await rm(partPath, { force: true }).catch(() => undefined);
      if (error instanceof AttachmentCacheError) throw error;
      if (options.signal?.aborted) {
        throw new AttachmentCacheError("cancelled", "Attachment write was cancelled.", {
          cause: error
        });
      }
      throw new AttachmentCacheError("write_failed", "Attachment cache write failed.", {
        cause: error
      });
    } finally {
      await releaseReservation();
    }
  }

  async importFile(filePath: string, options: ImportFileOptions = {}) {
    await this.repository.initialize();
    const maxBytes = boundedFileLimit(options.maxBytes, this.maxFileBytes);
    const partPath = this.createPartPath();
    let fileHandle: FileHandle | undefined;
    let sourceHandle: FileHandle | undefined;
    let sourceStream: ReturnType<FileHandle["createReadStream"]> | undefined;
    let releaseReservation: (() => Promise<void>) | undefined;
    if (options.signal?.aborted) {
      throw new AttachmentCacheError("cancelled", "Attachment import was cancelled.");
    }

    try {
      sourceHandle = await open(
        filePath,
        fsConstants.O_RDONLY | requiredNoFollowFlag()
      );
      const sourceBefore = await sourceHandle.stat({ bigint: true });
      if (!sourceBefore.isFile() || sourceBefore.nlink !== 1n) {
        throw new AttachmentCacheError("import_failed", "Attachment source is not a file.");
      }
      if (sourceBefore.size > BigInt(maxBytes)) {
        throw new AttachmentTooLargeError(maxBytes, Number(sourceBefore.size));
      }
      const expectedSize = Number(sourceBefore.size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        throw new AttachmentCacheError("import_failed", "Attachment source size is invalid.");
      }
      releaseReservation = await this.janitor.reserveWriteBytes(expectedSize);
      await mkdir(this.repository.temporaryDir, { recursive: true, mode: 0o700 });
      fileHandle = await open(partPath, "wx", 0o600);
      sourceStream = sourceHandle.createReadStream({
        autoClose: false,
        signal: options.signal
      });
      const hash = createHash("sha256");
      let sizeBytes = 0;

      for await (const value of sourceStream) {
        const bytes = typeof value === "string" ? Buffer.from(value) : value;
        const nextSize = sizeBytes + bytes.byteLength;
        if (nextSize > maxBytes) {
          sourceStream.destroy();
          throw new AttachmentTooLargeError(maxBytes, nextSize);
        }
        await this.janitor.ensureAvailableSpace(bytes.byteLength);
        await writeAll(fileHandle, bytes);
        hash.update(bytes);
        sizeBytes = nextSize;
      }

      const sourceAfter = await sourceHandle.stat({ bigint: true });
      throwIfCancelled(options.signal, "import");
      if (
        sourceBefore.dev !== sourceAfter.dev
        || sourceBefore.ino !== sourceAfter.ino
        || sourceBefore.size !== sourceAfter.size
        || sourceBefore.ctimeNs !== sourceAfter.ctimeNs
        || sourceBefore.mtimeNs !== sourceAfter.mtimeNs
        || sourceBefore.nlink !== sourceAfter.nlink
        || sizeBytes !== expectedSize
      ) {
        throw new AttachmentCacheError("import_failed", "Attachment source changed during import.");
      }
      await fileHandle.close();
      fileHandle = undefined;
      throwIfCancelled(options.signal, "import");
      return await this.commitCompletedPart({
        partPath,
        sha256: hash.digest("hex"),
        sizeBytes
      }, options.retainActiveTask === true);
    } catch (error) {
      sourceStream?.destroy();
      await fileHandle?.close().catch(() => undefined);
      await rm(partPath, { force: true }).catch(() => undefined);
      if (error instanceof AttachmentCacheError) throw error;
      if (options.signal?.aborted) {
        throw new AttachmentCacheError("cancelled", "Attachment import was cancelled.", {
          cause: error
        });
      }
      throw new AttachmentCacheError("import_failed", "Attachment import failed.", {
        cause: error
      });
    } finally {
      await sourceHandle?.close().catch(() => undefined);
      await releaseReservation?.();
    }
  }

  createPartPath() {
    return path.join(this.repository.temporaryDir, `${randomUUID()}.part`);
  }

  async commitCompletedPart(completed: CompletedAttachmentPart, retainActiveTask = false) {
    const cached = await this.repository.commitPart(completed);
    let handedOffActiveTask = false;
    try {
      await this.janitor.cleanup();
      handedOffActiveTask = retainActiveTask;
      return retainActiveTask ? { ...cached, activeTaskRetained: true as const } : cached;
    } finally {
      if (!handedOffActiveTask) await this.repository.endActiveTask(cached.sha256);
    }
  }
}

function throwIfCancelled(signal: AbortSignal | undefined, operation: "write" | "import") {
  if (!signal?.aborted) return;
  throw new AttachmentCacheError(
    "cancelled",
    `Attachment ${operation} was cancelled.`,
    { cause: signal.reason }
  );
}

function requiredNoFollowFlag() {
  const value = fsConstants.O_NOFOLLOW;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AttachmentCacheError(
      "import_failed",
      "Attachment import requires no-follow file support."
    );
  }
  return value;
}

function boundedFileLimit(value: number | undefined, fallback: number) {
  return Math.min(positiveInteger(value, fallback), fallback);
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

async function writeAll(fileHandle: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await fileHandle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new AttachmentCacheError("write_failed", "Attachment cache write made no progress.");
    }
    offset += bytesWritten;
  }
}

function inspectBase64(encoded: string) {
  let contentOffset = 0;
  if (/^data:/i.test(encoded)) {
    const comma = encoded.indexOf(",");
    if (comma < 0 || comma > 1024) throw new InvalidBase64Error();
    const header = encoded.slice(0, comma).toLowerCase();
    if (!header.includes(";base64")) throw new InvalidBase64Error();
    contentOffset = comma + 1;
  }

  const length = encoded.length - contentOffset;
  if (length % 4 !== 0) throw new InvalidBase64Error();
  let padding = 0;
  if (length > 0 && encoded.charCodeAt(encoded.length - 1) === 61) padding += 1;
  if (length > 1 && encoded.charCodeAt(encoded.length - 2) === 61) padding += 1;
  const dataEnd = encoded.length - padding;
  for (let index = contentOffset; index < dataEnd; index += 1) {
    if (!isBase64Character(encoded.charCodeAt(index))) throw new InvalidBase64Error();
  }
  for (let index = dataEnd; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) throw new InvalidBase64Error();
  }
  return { contentOffset, decodedBytes: length === 0 ? 0 : (length / 4) * 3 - padding };
}

function isBase64Character(code: number) {
  return (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 || code === 47;
}

function alignedBase64ChunkSize(value?: number) {
  const requested = positiveInteger(value, DEFAULT_BASE64_CHUNK_CHARACTERS);
  return Math.max(4, requested - (requested % 4));
}

function decodedBase64Length(value: string) {
  if (!value.length) return 0;
  let padding = 0;
  if (value.endsWith("=")) padding += 1;
  if (value.endsWith("==")) padding += 1;
  return (value.length / 4) * 3 - padding;
}
