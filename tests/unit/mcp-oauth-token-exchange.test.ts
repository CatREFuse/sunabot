// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createControlledMcpOAuthTokenExchange,
  McpOAuthHttpTokenExchange
} from "../../adapters/mcp/oauthTokenExchange.js";

const TOKEN_ENDPOINT = "https://auth.example.test/token";
const RESOURCE = "https://mcp.example.test/api";
const REDIRECT_URI = "http://127.0.0.1:52173/api/agent-extensions/mcp/oauth/callback";
const CODE_VERIFIER = "a".repeat(43);

describe("MCP OAuth token exchange", () => {
  it("posts a bounded authorization_code form including the resource audience", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp.read mcp.call"
    }));
    const exchange = new McpOAuthHttpTokenExchange({ fetch, now: () => 1_000 });

    await expect(exchange.exchangeAuthorizationCode({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "sunabot-client",
      code: "authorization-secret",
      codeVerifier: CODE_VERIFIER,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      signal: controller.signal
    })).resolves.toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 3_601_000
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
      }
    });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code",
      client_id: "sunabot-client",
      code: "authorization-secret",
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
      resource: RESOURCE
    });
    expect(`${url} ${JSON.stringify(init.headers)}`).not.toContain("authorization-secret");
    expect(`${url} ${JSON.stringify(init.headers)}`).not.toContain("access-secret");
  });

  it("posts refresh_token forms and accepts a rotated refresh token", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      access_token: "access-two",
      refresh_token: "refresh-two",
      token_type: "bearer"
    }));
    const exchange = new McpOAuthHttpTokenExchange({ fetch });

    await expect(exchange.refreshAccessToken({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: "sunabot-client",
      refreshToken: "refresh-one",
      resource: RESOURCE
    })).resolves.toEqual({
      status: "ok",
      tokens: { accessToken: "access-two", refreshToken: "refresh-two" }
    });
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0]?.[1].body)))).toEqual({
      grant_type: "refresh_token",
      client_id: "sunabot-client",
      refresh_token: "refresh-one",
      resource: RESOURCE
    });
  });

  it("returns invalid_grant only for an exact bounded OAuth error", async () => {
    const exact = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        error: "invalid_grant",
        error_description: "expired"
      }, 400))
    });
    await expect(exact.refreshAccessToken(refreshInput())).resolves.toEqual({ status: "invalid_grant" });

    for (const response of [
      jsonResponse({ error: "invalid_grant_extra" }, 400),
      jsonResponse({ error: "invalid_grant", access_token: "must-not-be-trusted" }, 400),
      jsonResponse({ error: "invalid_grant" }, 401)
    ]) {
      const exchange = new McpOAuthHttpTokenExchange({ fetch: vi.fn().mockResolvedValue(response) });
      await expect(exchange.refreshAccessToken(refreshInput())).rejects.toThrow("MCP_OAUTH_TOKEN_REFRESH_FAILED");
    }
  });

  it.each([
    [{ refresh_token: "refresh-only", token_type: "Bearer" }, "missing access token"],
    [{ access_token: "access", token_type: "Basic" }, "non-Bearer token type"],
    [{ access_token: "access", expires_in: 1.5 }, "fractional expiry"],
    [{ access_token: "access", unexpected: true }, "unknown response field"],
    [[{ access_token: "access" }], "non-object response"]
  ])("rejects strict token response case: %s", async (body) => {
    const exchange = new McpOAuthHttpTokenExchange({ fetch: vi.fn().mockResolvedValue(jsonResponse(body)) });
    await expect(exchange.exchangeAuthorizationCode(authorizationInput()))
      .rejects.toThrow("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
  });

  it("bounds token responses and never exposes remote bodies or tokens in errors", async () => {
    const oversizedCancel = vi.fn();
    const oversizedChunk = new TextEncoder().encode(JSON.stringify({ access_token: "secret-" + "x".repeat(128) }));
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedChunk);
      },
      cancel: oversizedCancel
    });
    const oversized = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(new Response(oversizedBody)),
      maxResponseBytes: 32
    });
    const oversizedError = await oversized.exchangeAuthorizationCode(authorizationInput()).catch((error: unknown) => error);
    expect(oversizedError).toBeInstanceOf(Error);
    expect((oversizedError as Error).message).toBe("MCP_OAUTH_TOKEN_RESPONSE_TOO_LARGE");
    expect((oversizedError as Error).message).not.toContain("secret-");
    expect(oversizedCancel).toHaveBeenCalledOnce();
    expect([...oversizedChunk]).toEqual(new Array(oversizedChunk.byteLength).fill(0));

    const remoteSecret = "remote-body-token";
    const failed = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(new Response(remoteSecret, { status: 500 }))
    });
    const failedError = await failed.exchangeAuthorizationCode(authorizationInput()).catch((error: unknown) => error);
    expect((failedError as Error).message).toBe("MCP_OAUTH_TOKEN_EXCHANGE_FAILED");
    expect((failedError as Error).message).not.toContain(remoteSecret);
  });

  it("wipes every streamed response chunk after successful and invalid parsing", async () => {
    const successChunks = [
      new TextEncoder().encode('{"access_token":"access-'),
      new TextEncoder().encode('secret"}')
    ];
    const success = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(streamResponse(successChunks))
    });
    await expect(success.exchangeAuthorizationCode(authorizationInput()))
      .resolves.toEqual({ accessToken: "access-secret" });
    expect(successChunks.every(isZeroed)).toBe(true);

    const invalidChunks = [
      new Uint8Array([0xff, 0xfe]),
      new TextEncoder().encode("remote-secret")
    ];
    const invalid = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(streamResponse(invalidChunks))
    });
    await expect(invalid.exchangeAuthorizationCode(authorizationInput()))
      .rejects.toThrow("MCP_OAUTH_TOKEN_RESPONSE_INVALID");
    expect(invalidChunks.every(isZeroed)).toBe(true);
  });

  it("fails closed when a remote error or oversized response cannot be cancelled", async () => {
    const failed = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("remote-secret"));
        },
        cancel() {
          throw new Error("cancel failed with remote-secret");
        }
      }), { status: 500 }))
    });
    await expect(failed.exchangeAuthorizationCode(authorizationInput()))
      .rejects.toThrow("MCP_OAUTH_TOKEN_RESPONSE_CLEANUP_FAILED");

    const oversizedChunk = new TextEncoder().encode("oversized-secret");
    const oversized = new McpOAuthHttpTokenExchange({
      fetch: vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversizedChunk);
        },
        cancel() {
          throw new Error("cancel failed");
        }
      }))),
      maxResponseBytes: 4
    });
    await expect(oversized.exchangeAuthorizationCode(authorizationInput()))
      .rejects.toThrow("MCP_OAUTH_TOKEN_RESPONSE_CLEANUP_FAILED");
    expect(isZeroed(oversizedChunk)).toBe(true);
  });

  it("passes AbortSignal to the controlled request and preserves caller cancellation", async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string | URL, init?: RequestInit) => {
      seenSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const exchange = new McpOAuthHttpTokenExchange({ fetch });
    const pending = exchange.exchangeAuthorizationCode({ ...authorizationInput(), signal: controller.signal });
    const reason = new Error("conversation stopped");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(seenSignals).toEqual([controller.signal]);
  });

  it("builds production exchange requests through the DNS-pinned controlled fetch", async () => {
    const resolve = vi.fn().mockResolvedValue(["93.184.216.34"]);
    const fetchPinned = vi.fn().mockResolvedValue(jsonResponse({ access_token: "access" }));
    const exchange = createControlledMcpOAuthTokenExchange({ resolve, fetchPinned });

    await expect(exchange.exchangeAuthorizationCode(authorizationInput()))
      .resolves.toEqual({ accessToken: "access" });
    expect(resolve).toHaveBeenCalledWith("auth.example.test");
    expect(fetchPinned).toHaveBeenCalledWith(
      expect.objectContaining({ href: TOKEN_ENDPOINT }),
      expect.objectContaining({ method: "POST", redirect: "manual", credentials: "omit" }),
      ["93.184.216.34"]
    );
  });
});

function authorizationInput() {
  return {
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "sunabot-client",
    code: "authorization-code",
    codeVerifier: CODE_VERIFIER,
    redirectUri: REDIRECT_URI,
    resource: RESOURCE
  };
}

function refreshInput() {
  return {
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "sunabot-client",
    refreshToken: "refresh-secret",
    resource: RESOURCE
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function streamResponse(chunks: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }));
}

function isZeroed(bytes: Uint8Array) {
  return bytes.every((value) => value === 0);
}
