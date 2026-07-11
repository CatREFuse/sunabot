// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProviderConfigRoutes } from "../../apps/api/plugins/providerConfigRoutes.js";
import { defaultConfig } from "../../src/config.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("provider and config API plugin", () => {
  it("registers request and response schemas and delegates each route", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));

    const config = defaultConfig();
    const readEnvelope = vi.fn(async () => ({ config, revision: "revision", fieldStates: {} }));
    const patchGroupReply = vi.fn(async () => ({ ok: true, applyMode: "hot" }));
    const patch = vi.fn(async () => ({ ok: true, applyMode: "hot" }));
    const testProvider = vi.fn(async () => ({ connected: true }));
    const authSnapshot = {
      installed: true,
      authenticated: true,
      method: "chatgpt",
      login: { state: "idle" as const }
    };
    registerProviderConfigRoutes(app, {
      codexAuth: {
        status: vi.fn(async () => authSnapshot),
        startLogin: vi.fn(async () => ({ ...authSnapshot, login: { state: "waiting" as const } })),
        logout: vi.fn(async () => ({ ...authSnapshot, authenticated: false }))
      },
      configService: { readEnvelope, patchGroupReply, patch },
      testProvider
    });

    expect((await app.inject({ method: "GET", url: "/api/codex-auth/status" })).json())
      .toMatchObject({ installed: true, authenticated: true });
    expect((await app.inject({ method: "POST", url: "/api/codex-auth/login" })).json().login.state)
      .toBe("waiting");
    expect((await app.inject({ method: "POST", url: "/api/codex-auth/logout" })).json().authenticated)
      .toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/config" })).json().revision).toBe("revision");

    const groupReplyBody = { revision: "revision", value: { enabled: true } };
    expect((await app.inject({
      method: "PATCH",
      url: "/api/config/group-reply",
      payload: groupReplyBody
    })).json()).toMatchObject({ ok: true, applyMode: "hot" });
    expect(patchGroupReply).toHaveBeenCalledWith(groupReplyBody);

    const sectionBody = { revision: "revision", value: config.providers };
    expect((await app.inject({
      method: "PATCH",
      url: "/api/config/providers",
      payload: sectionBody
    })).json()).toMatchObject({ ok: true, applyMode: "hot" });
    expect(patch).toHaveBeenCalledWith("providers", sectionBody);

    const models = await app.inject({ method: "GET", url: "/api/models" });
    expect(models.json()).toMatchObject({
      models: expect.any(Array),
      reasoningEfforts: expect.any(Array),
      imageModels: expect.any(Array)
    });

    const providerTest = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { provider: config.providers.items[0] }
    });
    expect(providerTest.statusCode).toBe(200);
    expect(providerTest.json()).toMatchObject({
      connected: true,
      ok: true,
      model: config.providers.items[0]?.model,
      elapsedMs: expect.any(Number)
    });
    expect(testProvider).toHaveBeenCalledWith(config.providers.items[0]);

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/codex-auth/login",
      "/api/codex-auth/logout",
      "/api/codex-auth/status",
      "/api/config",
      "/api/config/:section",
      "/api/config/group-reply",
      "/api/models",
      "/api/providers/test"
    ]);
    for (const schema of routeSchemas.values()) {
      expect(schema.response).toBeDefined();
      expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
    }
  });

  it("keeps provider connection failures mapped to 422", async () => {
    const app = Fastify();
    apps.push(app);
    const config = defaultConfig();
    registerProviderConfigRoutes(app, {
      codexAuth: {
        status: vi.fn(async () => ({ installed: false, authenticated: false, login: { state: "idle" } })),
        startLogin: vi.fn(async () => ({ installed: false, authenticated: false, login: { state: "failed" } })),
        logout: vi.fn(async () => ({ installed: false, authenticated: false, login: { state: "idle" } }))
      },
      configService: {
        readEnvelope: vi.fn(),
        patchGroupReply: vi.fn(),
        patch: vi.fn()
      },
      testProvider: vi.fn(async () => {
        throw new Error("fetch failed");
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { provider: config.providers.items[0] }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toBe("fetch failed");
  });
});
