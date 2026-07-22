import http from "node:http";
import https from "node:https";
import { Transform, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { WebFetchError } from "../../services/webfetch/contracts.js";
import {
  resolvePublicWebTarget,
  normalizedHostname,
  type ResolvedPublicTarget,
  type WebFetchDnsLookup
} from "./urlPolicy.js";

export const WEBFETCH_STATIC_TIMEOUT_MS = 90_000;
export const WEBFETCH_CONNECT_TIMEOUT_MS = 10_000;
export const WEBFETCH_CONNECT_RETRY_COUNT = 3;
export const WEBFETCH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const WEBFETCH_MAX_REDIRECTS = 5;

export interface SafeHtmlResult {
  html: string;
  finalUrl: string;
  status: number;
}

export interface SafeHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
}

export type PinnedRequest = (
  target: ResolvedPublicTarget,
  signal: AbortSignal
) => Promise<SafeHttpResponse>;

export interface SafeHtmlFetchOptions {
  signal?: AbortSignal;
  lookup?: WebFetchDnsLookup;
  request?: PinnedRequest;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function fetchSafeHtml(input: string, options: SafeHtmlFetchOptions = {}): Promise<SafeHtmlResult> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? WEBFETCH_STATIC_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let current = input;
  const request = options.request ?? requestPinnedTarget;
  try {
    for (let redirect = 0; redirect <= WEBFETCH_MAX_REDIRECTS; redirect += 1) {
      const target = await resolvePublicWebTarget(current, options.lookup, signal);
      const response = await requestWithRetries(target, signal, request);
      if (isRedirect(response.status)) {
        response.body.destroy();
        const location = firstHeader(response.headers.location);
        if (!location || redirect === WEBFETCH_MAX_REDIRECTS) {
          throw new WebFetchError("URL_NOT_ALLOWED", "Redirect limit exceeded.");
        }
        try {
          current = new URL(location, target.url).href;
        } catch {
          throw new WebFetchError("URL_NOT_ALLOWED", "Redirect URL is invalid.");
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.body.destroy();
        throw new WebFetchError("CONTENT_EXTRACTION_FAILED", "HTTP response was unsuccessful.");
      }
      const contentType = firstHeader(response.headers["content-type"]).toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) {
        response.body.destroy();
        throw new WebFetchError("UNSUPPORTED_CONTENT_TYPE", "Response is not HTML.");
      }
      if (/^\s*attachment(?:;|$)/i.test(firstHeader(response.headers["content-disposition"]))) {
        response.body.destroy();
        throw new WebFetchError("UNSUPPORTED_CONTENT_TYPE", "HTML attachments are not supported.");
      }
      const bytes = await readBoundedBytes(
        decodeBody(response.body, firstHeader(response.headers["content-encoding"])),
        options.maxBytes ?? WEBFETCH_MAX_RESPONSE_BYTES,
        signal
      );
      const html = decodeHtml(bytes, contentType);
      return { html, finalUrl: target.url.href, status: response.status };
    }
  } catch (error) {
    if (error instanceof WebFetchError) throw error;
    if (signal.aborted || isTimeoutError(error)) throw new WebFetchError("FETCH_TIMEOUT", "Fetch timed out.");
    throw new WebFetchError("CONTENT_EXTRACTION_FAILED", "Fetch failed.");
  }
  throw new WebFetchError("CONTENT_EXTRACTION_FAILED", "Fetch failed.");
}

async function requestWithRetries(
  target: ResolvedPublicTarget,
  signal: AbortSignal,
  request: PinnedRequest
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(target, signal);
    } catch (error) {
      if (signal.aborted || error instanceof WebFetchError || attempt >= WEBFETCH_CONNECT_RETRY_COUNT) {
        throw error;
      }
    }
  }
}

export async function requestPinnedTarget(
  target: ResolvedPublicTarget,
  signal: AbortSignal
): Promise<SafeHttpResponse> {
  const selected = target.addresses[0]!;
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.url.protocol,
      hostname: selected.address,
      family: selected.family,
      port: target.url.protocol === "https:" ? 443 : 80,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      servername: normalizedHostname(target.url),
      headers: {
        host: target.url.host,
        accept: "text/html,application/xhtml+xml;q=0.9",
        "accept-encoding": "br,gzip,deflate",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
        "user-agent": "Sunabot-WebFetch/1.0"
      },
      signal,
      timeout: WEBFETCH_CONNECT_TIMEOUT_MS
    }, (response) => resolve({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: response
    }));
    request.once("timeout", () => request.destroy(new Error("connect timeout")));
    request.once("error", reject);
    request.end();
  });
}

function decodeBody(body: Readable, encoding: string) {
  const normalized = encoding.trim().toLowerCase();
  if (!normalized || normalized === "identity") return body;
  if (normalized === "gzip" || normalized === "x-gzip") return body.pipe(createGunzip());
  if (normalized === "deflate") return body.pipe(createInflate());
  if (normalized === "br") return body.pipe(createBrotliDecompress());
  body.destroy();
  throw new WebFetchError("UNSUPPORTED_CONTENT_TYPE", "Unsupported response encoding.");
}

async function readBoundedBytes(body: Readable, maxBytes: number, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) callback(new WebFetchError("RESPONSE_TOO_LARGE", "Response exceeded limit."));
      else {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    }
  });
  const onAbort = () => limiter.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  limiter.once("error", () => body.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      body.pipe(limiter);
      limiter.once("finish", resolve);
      limiter.once("error", reject);
      body.once("error", reject);
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks);
}

function decodeHtml(bytes: Buffer, contentType: string) {
  const headerCharset = /(?:^|;)\s*charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)?.[1];
  const prefix = bytes.subarray(0, 4_096).toString("latin1");
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(prefix)?.[1]
    ?? /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i.exec(prefix)?.[1];
  const charset = (headerCharset ?? metaCharset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && /abort|timeout|timed out/i.test(`${error.name} ${error.message}`);
}
