import { createHash } from "node:crypto";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { fetch as undiciFetch } from "undici";
import {
  AttachmentCacheError,
  AttachmentTooLargeError,
  type DownloadHttpOptions
} from "./cacheTypes.js";
import { CacheIndexRepository } from "./cacheIndexRepository.js";
import { CacheJanitor } from "./cacheJanitor.js";
import { ContentAddressedStore } from "./contentAddressedStore.js";

const MAX_HTTP_REDIRECTS = 5;
const DEFAULT_ATTACHMENT_FETCH = undiciFetch as unknown as typeof fetch;

export interface AttachmentFetcherOptions {
  repository: CacheIndexRepository;
  janitor: CacheJanitor;
  contentStore: ContentAddressedStore;
  maxFileBytes: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class AttachmentFetcher {
  private readonly repository: CacheIndexRepository;
  private readonly janitor: CacheJanitor;
  private readonly contentStore: ContentAddressedStore;
  private readonly maxFileBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AttachmentFetcherOptions) {
    this.repository = options.repository;
    this.janitor = options.janitor;
    this.contentStore = options.contentStore;
    this.maxFileBytes = options.maxFileBytes;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? DEFAULT_ATTACHMENT_FETCH;
  }

  async downloadHttp(url: string, options: DownloadHttpOptions = {}) {
    await this.repository.initialize();
    const parsedUrl = parseHttpUrl(url);
    const maxBytes = boundedFileLimit(options.maxBytes, this.maxFileBytes);
    const connectTimeoutMs = positiveInteger(options.connectTimeoutMs, this.connectTimeoutMs);
    const idleTimeoutMs = positiveInteger(options.idleTimeoutMs, this.idleTimeoutMs);
    const fetchImpl = options.fetchImpl ?? this.fetchImpl;
    const partPath = this.contentStore.createPartPath();
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
    await this.janitor.prepareForWrite(0);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const connectionTimer = setTimeout(() => {
        timeoutCode = "connect_timeout";
        controller.abort();
      }, connectTimeoutMs);
      try {
        const result = await fetchHttpWithRedirects({
          initialUrl: parsedUrl,
          fetchImpl,
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
      releaseReservation = await this.janitor.reserveWriteBytes(maxBytes);
      if (!response.body) {
        throw new AttachmentCacheError(
          "missing_response_body",
          "Attachment download returned no response body."
        );
      }

      await mkdir(this.repository.temporaryDir, { recursive: true, mode: 0o700 });
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
        await this.janitor.ensureAvailableSpace(value.byteLength);
        await writeAll(fileHandle, value);
        hash.update(value);
        sizeBytes = nextSize;
      }

      await fileHandle.close();
      fileHandle = undefined;
      return await this.contentStore.commitCompletedPart({
        partPath,
        sha256: hash.digest("hex"),
        sizeBytes
      }, options.retainActiveTask === true);
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
}

interface HttpFetchInput {
  initialUrl: URL;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}

async function fetchHttpWithRedirects(input: HttpFetchInput) {
  let currentUrl = input.initialUrl;
  let followedRedirects = 0;
  while (true) {
    const response = await input.fetchImpl(currentUrl, {
      redirect: "manual",
      signal: input.signal
    });
    const location = response.headers.get("location");
    if (!location || !isFollowableRedirect(response.status)) {
      return {
        response,
        close: async () => undefined,
        destroy: async () => undefined
      };
    }

    await response.body?.cancel().catch(() => undefined);
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

function parseHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return parsed;
  } catch {
    throw new AttachmentCacheError("invalid_url", "Attachment URL must use HTTP or HTTPS.");
  }
}

function isFollowableRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}


function contentLength(headers: Headers) {
  const value = headers.get("content-length")?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function boundedFileLimit(value: number | undefined, fallback: number) {
  return Math.min(positiveInteger(value, fallback), fallback);
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
