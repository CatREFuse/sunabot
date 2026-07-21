import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { WebFetchError } from "../../services/webfetch/contracts.js";

export interface ResolvedPublicTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export type WebFetchDnsLookup = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const CLASH_FAKE_IP_RANGE = ipaddr.parseCIDR("198.18.0.0/15");
const DOH_RESPONSE_LIMIT_BYTES = 64 * 1024;
const DOH_TIMEOUT_MS = 3_000;
const DOH_CACHE_TTL_MS = 15_000;
const DOH_CACHE_MAX_ENTRIES = 256;
const dohCache = new Map<string, {
  expiresAt: number;
  records: Array<{ address: string; family: number }>;
}>();
const dohInflight = new Map<string, Promise<Array<{ address: string; family: number }>>>();

export async function resolvePublicWebTarget(
  input: string | URL,
  lookup: WebFetchDnsLookup = lookupWebFetchDns
): Promise<ResolvedPublicTarget> {
  const url = parsePublicWebUrl(input);
  const hostname = normalizedHostname(url);
  const literalFamily = ipaddr.isValid(hostname) ? ipaddr.parse(hostname).kind() : undefined;
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily === "ipv4" ? 4 : 6 }]
    : await lookup(hostname).catch(() => []);
  if (!records.length) throw new WebFetchError("TARGET_NOT_PUBLIC", "No public DNS target.");
  const addresses = records.map((record) => {
    if (record.family !== 4 && record.family !== 6) {
      throw new WebFetchError("TARGET_NOT_PUBLIC", "Invalid DNS address family.");
    }
    const address = normalizeIp(record.address);
    if (ipFamily(address) !== record.family) {
      throw new WebFetchError("TARGET_NOT_PUBLIC", "DNS address family mismatch.");
    }
    return { address, family: record.family as 4 | 6 };
  });
  if (addresses.some((record) => !isPublicIp(record.address) || ipFamily(record.address) !== record.family)) {
    throw new WebFetchError("TARGET_NOT_PUBLIC", "Target resolved outside the public address range.");
  }
  return { url, addresses };
}

export function parsePublicWebUrl(input: string | URL) {
  if (typeof input === "string" && hasNonAsciiAuthority(input)) {
    throw new WebFetchError("URL_NOT_ALLOWED", "Unicode hostnames are not allowed.");
  }
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new WebFetchError("URL_NOT_ALLOWED", "Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError("URL_NOT_ALLOWED", "Unsupported URL protocol.");
  }
  if (url.username || url.password || !url.hostname || url.hostname.length > 253) {
    throw new WebFetchError("URL_NOT_ALLOWED", "URL credentials or hostname are not allowed.");
  }
  if (url.hostname.endsWith(".")) {
    throw new WebFetchError("URL_NOT_ALLOWED", "Trailing-dot hostnames are not allowed.");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if ((url.protocol === "https:" && port !== 443) || (url.protocol === "http:" && port !== 80)) {
    throw new WebFetchError("URL_NOT_ALLOWED", "Only standard HTTP and HTTPS ports are allowed.");
  }
  url.hash = "";
  return url;
}

export function isPublicIp(value: string) {
  if (!ipaddr.isValid(value)) return false;
  const parsed = ipaddr.parse(value);
  // Do not normalize mapped IPv6 to IPv4: the mapped representation itself is
  // a common SSRF bypass and is rejected even when the embedded address is
  // public. Transition prefixes are rejected below as well.
  if (parsed.kind() === "ipv6" && parsed.range() === "ipv4Mapped") return false;
  const address = parsed;
  if (address.range() !== "unicast") return false;
  if (address.kind() === "ipv6") {
    const normalized = address.toNormalizedString().toLowerCase();
    if (normalized.startsWith("64:ff9b:") || normalized.startsWith("2002:") || normalized.startsWith("2001:0:")) {
      return false;
    }
  }
  return true;
}

function normalizeIp(value: string) {
  try {
    return ipaddr.process(value).toString();
  } catch {
    throw new WebFetchError("TARGET_NOT_PUBLIC", "Invalid target address.");
  }
}

function ipFamily(value: string): 4 | 6 {
  return ipaddr.parse(value).kind() === "ipv6" ? 6 : 4;
}

export async function lookupWebFetchDns(
  hostname: string,
  systemLookup: WebFetchDnsLookup = (target) => dns.lookup(target, { all: true, verbatim: true }),
  fetchImpl: typeof fetch = fetch
) {
  const records = await systemLookup(hostname).catch(() => []);
  if (records.length && !records.every((record) => isClashFakeIp(record.address))) return records;
  const cached = dohCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    dohCache.delete(hostname);
    dohCache.set(hostname, cached);
    return cached.records.map((record) => ({ ...record }));
  }
  if (cached) dohCache.delete(hostname);
  let current = dohInflight.get(hostname);
  if (!current) {
    current = lookupWithDnsOverHttps(hostname, fetchImpl).then((resolved) => {
      if (!resolved.length || resolved.some((record) => !isPublicIp(record.address))) {
        throw new WebFetchError("TARGET_NOT_PUBLIC", "DoH returned no public target.");
      }
      dohCache.delete(hostname);
      dohCache.set(hostname, {
        expiresAt: Date.now() + DOH_CACHE_TTL_MS,
        records: resolved.map((record) => ({ ...record }))
      });
      while (dohCache.size > DOH_CACHE_MAX_ENTRIES) {
        const oldest = dohCache.keys().next().value as string | undefined;
        if (!oldest) break;
        dohCache.delete(oldest);
      }
      return resolved;
    }).finally(() => dohInflight.delete(hostname));
    dohInflight.set(hostname, current);
  }
  return (await current).map((record) => ({ ...record }));
}

export function normalizedHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export async function lookupWithDnsOverHttps(
  hostname: string,
  fetchImpl: typeof fetch = fetch
): Promise<Array<{ address: string; family: number }>> {
  const signal = AbortSignal.timeout(DOH_TIMEOUT_MS);
  const queries = await Promise.allSettled([1, 28].map(async (type) => {
    // Use Cloudflare's literal-IP DoH endpoint so this fallback still works
    // when the host resolver itself is unavailable.  The certificate covers
    // 1.1.1.1 and the returned addresses are validated before caching.
    const endpoint = new URL("https://1.1.1.1/dns-query");
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", String(type));
    const response = await fetchImpl(endpoint, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal
    });
    if (!response.ok) throw new Error("DoH lookup failed");
    const text = await readBoundedDnsResponse(response);
    const payload = JSON.parse(text) as { Status?: unknown; Answer?: unknown };
    if (payload.Status !== 0 || !Array.isArray(payload.Answer)) return [];
    return payload.Answer.flatMap((answer) => {
      if (!answer || typeof answer !== "object") return [];
      const record = answer as { type?: unknown; data?: unknown };
      if (record.type !== type || typeof record.data !== "string" || !ipaddr.isValid(record.data)) return [];
      return [{ address: record.data, family: type === 28 ? 6 : 4 }];
    });
  }));
  const answers = queries.flatMap((query) => query.status === "fulfilled" ? query.value : []);
  if (!queries.some((query) => query.status === "fulfilled")) throw new Error("DoH lookup failed");
  return answers;
}

function isClashFakeIp(value: string) {
  if (!ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  return address.kind() === "ipv4" && address.match(CLASH_FAKE_IP_RANGE);
}

function hasNonAsciiAuthority(value: string) {
  const authorityStart = value.indexOf("://");
  if (authorityStart < 0) return false;
  const authorityEnd = value.slice(authorityStart + 3).search(/[/?#]/u);
  const authority = value.slice(
    authorityStart + 3,
    authorityEnd < 0 ? value.length : authorityStart + 3 + authorityEnd
  );
  return /[^\x00-\x7f]/u.test(authority);
}

async function readBoundedDnsResponse(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > DOH_RESPONSE_LIMIT_BYTES || !response.body) throw new Error("DoH response rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DOH_RESPONSE_LIMIT_BYTES) throw new Error("DoH response rejected");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
