import { createHash, randomUUID } from "node:crypto";
import { lookup as nodeLookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs as nodeStatfs,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  CACHE_MIN_FREE_BYTES,
  CACHE_UNREFERENCED_TTL_MS,
  DEFAULT_ATTACHMENT_CONNECT_TIMEOUT_MS,
  DEFAULT_ATTACHMENT_IDLE_TIMEOUT_MS,
  FILE_SIZE_LIMIT_BYTES
} from "./limits.js";

const CACHE_INDEX_VERSION = 1 as const;
const ORIGINAL_FILE_NAME = "original";
const DEFAULT_BASE64_CHUNK_CHARACTERS = 64 * 1024;
const TRASH_DIRECTORY_NAME = ".trash";
const MAX_HTTP_REDIRECTS = 5;
const DEFAULT_ATTACHMENT_FETCH = undiciFetch as unknown as typeof fetch;

export type AttachmentCacheErrorCode =
  | "cancelled"
  | "connect_timeout"
  | "download_failed"
  | "http_status"
  | "idle_timeout"
  | "import_failed"
  | "invalid_base64"
  | "invalid_cache_index"
  | "invalid_url"
  | "missing_response_body"
  | "redirect_limit"
  | "storage_exhausted"
  | "too_large"
  | "unsafe_url"
  | "write_failed";

export class AttachmentCacheError extends Error {
  constructor(
    readonly code: AttachmentCacheErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AttachmentCacheError";
  }
}

export class AttachmentTooLargeError extends AttachmentCacheError {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes?: number
  ) {
    super(
      "too_large",
      observedBytes == null
        ? `Attachment exceeds the ${maxBytes}-byte limit.`
        : `Attachment is ${observedBytes} bytes and exceeds the ${maxBytes}-byte limit.`
    );
    this.name = "AttachmentTooLargeError";
  }
}

export class InvalidBase64Error extends AttachmentCacheError {
  constructor(message = "Attachment data is not valid Base64.") {
    super("invalid_base64", message);
    this.name = "InvalidBase64Error";
  }
}

export type CacheParseStatus = "pending" | "ready" | "partial" | "failed";

export interface CacheIndexEntry {
  sha256: string;
  originalFile: string;
  originalSizeBytes: number;
  artifactsSizeBytes: number;
  lastAccessAt: string;
  parseStatus: CacheParseStatus;
  activeReferences: string[];
}

export interface CacheIndex {
  version: typeof CACHE_INDEX_VERSION;
  entries: Record<string, CacheIndexEntry>;
}

export interface CachedAttachment {
  cacheKey: string;
  sha256: string;
  sizeBytes: number;
  filePath: string;
  cacheHit: boolean;
  activeTaskRetained?: boolean;
}

export interface CacheStoreOptions {
  maxFileBytes?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  minimumFreeBytes?: number;
  unreferencedTtlMs?: number;
  allowPrivateNetwork?: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: AttachmentDnsLookup;
  statfsImpl?: AttachmentStatFs;
  now?: () => Date;
  trustedResolvedAddress?: (hostname: string, address: string) => boolean;
}

export interface AttachmentDnsLookupRecord {
  address: string;
  family: number;
}

export type AttachmentDnsLookup = (
  hostname: string
) => Promise<readonly AttachmentDnsLookupRecord[]>;

export interface AttachmentStatFsSnapshot {
  bavail: number | bigint;
  bsize: number | bigint;
}

export type AttachmentStatFs = (filePath: string) => Promise<AttachmentStatFsSnapshot>;

export interface CacheReference {
  cacheKey: string;
  reference: string;
}

export interface UpdateParseStateInput {
  parseStatus: CacheParseStatus;
  artifactsSizeBytes: number;
}

export interface CacheCleanupResult {
  removedCacheKeys: string[];
  reclaimedBytes: number;
  availableBytes: number;
}

export interface DownloadHttpOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  retainActiveTask?: boolean;
}

export interface WriteBase64Options {
  maxBytes?: number;
  chunkCharacters?: number;
  retainActiveTask?: boolean;
}

export interface ImportFileOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  retainActiveTask?: boolean;
}

interface CompletedPart {
  partPath: string;
  sha256: string;
  sizeBytes: number;
}

export class CacheStore {
  readonly rootDir: string;
  readonly indexPath: string;

  private readonly temporaryDir: string;
  private readonly trashDir: string;
  private readonly maxFileBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly minimumFreeBytes: number;
  private readonly unreferencedTtlMs: number;
  private readonly allowPrivateNetwork: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupImpl: AttachmentDnsLookup;
  private readonly statfsImpl: AttachmentStatFs;
  private readonly now: () => Date;
  private readonly trustedResolvedAddress: (hostname: string, address: string) => boolean;
  private readonly index: CacheIndex = {
    version: CACHE_INDEX_VERSION,
    entries: {}
  };
  private readonly activeTaskCounts = new Map<string, number>();
  private initialization?: Promise<void>;
  private indexQueue: Promise<void> = Promise.resolve();
  private reservationQueue: Promise<void> = Promise.resolve();
  private reservedWriteBytes = 0;

  constructor(rootDir: string, options: CacheStoreOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.indexPath = path.join(this.rootDir, "index.json");
    this.temporaryDir = path.join(this.rootDir, ".tmp");
    this.trashDir = path.join(this.rootDir, TRASH_DIRECTORY_NAME);
    this.maxFileBytes = boundedFileLimit(options.maxFileBytes, FILE_SIZE_LIMIT_BYTES);
    this.connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs,
      DEFAULT_ATTACHMENT_CONNECT_TIMEOUT_MS
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs,
      DEFAULT_ATTACHMENT_IDLE_TIMEOUT_MS
    );
    this.minimumFreeBytes = nonNegativeInteger(options.minimumFreeBytes, CACHE_MIN_FREE_BYTES);
    this.unreferencedTtlMs = nonNegativeInteger(
      options.unreferencedTtlMs,
      CACHE_UNREFERENCED_TTL_MS
    );
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
    this.fetchImpl = options.fetchImpl ?? DEFAULT_ATTACHMENT_FETCH;
    this.lookupImpl = options.lookupImpl ?? (async (hostname) =>
      nodeLookup(hostname, { all: true, verbatim: true }));
    this.statfsImpl = options.statfsImpl ?? (async (filePath) => nodeStatfs(filePath));
    this.now = options.now ?? (() => new Date());
    this.trustedResolvedAddress = options.trustedResolvedAddress ?? (() => false);
  }

  initialize() {
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  async downloadHttp(url: string, options: DownloadHttpOptions = {}) {
    await this.initialize();
    const parsedUrl = parseHttpUrl(url);
    const maxBytes = boundedFileLimit(options.maxBytes, this.maxFileBytes);
    const connectTimeoutMs = positiveInteger(options.connectTimeoutMs, this.connectTimeoutMs);
    const idleTimeoutMs = positiveInteger(options.idleTimeoutMs, this.idleTimeoutMs);
    const fetchImpl = options.fetchImpl ?? this.fetchImpl;
    const partPath = this.nextPartPath();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let fileHandle: FileHandle | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let timeoutCode: "connect_timeout" | "idle_timeout" | undefined;
    let releaseReservation: (() => Promise<void>) | undefined;
    let closeResponseTransport: (() => Promise<void>) | undefined;
    let destroyResponseTransport: (() => Promise<void>) | undefined;
    let response: Response | undefined;
    let responseTransportDestroyed = false;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);

    if (options.signal?.aborted) {
      throw new AttachmentCacheError("cancelled", "Attachment download was cancelled.");
    }
    await this.prepareForWrite(0);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const connectionTimer = setTimeout(() => {
        timeoutCode = "connect_timeout";
        controller.abort();
      }, connectTimeoutMs);

      try {
        const result = await fetchHttpWithValidatedRedirects({
          initialUrl: parsedUrl,
          fetchImpl,
          lookupImpl: this.lookupImpl,
          allowPrivateNetwork: this.allowPrivateNetwork,
          trustedResolvedAddress: this.trustedResolvedAddress,
          pinValidatedDns: fetchImpl === DEFAULT_ATTACHMENT_FETCH,
          signal: controller.signal
        });
        response = result.response;
        closeResponseTransport = result.close;
        destroyResponseTransport = result.destroy;
      } finally {
        clearTimeout(connectionTimer);
      }

      if (!response.ok) {
        throw new AttachmentCacheError(
          "http_status",
          `Attachment download returned HTTP ${response.status}.`
        );
      }

      const declaredBytes = contentLength(response.headers);
      if (declaredBytes != null && declaredBytes > maxBytes) {
        controller.abort();
        throw new AttachmentTooLargeError(maxBytes, declaredBytes);
      }
      releaseReservation = await this.reserveWriteBytes(maxBytes);
      if (!response.body) {
        throw new AttachmentCacheError(
          "missing_response_body",
          "Attachment download returned no response body."
        );
      }

      await mkdir(this.temporaryDir, { recursive: true, mode: 0o700 });
      fileHandle = await open(partPath, "wx", 0o600);
      reader = response.body.getReader();
      const hash = createHash("sha256");
      let sizeBytes = 0;

      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timeoutCode = "idle_timeout";
          controller.abort();
        }, idleTimeoutMs);
      };

      while (true) {
        armIdleTimer();
        const { done, value } = await reader.read();
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        if (done) break;
        if (!value?.byteLength) continue;

        const nextSize = sizeBytes + value.byteLength;
        if (nextSize > maxBytes) {
          controller.abort();
          throw new AttachmentTooLargeError(maxBytes, nextSize);
        }
        await this.ensureAvailableSpace(value.byteLength);
        await writeAll(fileHandle, value);
        hash.update(value);
        sizeBytes = nextSize;
      }

      await fileHandle.close();
      fileHandle = undefined;
      const completed: CompletedPart = {
        partPath,
        sha256: hash.digest("hex"),
        sizeBytes
      };
      return await this.finalizePart(completed, options.retainActiveTask === true);
    } catch (error) {
      if (idleTimer) clearTimeout(idleTimer);
      controller.abort();
      await destroyResponseTransport?.().catch(() => undefined);
      responseTransportDestroyed = true;
      await reader?.cancel().catch(() => undefined);
      if (!reader && !(error instanceof AttachmentTooLargeError)) {
        await response?.body?.cancel().catch(() => undefined);
      }
      await fileHandle?.close().catch(() => undefined);
      await rm(partPath, { force: true }).catch(() => undefined);
      if (error instanceof AttachmentCacheError) throw error;
      if (timeoutCode) {
        throw new AttachmentCacheError(
          timeoutCode,
          timeoutCode === "connect_timeout"
            ? "Attachment download connection timed out."
            : "Attachment download stopped receiving data.",
          { cause: error }
        );
      }
      if (options.signal?.aborted) {
        throw new AttachmentCacheError("cancelled", "Attachment download was cancelled.", {
          cause: error
        });
      }
      throw new AttachmentCacheError("download_failed", "Attachment download failed.", {
        cause: error
      });
    } finally {
      options.signal?.removeEventListener("abort", abortFromCaller);
      await releaseReservation?.();
      if (!responseTransportDestroyed) await closeResponseTransport?.();
    }
  }

  async writeBase64(encoded: string, options: WriteBase64Options = {}) {
    await this.initialize();
    const maxBytes = boundedFileLimit(options.maxBytes, this.maxFileBytes);
    const layout = inspectBase64(encoded);
    if (layout.decodedBytes > maxBytes) {
      throw new AttachmentTooLargeError(maxBytes, layout.decodedBytes);
    }
    const releaseReservation = await this.reserveWriteBytes(layout.decodedBytes);

    const chunkCharacters = alignedBase64ChunkSize(options.chunkCharacters);
    const partPath = this.nextPartPath();
    let fileHandle: FileHandle | undefined;

    try {
      await mkdir(this.temporaryDir, { recursive: true, mode: 0o700 });
      fileHandle = await open(partPath, "wx", 0o600);
      const hash = createHash("sha256");
      let sizeBytes = 0;

      for (
        let offset = layout.contentOffset;
        offset < encoded.length;
        offset += chunkCharacters
      ) {
        const end = Math.min(encoded.length, offset + chunkCharacters);
        const chunk = encoded.slice(offset, end);
        const bytes = Buffer.from(chunk, "base64");
        const expectedBytes = decodedBase64Length(chunk);
        if (bytes.length !== expectedBytes) {
          throw new InvalidBase64Error();
        }

        const nextSize = sizeBytes + bytes.length;
        if (nextSize > maxBytes) {
          throw new AttachmentTooLargeError(maxBytes, nextSize);
        }
        await this.ensureAvailableSpace(bytes.length);
        await writeAll(fileHandle, bytes);
        hash.update(bytes);
        sizeBytes = nextSize;
      }

      if (sizeBytes !== layout.decodedBytes) {
        throw new InvalidBase64Error();
      }
      await fileHandle.close();
      fileHandle = undefined;
      return await this.finalizePart({
        partPath,
        sha256: hash.digest("hex"),
        sizeBytes
      }, options.retainActiveTask === true);
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      await rm(partPath, { force: true }).catch(() => undefined);
      if (error instanceof AttachmentCacheError) throw error;
      throw new AttachmentCacheError("write_failed", "Attachment cache write failed.", {
        cause: error
      });
    } finally {
      await releaseReservation();
    }
  }

  async importFile(filePath: string, options: ImportFileOptions = {}) {
    await this.initialize();
    const maxBytes = boundedFileLimit(options.maxBytes, this.maxFileBytes);
    const partPath = this.nextPartPath();
    let fileHandle: FileHandle | undefined;
    let sourceStream: ReturnType<typeof createReadStream> | undefined;
    let releaseReservation: (() => Promise<void>) | undefined;

    if (options.signal?.aborted) {
      throw new AttachmentCacheError("cancelled", "Attachment import was cancelled.");
    }

    try {
      const sourceStat = await stat(filePath);
      if (!sourceStat.isFile()) {
        throw new AttachmentCacheError("import_failed", "Attachment source is not a file.");
      }
      if (sourceStat.size > maxBytes) {
        throw new AttachmentTooLargeError(maxBytes, sourceStat.size);
      }
      releaseReservation = await this.reserveWriteBytes(sourceStat.size);

      await mkdir(this.temporaryDir, { recursive: true, mode: 0o700 });
      fileHandle = await open(partPath, "wx", 0o600);
      sourceStream = createReadStream(filePath, { signal: options.signal });
      const hash = createHash("sha256");
      let sizeBytes = 0;

      for await (const value of sourceStream) {
        const bytes = typeof value === "string" ? Buffer.from(value) : value;
        const nextSize = sizeBytes + bytes.byteLength;
        if (nextSize > maxBytes) {
          sourceStream.destroy();
          throw new AttachmentTooLargeError(maxBytes, nextSize);
        }
        await this.ensureAvailableSpace(bytes.byteLength);
        await writeAll(fileHandle, bytes);
        hash.update(bytes);
        sizeBytes = nextSize;
      }

      await fileHandle.close();
      fileHandle = undefined;
      return await this.finalizePart({
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
      await releaseReservation?.();
    }
  }

  async getEntry(sha256: string) {
    await this.initialize();
    await this.indexQueue;
    const entry = this.index.entries[sha256];
    return entry ? cloneEntry(entry) : undefined;
  }

  async getIndex() {
    await this.initialize();
    await this.indexQueue;
    return cloneIndex(this.index);
  }

  async addReference(sha256: string, reference: string) {
    await this.initialize();
    return this.queueIndexMutation(async () => {
      const entry = this.requireEntry(sha256);
      if (!entry.activeReferences.includes(reference)) {
        entry.activeReferences.push(reference);
        entry.activeReferences.sort();
      }
      entry.lastAccessAt = this.now().toISOString();
      await this.writeIndexAtomically();
      return cloneEntry(entry);
    });
  }

  async removeReference(sha256: string, reference: string) {
    await this.initialize();
    return this.queueIndexMutation(async () => {
      const entry = this.requireEntry(sha256);
      entry.activeReferences = entry.activeReferences.filter((value) => value !== reference);
      entry.lastAccessAt = this.now().toISOString();
      await this.writeIndexAtomically();
      return cloneEntry(entry);
    });
  }

  async rebuildReferences(references: Iterable<CacheReference>) {
    await this.initialize();
    const rebuilt = new Map<string, Set<string>>();
    for (const value of references) {
      const cacheKey = value.cacheKey.trim();
      const reference = value.reference.trim();
      if (!cacheKey || !reference) continue;
      const values = rebuilt.get(cacheKey) ?? new Set<string>();
      values.add(reference);
      rebuilt.set(cacheKey, values);
    }

    await this.queueIndexMutation(async () => {
      for (const entry of Object.values(this.index.entries)) {
        entry.activeReferences = [...(rebuilt.get(entry.sha256) ?? [])].sort();
      }
      await this.writeIndexAtomically();
    });
    return this.cleanup();
  }

  async updateParseState(sha256: string, input: UpdateParseStateInput) {
    await this.initialize();
    if (!Number.isSafeInteger(input.artifactsSizeBytes) || input.artifactsSizeBytes < 0) {
      throw new AttachmentCacheError("write_failed", "Artifact size must be a non-negative integer.");
    }
    return this.queueIndexMutation(async () => {
      const entry = this.requireEntry(sha256);
      entry.parseStatus = input.parseStatus;
      entry.artifactsSizeBytes = input.artifactsSizeBytes;
      entry.lastAccessAt = this.now().toISOString();
      await this.writeIndexAtomically();
      return cloneEntry(entry);
    });
  }

  async beginActiveTask(sha256: string) {
    await this.initialize();
    return this.queueIndexMutation(async () => {
      this.requireEntry(sha256);
      this.incrementActiveTask(sha256);
    });
  }

  async endActiveTask(sha256: string) {
    await this.initialize();
    return this.queueIndexMutation(async () => {
      this.decrementActiveTask(sha256);
    });
  }

  async reserveArtifactBytes(requiredBytes: number) {
    await this.initialize();
    return this.reserveWriteBytes(requiredBytes);
  }

  async cleanup(): Promise<CacheCleanupResult> {
    await this.initialize();
    return this.queueIndexMutation(() => this.cleanupUnlocked());
  }

  private async initializeOnce() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700).catch(() => undefined);
    await mkdir(this.temporaryDir, { recursive: true, mode: 0o700 });
    await chmod(this.temporaryDir, 0o700).catch(() => undefined);
    await this.cleanupPartFiles();
    await mkdir(this.trashDir, { recursive: true, mode: 0o700 });
    await chmod(this.trashDir, 0o700).catch(() => undefined);

    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = parseIndex(raw);
      this.index.entries = parsed.entries;
      await chmod(this.indexPath, 0o600).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof AttachmentCacheError) throw error;
        throw new AttachmentCacheError("invalid_cache_index", "Attachment cache index is invalid.", {
          cause: error
        });
      }
    }
    await this.recoverTrashEntries();
    await this.cleanupOrphanEntryDirectories();
    await this.reconcileArtifactSizes();
  }

  private async cleanupPartFiles() {
    const entries = await readdir(this.temporaryDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
      .map((entry) => rm(path.join(this.temporaryDir, entry.name), { force: true })));
  }

  private async recoverTrashEntries() {
    const entries = await readdir(this.trashDir, { withFileTypes: true });
    for (const entry of entries) {
      const trashPath = path.join(this.trashDir, entry.name);
      const sha256 = entry.name.slice(0, 64);
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(sha256) || !this.index.entries[sha256]) {
        await rm(trashPath, { recursive: true, force: true });
        continue;
      }

      const entryDir = path.join(this.rootDir, sha256);
      try {
        await stat(entryDir);
        await rm(trashPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(trashPath, entryDir);
      }
    }
  }

  private async cleanupOrphanEntryDirectories() {
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    await Promise.all(entries.flatMap((entry) => {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) return [];
      if (this.index.entries[entry.name]) return [];
      return [rm(path.join(this.rootDir, entry.name), { recursive: true, force: true })];
    }));
  }

  private async reconcileArtifactSizes() {
    let changed = false;
    for (const entry of Object.values(this.index.entries)) {
      const artifactsSizeBytes = await directorySizeOrZero(path.join(
        this.rootDir,
        entry.sha256,
        "artifacts"
      ));
      if (entry.artifactsSizeBytes === artifactsSizeBytes) continue;
      entry.artifactsSizeBytes = artifactsSizeBytes;
      changed = true;
    }
    if (changed) await this.writeIndexAtomically();
  }

  private nextPartPath() {
    return path.join(this.temporaryDir, `${randomUUID()}.part`);
  }

  private async commitPart(completed: CompletedPart): Promise<CachedAttachment> {
    return this.queueIndexMutation(async () => {
      const entryDir = path.join(this.rootDir, completed.sha256);
      const filePath = path.join(entryDir, ORIGINAL_FILE_NAME);
      const originalFile = path.relative(this.rootDir, filePath);
      let cacheHit = false;

      await mkdir(entryDir, { recursive: true, mode: 0o700 });
      await chmod(entryDir, 0o700).catch(() => undefined);
      try {
        const existing = await stat(filePath);
        if (existing.isFile() && existing.size === completed.sizeBytes) {
          cacheHit = true;
          await rm(completed.partPath, { force: true });
        } else {
          await rename(completed.partPath, filePath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(completed.partPath, filePath);
      }

      const previous = this.index.entries[completed.sha256];
      this.index.entries[completed.sha256] = {
        sha256: completed.sha256,
        originalFile,
        originalSizeBytes: completed.sizeBytes,
        artifactsSizeBytes: previous?.artifactsSizeBytes ?? 0,
        lastAccessAt: this.now().toISOString(),
        parseStatus: previous?.parseStatus ?? "pending",
        activeReferences: previous?.activeReferences.slice().sort() ?? []
      };
      try {
        await this.writeIndexAtomically();
      } catch (error) {
        if (previous) this.index.entries[completed.sha256] = previous;
        else {
          delete this.index.entries[completed.sha256];
          await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
      }
      this.incrementActiveTask(completed.sha256);

      return {
        cacheKey: completed.sha256,
        sha256: completed.sha256,
        sizeBytes: completed.sizeBytes,
        filePath,
        cacheHit
      };
    }).catch(async (error) => {
      await rm(completed.partPath, { force: true }).catch(() => undefined);
      if (error instanceof AttachmentCacheError) throw error;
      throw new AttachmentCacheError("write_failed", "Attachment cache write failed.", {
        cause: error
      });
    });
  }

  private async finalizePart(completed: CompletedPart, retainActiveTask = false) {
    const cached = await this.commitPart(completed);
    try {
      await this.cleanup();
      return retainActiveTask
        ? { ...cached, activeTaskRetained: true as const }
        : cached;
    } finally {
      if (!retainActiveTask) await this.endActiveTask(cached.sha256);
    }
  }

  private async prepareForWrite(requiredBytes: number) {
    await this.cleanupForTarget(this.minimumFreeBytes + requiredBytes);
    await this.assertAvailableSpace(requiredBytes);
  }

  private reserveWriteBytes(requiredBytes: number) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > this.maxFileBytes) {
      throw new AttachmentTooLargeError(this.maxFileBytes, requiredBytes);
    }
    return this.queueReservation(async () => {
      const target = this.minimumFreeBytes + this.reservedWriteBytes + requiredBytes;
      await this.cleanupForTarget(target);
      const availableBytes = await this.readAvailableBytes();
      if (availableBytes < target) {
        throw new AttachmentCacheError(
          "storage_exhausted",
          "Attachment cache does not have enough free disk space."
        );
      }
      this.reservedWriteBytes += requiredBytes;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await this.queueReservation(async () => {
          this.reservedWriteBytes = Math.max(0, this.reservedWriteBytes - requiredBytes);
        });
      };
    });
  }

  private async ensureAvailableSpace(requiredBytes: number) {
    const availableBytes = await this.readAvailableBytes();
    if (hasSafeWriteSpace(availableBytes, this.minimumFreeBytes, requiredBytes)) return;
    await this.cleanupForTarget(this.minimumFreeBytes + requiredBytes);
    await this.assertAvailableSpace(requiredBytes);
  }

  private async cleanupForTarget(targetFreeBytes: number) {
    await this.initialize();
    return this.queueIndexMutation(() => this.cleanupUnlocked(targetFreeBytes));
  }

  private async assertAvailableSpace(requiredBytes: number) {
    const availableBytes = await this.readAvailableBytes();
    if (hasSafeWriteSpace(availableBytes, this.minimumFreeBytes, requiredBytes)) return;
    throw new AttachmentCacheError(
      "storage_exhausted",
      "Attachment cache does not have enough free disk space."
    );
  }

  private async cleanupUnlocked(
    targetFreeBytes = this.minimumFreeBytes
  ): Promise<CacheCleanupResult> {
    const removedCacheKeys: string[] = [];
    let reclaimedBytes = 0;
    const now = this.now().getTime();
    const expired = this.reclaimableEntries().filter((entry) =>
      now - accessTimestamp(entry.lastAccessAt) > this.unreferencedTtlMs);

    for (const entry of expired) {
      const reclaimed = await this.removeEntryAtomically(entry.sha256);
      if (reclaimed == null) continue;
      removedCacheKeys.push(entry.sha256);
      reclaimedBytes += reclaimed;
    }

    let availableBytes = await this.readAvailableBytes();
    for (const entry of this.reclaimableEntries()) {
      if (availableBytes >= targetFreeBytes) break;
      const reclaimed = await this.removeEntryAtomically(entry.sha256);
      if (reclaimed == null) continue;
      removedCacheKeys.push(entry.sha256);
      reclaimedBytes += reclaimed;
      availableBytes = await this.readAvailableBytes();
    }

    return {
      removedCacheKeys,
      reclaimedBytes,
      availableBytes
    };
  }

  private reclaimableEntries() {
    return Object.values(this.index.entries)
      .filter((entry) => entry.activeReferences.length === 0)
      .filter((entry) => !this.activeTaskCounts.has(entry.sha256))
      .sort(compareCacheEntries);
  }

  private async removeEntryAtomically(sha256: string) {
    const entry = this.index.entries[sha256];
    if (!entry || entry.activeReferences.length || this.activeTaskCounts.has(sha256)) {
      return undefined;
    }

    const entryDir = path.join(this.rootDir, sha256);
    const trashPath = path.join(this.trashDir, `${sha256}-${randomUUID()}`);
    const snapshot = cloneEntry(entry);
    let moved = false;
    await mkdir(this.trashDir, { recursive: true, mode: 0o700 });

    try {
      await rename(entryDir, trashPath);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    delete this.index.entries[sha256];
    try {
      await this.writeIndexAtomically();
    } catch (error) {
      this.index.entries[sha256] = snapshot;
      if (moved) {
        await rename(trashPath, entryDir).catch(() => undefined);
      }
      throw error;
    }

    if (moved) {
      await rm(trashPath, { recursive: true, force: true });
    }
    return snapshot.originalSizeBytes + snapshot.artifactsSizeBytes;
  }

  private async readAvailableBytes() {
    try {
      const value = await this.statfsImpl(this.rootDir);
      return availableBytesFromStatFs(value);
    } catch (error) {
      if (error instanceof AttachmentCacheError) throw error;
      throw new AttachmentCacheError(
        "storage_exhausted",
        "Attachment cache free space could not be inspected.",
        { cause: error }
      );
    }
  }

  private incrementActiveTask(sha256: string) {
    this.activeTaskCounts.set(sha256, (this.activeTaskCounts.get(sha256) ?? 0) + 1);
  }

  private decrementActiveTask(sha256: string) {
    const count = this.activeTaskCounts.get(sha256) ?? 0;
    if (count <= 1) this.activeTaskCounts.delete(sha256);
    else this.activeTaskCounts.set(sha256, count - 1);
  }

  private queueIndexMutation<T>(mutation: () => Promise<T>) {
    const result = this.indexQueue.then(mutation, mutation);
    this.indexQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private queueReservation<T>(operation: () => Promise<T>) {
    const result = this.reservationQueue.then(operation, operation);
    this.reservationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireEntry(sha256: string) {
    const entry = this.index.entries[sha256];
    if (!entry) {
      throw new AttachmentCacheError("write_failed", `Unknown attachment cache key: ${sha256}`);
    }
    return entry;
  }

  private async writeIndexAtomically() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.rootDir, `.index-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(this.index, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await rename(temporaryPath, this.indexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function downloadHttpToCache(
  store: CacheStore,
  url: string,
  options: DownloadHttpOptions = {}
) {
  return store.downloadHttp(url, options);
}

export function writeBase64ToCache(
  store: CacheStore,
  encoded: string,
  options: WriteBase64Options = {}
) {
  return store.writeBase64(encoded, options);
}

export function importFileToCache(
  store: CacheStore,
  filePath: string,
  options: ImportFileOptions = {}
) {
  return store.importFile(filePath, options);
}

function parseHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return parsed;
  } catch {
    throw new AttachmentCacheError("invalid_url", "Attachment URL must use HTTP or HTTPS.");
  }
}

interface ValidatedHttpFetchInput {
  initialUrl: URL;
  fetchImpl: typeof fetch;
  lookupImpl: AttachmentDnsLookup;
  allowPrivateNetwork: boolean;
  trustedResolvedAddress: (hostname: string, address: string) => boolean;
  pinValidatedDns: boolean;
  signal: AbortSignal;
}

async function fetchHttpWithValidatedRedirects(input: ValidatedHttpFetchInput) {
  let currentUrl = input.initialUrl;
  let followedRedirects = 0;

  while (true) {
    const validatedAddresses = await validateHttpTarget(
      currentUrl,
      input.lookupImpl,
      input.allowPrivateNetwork,
      input.trustedResolvedAddress,
      input.pinValidatedDns
    );
    const dispatcher = input.pinValidatedDns && validatedAddresses.length
      ? new Agent({ connect: { lookup: pinnedLookup(validatedAddresses) } })
      : undefined;
    let response: Response;
    try {
      response = await input.fetchImpl(currentUrl, {
        redirect: "manual",
        signal: input.signal,
        ...(dispatcher ? { dispatcher } : {})
      } as RequestInit);
    } catch (error) {
      await dispatcher?.destroy().catch(() => undefined);
      throw error;
    }
    const location = response.headers.get("location");
    if (!location || !isFollowableRedirect(response.status)) {
      return {
        response,
        close: async () => {
          await dispatcher?.close();
        },
        destroy: async () => {
          await dispatcher?.destroy();
        }
      };
    }

    await dispatcher?.destroy().catch(() => undefined);
    await cancelResponseBody(response);
    if (followedRedirects >= MAX_HTTP_REDIRECTS) {
      throw new AttachmentCacheError(
        "redirect_limit",
        `Attachment download exceeded ${MAX_HTTP_REDIRECTS} redirects.`
      );
    }

    try {
      currentUrl = parseHttpUrl(new URL(location, currentUrl).href);
    } catch (error) {
      if (error instanceof AttachmentCacheError) throw error;
      throw new AttachmentCacheError("invalid_url", "Attachment redirect URL is invalid.", {
        cause: error
      });
    }
    followedRedirects += 1;
  }
}

async function validateHttpTarget(
  url: URL,
  lookupImpl: AttachmentDnsLookup,
  allowPrivateNetwork: boolean,
  trustedResolvedAddress: (hostname: string, address: string) => boolean,
  pinValidatedDns: boolean
) {
  if (allowPrivateNetwork && !pinValidatedDns) return [];
  if (url.username || url.password) {
    throw unsafeAttachmentUrl();
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || (!allowPrivateNetwork && isLocalHostname(hostname))) {
    throw unsafeAttachmentUrl();
  }
  if (isIP(hostname)) {
    if (!allowPrivateNetwork && !isPublicIpAddress(hostname)) throw unsafeAttachmentUrl();
    return [{ address: hostname, family: isIP(hostname) }];
  }

  let addresses: readonly AttachmentDnsLookupRecord[];
  try {
    addresses = await lookupImpl(hostname);
  } catch (error) {
    throw unsafeAttachmentUrl(error);
  }
  if (
    !addresses.length ||
    (!allowPrivateNetwork && addresses.some(({ address }) =>
      !isPublicIpAddress(address) && !trustedResolvedAddress(hostname, address)))
  ) {
    throw unsafeAttachmentUrl();
  }
  return addresses.slice();
}

function pinnedLookup(addresses: readonly AttachmentDnsLookupRecord[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6
      ? options.family
      : undefined;
    const matching = requestedFamily
      ? addresses.filter(({ family }) => family === requestedFamily)
      : addresses.slice();
    const selected = matching.length ? matching : addresses;
    if (options.all) {
      callback(null, selected.map(({ address, family }) => ({ address, family })));
      return;
    }
    const first = selected[0];
    if (!first) {
      callback(Object.assign(new Error("No validated attachment address is available."), {
        code: "ENOTFOUND"
      }), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function isFollowableRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelResponseBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

function unsafeAttachmentUrl(cause?: unknown) {
  return new AttachmentCacheError(
    "unsafe_url",
    "Attachment URL must resolve only to public network addresses.",
    cause === undefined ? undefined : { cause }
  );
}

function normalizeHostname(hostname: string) {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function isLocalHostname(hostname: string) {
  return hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain" ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    hostname === "internal" ||
    hostname.endsWith(".internal") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa");
}

function isPublicIpAddress(address: string) {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4Address(normalized);
  if (family === 6) return isPublicIpv6Address(normalized);
  return false;
}

function isPublicIpv4Address(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) =>
    !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [first, second, third] = octets as [number, number, number, number];

  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6Address(address: string) {
  const value = parseIpv6Address(address);
  if (value == null || !matchesIpv6Prefix(value, IPV6_GLOBAL_UNICAST_PREFIX, 3)) return false;
  return !BLOCKED_IPV6_PREFIXES.some(([prefix, length]) =>
    matchesIpv6Prefix(value, prefix, length));
}

function parseIpv6Address(address: string) {
  if (address.includes("%")) return undefined;
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  const possibleIpv4 = normalized.slice(lastColon + 1);
  if (possibleIpv4.includes(".")) {
    const octets = possibleIpv4.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) =>
      !Number.isInteger(value) || value < 0 || value > 255)) return undefined;
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    normalized = `${normalized.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const compressed = normalized.split("::");
  if (compressed.length > 2) return undefined;
  const left = parseIpv6Segments(compressed[0]!);
  const right = compressed.length === 2 ? parseIpv6Segments(compressed[1]!) : [];
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((compressed.length === 1 && missing !== 0) || (compressed.length === 2 && missing < 1)) {
    return undefined;
  }
  const segments = compressed.length === 2
    ? [...left, ...Array<number>(missing).fill(0), ...right]
    : left;
  if (segments.length !== 8) return undefined;
  return segments.reduce((value, segment) => (value << 16n) | BigInt(segment), 0n);
}

function parseIpv6Segments(value: string) {
  if (!value) return [];
  const segments = value.split(":");
  if (segments.some((segment) => !/^[a-f0-9]{1,4}$/.test(segment))) return undefined;
  return segments.map((segment) => Number.parseInt(segment, 16));
}

function matchesIpv6Prefix(value: bigint, prefix: bigint, length: number) {
  const shift = BigInt(128 - length);
  return value >> shift === prefix >> shift;
}

function requiredIpv6Address(value: string) {
  const parsed = parseIpv6Address(value);
  if (parsed == null) throw new Error(`Invalid built-in IPv6 prefix: ${value}`);
  return parsed;
}

const IPV6_GLOBAL_UNICAST_PREFIX = requiredIpv6Address("2000::");
const BLOCKED_IPV6_PREFIXES: ReadonlyArray<readonly [bigint, number]> = [
  [requiredIpv6Address("2001::"), 23],
  [requiredIpv6Address("2001:db8::"), 32],
  [requiredIpv6Address("2002::"), 16],
  [requiredIpv6Address("3fff::"), 20]
];

function contentLength(headers: Headers) {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function directorySizeOrZero(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySizeOrZero(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function boundedFileLimit(value: number | undefined, fallback: number) {
  return Math.min(positiveInteger(value, fallback), fallback, FILE_SIZE_LIMIT_BYTES);
}

function hasSafeWriteSpace(
  availableBytes: number,
  minimumFreeBytes: number,
  requiredBytes: number
) {
  return availableBytes >= minimumFreeBytes + requiredBytes;
}

function availableBytesFromStatFs(value: AttachmentStatFsSnapshot) {
  const availableBlocks = nonNegativeBigInt(value.bavail);
  const blockSize = nonNegativeBigInt(value.bsize);
  const availableBytes = availableBlocks * blockSize;
  return availableBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(availableBytes);
}

function nonNegativeBigInt(value: number | bigint) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("Negative statfs value.");
    return value;
  }
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid statfs value.");
  return BigInt(Math.floor(value));
}

function accessTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareCacheEntries(left: CacheIndexEntry, right: CacheIndexEntry) {
  return accessTimestamp(left.lastAccessAt) - accessTimestamp(right.lastAccessAt) ||
    left.sha256.localeCompare(right.sha256);
}

async function writeAll(fileHandle: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await fileHandle.write(
      bytes,
      offset,
      bytes.byteLength - offset
    );
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

  const decodedBytes = length === 0 ? 0 : (length / 4) * 3 - padding;
  return { contentOffset, decodedBytes };
}

function isBase64Character(code: number) {
  return (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47;
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

function parseIndex(raw: string): CacheIndex {
  const parsed = JSON.parse(raw) as Partial<CacheIndex>;
  if (parsed.version !== CACHE_INDEX_VERSION || !isRecord(parsed.entries)) {
    throw new AttachmentCacheError("invalid_cache_index", "Attachment cache index is invalid.");
  }

  const entries: Record<string, CacheIndexEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!isCacheIndexEntry(value) || value.sha256 !== key) {
      throw new AttachmentCacheError("invalid_cache_index", "Attachment cache index is invalid.");
    }
    entries[key] = cloneEntry(value);
  }
  return { version: CACHE_INDEX_VERSION, entries };
}

function isCacheIndexEntry(value: unknown): value is CacheIndexEntry {
  if (!isRecord(value)) return false;
  return typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.originalFile === "string" &&
    typeof value.originalSizeBytes === "number" &&
    typeof value.artifactsSizeBytes === "number" &&
    typeof value.lastAccessAt === "string" &&
    (value.parseStatus === "pending" || value.parseStatus === "ready" ||
      value.parseStatus === "partial" || value.parseStatus === "failed") &&
    Array.isArray(value.activeReferences) &&
    value.activeReferences.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneEntry(entry: CacheIndexEntry): CacheIndexEntry {
  return {
    ...entry,
    activeReferences: entry.activeReferences.slice()
  };
}

function cloneIndex(index: CacheIndex): CacheIndex {
  return {
    version: CACHE_INDEX_VERSION,
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([key, entry]) => [key, cloneEntry(entry)])
    )
  };
}
