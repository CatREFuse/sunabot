export const CACHE_INDEX_VERSION = 1 as const;

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

export interface CompletedAttachmentPart {
  partPath: string;
  sha256: string;
  sizeBytes: number;
}
