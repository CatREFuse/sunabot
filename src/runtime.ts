import {
  type AppConfig,
  type ConversationRecord,
  type ParsedIncomingMessage
} from "./types.js";
import { AttachmentService } from "../services/media/attachments/service.js";
import { CommandRouter } from "../services/messaging/commandRouter.js";
import {
  getAgentPrivatePath,
  getAgentSessionQueuePath,
  getRootDir,
  getWorkspacePath,
  resolveProjectPath
} from "./config.js";
import { sqliteMemoryPersistence } from "../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../services/memory/persistence.js";
import { ReplyGateEpochs } from "../services/orchestration/groupReplyPolicy.js";
import { HookBus } from "../services/messaging/hookBus.js";
import type { MessagingPort } from "../packages/contracts/messaging/messages.js";
import type { AgentPersona } from "../services/agent/persona.js";
import { appendRequestLog } from "../adapters/observability/requestLog.js";
import { WORKSPACE_LAYOUT } from "../packages/platform/workspaceLayout.js";
import { SenderNameResolver } from "../services/conversations/senderName.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../adapters/onebot/qqMedia.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator
} from "../services/sessions/sessionCoordinator.js";
import { SessionStore } from "../services/sessions/sessionStore.js";
import {
  DIRECT_REPLY_TIMEOUT_MS,
  type RuntimeCommandContext,
  type AmbientReplyState,
  type AmbientIdleTimer,
  type SunaRuntimeOptions,
  type RuntimeBashAuditPort
} from "./runtime/runtimeContracts.js";
import { RuntimeLifecycle } from "./runtime/lifecycle.js";
import * as runtimeIntake from "./runtime/intake.js";
import * as runtimeReply from "./runtime/reply.js";
import { RuntimeOrchestration } from "./runtime/orchestration.js";
import * as runtimeDelivery from "./runtime/delivery.js";
import * as runtimeConversations from "./runtime/conversations.js";
import { RuntimeSelfie } from "./runtime/selfie.js";
import { RuntimeReplyDebounce } from "./runtime/replyDebounce.js";
import { RuntimeConversationAssets } from "./runtime/conversationAssets.js";
import { RuntimeScheduledTasks } from "./runtime/scheduledTasks.js";
import { RuntimeVoice } from "./runtime/voice.js";
import { RuntimeDirector } from "./runtime/director.js";
import { RuntimeAir } from "./runtime/air.js";
import { RuntimeWorkingMemory } from "./runtime/workMemory.js";
import { RuntimeUserProfile } from "./runtime/userProfile.js";
import { RuntimeAttachmentRefresh } from "./runtime/attachmentRefresh.js";
import { RuntimeDreams } from "./runtime/dreamPipeline.js";
import { stageCodexResultArtifacts } from "./runtime/codexArtifacts.js";
import { createRuntimeDreamsForHost, forceRuntimeDreamForHost } from "./runtime/dreamRuntime.js";
import { RuntimeTone } from "./runtime/tone.js";
import { TaskLimiter, errorMessage, loadConversationRecords } from "./runtime/infrastructure.js";
import type {
  RuntimeToolCapabilities,
  RuntimeToolCapabilityResolver,
  WorkspaceBashUnavailableReason
} from "../services/tools/bashCapability.js";
import type { BashExecutionBackend } from "../services/tools/bashAudit.js";
import type { ConversationCapabilityContextV1 } from "../services/conversations/conversationCapability.js";
import type { SystemConfigRuntimePort } from "../services/tools/systemConfigTool.js";
import type { WorkspaceBashRuntimePort } from "../services/tools/bashRuntime.js";
import type { ReplyTaskGate } from "../services/orchestration/broadcastStormDetector.js";
import { runWithAgentRuntimeContext } from "../packages/platform/runtimeAgentContext.js";
import type { RuntimeAgentExtensionsPort } from "./runtime/agentExtensions.js";
export class SunaRuntime {
  persona?: AgentPersona;
  private configValue!: AppConfig;
  private configEpochValue = 0;
  get config(): AppConfig { return this.configValue; }
  set config(value: AppConfig) {
    this.configValue = value;
    this.configEpochValue += 1;
  }
  get configEpoch() { return this.configEpochValue; }
  readonly conversationRecords: Map<string, ConversationRecord>;
  readonly activeDirectControllers = new Map<string, AbortController>();
  readonly ambientReplies = new Map<string, AmbientReplyState>();
  readonly ambientIdleTimers = new Map<string, AmbientIdleTimer>();
  readonly seenIncomingEvents = new Map<string, number>();
  readonly ambientLimiter = new TaskLimiter(2);
  readonly replyGates = new ReplyGateEpochs();
  readonly commandRouter: CommandRouter<RuntimeCommandContext>;
  readonly hydratedMessageIds = new Set<string>();
  readonly hydrationFailures = new Map<string, { attempts: number; nextAt: number; generation: string }>();
  hydrationGeneration = "";
  hydrationPromise?: Promise<void>;
  attachmentRefreshPromise?: Promise<void>;
  attachmentRefreshDirty = false;
  readonly hooks = new HookBus();
  readonly attachmentService: AttachmentService;
  readonly senderNameResolver = new SenderNameResolver();
  readonly sessionStore: SessionStore;
  readonly ownsSessionStore: boolean;
  readonly sessionCoordinator: SessionCoordinator;
  readonly scheduledTasks: RuntimeScheduledTasks;
  readonly director: RuntimeDirector;
  readonly air: RuntimeAir;
  readonly workingMemory: RuntimeWorkingMemory;
  readonly userProfile: RuntimeUserProfile;
  readonly dreams: RuntimeDreams;
  readonly bashAudit?: RuntimeBashAuditPort;
  readonly bashRuntime?: WorkspaceBashRuntimePort;
  private readonly rawToolCapabilityResolver?: RuntimeToolCapabilityResolver;
  readonly systemConfig?: SystemConfigRuntimePort;
  readonly agentExtensions?: RuntimeAgentExtensionsPort;
  readonly replyTaskGate: ReplyTaskGate;
  readonly resolveAdminNotificationAccountId?: () => Promise<string | undefined>;
  readonly incomingPreparations = new Map<string, {
      promise: Promise<void>;
      incoming: ParsedIncomingMessage;
    }>();
  activeGateway?: MessagingPort;
  private readonly runtimeController = new AbortController();
  private readonly lifecycle: RuntimeLifecycle;
  private readonly orchestration: RuntimeOrchestration;
  private readonly attachmentRefresh: RuntimeAttachmentRefresh;
  private readonly tone: RuntimeTone;
  private readonly selfie: RuntimeSelfie;
  private readonly replyDebounce: RuntimeReplyDebounce;
  private readonly conversationAssets: RuntimeConversationAssets;
  private readonly voice: RuntimeVoice;
  constructor(config: AppConfig, options: SunaRuntimeOptions = {}) {
      configureMemoryPersistence(sqliteMemoryPersistence);
      this.config = config;
      this.conversationRecords = new Map(loadConversationRecords(config).map((record) => [record.id, record]));
      this.rawToolCapabilityResolver = options.resolveToolCapabilities;
      this.bashAudit = options.bashAudit;
      this.bashRuntime = options.bashRuntime;
      this.systemConfig = options.systemConfig;
      this.agentExtensions = options.agentExtensions;
      this.replyTaskGate = options.replyTaskGate ?? { canCreateTaskFor: () => true };
      this.resolveAdminNotificationAccountId = options.resolveAdminNotificationAccountId;
      this.attachmentService = options.attachmentService ?? new AttachmentService(getRootDir(), {
        cacheRoot: getAgentPrivatePath(config, WORKSPACE_LAYOUT.attachmentCache, "cache", "attachments"),
        cacheOptions: { trustedResolvedAddress: isTrustedQqFakeIp }
      });
      this.ownsSessionStore = !options.sessionStore;
      this.sessionStore = options.sessionStore ?? new SessionStore({
        databasePath: process.env.VITEST
          ? ":memory:"
          : getAgentSessionQueuePath(config)
      });
      this.sessionCoordinator = new SessionCoordinator({
        store: this.sessionStore,
        handleEvent: (event, context) => this.inAgentContext(() => this.processSessionEvent(event, context)),
        deliverOutbox: (outbox, context) => this.inAgentContext(() => this.deliverSessionOutbox(outbox, context)),
        codexRunner: options.codexRunner ?? new CodexToolRunner(),
        cleanupCodexProcess: cleanupPersistedCodexProcess,
        runDeferredTool: (job, signal) => this.inAgentContext(() => this.processDeferredToolJob(job, signal)),
        finalizeCodexResult: (input) => this.inAgentContext(() => stageCodexResultArtifacts({
          ...input,
          cache: this.attachmentService.cache
        })),
        observeCodexToolUsage: (observation) => this.inAgentContext(async () => {
          await appendRequestLog({
            category: "model.response",
            action: "codex.tool.complete",
            providerKind: "codex-cli",
            model: observation.model,
            response: {
              ok: observation.ok,
              status: observation.status,
              ...(observation.usage ? { usage: observation.usage } : {})
            },
            metadata: {
              jobId: observation.jobId,
              conversationId: observation.conversationId,
              stage: "reply",
              attempt: observation.attempt
            }
          });
        }),
        codexSettings: () => ({
          enabled: this.config.bot.tools.codex.enabled,
          model: this.config.bot.tools.codex.model,
          executable: this.config.bot.tools.codex.codexExecutable,
          timeoutMs: this.config.bot.tools.codex.timeoutMs,
          maxConcurrency: this.config.bot.tools.codex.maxConcurrency,
          workspacePath: resolveProjectPath(this.config.persona.agentWorkspace) ?? getRootDir(),
          jobRoot: getAgentPrivatePath(this.config, WORKSPACE_LAYOUT.codexJobs, "runtime", "codex-jobs"),
          authFile: getWorkspacePath(WORKSPACE_LAYOUT.codexHome, "auth.json")
        }),
        turnTimeoutMs: DIRECT_REPLY_TIMEOUT_MS + 5_000,
        maxSessionConcurrency: 4,
        resolveHeldReplyGate: (outbox) => {
          const provenance = outbox.holdProvenance;
          if (provenance?.semantics !== "system_config_confirmation") return undefined;
          return this.replyGates.capture(
            provenance.originalReplyGate.scope,
            provenance.originalReplyGate.conversationId
          );
        },
        isDisconnectedError: (error) => error instanceof OutboxDisconnectedError ||
          /OneBot is not connected|websocket.*closed/i.test(errorMessage(error))
      });
      this.scheduledTasks = new RuntimeScheduledTasks(this);
      this.director = new RuntimeDirector(this);
      this.air = new RuntimeAir(this);
      this.workingMemory = new RuntimeWorkingMemory(this);
      this.userProfile = new RuntimeUserProfile(this);
      this.dreams = createRuntimeDreamsForHost(this);
      this.commandRouter = new CommandRouter<RuntimeCommandContext>([
        {
          id: "group-summary",
          names: ["总结群聊"],
          handler: async ({
            channelKey,
            incoming,
            gateway,
            signal,
            isCurrent,
            delivery,
            contextThroughSequence
          }) => {
            await this.replyWithGroupChatSummary(
              channelKey,
              incoming,
              gateway,
              signal,
              isCurrent,
              delivery,
              contextThroughSequence
            );
          }
        }
      ]);
        this.lifecycle = new RuntimeLifecycle(this);
      this.orchestration = new RuntimeOrchestration(this);
      this.attachmentRefresh = new RuntimeAttachmentRefresh(this);
      this.tone = new RuntimeTone(this);
      this.selfie = new RuntimeSelfie(this);
      this.replyDebounce = new RuntimeReplyDebounce(
        this,
        optionalNonNegativeReplyDebounceMs(options.replyDebounceMs)
      );
      this.conversationAssets = new RuntimeConversationAssets(this);
      this.voice = new RuntimeVoice(this, options.voice);
  }
  private inAgentContext<T>(operation: () => T): T { return runWithAgentRuntimeContext(this.config, operation); }
  get runtimeSignal() { return this.runtimeController.signal; }
  isRuntimeActive() { return !this.runtimeController.signal.aborted; }
  abortRuntime(reason: unknown = new DOMException("Runtime closed.", "AbortError")) {
    if (!this.runtimeController.signal.aborted) this.runtimeController.abort(reason);
  }
  initialize(...args: Parameters<RuntimeLifecycle["initialize"]>) { return this.inAgentContext(() => this.lifecycle.initialize(...args)); }
  close(...args: Parameters<RuntimeLifecycle["close"]>) { return this.inAgentContext(() => this.lifecycle.close(...args)); }
  reload(...args: Parameters<RuntimeLifecycle["reload"]>) { return this.inAgentContext(() => this.lifecycle.reload(...args)); }
  prepareReload(...args: Parameters<RuntimeLifecycle["prepareReload"]>) { return this.inAgentContext(() => this.lifecycle.prepareReload(...args)); }
  commitReload(...args: Parameters<RuntimeLifecycle["commitReload"]>) { return this.inAgentContext(() => this.lifecycle.commitReload(...args)); }
  reloadPrompts(...args: Parameters<RuntimeLifecycle["reloadPrompts"]>) { return this.inAgentContext(() => this.lifecycle.reloadPrompts(...args)); }
  preparePromptReload(...args: Parameters<RuntimeLifecycle["preparePromptReload"]>) { return this.inAgentContext(() => this.lifecycle.preparePromptReload(...args)); }
  commitPromptReload(...args: Parameters<RuntimeLifecycle["commitPromptReload"]>) { return this.inAgentContext(() => this.lifecycle.commitPromptReload(...args)); }
  getPersonaStatus(...args: Parameters<RuntimeLifecycle["getPersonaStatus"]>) { return this.lifecycle.getPersonaStatus(...args); }
  getProviderStatus(...args: Parameters<RuntimeLifecycle["getProviderStatus"]>) { return this.lifecycle.getProviderStatus(...args); }
  getProvider(...args: Parameters<RuntimeLifecycle["getProvider"]>) { return this.lifecycle.getProvider(...args); }
  getProviderForModel(...args: Parameters<RuntimeLifecycle["getProviderForModel"]>) { return this.lifecycle.getProviderForModel(...args); }
  ensureAgentPromptFiles(...args: Parameters<RuntimeLifecycle["ensureAgentPromptFiles"]>) { return this.inAgentContext(() => this.lifecycle.ensureAgentPromptFiles(...args)); }
  defaultPromptContent(...args: Parameters<RuntimeLifecycle["defaultPromptContent"]>) { return this.lifecycle.defaultPromptContent(...args); }
  renderPromptRequest(...args: Parameters<RuntimeLifecycle["renderPromptRequest"]>) { return this.lifecycle.renderPromptRequest(...args); }
  completePrompt(...args: Parameters<RuntimeLifecycle["completePrompt"]>) { return this.lifecycle.completePrompt(...args); }
  completePromptTurn(...args: Parameters<RuntimeLifecycle["completePromptTurn"]>) { return this.lifecycle.completePromptTurn(...args); }
  listScheduledTasks(...args: Parameters<RuntimeScheduledTasks["listScheduledTasks"]>) { return this.scheduledTasks.listScheduledTasks(...args); }
  getScheduledTask(...args: Parameters<RuntimeScheduledTasks["getScheduledTask"]>) { return this.scheduledTasks.getScheduledTask(...args); }
  createScheduledTask(...args: Parameters<RuntimeScheduledTasks["createScheduledTask"]>) { return this.inAgentContext(() => this.scheduledTasks.createScheduledTask(...args)); }
  updateScheduledTask(...args: Parameters<RuntimeScheduledTasks["updateScheduledTask"]>) { return this.inAgentContext(() => this.scheduledTasks.updateScheduledTask(...args)); }
  deleteScheduledTask(...args: Parameters<RuntimeScheduledTasks["deleteScheduledTask"]>) { return this.inAgentContext(() => this.scheduledTasks.deleteScheduledTask(...args)); }
  replayScheduledTaskDelivery(...args: Parameters<RuntimeScheduledTasks["replayScheduledTaskDelivery"]>) { return this.inAgentContext(() => this.scheduledTasks.replayScheduledTaskDelivery(...args)); }
  listDirectorSchedules(...args: Parameters<RuntimeDirector["listSchedules"]>) { return this.director.listSchedules(...args); }
  listDreamHistory(...args: Parameters<RuntimeDreams["listHistory"]>) { return this.dreams.listHistory(...args); }
  forceDream(input: Parameters<typeof forceRuntimeDreamForHost>[1]) {
    return this.inAgentContext(() => forceRuntimeDreamForHost(this, input));
  }
  getConversationRecords(...args: Parameters<RuntimeLifecycle["getConversationRecords"]>) { return this.lifecycle.getConversationRecords(...args); }
  publicConversationRecord(...args: Parameters<RuntimeLifecycle["publicConversationRecord"]>) { return this.lifecycle.publicConversationRecord(...args); }
  getConversationMessages(...args: Parameters<RuntimeLifecycle["getConversationMessages"]>) { return this.lifecycle.getConversationMessages(...args); }
  getConversationMessageStats(...args: Parameters<RuntimeLifecycle["getConversationMessageStats"]>) { return this.inAgentContext(() => this.lifecycle.getConversationMessageStats(...args)); }
  hydrateConversationIdentities(...args: Parameters<RuntimeLifecycle["hydrateConversationIdentities"]>) { return this.lifecycle.hydrateConversationIdentities(...args); }
  enrichMemoryEntries(...args: Parameters<RuntimeLifecycle["enrichMemoryEntries"]>) { return this.lifecycle.enrichMemoryEntries(...args); }
  setConversationReplyEnabled(...args: Parameters<RuntimeLifecycle["setConversationReplyEnabled"]>) { return this.lifecycle.setConversationReplyEnabled(...args); }
  getConversationToolPolicy(...args: Parameters<RuntimeLifecycle["getConversationToolPolicy"]>) { return this.lifecycle.getConversationToolPolicy(...args); }
  setConversationToolPolicy(...args: Parameters<RuntimeLifecycle["setConversationToolPolicy"]>) { return this.inAgentContext(() => this.lifecycle.setConversationToolPolicy(...args)); }
  announceServiceOnline(...args: Parameters<RuntimeLifecycle["announceServiceOnline"]>) { return this.lifecycle.announceServiceOnline(...args); }
  hydrateConversationRecords(...args: Parameters<typeof runtimeIntake.runtime_hydrateConversationRecords>) { return runtimeIntake.runtime_hydrateConversationRecords.call(this, ...args); }
  performHydrateConversationRecords(...args: Parameters<typeof runtimeIntake.runtime_performHydrateConversationRecords>) { return runtimeIntake.runtime_performHydrateConversationRecords.call(this, ...args); }
  handleInboundMessage(...args: Parameters<typeof runtimeIntake.runtime_handleInboundMessage>) { return this.inAgentContext(() => runtimeIntake.runtime_handleInboundMessage.call(this, ...args)); }
  processSessionEvent(...args: Parameters<typeof runtimeIntake.runtime_processSessionEvent>) { return this.inAgentContext(() => runtimeIntake.runtime_processSessionEvent.call(this, ...args)); }
  processIncomingReplyEvent(...args: Parameters<typeof runtimeIntake.runtime_processIncomingReplyEvent>) { return this.inAgentContext(() => runtimeIntake.runtime_processIncomingReplyEvent.call(this, ...args)); }
  deliverSessionOutbox(...args: Parameters<typeof runtimeIntake.runtime_deliverSessionOutbox>) { return this.inAgentContext(() => runtimeIntake.runtime_deliverSessionOutbox.call(this, ...args)); }
  conversationAssetProviderOptions(...args: Parameters<RuntimeConversationAssets["providerOptions"]>) { return this.conversationAssets.providerOptions(...args); }
  queueConversationAsset(...args: Parameters<RuntimeConversationAssets["queue"]>) { return this.inAgentContext(() => this.conversationAssets.queue(...args)); }
  resolveWorkbenchImageReferences(...args: Parameters<RuntimeConversationAssets["resolveImageReferences"]>) { return this.inAgentContext(() => this.conversationAssets.resolveImageReferences(...args)); }
  deliverConversationAssetOutbox(...args: Parameters<RuntimeConversationAssets["deliver"]>) { return this.inAgentContext(() => this.conversationAssets.deliver(...args)); }
  voiceSnapshot(...args: Parameters<RuntimeVoice["snapshot"]>) { return this.inAgentContext(() => this.voice.snapshot(...args)); }
  voiceProviderCapability(...args: Parameters<RuntimeVoice["providerCapability"]>) { return this.voice.providerCapability(...args); }
  synthesizeAndQueueVoice(...args: Parameters<RuntimeVoice["synthesizeAndQueue"]>) { return this.inAgentContext(() => this.voice.synthesizeAndQueue(...args)); }
  requireActiveGateway(...args: Parameters<typeof runtimeIntake.runtime_requireActiveGateway>) { return runtimeIntake.runtime_requireActiveGateway.call(this, ...args); }
  handleIncomingMessage(...args: Parameters<typeof runtimeIntake.runtime_handleIncomingMessage>) { return this.inAgentContext(() => runtimeIntake.runtime_handleIncomingMessage.call(this, ...args)); }
  prepareIncomingMessage(...args: Parameters<typeof runtimeIntake.runtime_prepareIncomingMessage>) { return runtimeIntake.runtime_prepareIncomingMessage.call(this, ...args); }
  replyToIncoming(...args: Parameters<typeof runtimeReply.runtime_replyToIncoming>) { return this.inAgentContext(() => runtimeReply.runtime_replyToIncoming.call(this, ...args)); }
  replyWithGroupChatSummary(...args: Parameters<typeof runtimeReply.runtime_replyWithGroupChatSummary>) { return runtimeReply.runtime_replyWithGroupChatSummary.call(this, ...args); }
  replyToToolCompletion(...args: Parameters<typeof runtimeReply.runtime_replyToToolCompletion>) { return runtimeReply.runtime_replyToToolCompletion.call(this, ...args); }
  processDeferredToolJob(...args: Parameters<typeof runtimeReply.runtime_processDeferredToolJob>) { return this.inAgentContext(() => runtimeReply.runtime_processDeferredToolJob.call(this, ...args)); }
  attachReplyReferences(...args: Parameters<typeof runtimeReply.runtime_attachReplyReferences>) { return runtimeReply.runtime_attachReplyReferences.call(this, ...args); }
  loadMessageDetails(...args: Parameters<typeof runtimeReply.runtime_loadMessageDetails>) { return runtimeReply.runtime_loadMessageDetails.call(this, ...args); }
  loadQuoteReferences(...args: Parameters<typeof runtimeReply.runtime_loadQuoteReferences>) { return runtimeReply.runtime_loadQuoteReferences.call(this, ...args); }
  selectRelevantAttachments(...args: Parameters<typeof runtimeReply.runtime_selectRelevantAttachments>) { return runtimeReply.runtime_selectRelevantAttachments.call(this, ...args); }
  refreshAttachmentCacheReferences(...args: Parameters<typeof runtimeReply.runtime_refreshAttachmentCacheReferences>) { return runtimeReply.runtime_refreshAttachmentCacheReferences.call(this, ...args); }
  buildRecentContextMessages(...args: Parameters<typeof runtimeReply.runtime_buildRecentContextMessages>) { return runtimeReply.runtime_buildRecentContextMessages.call(this, ...args); }
  contextMessageLimit(...args: Parameters<typeof runtimeReply.runtime_contextMessageLimit>) { return runtimeReply.runtime_contextMessageLimit.call(this, ...args); }
  retainedConversationMessageLimit(...args: Parameters<typeof runtimeReply.runtime_retainedConversationMessageLimit>) { return runtimeReply.runtime_retainedConversationMessageLimit.call(this, ...args); }
  groupReplyOptions(...args: Parameters<typeof runtimeReply.runtime_groupReplyOptions>) { return runtimeReply.runtime_groupReplyOptions.call(this, ...args); }
  resolveProviderBashHandle(
    incoming: ParsedIncomingMessage,
    promptOverride?: string,
    backend: BashExecutionBackend = "docker",
    capability?: Readonly<ConversationCapabilityContextV1>
  ) {
    return runtimeReply.runtime_resolveProviderBashHandle.call(
      this,
      incoming,
      promptOverride,
      this.rawToolCapabilityResolver,
      backend,
      capability
    );
  }
  async resolveToolCapabilities(
    backendOverride?: BashExecutionBackend | null
  ): Promise<RuntimeToolCapabilities> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const epoch = this.configEpoch;
      const config = freezeRuntimeConfigSnapshot(this.config);
      const backend = backendOverride === undefined
        ? "docker"
        : backendOverride;
      const workspacePath = resolveProjectPath(config.persona.agentWorkspace);
      let auditAvailable = false;
      if (backend && workspacePath && this.bashAudit) {
        try {
          auditAvailable = await this.bashAudit.available(config) === true;
        } catch {
          if (this.configEpoch !== epoch) continue;
          auditAvailable = false;
        }
      }
      if (this.configEpoch !== epoch) continue;
      if (!this.rawToolCapabilityResolver) {
        return {
          workspaceBash: false,
          workspaceBashReason: workspaceBashUnavailableReason(backend, workspacePath, auditAvailable),
          codex: false
        };
      }
      try {
        const capabilities = await this.rawToolCapabilityResolver({
          workspacePath: workspacePath ?? getRootDir(),
          workspaceBashBackend: backend ?? "docker",
          workspaceBashAuditAvailable: auditAvailable
        });
        if (this.configEpoch !== epoch) continue;
        const workspaceBash = Boolean(backend && workspacePath && auditAvailable && capabilities.workspaceBash === true);
        return {
          workspaceBash,
          ...(!workspaceBash ? {
            workspaceBashReason: workspaceBashUnavailableReason(
              backend,
              workspacePath,
              auditAvailable,
              capabilities.workspaceBashReason
            )
          } : {}),
          codex: capabilities.codex === true
        };
      } catch {
        if (this.configEpoch !== epoch) continue;
        return {
          workspaceBash: false,
          workspaceBashReason: workspaceBashUnavailableReason(backend, workspacePath, auditAvailable),
          codex: false
        };
      }
    }
    const config = freezeRuntimeConfigSnapshot(this.config);
    const backend = backendOverride === undefined
      ? "docker"
      : backendOverride;
    const workspacePath = resolveProjectPath(config.persona.agentWorkspace);
    return {
      workspaceBash: false,
      workspaceBashReason: workspaceBashUnavailableReason(
        backend,
        workspacePath,
        Boolean(backend && workspacePath && this.bashAudit)
      ),
      codex: false
    };
  }
  isAdminUser(...args: Parameters<typeof runtimeReply.runtime_isAdminUser>) { return runtimeReply.runtime_isAdminUser.call(this, ...args); }
  adminIdentity(...args: Parameters<RuntimeOrchestration["adminIdentity"]>) { return this.orchestration.adminIdentity(...args); }
  isReplySenderAllowed(...args: Parameters<RuntimeOrchestration["isReplySenderAllowed"]>) { return this.orchestration.isReplySenderAllowed(...args); }
  isDuplicateIncoming(...args: Parameters<RuntimeOrchestration["isDuplicateIncoming"]>) { return this.orchestration.isDuplicateIncoming(...args); }
  markIncomingSeen(...args: Parameters<RuntimeOrchestration["markIncomingSeen"]>) { return this.orchestration.markIncomingSeen(...args); }
  resolveIncomingReplyRoute(...args: Parameters<RuntimeOrchestration["resolveIncomingReplyRoute"]>) { return this.orchestration.resolveIncomingReplyRoute(...args); }
  isReplyTaskCurrent(...args: Parameters<RuntimeOrchestration["isReplyTaskCurrent"]>) { return this.orchestration.isReplyTaskCurrent(...args); }
  cancelScopeReplies(...args: Parameters<RuntimeOrchestration["cancelScopeReplies"]>) { return this.orchestration.cancelScopeReplies(...args); }
  cancelAllAmbientReplies(...args: Parameters<RuntimeOrchestration["cancelAllAmbientReplies"]>) { return this.orchestration.cancelAllAmbientReplies(...args); }
  resumeUserGroupOrchestrators(...args: Parameters<RuntimeOrchestration["resumeUserGroupOrchestrators"]>) { return this.inAgentContext(() => this.orchestration.resumeUserGroupOrchestrators(...args)); }
  suspendUserGroupOrchestrators(...args: Parameters<RuntimeOrchestration["suspendUserGroupOrchestrators"]>) { return this.inAgentContext(() => this.orchestration.suspendUserGroupOrchestrators(...args)); }
  patchIncomingMessage(...args: Parameters<RuntimeOrchestration["patchIncomingMessage"]>) { return this.orchestration.patchIncomingMessage(...args); }
  shouldRunUserGroupchatOrchestrator(...args: Parameters<RuntimeOrchestration["shouldRunUserGroupchatOrchestrator"]>) { return this.orchestration.shouldRunUserGroupchatOrchestrator(...args); }
  pendingOrchestratorUserMessages(...args: Parameters<RuntimeOrchestration["pendingOrchestratorUserMessages"]>) { return this.orchestration.pendingOrchestratorUserMessages(...args); }
  scheduleAmbientIdleReply(...args: Parameters<RuntimeOrchestration["scheduleAmbientIdleReply"]>) { return this.orchestration.scheduleAmbientIdleReply(...args); }
  cancelAmbientIdleTimer(...args: Parameters<RuntimeOrchestration["cancelAmbientIdleTimer"]>) { return this.orchestration.cancelAmbientIdleTimer(...args); }
  queueAmbientReply(...args: Parameters<RuntimeOrchestration["queueAmbientReply"]>) { return this.orchestration.queueAmbientReply(...args); }
  pumpAmbientReply(...args: Parameters<RuntimeOrchestration["pumpAmbientReply"]>) { return this.inAgentContext(() => this.orchestration.pumpAmbientReply(...args)); }
  isAmbientReplyCurrent(...args: Parameters<RuntimeOrchestration["isAmbientReplyCurrent"]>) { return this.orchestration.isAmbientReplyCurrent(...args); }
  cancelAmbientReply(...args: Parameters<RuntimeOrchestration["cancelAmbientReply"]>) { return this.orchestration.cancelAmbientReply(...args); }
  runUserGroupchatOrchestrator(...args: Parameters<RuntimeOrchestration["runUserGroupchatOrchestrator"]>) { return this.orchestration.runUserGroupchatOrchestrator(...args); }
  consumeOrchestratorBatch(...args: Parameters<RuntimeOrchestration["consumeOrchestratorBatch"]>) { return this.orchestration.consumeOrchestratorBatch(...args); }
  recordOrchestratorDecision(...args: Parameters<RuntimeOrchestration["recordOrchestratorDecision"]>) { return this.orchestration.recordOrchestratorDecision(...args); }
  scheduleAttachmentCacheRefresh() { return this.attachmentRefresh.schedule(); }
  rewriteToneText(...args: Parameters<RuntimeTone["rewrite"]>) { return this.inAgentContext(() => this.tone.rewrite(...args)); }
  rewriteToneDelivery(...args: Parameters<RuntimeTone["rewriteForDelivery"]>) { return this.inAgentContext(() => this.tone.rewriteForDelivery(...args)); }
  sendAssistantReply(...args: Parameters<typeof runtimeDelivery.runtime_sendAssistantReply>) { return runtimeDelivery.runtime_sendAssistantReply.call(this, ...args); }
  replyDeliveryDraft(...args: Parameters<typeof runtimeDelivery.runtime_replyDeliveryDraft>) { return runtimeDelivery.runtime_replyDeliveryDraft.call(this, ...args); }
  deliverReplyOutbox(...args: Parameters<typeof runtimeDelivery.runtime_deliverReplyOutbox>) { return runtimeDelivery.runtime_deliverReplyOutbox.call(this, ...args); }
  sendErrorReply(...args: Parameters<typeof runtimeDelivery.runtime_sendErrorReply>) { return runtimeDelivery.runtime_sendErrorReply.call(this, ...args); }
  incomingCaptureSequence(...args: Parameters<typeof runtimeConversations.runtime_incomingCaptureSequence>) { return runtimeConversations.runtime_incomingCaptureSequence.call(this, ...args); }
  recordIncomingMessage(...args: Parameters<typeof runtimeConversations.runtime_recordIncomingMessage>) { return runtimeConversations.runtime_recordIncomingMessage.call(this, ...args); }
  recordAssistantRequestStarted(...args: Parameters<typeof runtimeConversations.runtime_recordAssistantRequestStarted>) { return runtimeConversations.runtime_recordAssistantRequestStarted.call(this, ...args); }
  recordAssistantMessage(...args: Parameters<typeof runtimeConversations.runtime_recordAssistantMessage>) { return runtimeConversations.runtime_recordAssistantMessage.call(this, ...args); }
  recordAssistantTurnTools(...args: Parameters<typeof runtimeConversations.runtime_recordAssistantTurnTools>) { return runtimeConversations.runtime_recordAssistantTurnTools.call(this, ...args); }
  discardAssistantRequest(...args: Parameters<typeof runtimeConversations.runtime_discardAssistantRequest>) { return runtimeConversations.runtime_discardAssistantRequest.call(this, ...args); }
  ensureConversationRecord(...args: Parameters<typeof runtimeConversations.runtime_ensureConversationRecord>) { return runtimeConversations.runtime_ensureConversationRecord.call(this, ...args); }
  upsertConversationRecordForReplySetting(...args: Parameters<typeof runtimeConversations.runtime_upsertConversationRecordForReplySetting>) { return runtimeConversations.runtime_upsertConversationRecordForReplySetting.call(this, ...args); }
  persistConversationRecords(...args: Parameters<typeof runtimeConversations.runtime_persistConversationRecords>) { return this.inAgentContext(() => runtimeConversations.runtime_persistConversationRecords.call(this, ...args)); }
  persistConversationRecordStrict(...args: Parameters<typeof runtimeConversations.runtime_persistConversationRecordStrict>) { return this.inAgentContext(() => runtimeConversations.runtime_persistConversationRecordStrict.call(this, ...args)); }
  markConversationMessagesAsRecordedOnly(...args: Parameters<typeof runtimeConversations.runtime_markConversationMessagesAsRecordedOnly>) { return runtimeConversations.runtime_markConversationMessagesAsRecordedOnly.call(this, ...args); }
  getActiveConversationRecords(...args: Parameters<typeof runtimeConversations.runtime_getActiveConversationRecords>) { return runtimeConversations.runtime_getActiveConversationRecords.call(this, ...args); }
  recordServiceMessage(...args: Parameters<typeof runtimeConversations.runtime_recordServiceMessage>) { return runtimeConversations.runtime_recordServiceMessage.call(this, ...args); }
  readRelevantUserProfiles(...args: Parameters<RuntimeSelfie["readRelevantUserProfiles"]>) { return this.selfie.readRelevantUserProfiles(...args); }
  runSelfie(...args: Parameters<RuntimeSelfie["runSelfie"]>) { return this.inAgentContext(() => this.selfie.runSelfie(...args)); }
  rewriteSelfiePrompt(...args: Parameters<RuntimeSelfie["rewriteSelfiePrompt"]>) { return this.inAgentContext(() => this.selfie.rewriteSelfiePrompt(...args)); }
  collectSelfieChatReferenceImages(...args: Parameters<RuntimeSelfie["collectSelfieChatReferenceImages"]>) { return this.selfie.collectSelfieChatReferenceImages(...args); }
  loadSelfieReferenceImages(...args: Parameters<RuntimeSelfie["loadSelfieReferenceImages"]>) { return this.selfie.loadSelfieReferenceImages(...args); }
  activeReplyDebounce(...args: Parameters<RuntimeReplyDebounce["activeEvent"]>) { return this.replyDebounce.activeEvent(...args); }
  handlePersistedReplyDuplicate(...args: Parameters<RuntimeReplyDebounce["handlePersistedDuplicate"]>) { return this.replyDebounce.handlePersistedDuplicate(...args); }
  handleActiveReplyDebounceIncoming(...args: Parameters<RuntimeReplyDebounce["handleActiveIncoming"]>) { return this.replyDebounce.handleActiveIncoming(...args); }
  scheduleReplyDebounce(...args: Parameters<RuntimeReplyDebounce["schedule"]>) { return this.replyDebounce.schedule(...args); }
  bumpReplyDebounce(...args: Parameters<RuntimeReplyDebounce["bump"]>) { return this.replyDebounce.bump(...args); }
  trackReplyDebouncePreparation(...args: Parameters<RuntimeReplyDebounce["trackPreparation"]>) { return this.replyDebounce.trackPreparation(...args); }
  waitForReplyDebouncePreparations(...args: Parameters<RuntimeReplyDebounce["waitForPreparations"]>) { return this.replyDebounce.waitForPreparations(...args); }
  recoverActiveReplyDebounceConversation(...args: Parameters<RuntimeReplyDebounce["recoverActiveConversation"]>) { return this.replyDebounce.recoverActiveConversation(...args); }
  recoverReplyDebounceMessages(...args: Parameters<RuntimeReplyDebounce["recoverMessages"]>) { return this.replyDebounce.recoverMessages(...args); }
  protectedConversationIds(...args: Parameters<RuntimeReplyDebounce["protectedConversationIds"]>) { return this.replyDebounce.protectedConversationIds(...args); }
  prepareReplyDebounceMessages(...args: Parameters<RuntimeReplyDebounce["prepareMessages"]>) { return this.replyDebounce.prepareMessages(...args); }
  clearReplyDebouncePreparation(...args: Parameters<RuntimeReplyDebounce["clearPreparation"]>) { return this.replyDebounce.clearPreparation(...args); }
  processReplyDebounceEvent(...args: Parameters<RuntimeReplyDebounce["process"]>) { return this.inAgentContext(() => this.replyDebounce.process(...args)); }
}

function optionalNonNegativeReplyDebounceMs(value: number | undefined) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("replyDebounceMs must be a non-negative integer.");
  }
  return value;
}

function freezeRuntimeConfigSnapshot(config: AppConfig): AppConfig {
  return deepFreezeRuntimeConfig(structuredClone(config));
}

function deepFreezeRuntimeConfig<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeRuntimeConfig(nested);
  return Object.freeze(value);
}

function workspaceBashUnavailableReason(
  backend: BashExecutionBackend | null,
  workspacePath: string | undefined,
  auditAvailable: boolean,
  probeReason?: WorkspaceBashUnavailableReason
): WorkspaceBashUnavailableReason {
  if (!workspacePath) return "BASH_WORKBENCH_UNAVAILABLE";
  if (!auditAvailable) return "BASH_AUDIT_UNAVAILABLE";
  if (probeReason) return probeReason;
  return backend === "native"
    ? "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    : "BASH_DOCKER_ISOLATION_UNAVAILABLE";
}
