import http from "node:http";
import path from "node:path";
import fs, { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { AgentFileRepository } from "../../src/admin/agentFiles.js";
import { AdminAuthService } from "../../src/admin/auth.js";
import { ConfigService } from "../../src/admin/configService.js";
import { ConfigDoctorService, type ConfigDoctorModelRunner } from "../../src/admin/configDoctor.js";
import { AgentConfigService } from "../../src/admin/agentConfigService.js";
import { SystemConfigService } from "../../src/admin/systemConfigService.js";
import { CodexAuthService } from "../../src/admin/codexAuth.js";
import { MonitorSettingsStore } from "../../src/admin/monitorSettings.js";
import { SelfieReferenceRepository } from "../../src/admin/selfieReferences.js";
import {
  getConfigPath,
  getRootDir,
  getWorkspaceDir,
  getWorkspacePath,
  loadConfig,
  resolveProjectPath
} from "../../src/config.js";
import {
  applicationDatabasePath,
  applicationDataStore,
  closeApplicationDataStores,
  sqliteMemoryPersistence
} from "../../adapters/sqlite/applicationDataStore.js";
import { SqliteAdminSessionStore } from "../../adapters/sqlite/adminSessionStore.js";
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
import { registerAgentRoutes } from "./plugins/agentRoutes.js";
import { registerAuthRoutes } from "./plugins/authRoutes.js";
import { registerConversationRoutes } from "./plugins/conversationRoutes.js";
import { registerConfigDoctorRoutes } from "./plugins/configDoctorRoutes.js";
import { registerMediaRoutes } from "./plugins/mediaRoutes.js";
import { registerMemoryRoutes } from "./plugins/memoryRoutes.js";
import { registerMonitoringRoutes } from "./plugins/monitoringRoutes.js";
import { registerOneBotRoutes } from "./plugins/onebotRoutes.js";
import { registerProviderConfigRoutes } from "./plugins/providerConfigRoutes.js";
import { registerSelfieReferenceRoutes } from "./plugins/selfieReferenceRoutes.js";
import type { AppConfig, ProviderConfig } from "../../src/types.js";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { AgentRegistry, type AgentRegistryOptions } from "../../services/agents/agentRegistry.js";
import { AgentRuntimeManager } from "../../services/agents/agentRuntimeManager.js";
import {
  AccountRuntimeReconciler,
  type AccountRuntimeReconcilerPort,
  RuntimeProbeClient,
  type RuntimeProbeClientPort
} from "../../services/agents/accountRuntimeReconciler.js";
import { BroadcastStormDetector } from "../../services/orchestration/public.js";
import {
  createRuntimeToolCapabilityResolver,
  createWorkspaceBashCapabilityProbe
} from "../../services/tools/bashCapability.js";
import {
  inspectMultiAgentMigrationGate,
  validateMultiAgentWorkspacePath
} from "../../packages/platform/multiAgentMigrationGate.mjs";
import {
  completeFirstRunBootstrap,
  inspectFirstRunBootstrap
} from "../../tooling/runtime/first-run-state.mjs";
import { collectWorkspaceProbeFacts } from "../../tooling/runtime/probe.mjs";
import { buildRuntimeProbe } from "../../tooling/runtime/probe.mjs";
import type { SystemConfigRuntimePort } from "../../services/tools/systemConfigTool.js";

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
  configDoctorModelRunner?: ConfigDoctorModelRunner;
  agentRegistry?: Pick<AgentRegistryOptions, "workspaceRoot" | "allowUnmarkedMigration">;
  accountRuntimeReconciler?: false | AccountRuntimeReconcilerPort;
  runtimeProbeClient?: false | RuntimeProbeClientPort;
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
  agentRegistry: AgentRegistry;
  agentRuntimeManager: AgentRuntimeManager;
  getConfig(): AppConfig;
  startOneBotListener(address?: Partial<OneBotListenerAddress>): Promise<OneBotListenerAddress>;
}

export async function buildApp(options: CreateAppOptions = {}): Promise<BuiltApp> {
  const skipWorkspaceMigrationGate = options.agentRegistry?.allowUnmarkedMigration === true;
  if (skipWorkspaceMigrationGate) await validateMultiAgentWorkspacePath(getWorkspaceDir());
  else await assertRuntimeWorkspaceMigrationGate();
  configureMemoryPersistence(sqliteMemoryPersistence);
  const startedAt = new Date().toISOString();
  let config = options.config ?? await loadConfig();
  if (!skipWorkspaceMigrationGate) {
    const configuredAgentWorkspace = config.persona.agentWorkspace.replaceAll("\\", "/");
    const configuredSystemPrompts = config.persona.systemPromptWorkspace.replaceAll("\\", "/");
    if (
      config.persona.defaultAgentId !== "plana"
      || configuredAgentWorkspace !== `workspace/${WORKSPACE_LAYOUT.defaultAgent}`
      || configuredSystemPrompts !== `workspace/${WORKSPACE_LAYOUT.systemPrompts}`
    ) {
      throw new ServiceError(
        409,
        "AGENT_WORKSPACE_UNSUPPORTED",
        "Plana 与公共系统提示词必须使用标准 workspace 路径。"
      );
    }
    const activeDatabase = applicationDatabasePath(config);
    const canonicalDatabase = getWorkspacePath(WORKSPACE_LAYOUT.database);
    if (path.resolve(activeDatabase) !== path.resolve(canonicalDatabase)) {
      throw new ServiceError(
        409,
        "DATABASE_PATH_UNSUPPORTED",
        "主库必须位于 workspace/business/data/sunabot.sqlite。"
      );
    }
  }
  const agentRegistry = new AgentRegistry(config, {
    store: applicationDataStore(config),
    workspaceRoot: options.agentRegistry?.workspaceRoot ?? getWorkspacePath(WORKSPACE_LAYOUT.agentRoot),
    allowUnmarkedMigration: skipWorkspaceMigrationGate,
    workspaceGateAlreadyChecked: !skipWorkspaceMigrationGate
  });
  await agentRegistry.initialize();
  const defaultAgentConfig = await agentRegistry.config(config.persona.defaultAgentId, config);
  const broadcastStormDetector = new BroadcastStormDetector(config.broadcastStorm);
  const outboundMedia = options.outboundMedia ?? new OutboundMediaDelivery({
    rootDir: getWorkspacePath(WORKSPACE_LAYOUT.mediaImages),
    referenceMode: outboundMediaReferenceMode(),
    maxInlineBytes: outboundMediaMaxInlineBytes()
  });
  const codexAuth = new CodexAuthService({
    codexHome: getWorkspacePath(WORKSPACE_LAYOUT.codexHome),
    executable: process.env.SUNABOT_CODEX_EXECUTABLE
  });
  const probeWorkspaceBash = createWorkspaceBashCapabilityProbe();
  const toolCapabilitiesFor = (agentConfig: AppConfig) => createRuntimeToolCapabilityResolver({
    getCodexStatus: () => codexAuth.status(),
    getWorkspaceBashCapability: () => probeWorkspaceBash(
      resolveProjectPath(agentConfig.persona.agentWorkspace) ?? getRootDir()
    )
  });
  const resolveToolCapabilities = toolCapabilitiesFor(defaultAgentConfig);
  let systemConfigService: SystemConfigService | undefined;
  const systemConfigRuntime: SystemConfigRuntimePort = {
    createTurn(context) {
      if (!systemConfigService) throw new Error("System configuration service is not ready.");
      return systemConfigService.createTurn(context);
    }
  };
  const createRuntime = (agentConfig: AppConfig) => new SunaRuntime(agentConfig, {
    resolveToolCapabilities: toolCapabilitiesFor(agentConfig),
    systemConfig: systemConfigRuntime,
    replyTaskGate: broadcastStormDetector
  });
  const runtime = new SunaRuntime(defaultAgentConfig, {
    resolveToolCapabilities,
    systemConfig: systemConfigRuntime,
    replyTaskGate: broadcastStormDetector
  });
  if (options.initializeRuntime !== false) await runtime.initialize();
  const agentRuntimeManager = new AgentRuntimeManager(agentRegistry, {
    defaultRuntime: runtime,
    createRuntime,
    initializeRuntime: options.initializeRuntime !== false,
    broadcastStormDetector
  });
  await agentRuntimeManager.initialize();
  if (options.initializeRuntime !== false) {
    const firstRun = await completeFirstRunBootstrap(getWorkspaceDir());
    if (firstRun.state === "pending" && "missing" in firstRun && Array.isArray(firstRun.missing)) {
      throw new ServiceError(
        409,
        "FIRST_RUN_BOOTSTRAP_INCOMPLETE",
        `首次运行仍缺少持久化边界：${firstRun.missing.join(", ")}。`
      );
    }
  }

  const adminSessionStore = new SqliteAdminSessionStore(applicationDatabasePath(config));
  const adminAuth = await AdminAuthService.create({
    credentialsPath: getWorkspacePath(WORKSPACE_LAYOUT.adminCredentials),
    fusePath: getWorkspacePath(WORKSPACE_LAYOUT.adminFuse),
    bearerToken: process.env.SUNABOT_ADMIN_TOKEN,
    allowedOrigins: (process.env.SUNABOT_ADMIN_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    sessionStore: adminSessionStore
  });
  const app = Fastify({ logger: options.logger ?? false, trustProxy: false });
  const monitorSettings = new MonitorSettingsStore(getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv));
  const listenerOptions = options.onebotListener === false ? undefined : options.onebotListener;
  const onebotServer = options.onebotListener === false
    ? undefined
    : listenerOptions?.server ?? createOneBotHttpServer();
  const gatewayServer = onebotServer ?? http.createServer();
  const onebotGateway = new OneBotGateway(gatewayServer, config, agentRuntimeManager, {
    outboundMedia,
    isAccountAllowed: (accountId) => Boolean(agentRegistry.account(accountId))
  });
  const conversationDirectory = new ConversationDirectory({
    cachePath: getWorkspacePath(WORKSPACE_LAYOUT.conversationDirectoryCache)
  });
  onebotGateway.on("connected", () => agentRuntimeManager.resumeUserGroupOrchestrators(onebotGateway));
  onebotGateway.on("disconnected", () => agentRuntimeManager.suspendUserGroupOrchestrators());
  if (onebotServer) onebotGateway.mount();
  const activeReverseWsPath = config.onebot.reverseWsPath;
  const serviceMonitor = new ServiceMonitor(runtime, onebotGateway, monitorSettings);
  app.addHook("onClose", async () => {
    await onebotGateway.close();
    await closeHttpServer(onebotServer);
    codexAuth.close();
    adminSessionStore.close();
    serviceMonitor.close();
    await agentRuntimeManager.close();
    closeApplicationDataStores();
  });
  const agentFiles = new AgentFileRepository({ runtime });
  const selfieReferences = new Map<string, SelfieReferenceRepository>();
  const selfieReferencesFor = (agentId: string) => {
    const existing = selfieReferences.get(agentId);
    if (existing) return existing;
    const repository = new SelfieReferenceRepository({
      getConfig: () => agentId === config.persona.defaultAgentId
        ? config
        : agentRuntimeManager.require(agentId).config
    });
    selfieReferences.set(agentId, repository);
    return repository;
  };
  const configService = new ConfigService({
    getActiveConfig: () => config,
    prepareApply: async (candidate) => {
      const defaultCandidate = await agentRegistry.config(runtime.config.persona.defaultAgentId, candidate);
      await agentFiles.validateConfig(defaultCandidate);
      const agentFileRevisions = await agentFiles.captureConfigRevisions(defaultCandidate);
      const snapshot = await runtime.prepareReload(defaultCandidate);
      const custom = await Promise.all(agentRuntimeManager.entries()
        .filter(([agentId]) => agentId !== runtime.config.persona.defaultAgentId)
        .map(async ([agentId, agentRuntime]) => {
          const agentConfig = await agentRegistry.config(agentId, candidate);
          const repository = new AgentFileRepository({ runtime: agentRuntime });
          await repository.validateConfig(agentConfig);
          return {
            agentConfig,
            agentRuntime,
            repository,
            revisions: await repository.captureConfigRevisions(agentConfig),
            snapshot: await agentRuntime.prepareReload(agentConfig)
          };
        }));
      return {
        async verify() {
          await agentFiles.assertConfigRevisions(defaultCandidate, agentFileRevisions);
          await Promise.all(custom.map((item) => item.repository.assertConfigRevisions(item.agentConfig, item.revisions)));
        },
        async commit() {
          await runtime.ensureAgentPromptFiles(defaultCandidate);
          runtime.commitReload(snapshot);
          for (const item of custom) item.agentRuntime.commitReload(item.snapshot);
          onebotGateway.updateConfig({
            ...candidate,
            onebot: { ...candidate.onebot, reverseWsPath: activeReverseWsPath }
          });
          broadcastStormDetector.updateConfig(candidate.broadcastStorm);
          agentRegistry.updateSharedConfig(candidate);
          config = candidate;
        }
      };
    }
  });
  const configDoctorService = new ConfigDoctorService({
    configService,
    getActiveConfig: () => config,
    isModelAvailable: (provider) => new OpenAIProvider(provider).hasApiKey(),
    runModel: options.configDoctorModelRunner ?? (async ({ provider, request, signal }) => (
      new OpenAIProvider(provider).completeRequest(request, {
        signal,
        modelRequestMaxRetries: 0,
        logContext: { stage: "config_doctor", promptFamily: "config_doctor" }
      })
    ))
  });
  const agentConfigService = new AgentConfigService(agentRegistry, agentRuntimeManager, configService);
  const accountRuntimeReconciler = options.accountRuntimeReconciler === false
    ? undefined
    : options.accountRuntimeReconciler ?? new AccountRuntimeReconciler();
  const runtimeProbeClient = options.runtimeProbeClient === false
    ? undefined
    : options.runtimeProbeClient ?? new RuntimeProbeClient();
  const getOnebotStatus = (agentId: string) => {
    const status = onebotGateway.getStatus();
    const accounts = (status.accounts ?? []).filter((account) => agentRegistry.account(account.accountId)?.agentId === agentId);
    return {
      ...status,
      connected: accounts.length > 0,
      connections: accounts.length,
      selfIds: accounts.flatMap((account) => account.selfId ? [account.selfId] : []),
      accounts,
      connectedAt: accounts[0]?.connectedAt
    };
  };
  const getRuntimeProbeFacts = async (agentId: string) => {
    agentRuntimeManager.require(agentId);
    const status = onebotGateway.getStatus();
    const connectedAccountIds = (status.accounts ?? []).map((account) => account.accountId);
    if (runtimeProbeClient) {
      try {
        return await runtimeProbeClient.collectFacts({ connectedAccountIds });
      } catch (error) {
        console.error("[runtime-probe] host probe failed", error instanceof Error ? error.message : String(error));
      }
    }
    const facts = await collectWorkspaceProbeFacts({
      workspace: getWorkspaceDir(),
      connectedAccountIds,
      conflicts: [{
        id: "host-runtime-probe",
        code: "HOST_RUNTIME_PROBE_UNAVAILABLE",
        path: getWorkspacePath("runtime/launcher-state.json"),
        action: "./sunabot.sh restart",
        detail: "host runtime probe is unavailable"
      }]
    });
    const codex = await codexAuth.status();
    return {
      ...facts,
      core: {
        mode: process.env.SUNABOT_RUNTIME_MODE ?? "api",
        running: true,
        apiReady: true,
        onebotReady: onebotServer?.listening ?? false,
        apiPath: `http://${config.server.host}:${config.server.port}/api/auth/session`,
        onebotPath: activeReverseWsPath
      },
      dependencies: {
        node: { ok: process.versions.node === "24.18.0", detail: process.versions.node }
      },
      capabilities: {
        ...facts.capabilities,
        codexCli: { ok: codex.installed, detail: codex.installed ? "available" : "unavailable" },
        codexAuth: { ok: codex.authenticated, detail: codex.authenticated ? "authenticated" : "not authenticated" },
        accountReconciler: { ok: false, detail: "host reconciler is not running" }
      }
    };
  };
  systemConfigService = new SystemConfigService({
    registry: agentRegistry,
    agentConfigService,
    getRuntime: (agentId) => agentRuntimeManager.require(agentId),
    getOnebotStatus,
    getRuntimeProbe: async (agentId) => buildRuntimeProbe(await getRuntimeProbeFacts(agentId)),
    getRecoveryStatus: () => configService.getRecoveryStatus(),
    startedAt
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

  app.get("/healthz/runtime", async () => ({ schemaVersion: 1, live: true }));

  registerMonitoringRoutes(app, {
    startedAt,
    getConfigPath,
    monitorSettings,
    serviceMonitor,
    onebotGateway,
    getOnebotStatus,
    runtime,
    getRuntime: (agentId) => agentRuntimeManager.require(agentId),
    configService,
    getRuntimeProbeFacts
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

  registerConversationRoutes(app, {
    runtime,
    getRuntime: (agentId) => agentRuntimeManager.require(agentId),
    onebotGateway,
    conversationDirectory
  });
  registerAgentRoutes(app, agentRegistry, {
    decorateAgents: (agents) => agentRuntimeManager.decorateAgents(agents, onebotGateway.getStatus()),
    onAgentCreated: async (agentId) => {
      await agentRuntimeManager.start(agentId);
    },
    onAgentUpdated: async (agentId, enabled) => {
      if (enabled) await agentRuntimeManager.start(agentId);
      else await agentRuntimeManager.stop(agentId);
      if (accountRuntimeReconciler) {
        const agent = await agentRegistry.get(agentId);
        await Promise.all(agent.accounts.map((account) => accountRuntimeReconciler.reconcile(account.id)));
      }
    },
    onPromptSettingsUpdated: async (agentId) => {
      await agentRuntimeManager.require(agentId).reload(await agentRegistry.config(agentId));
    },
    isAccountConnected: (accountId) => Boolean(onebotGateway.getStatus().accounts?.some((account) => account.accountId === accountId)),
    reconcileAccount: accountRuntimeReconciler
      ? (accountId) => accountRuntimeReconciler.reconcile(accountId)
      : undefined
  });
  registerMediaRoutes(app, {
    getConfig: () => config,
    runtime,
    getAgentContext: (agentId) => {
      const agentRuntime = agentRuntimeManager.require(agentId);
      return { config: agentRuntime.config, runtime: agentRuntime };
    },
    getAllAgentConfigs: async () => Promise.all((await agentRegistry.list())
      .filter((agent) => agent.enabled)
      .map((agent) => agentRegistry.config(agent.id)))
  });
  registerOneBotRoutes(app, onebotGateway, { agentRegistry });
  registerProviderConfigRoutes(app, { codexAuth, configService, agentConfigService, testProvider: options.testProvider });
  registerConfigDoctorRoutes(app, configDoctorService);
  registerMemoryRoutes(app, {
    getConfig: () => config,
    runtime,
    getAgentContext: (agentId) => {
      const agentRuntime = agentRuntimeManager.require(agentId);
      return { config: agentRuntime.config, runtime: agentRuntime };
    }
  });
  registerAgentToolRoutes(app, {
    agentFiles,
    resolveToolCapabilities,
    getConfig: () => config,
    getAgentContext: (agentId) => {
      const agentRuntime = agentRuntimeManager.require(agentId);
      return {
        config: agentRuntime.config,
        agentFiles: new AgentFileRepository({ runtime: agentRuntime }),
        resolveToolCapabilities: toolCapabilitiesFor(agentRuntime.config)
      };
    }
  });
  registerSelfieReferenceRoutes(app, {
    repository: selfieReferencesFor(runtime.config.persona.defaultAgentId),
    getRepository: selfieReferencesFor
  });

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
    agentRegistry,
    agentRuntimeManager,
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
  await assertRuntimeWorkspaceMigrationGate();
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

async function assertRuntimeWorkspaceMigrationGate() {
  let gate;
  try {
    gate = await inspectMultiAgentMigrationGate(getWorkspaceDir());
  } catch (error) {
    if ((error as { code?: string }).code !== "MULTI_AGENT_MIGRATION_STATE_INVALID") throw error;
    const firstRun = await inspectFirstRunBootstrap(getWorkspaceDir());
    if (firstRun.state === "active") return;
    throw error;
  }
  if (gate.state !== "trusted") {
    throw new ServiceError(
      409,
      "MULTI_AGENT_MIGRATION_REQUIRED",
      "现有 workspace 缺少可信多 Agent 迁移标记；请通过 ./sunabot.sh up 初始化空目录，或停服执行单 Agent 迁移。"
    );
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
  return pathname === "/" || [
    "overview",
    "conversations",
    "web-chat",
    "agent-prompts",
    "system-prompts",
    "prompts",
    "memory",
    "images",
    "logs",
    "agents",
    "agent-settings",
    "settings",
    "config-doctor"
  ]
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
