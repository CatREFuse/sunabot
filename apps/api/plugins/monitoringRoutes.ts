import type { FastifyInstance } from "fastify";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import type { ConfigService } from "../../../src/admin/configService.js";
import type { MonitorSettingsStore } from "../../../src/admin/monitorSettings.js";
import type { SunaRuntime } from "../../../src/runtime.js";
import type { ServiceMonitor } from "../../../src/serviceMonitor.js";

export interface MonitoringRouteOptions {
  startedAt: string;
  getConfigPath(): string;
  monitorSettings: MonitorSettingsStore;
  serviceMonitor: ServiceMonitor;
  onebotGateway: OneBotGateway;
  getOnebotStatus?: (agentId: string) => ReturnType<OneBotGateway["getStatus"]>;
  runtime: SunaRuntime;
  getRuntime?: (agentId: string) => SunaRuntime;
  configService: ConfigService;
}

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;

export function registerMonitoringRoutes(app: FastifyInstance, options: MonitoringRouteOptions) {
  app.get("/api/monitoring/settings", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.monitorSettings.publicSettings());

  app.put("/api/monitoring/settings", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => options.monitorSettings.update(request.body as never));

  app.post("/api/monitoring/test", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.serviceMonitor.testNotification());

  app.get("/api/status", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const agentId = requestAgentId(request.query);
    const runtime = options.getRuntime?.(agentId) ?? options.runtime;
    return {
    startedAt: options.startedAt,
    configPath: options.getConfigPath(),
    onebot: options.getOnebotStatus?.(agentId) ?? options.onebotGateway.getStatus(),
    persona: runtime.getPersonaStatus(),
    provider: runtime.getProviderStatus(),
    recovery: options.configService.getRecoveryStatus()
    };
  });
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
}
