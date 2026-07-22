// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  isPublicIp,
  lookupWebFetchDns,
  parsePublicWebUrl,
  resolvePublicWebTarget
} from "../../adapters/webfetch/urlPolicy.js";
import { fetchSafeHtml } from "../../adapters/webfetch/safeHttpFetcher.js";
import { RendererLimiter, RendererQueueFullError } from "../../apps/webfetch-renderer/rendererLimiter.js";
import { rejectConnect } from "../../apps/webfetch-renderer/safeProxy.js";
import type { Duplex } from "node:stream";
import {
  LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR,
  preflightProviderToolResponse
} from "../../adapters/model/provider/toolResponsePreflight.js";
import { createTurnToolState } from "../../adapters/model/provider/turnToolState.js";

describe("WebFetch URL policy", () => {
  it("rejects non-web schemes, credentials, custom ports and trailing-dot hosts", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/file",
      "https://user:secret@example.com/",
      "https://example.com:8443/",
      "https://example.com./",
      "https://ｅxample.com/"
    ]) expect(() => parsePublicWebUrl(url)).toThrow();
  });

  it("rejects private, mapped and transition addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:5db8:d822",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2"
    ]) expect(isPublicIp(address), address).toBe(false);
    expect(isPublicIp("93.184.216.34")).toBe(true);
    expect(isPublicIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
  });

  it("fails closed when any DNS answer is private or its family is inconsistent", async () => {
    await expect(resolvePublicWebTarget("https://example.com", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ])).rejects.toMatchObject({ code: "TARGET_NOT_PUBLIC" });

    await expect(resolvePublicWebTarget("https://example.com", async () => [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 4 }
    ])).rejects.toMatchObject({ code: "TARGET_NOT_PUBLIC" });

    await expect(resolvePublicWebTarget("https://example.com", async () => [
      { address: "93.184.216.34", family: 0 }
    ])).rejects.toMatchObject({ code: "TARGET_NOT_PUBLIC" });

    await expect(resolvePublicWebTarget("https://example.com", async () => [
      { address: "93.184.216.34", family: 4 }
    ])).resolves.toMatchObject({
      url: expect.objectContaining({ protocol: "https:" }),
      addresses: [{ address: "93.184.216.34", family: 4 }]
    });
  });

  it("replaces Clash Fake-IP DNS answers through bounded DoH without weakening literal IP policy", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const type = new URL(String(input)).searchParams.get("type");
      return new Response(JSON.stringify({
        Status: 0,
        Answer: type === "1"
          ? [{ type: 1, data: "93.184.216.34" }]
          : [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }]
      }), { headers: { "content-type": "application/dns-json" } });
    });
    const records = await lookupWebFetchDns(
      "example.com",
      async () => [{ address: "198.18.2.186", family: 4 }],
      fetchImpl as typeof fetch
    );

    expect(records).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(() => parsePublicWebUrl("http://198.18.2.186/")).not.toThrow();
    await expect(resolvePublicWebTarget("http://198.18.2.186/"))
      .rejects.toMatchObject({ code: "TARGET_NOT_PUBLIC" });
  });

  it("single-flights and briefly caches verified public DoH answers", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      await Promise.resolve();
      const type = new URL(String(input)).searchParams.get("type");
      return new Response(JSON.stringify({
        Status: 0,
        Answer: type === "1"
          ? [{ type: 1, data: "93.184.216.34" }]
          : [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }]
      }));
    });
    const systemLookup = vi.fn(async () => [{ address: "198.18.9.9", family: 4 }]);

    const [first, second] = await Promise.all([
      lookupWebFetchDns("singleflight-webfetch.test", systemLookup, fetchImpl as typeof fetch),
      lookupWebFetchDns("singleflight-webfetch.test", systemLookup, fetchImpl as typeof fetch)
    ]);
    const third = await lookupWebFetchDns(
      "singleflight-webfetch.test",
      systemLookup,
      fetchImpl as typeof fetch
    );

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(systemLookup).toHaveBeenCalledTimes(3);
  });

  it("falls back to bounded DoH when system DNS is unavailable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const type = new URL(String(input)).searchParams.get("type");
      return new Response(JSON.stringify({
        Status: 0,
        Answer: type === "1"
          ? [{ type: 1, data: "93.184.216.34" }]
          : []
      }));
    });

    await expect(lookupWebFetchDns(
      "system-dns-unavailable.test",
      async () => { throw new Error("ENOTFOUND"); },
      fetchImpl as typeof fetch
    )).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses a verified public family when the other DoH family times out", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const type = new URL(String(input)).searchParams.get("type");
      if (type === "28") throw new Error("AAAA timeout");
      return new Response(JSON.stringify({
        Status: 0,
        Answer: [{ type: 1, data: "93.184.216.34" }]
      }));
    });

    await expect(lookupWebFetchDns(
      "partial-doh-family.test",
      async () => [],
      fetchImpl as typeof fetch
    )).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("includes DNS resolution in the static fetch deadline", async () => {
    const lookup = vi.fn((_hostname: string, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    await expect(fetchSafeHtml("https://dns-timeout.test/", {
      lookup,
      timeoutMs: 20
    })).rejects.toMatchObject({ code: "FETCH_TIMEOUT" });
    expect(lookup).toHaveBeenCalledWith("dns-timeout.test", expect.any(AbortSignal));
  });
});

describe("WebFetch renderer resource boundaries", () => {
  it("bounds queued renders and removes an aborted waiter", async () => {
    const limiter = new RendererLimiter(1, 1);
    let release!: () => void;
    const active = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const queued = limiter.run(async () => undefined, controller.signal);

    await expect(limiter.run(async () => undefined)).rejects.toBeInstanceOf(RendererQueueFullError);
    controller.abort(new Error("client disconnected"));
    await expect(queued).rejects.toThrow("client disconnected");
    release();
    await active;
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
    limiter.close();
  });

  it("rejects HTTPS CONNECT tunnels", () => {
    const end = vi.fn();
    rejectConnect({ end } as unknown as Duplex);
    expect(end).toHaveBeenCalledWith(expect.stringContaining("405 Method Not Allowed"));
  });
});

describe("WebFetch provider boundary", () => {
  it("blocks local data and webfetch in the same batch before execution", () => {
    const calls = [
      call("memory_recall", { query: "private context" }, "local"),
      call("webfetch", { url: "https://example.com", semanticMatch: false }, "network")
    ];
    const result = preflightProviderToolResponse(calls, "", {}, createTurnToolState());

    expect(result.rejected).toHaveLength(2);
    expect(result.rejected?.map((output) => JSON.parse(output.output))).toEqual([
      { ok: false, error: LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR },
      { ok: false, error: LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR }
    ]);
  });

  it("blocks webfetch after local activity and allows it after websearch activity", () => {
    const localState = createTurnToolState();
    localState.acceptedToolNames.push("memory_recall");
    expect(preflightProviderToolResponse([
      call("webfetch", { url: "https://example.com", semanticMatch: false }, "fetch")
    ], "", {}, localState).rejected).toBeDefined();

    const outboundState = createTurnToolState();
    outboundState.acceptedToolNames.push("websearch");
    expect(preflightProviderToolResponse([
      call("webfetch", { url: "https://example.com", semanticMatch: false }, "fetch")
    ], "", {}, outboundState).rejected).toBeUndefined();
  });
});

function call(name: string, args: Record<string, unknown>, id: string) {
  return {
    type: "function_call" as const,
    name,
    call_id: id,
    arguments: JSON.stringify(args)
  };
}
