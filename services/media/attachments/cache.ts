import { statfs as nodeStatfs } from "node:fs/promises";
import path from "node:path";
import {
  CACHE_MIN_FREE_BYTES,
  CACHE_UNREFERENCED_TTL_MS,
  DEFAULT_ATTACHMENT_CONNECT_TIMEOUT_MS,
  DEFAULT_ATTACHMENT_IDLE_TIMEOUT_MS,
  FILE_SIZE_LIMIT_BYTES
} from "./limits.js";
import { AttachmentFetcher } from "./attachmentFetcher.js";
import { CacheIndexRepository } from "./cacheIndexRepository.js";
import { CacheJanitor } from "./cacheJanitor.js";
import { ContentAddressedStore } from "./contentAddressedStore.js";
import type {
  CacheReference,
  CacheStoreOptions,
  DownloadHttpOptions,
  ImportFileOptions,
  UpdateParseStateInput,
  WriteBase64Options
} from "./cacheTypes.js";

export * from "./cacheTypes.js";
export { AttachmentFetcher } from "./attachmentFetcher.js";
export { CacheIndexRepository } from "./cacheIndexRepository.js";
export { CacheJanitor } from "./cacheJanitor.js";
export { ContentAddressedStore } from "./contentAddressedStore.js";

export class CacheStore {
  readonly rootDir: string;
  readonly indexPath: string;
  readonly indexRepository: CacheIndexRepository;
  readonly janitor: CacheJanitor;
  readonly contentStore: ContentAddressedStore;
  readonly fetcher: AttachmentFetcher;

  constructor(rootDir: string, options: CacheStoreOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    const maxFileBytes = boundedFileLimit(options.maxFileBytes, FILE_SIZE_LIMIT_BYTES);
    const minimumFreeBytes = nonNegativeInteger(options.minimumFreeBytes, CACHE_MIN_FREE_BYTES);
    const unreferencedTtlMs = nonNegativeInteger(
      options.unreferencedTtlMs,
      CACHE_UNREFERENCED_TTL_MS
    );
    const now = options.now ?? (() => new Date());
    this.indexRepository = new CacheIndexRepository(this.rootDir, now);
    this.indexPath = this.indexRepository.indexPath;
    this.janitor = new CacheJanitor({
      repository: this.indexRepository,
      maxFileBytes,
      minimumFreeBytes,
      unreferencedTtlMs,
      statfsImpl: options.statfsImpl ?? (async (filePath) => nodeStatfs(filePath)),
      now
    });
    this.contentStore = new ContentAddressedStore({
      repository: this.indexRepository,
      janitor: this.janitor,
      maxFileBytes
    });
    this.fetcher = new AttachmentFetcher({
      repository: this.indexRepository,
      janitor: this.janitor,
      contentStore: this.contentStore,
      maxFileBytes,
      connectTimeoutMs: positiveInteger(
        options.connectTimeoutMs,
        DEFAULT_ATTACHMENT_CONNECT_TIMEOUT_MS
      ),
      idleTimeoutMs: positiveInteger(
        options.idleTimeoutMs,
        DEFAULT_ATTACHMENT_IDLE_TIMEOUT_MS
      ),
      allowPrivateNetwork: options.allowPrivateNetwork === true,
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
      trustedResolvedAddress: options.trustedResolvedAddress
    });
  }

  initialize() {
    return this.indexRepository.initialize();
  }

  downloadHttp(url: string, options: DownloadHttpOptions = {}) {
    return this.fetcher.downloadHttp(url, options);
  }

  writeBase64(encoded: string, options: WriteBase64Options = {}) {
    return this.contentStore.writeBase64(encoded, options);
  }

  importFile(filePath: string, options: ImportFileOptions = {}) {
    return this.contentStore.importFile(filePath, options);
  }

  getEntry(sha256: string) {
    return this.indexRepository.getEntry(sha256);
  }

  getIndex() {
    return this.indexRepository.getIndex();
  }

  addReference(sha256: string, reference: string) {
    return this.indexRepository.addReference(sha256, reference);
  }

  removeReference(sha256: string, reference: string) {
    return this.indexRepository.removeReference(sha256, reference);
  }

  async rebuildReferences(references: Iterable<CacheReference>) {
    await this.indexRepository.rebuildReferences(references);
    return this.janitor.cleanup();
  }

  updateParseState(sha256: string, input: UpdateParseStateInput) {
    return this.indexRepository.updateParseState(sha256, input);
  }

  beginActiveTask(sha256: string) {
    return this.indexRepository.beginActiveTask(sha256);
  }

  endActiveTask(sha256: string) {
    return this.indexRepository.endActiveTask(sha256);
  }

  reserveArtifactBytes(requiredBytes: number) {
    return this.janitor.reserveArtifactBytes(requiredBytes);
  }

  cleanup() {
    return this.janitor.cleanup();
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

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function boundedFileLimit(value: number | undefined, fallback: number) {
  return Math.min(positiveInteger(value, fallback), fallback, FILE_SIZE_LIMIT_BYTES);
}
