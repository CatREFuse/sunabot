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
import { SelfieReferenceRepository } from "../../src/admin/selfieReferences.js";
import { getConfigPath, getRootDir, getWorkspacePath, loadConfig } from "../../src/config.js";
import {
  closeApplicationDataStores,
  sqliteMemoryPersistence
} from "../../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import {
  OutboundMediaDelivery,
  outboundMediaMaxInlineBytes,
  outboundMediaReferenceMode
} from "../../services/delivery/outboundMedia.js";
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
import { registerSelfieReferenceRoutes } from "./plugins/selfieReferenceRoutes.js";
import type { AppConfig, ProviderConfig } from "../../src/types.js";

export interface CreateAppOptions {
  config?: AppConfig;
  initializeRuntime?: boolean;
  logger?: boolean;
  outboundMedia?: OutboundMediaDelivery;
  onebotListener?: false | {
    server?: http.Server;
    host?: string;
    port?: number;
  };
  testProvider?: (provider: ProviderConfig) => Promise<Record<string, unknown>>;
}

export interface OneBotListenerAddress {
  host: string;
  port: number;
}

export interface BuiltApp {
  app: FastifyInstance;
  runtime: SunaRuntime;
  onebotGateway: OneBotGateway;
  onebotServer?: http.Server;
  outboundMedia: OutboundMediaDelivery;
  serviceMonitor: ServiceMonitor;
  getConfig(): AppConfig;
  startOneBotListener(address?: Partial<OneBotListenerAddress>): Promise<OneBotListenerAddress>;
}

export async function buildApp(options: CreateAppOptions = {}): Promise<BuiltApp> {
  configureMemoryPersistence(sqliteMemoryPersistence);
  const startedAt = new Date().toISOString();
  let config = options.config ?? await loadConfig();
  const outboundMedia = options.outboundMedia ?? new OutboundMediaDelivery({
    rootDir: getWorkspacePath(WORKSPACE_LAYOUT.mediaImages),
    referenceMode: outboundMediaReferenceMode(),
    maxInlineBytes: outboundMediaMaxInlineBytes()
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
  const listenerOptions = options.onebotListener === false ? undefined : options.onebotListener;
  const onebotServer = options.onebotListener === false
    ? undefined
    : listenerOptions?.server ?? createOneBotHttpServer();
  const gatewayServer = onebotServer ?? http.createServer();
  const onebotGateway = new OneBotGateway(gatewayServer, config, runtime, { outboundMedia });
  const conversationDirectory = new ConversationDirectory({
    cachePath: getWorkspacePath(WORKSPACE_LAYOUT.conversationDirectoryCache)
  });
  onebotGateway.on("connected", () => runtime.resumeUserGroupOrchestrators(onebotGateway));
  onebotGateway.on("disconnected", () => runtime.suspendUserGroupOrchestrators());
  if (onebotServer) onebotGateway.mount();
  const activeReverseWsPath = config.onebot.reverseWsPath;
  const serviceMonitor = new ServiceMonitor(runtime, onebotGateway, monitorSettings);
  app.addHook("onClose", async () => {
    await onebotGateway.close();
    await closeHttpServer(onebotServer);
    codexAuth.close();
    serviceMonitor.close();
    runtime.close();
    closeApplicationDataStores();
  });
  const agentFiles = new AgentFileRepository({ runtime });
  const selfieReferences = new SelfieReferenceRepository({ getConfig: () => config });
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
    if ((request.raw.url ?? request.url).startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
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
    decorateReply: false,
    maxAge: "7d"
  });

  const webDist = path.join(getRootDir(), "apps/admin-web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      setHeaders(response, filePath) {
        response.setHeader("cache-control", path.basename(filePath) === "index.html"
          ? "no-cache"
          : "public, max-age=31536000, immutable");
      }
    });
  }

  registerConversationRoutes(app, { runtime, onebotGateway, conversationDirectory });
  registerMediaRoutes(app, { getConfig: () => config, runtime });
  registerOneBotRoutes(app, onebotGateway);
  registerProviderConfigRoutes(app, { codexAuth, configService, testProvider: options.testProvider });
  registerMemoryRoutes(app, { getConfig: () => config, runtime });
  registerAgentToolRoutes(app, { agentFiles, getConfig: () => config });
  registerSelfieReferenceRoutes(app, { repository: selfieReferences });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const indexPath = path.join(webDist, "index.html");
    if (request.method === "GET" && isSpaRoute(pathname) && existsSync(indexPath)) {
      return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(fs.createReadStream(indexPath));
    }
    return reply.status(404).send({ error: { code: "NOT_FOUND", message: "请求的资源不存在。" } });
  });

  return {
    app,
    runtime,
    onebotGateway,
    onebotServer,
    outboundMedia,
    serviceMonitor,
    getConfig: () => config,
    async startOneBotListener(address = {}) {
      if (!onebotServer) {
        throw new Error("OneBot listener is disabled for this application instance.");
      }
      assertOneBotAccessToken(config);
      if (onebotServer.listening) {
        throw new Error("OneBot listener is already running.");
      }
      const defaults = resolveOneBotListenerAddress();
      const host = address.host ?? listenerOptions?.host ?? defaults.host;
      const port = address.port ?? listenerOptions?.port ?? defaults.port;
      validateListenerAddress(host, port, address.port != null || listenerOptions?.port != null);
      await listenHttpServer(onebotServer, host, port);
      const boundAddress = onebotServer.address();
      if (!boundAddress || typeof boundAddress === "string") {
        throw new Error("OneBot listener did not expose a TCP address.");
      }
      return { host, port: boundAddress.port };
    }
  };
}

export async function createApp(options: CreateAppOptions = {}) {
  return (await buildApp(options)).app;
}

export async function startServer() {
  const config = await loadConfig();
  assertOneBotAccessToken(config);
  const built = await buildApp({ config, logger: true });
  const removeShutdownHandlers = installShutdownHandlers(built);
  built.app.addHook("onClose", async () => removeShutdownHandlers());
  try {
    const onebotAddress = await built.startOneBotListener();
    await built.app.listen({ host: config.server.host, port: config.server.port });
    built.serviceMonitor.start();
    console.log(`sunabot listening on http://${formatHost(config.server.host)}:${config.server.port}`);
    console.log(
      `onebot reverse ws: ws://${formatHost(onebotAddress.host)}:${onebotAddress.port}${config.onebot.reverseWsPath}`
    );
    return built;
  } catch (error) {
    await built.app.close();
    throw error;
  }
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
  return pathname === "/" || ["overview", "conversations", "web-chat", "prompts", "memory", "images", "logs", "settings"]
    .some((segment) => pathname === `/${segment}` || pathname.startsWith(`/${segment}/`));
}

export function assertOneBotAccessToken(
  config: Pick<AppConfig, "onebot">,
  env: NodeJS.ProcessEnv = process.env
) {
  const variable = config.onebot.accessTokenEnv;
  if (env[variable]?.trim()) return;
  throw new Error(
    `Cannot start the OneBot listener: ${variable} is required. ` +
    "Configure the same non-empty token in Sunabot Core and NapCat."
  );
}

export function resolveOneBotListenerAddress(
  env: { SUNABOT_ONEBOT_HOST?: string; SUNABOT_ONEBOT_PORT?: string } = process.env
): OneBotListenerAddress {
  const host = env.SUNABOT_ONEBOT_HOST?.trim() || "127.0.0.1";
  const rawPort = env.SUNABOT_ONEBOT_PORT?.trim() || "8788";
  const port = Number(rawPort);
  validateListenerAddress(host, port, false);
  return { host, port };
}

function validateListenerAddress(host: string, port: number, allowEphemeralPort: boolean) {
  if (!host.trim()) throw new Error("SUNABOT_ONEBOT_HOST must not be empty.");
  const minimum = allowEphemeralPort ? 0 : 1;
  if (!Number.isSafeInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`SUNABOT_ONEBOT_PORT must be an integer between ${minimum} and 65535.`);
  }
}

function createOneBotHttpServer() {
  return http.createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?", 1)[0] === "/healthz") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end("ONEBOT_WEBSOCKET_UPGRADE_REQUIRED\n");
  });
}

function listenHttpServer(server: http.Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeHttpServer(server: http.Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function formatHost(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function installShutdownHandlers(built: BuiltApp) {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise) return;
    shutdownPromise = (async () => {
      await built.serviceMonitor.notifyShutdown(signal);
      await built.app.close();
    })().catch((error) => {
      console.error("sunabot graceful shutdown failed", error);
      process.exitCode = 1;
    });
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}
