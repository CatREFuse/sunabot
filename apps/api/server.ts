import http from "node:http";
import path from "node:path";
import fs, { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { AgentFileRepository } from "../../src/admin/agentFiles.js";
import { AdminAuthService } from "../../src/admin/auth.js";
import { ConfigService } from "../../src/admin/configService.js";
import { CodexAuthService } from "../../src/admin/codexAuth.js";
import { MonitorSettingsStore } from "../../src/admin/monitorSettings.js";
import { getConfigPath, getRootDir, getWorkspacePath, loadConfig } from "../../src/config.js";
import {
  closeApplicationDataStores,
  sqliteMemoryPersistence
} from "../../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { OutboundMediaDelivery } from "../../services/delivery/outboundMedia.js";
import { SunaRuntime } from "../../src/runtime.js";
import { ServiceMonitor } from "../../src/serviceMonitor.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { registerAgentToolRoutes } from "./plugins/agentToolRoutes.js";
import { registerAuthRoutes } from "./plugins/authRoutes.js";
import { registerConversationRoutes } from "./plugins/conversationRoutes.js";
import { registerMediaRoutes } from "./plugins/mediaRoutes.js";
import { registerMemoryRoutes } from "./plugins/memoryRoutes.js";
import { registerMonitoringRoutes } from "./plugins/monitoringRoutes.js";
import { registerOneBotRoutes } from "./plugins/onebotRoutes.js";
import { registerProviderConfigRoutes } from "./plugins/providerConfigRoutes.js";
import type { AppConfig, ProviderConfig } from "../../src/types.js";

export interface CreateAppOptions {
  config?: AppConfig;
  initializeRuntime?: boolean;
  logger?: boolean;
  outboundMedia?: OutboundMediaDelivery;
  testProvider?: (provider: ProviderConfig) => Promise<Record<string, unknown>>;
}

export interface BuiltApp {
  app: FastifyInstance;
  runtime: SunaRuntime;
  onebotGateway: OneBotGateway;
  outboundMedia: OutboundMediaDelivery;
  serviceMonitor: ServiceMonitor;
  getConfig(): AppConfig;
}

export async function buildApp(options: CreateAppOptions = {}): Promise<BuiltApp> {
  configureMemoryPersistence(sqliteMemoryPersistence);
  const startedAt = new Date().toISOString();
  let config = options.config ?? await loadConfig();
  const outboundMedia = options.outboundMedia ?? new OutboundMediaDelivery({
    rootDir: getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
  });
  const runtime = new SunaRuntime(config);
  if (options.initializeRuntime !== false) await runtime.initialize();

  const adminAuth = await AdminAuthService.create({
    credentialsPath: getWorkspacePath(WORKSPACE_LAYOUT.adminCredentials),
    fusePath: getWorkspacePath(WORKSPACE_LAYOUT.adminFuse),
    bearerToken: process.env.SUNABOT_ADMIN_TOKEN,
    allowedOrigins: (process.env.SUNABOT_ADMIN_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  });
  const codexAuth = new CodexAuthService({
    codexHome: getWorkspacePath(WORKSPACE_LAYOUT.codexHome),
    executable: process.env.SUNABOT_CODEX_EXECUTABLE
  });

  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  const monitorSettings = new MonitorSettingsStore(getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv));
  const onebotGateway = new OneBotGateway(app.server as http.Server, config, runtime, { outboundMedia });
  const conversationDirectory = new ConversationDirectory({
    cachePath: getWorkspacePath(WORKSPACE_LAYOUT.conversationDirectoryCache)
  });
  onebotGateway.on("connected", () => runtime.resumeUserGroupOrchestrators(onebotGateway));
  onebotGateway.on("disconnected", () => runtime.suspendUserGroupOrchestrators());
  onebotGateway.mount();
  const activeReverseWsPath = config.onebot.reverseWsPath;
  const serviceMonitor = new ServiceMonitor(runtime, onebotGateway, monitorSettings);
  app.addHook("onClose", async () => {
    codexAuth.close();
    serviceMonitor.close();
    runtime.close();
    closeApplicationDataStores();
  });
  const agentFiles = new AgentFileRepository({ runtime });
  const configService = new ConfigService({
    prepareApply: async (candidate) => {
      await agentFiles.validateConfig(candidate);
      const agentFileRevisions = await agentFiles.captureConfigRevisions(candidate);
      const snapshot = await runtime.prepareReload(candidate);
      return {
        verify() {
          return agentFiles.assertConfigRevisions(candidate, agentFileRevisions);
        },
        async commit() {
          await runtime.ensureAgentPromptFiles(candidate);
          runtime.commitReload(snapshot);
          onebotGateway.updateConfig({
            ...candidate,
            onebot: { ...candidate.onebot, reverseWsPath: activeReverseWsPath }
          });
          config = candidate;
        }
      };
    }
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ServiceError) {
      if (error.statusCode === 401 && request.headers.authorization) {
        reply.header("www-authenticate", "Bearer");
      }
      return reply.status(error.statusCode).send(error.toJSON());
    }
    const genericError = error as { statusCode?: number; message?: string };
    const statusCode = typeof genericError.statusCode === "number" && genericError.statusCode >= 400 && genericError.statusCode < 500
      ? genericError.statusCode
      : 500;
    const message = statusCode === 500 ? "服务器处理请求失败。" : genericError.message ?? "请求失败。";
    requestLogError(error);
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 404 ? "NOT_FOUND" : statusCode === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
        message
      }
    });
  });

  registerAuthRoutes(app, adminAuth);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if ((request.raw.url ?? request.url).startsWith("/api/")) reply.header("cache-control", "no-store");
    if (request.headers["x-forwarded-proto"] === "https") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  registerMonitoringRoutes(app, {
    startedAt,
    getConfigPath,
    monitorSettings,
    serviceMonitor,
    onebotGateway,
    runtime,
    configService
  });

  await app.register(fastifyStatic, {
    root: getWorkspacePath(WORKSPACE_LAYOUT.mediaImages),
    prefix: "/generated-images/",
    decorateReply: false
  });

  const webDist = path.join(getRootDir(), "apps/admin-web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/"
    });
  }

  registerConversationRoutes(app, { runtime, onebotGateway, conversationDirectory });
  registerMediaRoutes(app, { getConfig: () => config, runtime });
  registerOneBotRoutes(app, onebotGateway);
  registerProviderConfigRoutes(app, { codexAuth, configService, testProvider: options.testProvider });
  registerMemoryRoutes(app, { getConfig: () => config, runtime });
  registerAgentToolRoutes(app, { agentFiles });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const indexPath = path.join(webDist, "index.html");
    if (request.method === "GET" && isSpaRoute(pathname) && existsSync(indexPath)) {
      return reply.type("text/html; charset=utf-8").send(fs.createReadStream(indexPath));
    }
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "请求的资源不存在。" } });
  });

  return {
    app,
    runtime,
    onebotGateway,
    outboundMedia,
    serviceMonitor,
    getConfig: () => config
  };
}

export async function createApp(options: CreateAppOptions = {}) {
  return (await buildApp(options)).app;
}

export async function startServer() {
  const built = await buildApp({ logger: true });
  const config = built.getConfig();
  await built.app.listen({ host: config.server.host, port: config.server.port });
  built.serviceMonitor.start();
  const address = `http://${config.server.host}:${config.server.port}`;
  console.log(`sunabot listening on ${address}`);
  console.log(`onebot reverse ws: ws://${config.server.host}:${config.server.port}${config.onebot.reverseWsPath}`);
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isDirectExecution) {
  void startServer().catch((error) => {
    console.error("sunabot failed to start", error);
    process.exitCode = 1;
  });
}

function requestLogError(error: unknown) {
  console.error("[server] request failed", error);
}

function isSpaRoute(pathname: string) {
  return pathname === "/" || ["overview", "conversations", "prompts", "memory", "images", "settings"]
    .some((segment) => pathname === `/${segment}` || pathname.startsWith(`/${segment}/`));
}
