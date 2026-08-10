// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  parseWebUrl,
  resolveWebTarget
} from "../../adapters/webfetch/urlPolicy.js";
import {
  fetchSafeHtml,
  WEBFETCH_CONNECT_RETRY_COUNT,
  WEBFETCH_CONNECT_TIMEOUT_MS,
  WEBFETCH_STATIC_TIMEOUT_MS
} from "../../adapters/webfetch/safeHttpFetcher.js";
import { RendererLimiter, RendererQueueFullError } from "../../apps/webfetch-renderer/rendererLimiter.js";
import { rejectConnect } from "../../apps/webfetch-renderer/safeProxy.js";
import { Readable, type Duplex } from "node:stream";

describe("WebFetch URL handling", () => {
  it("allows up to 90 seconds for the complete static fetch", () => {
    expect(WEBFETCH_STATIC_TIMEOUT_MS).toBe(90_000);
    expect(WEBFETCH_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(WEBFETCH_CONNECT_RETRY_COUNT).toBe(3);
  });

  it("retries three connection failures before returning a response", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("<html><body>ok</body></html>")])
      });

    await expect(fetchSafeHtml("https://retry.test/", {
      request
    })).resolves.toMatchObject({ status: 200 });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("stops after three connection retries", async () => {
    const request = vi.fn(async () => { throw new Error("ECONNRESET"); });

    await expect(fetchSafeHtml("https://retry.test/", {
      request
    })).rejects.toMatchObject({ code: "CONTENT_EXTRACTION_FAILED" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("accepts every HTTP(S) address form", () => {
    for (const url of [
      "http://127.0.0.1:19090/file",
      "https://user:secret@example.com/",
      "https://example.com:8443/",
      "https://example.com./",
      "https://ｅxample.com/"
    ]) expect(() => parseWebUrl(url)).not.toThrow();
  });

  it("rejects only unsupported URL schemes", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/file", "not-a-url"]) {
      expect(() => parseWebUrl(url)).toThrow();
    }
  });

  it("accepts loopback, private, reserved and Fake-IP targets without DNS filtering", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.2/",
      "http://198.18.2.186/",
      "http://[::1]/",
      "http://[fc00::1]/"
    ]) expect(resolveWebTarget(url).url.href).toBe(url);
  });

  it("uses the supplied target directly and keeps the static fetch deadline", async () => {
    const request = vi.fn((_target: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    await expect(fetchSafeHtml("http://127.0.0.1:19090/reference.html", {
      request,
      timeoutMs: 20
    })).rejects.toMatchObject({ code: "FETCH_TIMEOUT" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.objectContaining({ hostname: "127.0.0.1", port: "19090" }) }),
      expect.any(AbortSignal)
    );
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
