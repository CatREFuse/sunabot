import { createHash } from "node:crypto";
import { lookup as nodeLookup } from "node:dns/promises";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  AttachmentCacheError,
  AttachmentTooLargeError,
  type AttachmentDnsLookup,
  type AttachmentDnsLookupRecord,
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
  allowPrivateNetwork: boolean;
  fetchImpl?: typeof fetch;
  lookupImpl?: AttachmentDnsLookup;
  trustedResolvedAddress?: (hostname: string, address: string) => boolean;
}

export class AttachmentFetcher {
  private readonly repository: CacheIndexRepository;
  private readonly janitor: CacheJanitor;
  private readonly contentStore: ContentAddressedStore;
  private readonly maxFileBytes: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly allowPrivateNetwork: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupImpl: AttachmentDnsLookup;
  private readonly trustedResolvedAddress: (hostname: string, address: string) => boolean;

  constructor(options: AttachmentFetcherOptions) {
    this.repository = options.repository;
    this.janitor = options.janitor;
    this.contentStore = options.contentStore;
    this.maxFileBytes = options.maxFileBytes;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.allowPrivateNetwork = options.allowPrivateNetwork;
    this.fetchImpl = options.fetchImpl ?? DEFAULT_ATTACHMENT_FETCH;
    this.lookupImpl = options.lookupImpl ?? (async (hostname) =>
      nodeLookup(hostname, { all: true, verbatim: true }));
    this.trustedResolvedAddress = options.trustedResolvedAddress ?? (() => false);
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
        close: async () => { await dispatcher?.close(); },
        destroy: async () => { await dispatcher?.destroy(); }
      };
    }

    await dispatcher?.destroy().catch(() => undefined);
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

async function validateHttpTarget(
  url: URL,
  lookupImpl: AttachmentDnsLookup,
  allowPrivateNetwork: boolean,
  trustedResolvedAddress: (hostname: string, address: string) => boolean,
  pinValidatedDns: boolean
) {
  if (allowPrivateNetwork && !pinValidatedDns) return [];
  if (url.username || url.password) throw unsafeAttachmentUrl();
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
