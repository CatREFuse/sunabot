import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import fs, { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { createDockerBashSupervisor } from "../../adapters/docker/dockerBashSupervisor.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { SqliteAdminSessionStore } from "../../adapters/sqlite/adminSessionStore.js";
import {
  applicationDatabasePath,
  applicationDataStore,
  closeApplicationDataStores,
  sqliteMemoryPersistence
} from "../../adapters/sqlite/applicationDataStore.js";
import type { AppConfig, ProviderConfig } from "../../packages/contracts/admin/public.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  inspectMultiAgentMigrationGate,
  validateMultiAgentWorkspacePath
} from "../../packages/platform/multiAgentMigrationGate.mjs";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import {
  AccountRuntimeReconciler,
  RuntimeProbeClient,
  type AccountRuntimeReconcilerPort,
  type RuntimeProbeClientPort
} from "../../services/agents/accountRuntimeReconciler.js";
import { AgentRegistry, type AgentRegistryOptions } from "../../services/agents/agentRegistry.js";
import { AgentRuntimeManager } from "../../services/agents/agentRuntimeManager.js";
import { ConversationDirectory } from "../../services/conversations/conversationDirectory.js";
import {
  OutboundMediaDelivery,
  outboundMediaMaxInlineBytes,
  outboundMediaReferenceMode
} from "../../services/delivery/outboundMedia.js";
import { knowledgeBaseForConfig } from "../../services/knowledge/public.js";
import { AGENT_ID_PATTERN } from "../../packages/contracts/extensions/agentExtensions.js";
import { isEmojiFileName } from "../../services/emojis/emojiCatalog.js";
import { emojiMediaLocation } from "../../src/emojis/emojiStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import { BroadcastStormDetector } from "../../services/orchestration/public.js";
import {
  createRuntimeToolCapabilityResolver,
  createWorkspaceBashCapabilityProbe,
  type RuntimeToolCapabilityResolver
} from "../../services/tools/bashCapability.js";
import type { SystemConfigRuntimePort } from "../../services/tools/systemConfigTool.js";
import type { WorkspaceBashRuntimePort } from "../../services/tools/bashRuntime.js";
import { AgentConfigService } from "../../src/admin/agentConfigService.js";
import { AgentFileRepository } from "../../src/admin/agentFiles.js";
import { AdminAuthService } from "../../src/admin/auth.js";
import { CodexAuthService } from "../../src/admin/codexAuth.js";
import { ConfigDoctorService, type ConfigDoctorModelRunner } from "../../src/admin/configDoctor.js";
import { ConfigService } from "../../src/admin/configService.js";
import { MonitorSettingsStore } from "../../src/admin/monitorSettings.js";
import { SelfieReferenceRepository } from "../../src/admin/selfieReferences.js";
import { SystemConfigService } from "../../src/admin/systemConfigService.js";
import {
  getConfigPath,
  getRootDir,
  getWorkspaceDir,
  getWorkspacePath,
  loadConfig
} from "../../src/config.js";
import { SunaRuntime } from "../../src/runtime.js";
import { auxiliaryProviderCompleteOptions } from "../../src/runtime/auxiliaryModelBudget.js";
import type { RuntimeBashAuditPort } from "../../src/runtime/runtimeContracts.js";
import { ServiceMonitor } from "../../src/serviceMonitor.js";
import {
  completeFirstRunBootstrap,
  inspectFirstRunBootstrap
} from "../../tooling/runtime/first-run-state.mjs";
import { resolveMcpStdioRuntimeOptions } from "../../tooling/runtime/mcp-runtime-config.mjs";
import { buildRuntimeProbe, collectWorkspaceProbeFacts } from "../../tooling/runtime/probe.mjs";
import { readAccountRuntimeStatus } from "./accountRuntimeStatus.js";
import {
  buildAgentExtensionApiComposition,
  registerAgentExtensionApi,
  type AgentExtensionApiOptions
} from "./agentExtensionApi.js";
import { createBashAuditRuntimePort } from "./bashAuditRuntime.js";
import { resolveDreamAccountId } from "./dreamApiComposition.js";
import { registerAgentEmojiApi } from "./emojiApiComposition.js";
import { registerAgentRoutes } from "./plugins/agentRoutes.js";
import { registerAgentToolRoutes } from "./plugins/agentToolRoutes.js";
import { registerAuthRoutes } from "./plugins/authRoutes.js";
import { registerConfigDoctorRoutes } from "./plugins/configDoctorRoutes.js";
import { registerConversationRoutes } from "./plugins/conversationRoutes.js";
import { registerKnowledgeRoutes } from "./plugins/knowledgeRoutes.js";
import { registerMediaRoutes, type MediaHostnameLookup, type MediaPinnedRequest } from "./plugins/mediaRoutes.js";
import { registerMemoryRoutes } from "./plugins/memoryRoutes.js";
import { registerMonitoringRoutes } from "./plugins/monitoringRoutes.js";
import { registerOneBotRoutes } from "./plugins/onebotRoutes.js";
import { registerProviderConfigRoutes } from "./plugins/providerConfigRoutes.js";
import { registerReleaseRoutes } from "./plugins/releaseRoutes.js";
import { registerScheduledTaskRoutes } from "./plugins/scheduledTaskRoutes.js";
import { registerDirectorRoutes } from "./plugins/directorRoutes.js";
import { registerSelfieReferenceRoutes } from "./plugins/selfieReferenceRoutes.js";
import { isSpaRoute } from "./spaRouting.js";
import { buildVoiceApiComposition, registerVoiceApi } from "./voiceApiComposition.js";
import { resolveEnabledAgentAccountId } from "./agentNotificationComposition.js";
import {
  assertOneBotAccessToken,
  closeOneBotHttpServer,
  createOneBotHttpServer,
  resolveOneBotListenerAddress,
  startOneBotHttpServer,
  type OneBotListenerAddress
} from "./onebotListener.js";
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
  bashAudit?: RuntimeBashAuditPort;
  bashRuntime?: WorkspaceBashRuntimePort;
  resolveToolCapabilities?: RuntimeToolCapabilityResolver;
  agentExtensions?: AgentExtensionApiOptions;
  mediaHostnameLookup?: MediaHostnameLookup;
  mediaPinnedRequest?: MediaPinnedRequest;
}
export interface BuiltApp {
  app: FastifyInstance;
  runtime: SunaRuntime;
  onebotGateway: OneBotGateway;
  onebotServer?: http.Server;
  outboundMedia: OutboundMediaDelivery;
  serviceMonitor: ServiceMonitor;
  agentRegistry: AgentRegistry;
  agentRuntimeManager: AgentRuntimeManager<SunaRuntime>;
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
  const agentExtensions = buildAgentExtensionApiComposition(options.agentExtensions, getWorkspaceDir(), agentRegistry);
  if (options.initializeRuntime !== false) {
    await Promise.all((await agentRegistry.list()).map((agent) => (
      agentExtensions.ensureBundledSkills(agent.id)
    )));
  }
  const runtimeAgentExtensions = agentExtensions.runtime;
  const broadcastStormDetector = new BroadcastStormDetector(config.broadcastStorm);
  const outboundMedia = options.outboundMedia ?? new OutboundMediaDelivery({
    rootDir: getWorkspacePath(WORKSPACE_LAYOUT.mediaImages),
    workspaceRoot: getWorkspaceDir(),
    referenceMode: outboundMediaReferenceMode(),
    maxInlineBytes: outboundMediaMaxInlineBytes()
  });
  const codexAuth = new CodexAuthService({
    codexHome: getWorkspacePath(WORKSPACE_LAYOUT.codexHome),
    executable: process.env.SUNABOT_CODEX_EXECUTABLE
  });
  const bashRuntime = options.bashRuntime ?? createDockerBashSupervisor();
  const workspaceBashProbes = {
    native: createWorkspaceBashCapabilityProbe({ backend: "native", runtime: bashRuntime }),
    docker: createWorkspaceBashCapabilityProbe({ backend: "docker", runtime: bashRuntime })
  };
  const resolveToolCapabilities = options.resolveToolCapabilities ?? createRuntimeToolCapabilityResolver({
    getCodexStatus: () => codexAuth.status(),
    getWorkspaceBashCapability: (context) => workspaceBashProbes[context.workspaceBashBackend](
      context.workspacePath
    )
  });
  const bashAudit = options.bashAudit ?? createBashAuditRuntimePort();
  let systemConfigService: SystemConfigService | undefined;
  let readConnectedAccountIds = (): string[] => [];
  const systemConfigRuntime: SystemConfigRuntimePort = {
    createTurn(context) {
      if (!systemConfigService) throw new Error("System configuration service is not ready.");
      return systemConfigService.createTurn(context);
    }
  };
  const createRuntime = (agentConfig: AppConfig) => new SunaRuntime(agentConfig, {
    resolveToolCapabilities,
    bashAudit,
    bashRuntime,
    bashSkillRepository: agentExtensions.bashSkillRepository,
    systemConfig: systemConfigRuntime,
    agentExtensions: runtimeAgentExtensions,
    replyTaskGate: broadcastStormDetector,
    resolveAdminNotificationAccountId: () => resolveEnabledAgentAccountId(
      agentConfig.persona.defaultAgentId,
      agentRegistry,
      readConnectedAccountIds()
    )
  });
  const runtime = createRuntime(defaultAgentConfig);
  const agentRuntimeManager = new AgentRuntimeManager(agentRegistry, {
    defaultRuntime: runtime,
    createRuntime,
    initializeRuntime: options.initializeRuntime !== false,
    broadcastStormDetector,
    readAccountRuntimeStatus,
    probeExtensionReadiness: (agentId) => agentExtensions.mcpRuntimeService.readiness(agentId)
  });
  const listenerOptions = options.onebotListener === false ? undefined : options.onebotListener;
  const onebotServer = options.onebotListener === false
    ? undefined
    : listenerOptions?.server ?? createOneBotHttpServer();
  const gatewayServer = onebotServer ?? http.createServer();
  const onebotGateway = new OneBotGateway(gatewayServer, config, agentRuntimeManager, {
    outboundMedia,
    isAccountAllowed: (accountId) => Boolean(agentRegistry.account(accountId))
  });
  readConnectedAccountIds = () => (onebotGateway.getStatus().accounts ?? [])
    .map((account) => account.accountId);
  await agentRuntimeManager.initialize();
  const getRuntime = (agentId: string) => agentRuntimeManager.require(agentId);
  const getRuntimeContext = (agentId: string) => {
    const agentRuntime = getRuntime(agentId);
    return { config: agentRuntime.config, runtime: agentRuntime };
  };
  const voiceApi = buildVoiceApiComposition({
    defaultAgentId: () => config.persona.defaultAgentId,
    getRuntime
  });
  agentExtensions.setAgentChangedHandler(async (agentId) => {
    await agentRuntimeManager.refreshReadiness(agentId);
  });
  agentExtensions.mcpRuntimeService.setReadinessInvalidationHandler((agentId) =>
    agentRuntimeManager.refreshReadiness(agentId).then(() => undefined));
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
  const conversationDirectory = new ConversationDirectory({
    cachePath: getWorkspacePath(WORKSPACE_LAYOUT.conversationDirectoryCache)
  });
  onebotGateway.on("connected", () => {
    void agentRuntimeManager.resumeUserGroupOrchestrators(onebotGateway).catch((error) => requestLogError(error));
  });
  onebotGateway.on("disconnected", () => agentRuntimeManager.suspendUserGroupOrchestrators());
  if (onebotServer) onebotGateway.mount();
  const activeReverseWsPath = config.onebot.reverseWsPath;
  const serviceMonitor = new ServiceMonitor(runtime, onebotGateway, monitorSettings);
  app.addHook("onClose", async () => {
    await onebotGateway.close();
    await closeOneBotHttpServer(onebotServer);
    codexAuth.close();
    adminSessionStore.close();
    serviceMonitor.close();
    await agentRuntimeManager.close();
    await agentExtensions.close();
    closeApplicationDataStores();
  });
  const agentFiles = new AgentFileRepository({ runtime });
  const agentFilesFor = (agentId: string) => new AgentFileRepository({ runtime: getRuntime(agentId) });
  const selfieReferences = new Map<string, SelfieReferenceRepository>();
  const selfieReferencesFor = (agentId: string, backend: "native" | "docker" = "native") => {
    const key = `${agentId}:${backend}`;
    const existing = selfieReferences.get(key);
    if (existing) return existing;
    const repository = new SelfieReferenceRepository({
      getConfig: () => agentId === config.persona.defaultAgentId
        ? config
        : agentRegistry.config(agentId, config),
      backend
    });
    selfieReferences.set(key, repository);
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
      new OpenAIProvider(provider).completeRequest(request, auxiliaryProviderCompleteOptions({
        signal,
        modelRequestMaxRetries: 0,
        logContext: { stage: "config_doctor", promptFamily: "config_doctor" }
      }))
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
    getRuntime,
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
  registerAgentExtensionApi(app, agentExtensions, adminAuth);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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

  app.get("/generated-images/:workbench/:agentId/emoji/:fileName", async (request, reply) => {
    const params = request.params as { workbench?: string; agentId?: string; fileName?: string };
    const backend = params.workbench === "workbench"
      ? "native" as const
      : params.workbench === "docker-workbench"
        ? "docker" as const
        : undefined;
    const agentId = String(params.agentId ?? "");
    const fileName = String(params.fileName ?? "");
    if (!backend || !AGENT_ID_PATTERN.test(agentId) || !isEmojiFileName(fileName)) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
    }
    const location = emojiMediaLocation(getRuntime(agentId).config, fileName, backend);
    try {
      const stats = await fsp.lstat(location.filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.status(404).send({ code: "NOT_FOUND", message: "Not found." });
      }
      throw error;
    }
    return reply
      .type(fileName.endsWith(".gif") ? "image/gif" : "image/png")
      .send(fs.createReadStream(location.filePath));
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
    getRuntime,
    onebotGateway,
    conversationDirectory
  });
  registerScheduledTaskRoutes(app, { runtime, getRuntime });
  registerDirectorRoutes(app, { runtime, getRuntime });
  registerAgentRoutes(app, agentRegistry, {
    decorateAgents: (agents) => agentRuntimeManager.decorateAgents(agents, onebotGateway.getStatus()),
    onAgentCreated: async (agentId) => {
      if (options.initializeRuntime !== false) await agentExtensions.ensureBundledSkills(agentId);
      await agentRuntimeManager.start(agentId);
    },
    onAgentUpdated: async (agentId, enabled) => {
      if (enabled) await agentRuntimeManager.start(agentId);
      else {
        await agentRuntimeManager.stop(agentId);
        await agentExtensions.closeAgent(agentId);
      }
      if (accountRuntimeReconciler) {
        const agent = await agentRegistry.get(agentId);
        await Promise.all(agent.accounts.map((account) => accountRuntimeReconciler.reconcile(account.id)));
      }
    },
    onAgentRemovalPrepared: async (agent) => {
      await agentRuntimeManager.stop(agent.id);
      if (!agent.accounts.length) return;
      if (!accountRuntimeReconciler) {
        throw new ServiceError(503, "ACCOUNT_RUNTIME_UNAVAILABLE", "QQ 运行时服务不可用。请执行 ./sunabot.sh restart。");
      }
      const states = await Promise.all(agent.accounts.map((account) => accountRuntimeReconciler.reconcile(account.id)));
      if (states.some((state) => state.reconcileRequired)) {
        throw new ServiceError(409, "AGENT_DELETE_RECONCILIATION_REQUIRED", "QQ 运行容器尚未停止，请处理后重试删除。");
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
    getConfig: () => config, runtime, lookupHostname: options.mediaHostnameLookup, requestRemoteImage: options.mediaPinnedRequest,
    getAgentContext: getRuntimeContext,
    getAllAgentConfigs: async () => Promise.all((await agentRegistry.list())
      .filter((agent) => agent.enabled)
      .map((agent) => agentRegistry.config(agent.id)))
  });
  registerOneBotRoutes(app, onebotGateway, {
    agentRegistry,
    restartAccount: accountRuntimeReconciler ? async (accountId: string) => {
      const state = await accountRuntimeReconciler.restart(accountId);
      if (state.reconcileRequired) throw new ServiceError(503, "ACCOUNT_RUNTIME_RESTART_FAILED", state.lastError ?? "QQ 运行容器重启失败。");
    } : undefined
  });
  registerProviderConfigRoutes(app, { codexAuth, configService, agentConfigService, testProvider: options.testProvider });
  registerConfigDoctorRoutes(app, configDoctorService);
  registerReleaseRoutes(app);
  registerMemoryRoutes(app, {
    getConfig: () => config,
    runtime,
    getAgentContext: getRuntimeContext,
    resolveDreamAccountId: (agentId) => resolveDreamAccountId(agentId, onebotGateway, agentRegistry)
  });
  registerKnowledgeRoutes(app, {
    getService: (agentId, backend) => knowledgeBaseForConfig(getRuntime(agentId).config, backend)
  });
  registerAgentToolRoutes(app, {
    agentFiles,
    resolveToolCapabilities: (backend) => runtime.resolveToolCapabilities(backend),
    resolveConversationAssetCapability: () => conversationAssetCapabilityFor(config.persona.defaultAgentId, onebotGateway, agentRegistry),
    resolveVoiceCapability: () => voiceApi.resolveCapability(config.persona.defaultAgentId),
    getConfig: () => config,
    getAgentContext: (agentId) => {
      const agentRuntime = getRuntime(agentId);
      return {
        config: agentRuntime.config,
        agentFiles: agentFilesFor(agentId),
        resolveToolCapabilities: (backend) => agentRuntime.resolveToolCapabilities(backend),
        resolveConversationAssetCapability: () => conversationAssetCapabilityFor(agentId, onebotGateway, agentRegistry),
        resolveVoiceCapability: () => voiceApi.resolveCapability(agentId),
        resolveSkillToolCapabilities: () => agentExtensions.skillToolCapabilities(agentId)
      };
    }
  });
  registerSelfieReferenceRoutes(app, {
    repository: selfieReferencesFor(runtime.config.persona.defaultAgentId),
    getRepository: selfieReferencesFor
  });
  registerAgentEmojiApi(app, {
    getConfig: () => config,
    runtime,
    getRuntime,
    configService,
    agentConfigService
  });
  registerVoiceApi(app, voiceApi);

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
      return startOneBotHttpServer(
        onebotServer,
        { host, port },
        address.port != null || listenerOptions?.port != null
      );
    }
  };
}

function conversationAssetCapabilityFor(
  agentId: string,
  gateway: OneBotGateway,
  registry: AgentRegistry
) {
  if (typeof gateway.sendConversationAsset !== "function") return false;
  const status = gateway.getStatus();
  return status.connected && (status.accounts ?? []).some(
    (account) => registry.account(account.accountId)?.agentId === agentId
  );
}

export async function createApp(options: CreateAppOptions = {}) {
  return (await buildApp(options)).app;
}
export async function startServer() {
  await assertRuntimeWorkspaceMigrationGate();
  const config = await loadConfig();
  assertOneBotAccessToken(config);
  const built = await buildApp({
    config,
    logger: true,
    agentExtensions: {
      mcpStdio: resolveMcpStdioRuntimeOptions(process.env, process.platform)
    }
  });
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
