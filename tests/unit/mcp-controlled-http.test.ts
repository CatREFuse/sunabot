// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ClearableMcpHttpAuthorization,
  assertSafeMcpConfiguredHeaders,
  createControlledMcpFetch
} from "../../adapters/mcp/controlledHttp.js";
import { responseWithDispatcherCleanup } from "../../adapters/mcp/nodePinnedFetch.js";

describe("controlled MCP HTTP", () => {
  it("injects authorization per request and clears both the envelope and transient header", async () => {
    const token = "request-scoped-secret";
    let capturedInit: RequestInit | undefined;
    let observedAuthorization: string | null = null;
    const authorization = new ClearableMcpHttpAuthorization(token);
    const fetch = authorization.authorizedFetch(async (_input, init) => {
      capturedInit = init;
      observedAuthorization = new Headers(init?.headers).get("authorization");
      return new Response(null, { status: 204 });
    });

    await expect(fetch("https://mcp.example.test/mcp")).resolves.toMatchObject({ status: 204 });
    expect(observedAuthorization).toBe(`Bearer ${token}`);
    expect(new Headers(capturedInit?.headers).has("authorization")).toBe(false);
    authorization.clear();
    expect(authorization.cleared).toBe(true);
    expect(JSON.stringify(authorization)).not.toContain(token);
    await expect(fetch("https://mcp.example.test/mcp")).rejects.toThrow("MCP_HTTP_CREDENTIAL_UNAVAILABLE");
  });

  it("strictly destroys a pinned dispatcher when graceful close fails", async () => {
    let activeDispatchers = 1;
    const dispatcher = {
      close: vi.fn(async () => { throw new Error("close failed"); }),
      destroy: vi.fn(async () => { activeDispatchers -= 1; })
    };
    const response = await responseWithDispatcherCleanup(new Response("ok"), dispatcher, 20);

    await expect(response.text()).rejects.toThrow("MCP_HTTP_CLEANUP_FAILED");
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).toHaveBeenCalledOnce();
    expect(activeDispatchers).toBe(0);
  });

  it("closes a pinned dispatcher exactly once for an empty response", async () => {
    let activeDispatchers = 1;
    const dispatcher = {
      close: vi.fn(async () => { activeDispatchers -= 1; }),
      destroy: vi.fn(async () => { activeDispatchers -= 1; })
    };
    await expect(responseWithDispatcherCleanup(new Response(null, { status: 204 }), dispatcher, 20))
      .resolves.toMatchObject({ status: 204 });
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).not.toHaveBeenCalled();
    expect(activeDispatchers).toBe(0);
  });

  it("pins every same-origin redirect hop to newly validated public DNS answers", async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.35"]);
    const fetchPinned = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/mcp-v2" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const controlledFetch = createControlledMcpFetch({ resolve, fetchPinned, timeoutMs: 1_000 });

    const response = await controlledFetch("https://mcp.example.test/mcp", { method: "POST", body: "{}" });

    expect(await response.text()).toBe("ok");
    expect(resolve).toHaveBeenNthCalledWith(1, "mcp.example.test");
    expect(resolve).toHaveBeenNthCalledWith(2, "mcp.example.test");
    expect(fetchPinned.mock.calls.map((call) => [String(call[0]), call[2]])).toEqual([
      ["https://mcp.example.test/mcp", ["93.184.216.34"]],
      ["https://mcp.example.test/mcp-v2", ["93.184.216.35"]]
    ]);
    expect(fetchPinned.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", credentials: "omit" });
  });

  it("cancels redirect and declared-oversize bodies so pinned connections are released", async () => {
    const redirectCancelled = vi.fn();
    const oversizedCancelled = vi.fn();
    const redirectBody = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel: redirectCancelled
    });
    const redirecting = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned: vi.fn()
        .mockResolvedValueOnce(new Response(redirectBody, {
          status: 307,
          headers: { location: "/next" }
        }))
        .mockResolvedValueOnce(new Response("ok"))
    });
    expect(await (await redirecting("https://mcp.example.test/mcp")).text()).toBe("ok");
    expect(redirectCancelled).toHaveBeenCalledOnce();

    const oversizedBody = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel: oversizedCancelled
    });
    const oversized = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned: vi.fn().mockResolvedValue(new Response(oversizedBody, {
        headers: { "content-length": "100" }
      })),
      maxResponseBytes: 8
    });
    await expect(oversized("https://mcp.example.test/mcp")).rejects.toThrow("MCP_HTTP_RESPONSE_TOO_LARGE");
    expect(oversizedCancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["http://mcp.example.test/mcp", ["203.0.113.10"]],
    ["https://mcp.example.test/mcp", ["127.0.0.1"]],
    ["https://mcp.example.test/mcp", ["10.0.0.1"]],
    ["https://mcp.example.test/mcp", ["169.254.169.254"]],
    ["https://mcp.example.test/mcp", ["::1"]],
    ["https://mcp.example.test/mcp", ["fe80::1"]],
    ["https://mcp.example.test/mcp", ["::ffff:7f00:1"]],
    ["https://mcp.example.test/mcp", ["::ffff:a9fe:a9fe"]],
    ["https://mcp.example.test/mcp", ["::ffff:0:7f00:1"]],
    ["https://mcp.example.test/mcp", ["::7f00:1"]],
    ["https://mcp.example.test/mcp", ["64:ff9b::7f00:1"]],
    ["https://mcp.example.test/mcp", ["64:ff9b:1::a9fe:a9fe"]],
    ["https://mcp.example.test/mcp", ["192.0.0.8"]],
    ["https://mcp.example.test/mcp", ["192.0.2.8"]],
    ["https://mcp.example.test/mcp", ["198.51.100.8"]],
    ["https://mcp.example.test/mcp", ["203.0.113.8"]],
    ["https://mcp.example.test/mcp", ["2001:db8::1"]],
    ["https://mcp.example.test/mcp", ["2001::1"]],
    ["https://mcp.example.test/mcp", ["2001:20::1"]],
    ["https://mcp.example.test/mcp", ["2002::1"]],
    ["https://mcp.example.test/mcp", ["3fff::1"]],
    ["https://mcp.example.test/mcp", ["fe80::1%25en0"]],
    ["https://mcp.example.test/mcp", ["93.184.216.34", "192.0.2.8"]]
  ])("rejects unsafe endpoint %s resolved as %j", async (url, addresses) => {
    const fetchPinned = vi.fn();
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(addresses),
      fetchPinned
    });
    await expect(controlledFetch(url)).rejects.toThrow("MCP_HTTP_ENDPOINT_UNSAFE");
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("accepts a public native IPv6 address", async () => {
    const fetchPinned = vi.fn().mockResolvedValue(new Response("ok"));
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["2606:4700:4700::1111"]),
      fetchPinned
    });
    expect(await (await controlledFetch("https://mcp.example.test/mcp")).text()).toBe("ok");
    expect(fetchPinned).toHaveBeenCalledOnce();
  });

  it.each([
    ["http://localhost:43123/mcp", "localhost", "127.0.0.1"],
    ["http://127.0.0.1:43123/mcp", "127.0.0.1", "127.0.0.1"],
    ["http://[::1]:43123/mcp", "[::1]", "::1"]
  ])("allows loopback only for explicit endpoint %s", async (endpoint, hostname, address) => {
    const resolve = vi.fn().mockResolvedValue([address]);
    const fetchPinned = vi.fn().mockResolvedValue(new Response("ok"));
    const controlledFetch = createControlledMcpFetch({
      resolve,
      fetchPinned
    });

    expect(await (await controlledFetch(endpoint)).text()).toBe("ok");
    expect(fetchPinned).toHaveBeenCalledWith(
      expect.objectContaining({ hostname }),
      expect.any(Object),
      [address]
    );
    expect(resolve).toHaveBeenCalledWith(hostname === "[::1]" ? "::1" : hostname);
  });

  it.each([
    ["http://127.0.0.2:43123/mcp", ["127.0.0.2"]],
    ["http://127.0.0.1:43123/mcp", ["127.0.0.2"]],
    ["http://[::1]:43123/mcp", ["127.0.0.1"]],
    ["http://localhost:43123/mcp", ["93.184.216.34"]]
  ])("rejects mismatched or non-explicit loopback endpoint %s", async (endpoint, addresses) => {
    const fetchPinned = vi.fn();
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(addresses), fetchPinned
    });
    await expect(controlledFetch(endpoint)).rejects.toThrow("MCP_HTTP_ENDPOINT_UNSAFE");
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("rejects cross-origin redirects before forwarding credentials", async () => {
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned: vi.fn().mockResolvedValue(new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/mcp" }
      }))
    });

    await expect(controlledFetch("https://mcp.example.test/mcp", {
      headers: { authorization: "Bearer managed-secret" }
    })).rejects.toThrow("MCP_HTTP_REDIRECT_ORIGIN_CHANGED");
  });

  it.each(["authorization", "cookie", "host", "origin", "mcp-session-id", "mcp-protocol-version", "proxy-authorization"])(
    "rejects user-configured reserved header %s",
    (header) => expect(() => assertSafeMcpConfiguredHeaders({ [header]: "value" })).toThrow("MCP_HTTP_HEADER_RESERVED")
  );

  it("also rejects host, cookie, origin, and proxy headers at the transport boundary", async () => {
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned: vi.fn()
    });
    for (const header of ["host", "cookie", "origin", "proxy-authorization"]) {
      await expect(controlledFetch("https://mcp.example.test/mcp", { headers: { [header]: "x" } }))
        .rejects.toThrow("MCP_HTTP_HEADER_RESERVED");
    }
  });

  it("bounds response bytes", async () => {
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned: vi.fn().mockResolvedValue(new Response("123456789")),
      maxResponseBytes: 8
    });

    const response = await controlledFetch("https://mcp.example.test/mcp");
    await expect(response.text()).rejects.toThrow("MCP_HTTP_RESPONSE_TOO_LARGE");
  });

  it("applies an explicit total timeout and relays caller abort", async () => {
    vi.useFakeTimers();
    const seenSignals: AbortSignal[] = [];
    const fetchPinned = vi.fn((_url, init: RequestInit) => {
      seenSignals.push(init.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const controlledFetch = createControlledMcpFetch({
      resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
      fetchPinned,
      timeoutMs: 50
    });
    const timed = controlledFetch("https://mcp.example.test/mcp");
    const timedExpectation = expect(timed).rejects.toThrow("MCP_HTTP_TIMEOUT");
    await vi.advanceTimersByTimeAsync(51);
    await timedExpectation;
    expect(seenSignals[0]?.aborted).toBe(true);

    const controller = new AbortController();
    const aborted = controlledFetch("https://mcp.example.test/mcp", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("conversation stopped"));
    await expect(aborted).rejects.toThrow("conversation stopped");
    vi.useRealTimers();
  });
});
