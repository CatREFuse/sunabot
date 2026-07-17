import net from "node:net";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export type McpDnsResolver = (hostname: string) => Promise<string[]>;
export type McpPinnedFetch = (url: URL, init: RequestInit, validatedAddresses: readonly string[]) => Promise<Response>;

export interface ControlledMcpFetchOptions {
  resolve: McpDnsResolver;
  /**
   * Must connect only to one of validatedAddresses and must not perform an
   * independent hostname lookup. There is intentionally no global-fetch
   * fallback because that would reopen DNS rebinding.
   */
  fetchPinned: McpPinnedFetch;
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export class ClearableMcpHttpAuthorization {
  #token: Buffer;
  #cleared = false;

  constructor(accessToken: string) {
    this.#token = Buffer.from(accessToken, "utf8");
  }

  authorizedFetch(fetch: FetchLike): FetchLike {
    return async (input, init = {}) => {
      if (this.#cleared) throw stableError("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
      const headers = normalizedHeaders(init.headers ?? {});
      if (headers.has("authorization")) throw stableError("MCP_HTTP_HEADER_RESERVED");
      headers.set("authorization", `Bearer ${this.#token.toString("utf8")}`);
      try {
        return await fetch(input, { ...init, headers });
      } finally {
        headers.delete("authorization");
      }
    };
  }

  clear() {
    if (this.#cleared) return;
    this.#cleared = true;
    this.#token.fill(0);
    this.#token = Buffer.alloc(0);
  }

  get cleared() {
    return this.#cleared;
  }
}

const RESERVED_CONFIG_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "mcp-session-id",
  "mcp-protocol-version",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection"
]);
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function assertSafeMcpConfiguredHeaders(headers: HeadersInit | undefined) {
  if (!headers) return;
  let invalid = false;
  normalizedHeaders(headers).forEach((_value, name) => {
    if (RESERVED_CONFIG_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith("proxy-")) {
      invalid = true;
    }
  });
  if (invalid) throw stableError("MCP_HTTP_HEADER_RESERVED");
}

export function assertSafeMcpHttpEndpoint(input: string | URL) {
  const url = parseUrl(input);
  validateEndpointShape(url);
  return url;
}

export function assertSafeMcpBrowserAuthorizationEndpoint(input: string | URL) {
  const url = parseUrl(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  }
  const hostname = mcpDnsHostname(url.hostname).toLowerCase();
  if (hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".home.arpa")) {
    throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  }
  const kind = net.isIP(hostname);
  if ((kind === 4 && unsafeIpv4(hostname)) || (kind === 6 && unsafeIpv6(hostname))) {
    throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  }
  return url;
}

export function createControlledMcpFetch(options: ControlledMcpFetchOptions): FetchLike {
  const maxRedirects = boundedPositiveInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 10);
  const maxResponseBytes = boundedPositiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 32 * 1024 * 1024);
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 5 * 60_000);

  return async (input, init = {}) => {
    const initialUrl = parseUrl(input);
    assertRuntimeTransportHeaders(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST" && method !== "DELETE") throw stableError("MCP_HTTP_METHOD_INVALID");
    const deadline = createDeadline(timeoutMs, init.signal);
    try {
      const response = await Promise.race([
        fetchRedirect(initialUrl, initialUrl.origin, init, 0, deadline.signal),
        deadline.rejection
      ]);
      return await limitResponseBody(response, maxResponseBytes, deadline.finish);
    } catch (error) {
      deadline.finish();
      if (deadline.timedOut()) throw stableError("MCP_HTTP_TIMEOUT");
      if (init.signal?.aborted) throw abortReason(init.signal);
      throw error;
    }
  };

  async function fetchRedirect(
    url: URL,
    initialOrigin: string,
    init: RequestInit,
    redirectCount: number,
    signal: AbortSignal
  ): Promise<Response> {
    validateEndpointShape(url);
    if (url.origin !== initialOrigin) throw stableError("MCP_HTTP_REDIRECT_ORIGIN_CHANGED");
    let addresses: string[];
    try {
      addresses = await options.resolve(mcpDnsHostname(url.hostname));
    } catch {
      throw stableError("MCP_HTTP_DNS_FAILED");
    }
    validateResolvedAddresses(url, addresses);
    let response: Response;
    try {
      response = await options.fetchPinned(url, {
        ...init,
        credentials: "omit",
        redirect: "manual",
        signal
      }, [...addresses]);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? stableError("MCP_HTTP_ABORTED");
      throw stableError("MCP_HTTP_REQUEST_FAILED");
    }
    if (!isRedirect(response.status)) return response;
    await cancelResponseBody(response.body, stableError("MCP_HTTP_REDIRECTED"));
    const location = response.headers.get("location");
    if (!location) throw stableError("MCP_HTTP_REDIRECT_INVALID");
    if (redirectCount >= maxRedirects) throw stableError("MCP_HTTP_REDIRECT_LIMIT");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw stableError("MCP_HTTP_REDIRECT_INVALID");
    }
    if (next.origin !== initialOrigin) throw stableError("MCP_HTTP_REDIRECT_ORIGIN_CHANGED");
    return fetchRedirect(next, initialOrigin, init, redirectCount + 1, signal);
  }
}

function validateEndpointShape(url: URL) {
  if (url.username || url.password || url.hash) throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  const loopback = explicitLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  }
}

function assertRuntimeTransportHeaders(headers: HeadersInit | undefined) {
  if (!headers) return;
  let invalid = false;
  normalizedHeaders(headers).forEach((_value, name) => {
    const normalized = name.toLowerCase();
    if (normalized === "cookie" || normalized === "host" || normalized === "origin" || normalized.startsWith("proxy-")) {
      invalid = true;
    }
  });
  if (invalid) throw stableError("MCP_HTTP_HEADER_RESERVED");
}

function normalizedHeaders(headers: HeadersInit) {
  try {
    return new Headers(headers);
  } catch {
    throw stableError("MCP_HTTP_HEADER_INVALID");
  }
}

function validateResolvedAddresses(url: URL, addresses: readonly string[]) {
  if (addresses.length === 0 || addresses.length > 16) throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
  const loopback = explicitLoopbackHost(url.hostname);
  for (const address of addresses) {
    const kind = net.isIP(address);
    if (!kind) throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
    const unsafe = kind === 4 ? unsafeIpv4(address) : unsafeIpv6(address);
    if (loopback) {
      if (!isLoopback(address) || (loopback !== "localhost" && !matchesLoopbackLiteral(loopback, address))) {
        throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
      }
    } else if (unsafe) {
      throw stableError("MCP_HTTP_ENDPOINT_UNSAFE");
    }
  }
}

function unsafeIpv4(address: string) {
  const octets = address.split(".").map(Number);
  const [a = -1, b = -1, c = -1] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function unsafeIpv6(address: string) {
  const value = ipv6Value(address);
  if (value == null || value === 0n || value === 1n) return true;
  if (inIpv6Cidr(value, 0xfc00n, 7) || inIpv6Cidr(value, 0xfe80n, 10) ||
      inIpv6Cidr(value, 0xff00n, 8)) return true;
  const prefix96 = value >> 32n;
  const compatible = prefix96 === 0n;
  const mapped = prefix96 === 0xffffn;
  const translated = prefix96 === 0xffff0000n;
  const wellKnownNat64 = prefix96 === 0x0064ff9b0000000000000000n;
  const localNat64 = (value >> 80n) === 0x0064ff9b0001n;
  const globalUnicast = inIpv6Cidr(value, 0x2000n, 3);
  const specialGlobal = inIpv6Cidr(value, 0x20010000n, 23, 32)
    || inIpv6Cidr(value, 0x20010db8n, 32, 32)
    || inIpv6Cidr(value, 0x20020000n, 16, 32)
    || inIpv6Cidr(value, 0x3fff0000n, 20, 32);
  return compatible || mapped || translated || wellKnownNat64 || localNat64 || !globalUnicast || specialGlobal;
}

function ipv6Value(address: string) {
  if (address.includes("%")) return null;
  let normalized = address.toLowerCase();
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    const replacement = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    normalized = normalized.slice(0, normalized.length - dotted.length) + replacement;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const segments = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (segments.length !== 8 || segments.some((segment) => !/^[a-f0-9]{1,4}$/u.test(segment))) return null;
  return segments.reduce((value, segment) => (value << 16n) | BigInt(`0x${segment}`), 0n);
}

function inIpv6Cidr(value: bigint, prefix: bigint, prefixLength: number, prefixWidth = 16) {
  const shift = BigInt(128 - prefixLength);
  return (value >> shift) === (prefix >> BigInt(prefixWidth - prefixLength));
}

function isLoopback(address: string) {
  return address === "::1" || address.startsWith("127.");
}

function explicitLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost") return "localhost" as const;
  if (normalized === "127.0.0.1") return "127.0.0.1" as const;
  if (normalized === "[::1]" || normalized === "::1") return "::1" as const;
  return undefined;
}

function matchesLoopbackLiteral(hostname: "127.0.0.1" | "::1", address: string) {
  return hostname === "127.0.0.1" ? address === "127.0.0.1" : ipv6Value(address) === 1n;
}

export function mcpDnsHostname(hostname: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const unwrapped = hostname.slice(1, -1);
    if (net.isIP(unwrapped) === 6) return unwrapped;
  }
  return hostname;
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseUrl(input: string | URL) {
  try {
    return new URL(input);
  } catch {
    throw stableError("MCP_HTTP_ENDPOINT_INVALID");
  }
}

async function limitResponseBody(response: Response, maxBytes: number, finish: () => void) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    await cancelResponseBody(response.body, stableError("MCP_HTTP_RESPONSE_TOO_LARGE"));
    finish();
    throw stableError("MCP_HTTP_RESPONSE_TOO_LARGE");
  }
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > maxBytes) {
          finish();
          await reader.cancel(stableError("MCP_HTTP_RESPONSE_TOO_LARGE"));
          controller.error(stableError("MCP_HTTP_RESPONSE_TOO_LARGE"));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null, reason: Error) {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    throw stableError("MCP_HTTP_CLEANUP_FAILED");
  }
}

function createDeadline(timeoutMs: number, callerSignal: AbortSignal | null | undefined) {
  const controller = new AbortController();
  let timeout = false;
  let rejectDeadline!: (reason: unknown) => void;
  const rejection = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    timeout = true;
    const error = stableError("MCP_HTTP_TIMEOUT");
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  const abort = () => {
    const reason = callerSignal ? abortReason(callerSignal) : stableError("MCP_HTTP_ABORTED");
    controller.abort(reason);
    rejectDeadline(reason);
  };
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  let finished = false;
  return {
    signal: controller.signal,
    rejection,
    timedOut: () => timeout,
    finish: () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    }
  };
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : stableError("MCP_HTTP_ABORTED");
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw stableError("MCP_HTTP_CONFIG_INVALID");
  return value;
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
