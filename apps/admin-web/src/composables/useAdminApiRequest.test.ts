import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest session coordination", () => {
  it("waits for the administrator session before sending a write request", async () => {
    const session = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === "/api/auth/session") return session.promise;
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { apiRequest } = await import("./useAdminApi");

    const request = apiRequest<{ ok: boolean }>("/api/write", {
      method: "POST",
      body: JSON.stringify({ enabled: true })
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    session.resolve(jsonResponse({
      authenticated: true,
      username: "admin",
      csrfToken: "csrf-ready"
    }));
    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(headers.get("x-sunabot-csrf")).toBe("csrf-ready");
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
