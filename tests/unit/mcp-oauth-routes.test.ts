// @vitest-environment node
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentMcpOAuthRoutes } from "../../apps/api/plugins/agentMcpOAuthRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("MCP OAuth admin routes", () => {
  it("binds begin to the authenticated browser session without accepting secret values", async () => {
    const service = serviceMock();
    service.begin.mockResolvedValue({
      authorizationUrl: "https://auth.example.test/authorize?opaque=1",
      authorizationOrigin: "https://auth.example.test",
      expiresAt: "2026-07-17T00:05:00.000Z",
      credentialHandle: "must-not-leak"
    });
    const app = Fastify();
    apps.push(app);
    registerAgentMcpOAuthRoutes(app, {
      service: service as never,
      adminGuard: vi.fn(async () => undefined) as never,
      browserSessionId: () => "session:browser-a"
    });
    const payload = {
      agentId: "agent-a",
      serverId: "server-a",
      authorizationEndpoint: "https://auth.example.test/authorize",
      tokenEndpoint: "https://auth.example.test/token",
      clientId: "client-a",
      scopes: ["tools"]
    };
    const response = await app.inject({
      method: "POST", url: "/api/agent-extensions/mcp/oauth/begin", payload
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authorizationUrl: "https://auth.example.test/authorize?opaque=1",
      authorizationOrigin: "https://auth.example.test",
      expiresAt: "2026-07-17T00:05:00.000Z"
    });
    expect(service.begin).toHaveBeenCalledWith({
      ...payload,
      browserSessionId: "session:browser-a",
      signal: expect.any(AbortSignal)
    });
    expect(response.body).not.toContain("must-not-leak");

    const injected = await app.inject({
      method: "POST",
      url: "/api/agent-extensions/mcp/oauth/begin",
      payload: { ...payload, accessToken: "secret-token" }
    });
    expect(injected.statusCode).toBe(400);
    expect(injected.body).not.toContain("secret-token");
    expect(service.begin).toHaveBeenCalledOnce();
  });

  it("routes refresh/revoke and fails closed when the encrypted vault is not configured", async () => {
    const service = serviceMock();
    service.refresh.mockResolvedValue({ ok: true });
    service.revoke.mockResolvedValue({ ok: true });
    const app = Fastify();
    apps.push(app);
    registerAgentMcpOAuthRoutes(app, {
      service: service as never,
      adminGuard: vi.fn(async () => undefined) as never,
      browserSessionId: () => "session:browser-a"
    });
    const target = { agentId: "agent-a", serverId: "server-a" };
    expect((await app.inject({
      method: "POST", url: "/api/agent-extensions/mcp/oauth/refresh", payload: target
    })).statusCode).toBe(200);
    expect(service.refresh).toHaveBeenCalledWith({ ...target, signal: expect.any(AbortSignal) });
    expect((await app.inject({
      method: "POST", url: "/api/agent-extensions/mcp/oauth/revoke", payload: target
    })).statusCode).toBe(200);
    expect(service.revoke).toHaveBeenCalledWith(target);

    const unavailable = Fastify();
    apps.push(unavailable);
    registerAgentMcpOAuthRoutes(unavailable, {
      adminGuard: vi.fn(async () => undefined) as never,
      browserSessionId: () => "session:browser-a"
    });
    const response = await unavailable.inject({
      method: "POST", url: "/api/agent-extensions/mcp/oauth/refresh", payload: target
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "MCP_OAUTH_UNAVAILABLE" });
  });
});

function serviceMock() {
  return { begin: vi.fn(), refresh: vi.fn(), revoke: vi.fn() };
}
