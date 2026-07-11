// @vitest-environment node
import Fastify, { type FastifySchema } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMonitoringRoutes } from "../../apps/api/plugins/monitoringRoutes.js";
import type { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import type { ConfigService } from "../../src/admin/configService.js";
import type { MonitorSettingsStore } from "../../src/admin/monitorSettings.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { ServiceMonitor } from "../../src/serviceMonitor.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("monitoring API plugin", () => {
  it("registers schemas and composes status without owning lifecycle", async () => {
    const routeSchemas = new Map<string, FastifySchema>();
    const app = Fastify();
    apps.push(app);
    app.addHook("onRoute", (route) => routeSchemas.set(route.url, route.schema ?? {}));

    const publicSettings = vi.fn(async () => ({ barkUrlConfigured: false }));
    const update = vi.fn(async (body: unknown) => ({ ok: true, ...body as object }));
    const testNotification = vi.fn(async () => ({ ok: true, delivered: true }));
    registerMonitoringRoutes(app, {
      startedAt: "2026-07-12T00:00:00.000Z",
      getConfigPath: () => "/workspace/business/config/sunabot.json",
      monitorSettings: { publicSettings, update } as unknown as MonitorSettingsStore,
      serviceMonitor: { testNotification } as unknown as ServiceMonitor,
      onebotGateway: { getStatus: () => ({ connected: true }) } as unknown as OneBotGateway,
      runtime: {
        getPersonaStatus: () => ({ ready: true }),
        getProviderStatus: () => ({ ready: true })
      } as unknown as SunaRuntime,
      configService: { getRecoveryStatus: () => ({ required: false }) } as unknown as ConfigService
    });

    expect((await app.inject({ method: "GET", url: "/api/monitoring/settings" })).json())
      .toEqual({ barkUrlConfigured: false });
    const settingsBody = { barkUrl: "" };
    expect((await app.inject({ method: "PUT", url: "/api/monitoring/settings", payload: settingsBody })).json())
      .toEqual({ ok: true, barkUrl: "" });
    expect(update).toHaveBeenCalledWith(settingsBody);
    expect((await app.inject({ method: "POST", url: "/api/monitoring/test" })).json())
      .toEqual({ ok: true, delivered: true });

    expect((await app.inject({ method: "GET", url: "/api/status" })).json()).toMatchObject({
      startedAt: "2026-07-12T00:00:00.000Z",
      configPath: "/workspace/business/config/sunabot.json",
      onebot: { connected: true },
      persona: { ready: true },
      provider: { ready: true },
      recovery: { required: false }
    });

    expect([...routeSchemas.keys()].sort()).toEqual([
      "/api/monitoring/settings",
      "/api/monitoring/test",
      "/api/status"
    ]);
    assertRequestAndResponseSchemas(routeSchemas);
  });
});

function assertRequestAndResponseSchemas(routeSchemas: Map<string, FastifySchema>) {
  for (const schema of routeSchemas.values()) {
    expect(schema.response).toBeDefined();
    expect(schema.body ?? schema.querystring ?? schema.params).toBeDefined();
  }
}
