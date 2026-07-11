// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuthRoutes } from "../../apps/api/plugins/authRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("admin auth API plugin", () => {
  it("registers request and response schemas and preserves auth responses", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));

    const authorize = vi.fn(async () => undefined);
    const logout = vi.fn();
    const tripFuse = vi.fn(async () => undefined);
    const getFuseStatus = vi.fn(() => ({ manual: false, automatic: false }));
    registerAuthRoutes(app, {
      authorize,
      getSessionStatus: vi.fn(() => ({ authenticated: false })),
      login: vi.fn(async () => ({
        authenticated: true,
        username: "admin",
        csrfToken: "csrf-token",
        expiresAt: "2026-07-11T00:00:00.000Z"
      })),
      logout,
      getFuseStatus,
      tripFuse
    });

    const session = await app.inject({ method: "GET", url: "/api/auth/session" });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "test-password" }
    });
    const security = await app.inject({ method: "GET", url: "/api/auth/security" });
    const fuse = await app.inject({ method: "POST", url: "/api/auth/fuse" });
    const logoutResponse = await app.inject({ method: "POST", url: "/api/auth/logout" });

    expect(session.json()).toEqual({ authenticated: false });
    expect(login.json()).toMatchObject({ authenticated: true, username: "admin", csrfToken: "csrf-token" });
    expect(security.json()).toEqual({ fuse: { manual: false, automatic: false } });
    expect(fuse.json()).toEqual({ ok: true, fuse: { manual: false, automatic: false } });
    expect(logoutResponse.statusCode).toBe(204);
    expect(logoutResponse.body).toBe("");
    expect(authorize).toHaveBeenCalled();
    expect(tripFuse).toHaveBeenCalledWith("webui-emergency");
    expect(logout).toHaveBeenCalledOnce();

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/auth/fuse",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/security",
      "/api/auth/session"
    ]);
    for (const schema of routeSchemas.values()) {
      expect(schema.response).toBeDefined();
      expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
    }
  });
});
