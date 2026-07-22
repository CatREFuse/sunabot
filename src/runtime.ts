import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
  ChatMessage,
  ConversationMessageQuote,
  ConversationRecord,
  ImageResult,
  ParsedIncomingMessage,
  ReasoningEffort
} from "./types.js";
import { resolveModelReasoningEffort } from "./admin/models.js";
import { AttachmentService } from "../services/media/attachments/service.js";
import type {
  AttachmentExtractionContext,
  ParsedAttachment
} from "../services/media/attachments/types.js";
import { CommandRouter, type CommandMatch } from "../services/messaging/commandRouter.js";
import { isReplySenderAllowed } from "../services/messaging/replySenderPolicy.js";
import { getAgentPrivatePath, getAgentSessionQueuePath, getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "./config.js";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeToolCompletion,
  incomingReplyEnvelope,
  type AssistantReplyOutboxEnvelope,
  type AssistantReplyOutboxPayload,
  type AsyncToolCompletionPayload,
  type RuntimeIncomingReplyEventPayload
} from "../packages/contracts/session/runtimeMessages.js";
import { applicationDataStore, sqliteMemoryPersistence } from "../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../services/memory/persistence.js";
import {
  ReplyGateEpochs,
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute,
  type ReplyGateSnapshot
} from "../services/orchestration/groupReplyPolicy.js";
import { HookBus } from "../services/messaging/hookBus.js";
import {
  applyMemoryBatchTransaction,
  ensureAgentTextFile,
  formatMemoryMatchesForPrompt,
  isMemoryBatchCommitted,
  mergeUserProfileMemory,
  normalizeEventMemorySchema,
  readAgentTextFile,
  readMemorySourceEntries,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  recallMemory,
  recoverMemoryTransactions,
  replaceWorkingMemoryFacts,
  resolveUserAddressName,
  type MemoryEntry,
  type MemoryFactInput
} from "../services/memory/memoryService.js";
import {
  MemorySchedulerStore,
  type MemoryClaim,
  type MemoryQueuedMessage
} from "../services/memory/memoryScheduler.js";
import {
  OpenAIProvider,
  type ProviderBashOptions,
  type ProviderCompleteOptions,
  type ProviderDeferredTurn
} from "../adapters/model/openaiProvider.js";
import type { ProviderLogContext } from "../packages/contracts/model/modelGateway.js";
import {
  inboundImageUrls,
  replaceInboundImageUrls,
  type MessageDetailsV1,
  type MessagingPort,
  type OutboundMessageV1
} from "../packages/contracts/messaging/messages.js";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../packages/contracts/media/media.js";
import { loadPersona, AgentPersona } from "../services/agent/persona.js";
import { appendRequestLog } from "./requestLog.js";
import { WORKSPACE_LAYOUT } from "../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../services/tools/selfieTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type SessionHandleResult
} from "../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord } from "../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../services/tools/tools.js";
import { promptDefinitionById } from "../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../services/agent/persona.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions, RuntimeBashAuditPort } from "./runtime/runtimeContracts.js";
import { RuntimeLifecycle } from "./runtime/lifecycle.js";
import { RuntimeIntake } from "./runtime/intake.js";
import { RuntimeReply } from "./runtime/reply.js";
import { RuntimeOrchestration } from "./runtime/orchestration.js";
import { RuntimeMemoryPipeline } from "./runtime/memoryPipeline.js";
import { RuntimeDelivery } from "./runtime/delivery.js";
import { RuntimeConversations } from "./runtime/conversations.js";
import { RuntimeSelfie } from "./runtime/selfie.js";
import { RuntimeGroupThreads } from "./runtime/groupThreadPipeline.js";
import { RuntimeReplyDebounce } from "./runtime/replyDebounce.js";
import { RuntimeConversationAssets } from "./runtime/conversationAssets.js";
import { RuntimeScheduledTasks } from "./runtime/scheduledTasks.js";
import { RuntimeVoice } from "./runtime/voice.js";
import { RuntimeDirector } from "./runtime/director.js";
import { RuntimeAir } from "./runtime/air.js";
import { RuntimeDreams } from "./runtime/dreamPipeline.js";
import { createRuntimeDreamsForHost, forceRuntimeDreamForHost } from "./runtime/dreamRuntime.js";
import { RuntimeTone } from "./runtime/tone.js";
import { TaskLimiter, errorMessage, loadConversationRecords } from "./runtime/infrastructure.js";
import type {
  RuntimeToolCapabilities,
  RuntimeToolCapabilityResolver,
  WorkspaceBashUnavailableReason
} from "../services/tools/bashCapability.js";
import type { BashExecutionBackend } from "../services/tools/bashAudit.js";
import type { SystemConfigRuntimePort } from "../services/tools/systemConfigTool.js";
import type { ReplyTaskGate } from "../services/orchestration/broadcastStormDetector.js";
import { runWithAgentRuntimeContext } from "../packages/platform/runtimeAgentContext.js";
import type { RuntimeAgentExtensionsPort } from "./runtime/agentExtensions.js";
export * from "./runtime/runtimeContracts.js";
export * from "./runtime/runtimeHelpers.js";

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
  readonly memoryScheduler: MemorySchedulerStore;
  memoryDrainPromise?: Promise<void>;
  memoryDrainDirty = false;
  memoryWakeTimer?: NodeJS.Timeout;
  readonly hooks = new HookBus();
  readonly attachmentService: AttachmentService;
  readonly senderNameResolver = new SenderNameResolver();
  readonly sessionStore: SessionStore;
  readonly ownsSessionStore: boolean;
  readonly sessionCoordinator: SessionCoordinator;
  readonly scheduledTasks: RuntimeScheduledTasks;
  readonly director: RuntimeDirector;
  readonly air: RuntimeAir;
  readonly dreams: RuntimeDreams;
  readonly bashAudit?: RuntimeBashAuditPort;
  private readonly rawToolCapabilityResolver?: RuntimeToolCapabilityResolver;
  readonly systemConfig?: SystemConfigRuntimePort;
  readonly agentExtensions?: RuntimeAgentExtensionsPort;
  readonly replyTaskGate: ReplyTaskGate;
  readonly incomingPreparations = new Map<string, {
      promise: Promise<void>;
      incoming: ParsedIncomingMessage;
    }>();
  activeGateway?: MessagingPort;
  private readonly lifecycle: RuntimeLifecycle;
  private readonly intake: RuntimeIntake;
  private readonly reply: RuntimeReply;
  private readonly orchestration: RuntimeOrchestration;
  private readonly memory: RuntimeMemoryPipeline;
  private readonly tone: RuntimeTone;
  private readonly delivery: RuntimeDelivery;
  private readonly conversations: RuntimeConversations;
  private readonly selfie: RuntimeSelfie;
  private readonly groupThreads: RuntimeGroupThreads;
  private readonly replyDebounce: RuntimeReplyDebounce;
  private readonly conversationAssets: RuntimeConversationAssets;
  private readonly voice: RuntimeVoice;
  constructor(config: AppConfig, options: SunaRuntimeOptions = {}) {
      configureMemoryPersistence(sqliteMemoryPersistence);
      this.config = config;
      this.conversationRecords = new Map(loadConversationRecords(config).map((record) => [record.id, record]));
      this.rawToolCapabilityResolver = options.resolveToolCapabilities;
      this.bashAudit = options.bashAudit;
      this.systemConfig = options.systemConfig;
      this.agentExtensions = options.agentExtensions;
      this.replyTaskGate = options.replyTaskGate ?? { canCreateTaskFor: () => true };
      this.memoryScheduler = new MemorySchedulerStore(config);
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
      this.intake = new RuntimeIntake(this);
      this.reply = new RuntimeReply(this);
      this.orchestration = new RuntimeOrchestration(this);
      this.memory = new RuntimeMemoryPipeline(this);
      this.tone = new RuntimeTone(this);
      this.delivery = new RuntimeDelivery(this);
      this.conversations = new RuntimeConversations(this);
      this.selfie = new RuntimeSelfie(this);
      this.groupThreads = new RuntimeGroupThreads(this);
      this.replyDebounce = new RuntimeReplyDebounce(
        this,
        optionalNonNegativeReplyDebounceMs(options.replyDebounceMs)
      );
      this.conversationAssets = new RuntimeConversationAssets(this);
      this.voice = new RuntimeVoice(this, options.voice);
  }
  private inAgentContext<T>(operation: () => T): T { return runWithAgentRuntimeContext(this.config, operation); }
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
  consolidateWorkingMemory(...args: Parameters<RuntimeLifecycle["consolidateWorkingMemory"]>) { return this.inAgentContext(() => this.lifecycle.consolidateWorkingMemory(...args)); }
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
  hydrateConversationRecords(...args: Parameters<RuntimeIntake["hydrateConversationRecords"]>) { return this.intake.hydrateConversationRecords(...args); }
  performHydrateConversationRecords(...args: Parameters<RuntimeIntake["performHydrateConversationRecords"]>) { return this.intake.performHydrateConversationRecords(...args); }
  handleInboundMessage(...args: Parameters<RuntimeIntake["handleInboundMessage"]>) { return this.inAgentContext(() => this.intake.handleInboundMessage(...args)); }
  processSessionEvent(...args: Parameters<RuntimeIntake["processSessionEvent"]>) { return this.inAgentContext(() => this.intake.processSessionEvent(...args)); }
  processIncomingReplyEvent(...args: Parameters<RuntimeIntake["processIncomingReplyEvent"]>) { return this.inAgentContext(() => this.intake.processIncomingReplyEvent(...args)); }
  deliverSessionOutbox(...args: Parameters<RuntimeIntake["deliverSessionOutbox"]>) { return this.inAgentContext(() => this.intake.deliverSessionOutbox(...args)); }
  conversationAssetProviderOptions(...args: Parameters<RuntimeConversationAssets["providerOptions"]>) { return this.conversationAssets.providerOptions(...args); }
  queueConversationAsset(...args: Parameters<RuntimeConversationAssets["queue"]>) { return this.inAgentContext(() => this.conversationAssets.queue(...args)); }
  deliverConversationAssetOutbox(...args: Parameters<RuntimeConversationAssets["deliver"]>) { return this.inAgentContext(() => this.conversationAssets.deliver(...args)); }
  voiceSnapshot(...args: Parameters<RuntimeVoice["snapshot"]>) { return this.inAgentContext(() => this.voice.snapshot(...args)); }
  voiceProviderCapability(...args: Parameters<RuntimeVoice["providerCapability"]>) { return this.voice.providerCapability(...args); }
  synthesizeAndQueueVoice(...args: Parameters<RuntimeVoice["synthesizeAndQueue"]>) { return this.inAgentContext(() => this.voice.synthesizeAndQueue(...args)); }
  requireActiveGateway(...args: Parameters<RuntimeIntake["requireActiveGateway"]>) { return this.intake.requireActiveGateway(...args); }
  handleIncomingMessage(...args: Parameters<RuntimeIntake["handleIncomingMessage"]>) { return this.inAgentContext(() => this.intake.handleIncomingMessage(...args)); }
  prepareIncomingMessage(...args: Parameters<RuntimeIntake["prepareIncomingMessage"]>) { return this.intake.prepareIncomingMessage(...args); }
  replyToIncoming(...args: Parameters<RuntimeReply["replyToIncoming"]>) { return this.inAgentContext(() => this.reply.replyToIncoming(...args)); }
  replyWithGroupChatSummary(...args: Parameters<RuntimeReply["replyWithGroupChatSummary"]>) { return this.reply.replyWithGroupChatSummary(...args); }
  replyToToolCompletion(...args: Parameters<RuntimeReply["replyToToolCompletion"]>) { return this.reply.replyToToolCompletion(...args); }
  processDeferredToolJob(...args: Parameters<RuntimeReply["processDeferredToolJob"]>) { return this.inAgentContext(() => this.reply.processDeferredToolJob(...args)); }
  attachReplyReferences(...args: Parameters<RuntimeReply["attachReplyReferences"]>) { return this.reply.attachReplyReferences(...args); }
  loadMessageDetails(...args: Parameters<RuntimeReply["loadMessageDetails"]>) { return this.reply.loadMessageDetails(...args); }
  loadQuoteReferences(...args: Parameters<RuntimeReply["loadQuoteReferences"]>) { return this.reply.loadQuoteReferences(...args); }
  selectRelevantAttachments(...args: Parameters<RuntimeReply["selectRelevantAttachments"]>) { return this.reply.selectRelevantAttachments(...args); }
  refreshAttachmentCacheReferences(...args: Parameters<RuntimeReply["refreshAttachmentCacheReferences"]>) { return this.reply.refreshAttachmentCacheReferences(...args); }
  buildRecentContextMessages(...args: Parameters<RuntimeReply["buildRecentContextMessages"]>) { return this.reply.buildRecentContextMessages(...args); }
  contextMessageLimit(...args: Parameters<RuntimeReply["contextMessageLimit"]>) { return this.reply.contextMessageLimit(...args); }
  retainedConversationMessageLimit(...args: Parameters<RuntimeReply["retainedConversationMessageLimit"]>) { return this.reply.retainedConversationMessageLimit(...args); }
  groupReplyOptions(...args: Parameters<RuntimeReply["groupReplyOptions"]>) { return this.reply.groupReplyOptions(...args); }
  resolveProviderBashHandle(incoming: ParsedIncomingMessage, promptOverride?: string) {
    return this.reply.resolveProviderBashHandle(incoming, promptOverride, this.rawToolCapabilityResolver);
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
  isAdminUser(...args: Parameters<RuntimeReply["isAdminUser"]>) { return this.reply.isAdminUser(...args); }
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
  scheduleAttachmentCacheRefresh(...args: Parameters<RuntimeMemoryPipeline["scheduleAttachmentCacheRefresh"]>) { return this.memory.scheduleAttachmentCacheRefresh(...args); }
  scheduleMemoryCompression(...args: Parameters<RuntimeMemoryPipeline["scheduleMemoryCompression"]>) { return this.memory.scheduleMemoryCompression(...args); }
  seedMemoryScheduler(...args: Parameters<RuntimeMemoryPipeline["seedMemoryScheduler"]>) { return this.memory.seedMemoryScheduler(...args); }
  enqueueConversationMemory(...args: Parameters<RuntimeMemoryPipeline["enqueueConversationMemory"]>) { return this.memory.enqueueConversationMemory(...args); }
  scheduleMemoryDrain(...args: Parameters<RuntimeMemoryPipeline["scheduleMemoryDrain"]>) { return this.memory.scheduleMemoryDrain(...args); }
  armMemoryWakeTimer(...args: Parameters<RuntimeMemoryPipeline["armMemoryWakeTimer"]>) { return this.memory.armMemoryWakeTimer(...args); }
  drainMemoryScheduler(...args: Parameters<RuntimeMemoryPipeline["drainMemoryScheduler"]>) { return this.inAgentContext(() => this.memory.drainMemoryScheduler(...args)); }
  projectMemoryCursor(...args: Parameters<RuntimeMemoryPipeline["projectMemoryCursor"]>) { return this.memory.projectMemoryCursor(...args); }
  rewriteToneText(...args: Parameters<RuntimeTone["rewrite"]>) { return this.inAgentContext(() => this.tone.rewrite(...args)); }
  rewriteToneDelivery(...args: Parameters<RuntimeTone["rewriteForDelivery"]>) { return this.inAgentContext(() => this.tone.rewriteForDelivery(...args)); }
  sendAssistantReply(...args: Parameters<RuntimeDelivery["sendAssistantReply"]>) { return this.delivery.sendAssistantReply(...args); }
  replyDeliveryDraft(...args: Parameters<RuntimeDelivery["replyDeliveryDraft"]>) { return this.delivery.replyDeliveryDraft(...args); }
  deliverReplyOutbox(...args: Parameters<RuntimeDelivery["deliverReplyOutbox"]>) { return this.delivery.deliverReplyOutbox(...args); }
  sendErrorReply(...args: Parameters<RuntimeDelivery["sendErrorReply"]>) { return this.delivery.sendErrorReply(...args); }
  incomingCaptureSequence(...args: Parameters<RuntimeConversations["incomingCaptureSequence"]>) { return this.conversations.incomingCaptureSequence(...args); }
  recordIncomingMessage(...args: Parameters<RuntimeConversations["recordIncomingMessage"]>) { return this.conversations.recordIncomingMessage(...args); }
  recordAssistantRequestStarted(...args: Parameters<RuntimeConversations["recordAssistantRequestStarted"]>) { return this.conversations.recordAssistantRequestStarted(...args); }
  recordAssistantMessage(...args: Parameters<RuntimeConversations["recordAssistantMessage"]>) { return this.conversations.recordAssistantMessage(...args); }
  recordAssistantTurnTools(...args: Parameters<RuntimeConversations["recordAssistantTurnTools"]>) { return this.conversations.recordAssistantTurnTools(...args); }
  discardAssistantRequest(...args: Parameters<RuntimeConversations["discardAssistantRequest"]>) { return this.conversations.discardAssistantRequest(...args); }
  ensureConversationRecord(...args: Parameters<RuntimeConversations["ensureConversationRecord"]>) { return this.conversations.ensureConversationRecord(...args); }
  upsertConversationRecordForReplySetting(...args: Parameters<RuntimeConversations["upsertConversationRecordForReplySetting"]>) { return this.conversations.upsertConversationRecordForReplySetting(...args); }
  persistConversationRecords(...args: Parameters<RuntimeConversations["persistConversationRecords"]>) { return this.inAgentContext(() => this.conversations.persistConversationRecords(...args)); }
  persistConversationRecordStrict(...args: Parameters<RuntimeConversations["persistConversationRecordStrict"]>) { return this.inAgentContext(() => this.conversations.persistConversationRecordStrict(...args)); }
  markConversationMessagesAsRecordedOnly(...args: Parameters<RuntimeConversations["markConversationMessagesAsRecordedOnly"]>) { return this.conversations.markConversationMessagesAsRecordedOnly(...args); }
  getActiveConversationRecords(...args: Parameters<RuntimeConversations["getActiveConversationRecords"]>) { return this.conversations.getActiveConversationRecords(...args); }
  recordServiceMessage(...args: Parameters<RuntimeConversations["recordServiceMessage"]>) { return this.conversations.recordServiceMessage(...args); }
  processMemoryClaim(...args: Parameters<RuntimeMemoryPipeline["processMemoryClaim"]>) { return this.inAgentContext(() => this.memory.processMemoryClaim(...args)); }
  enrichParticipantAddressNames(...args: Parameters<RuntimeMemoryPipeline["enrichParticipantAddressNames"]>) { return this.memory.enrichParticipantAddressNames(...args); }
  mergeConversationWorkingMemory(...args: Parameters<RuntimeMemoryPipeline["mergeConversationWorkingMemory"]>) { return this.inAgentContext(() => this.memory.mergeConversationWorkingMemory(...args)); }
  mergeWorkingMemory(...args: Parameters<RuntimeMemoryPipeline["mergeWorkingMemory"]>) { return this.inAgentContext(() => this.memory.mergeWorkingMemory(...args)); }
  requestWorkingMemoryMerge(...args: Parameters<RuntimeMemoryPipeline["requestWorkingMemoryMerge"]>) { return this.inAgentContext(() => this.memory.requestWorkingMemoryMerge(...args)); }
  compressUserProfiles(...args: Parameters<RuntimeMemoryPipeline["compressUserProfiles"]>) { return this.inAgentContext(() => this.memory.compressUserProfiles(...args)); }
  readRelevantUserProfiles(...args: Parameters<RuntimeSelfie["readRelevantUserProfiles"]>) { return this.selfie.readRelevantUserProfiles(...args); }
  runSelfie(...args: Parameters<RuntimeSelfie["runSelfie"]>) { return this.inAgentContext(() => this.selfie.runSelfie(...args)); }
  rewriteSelfiePrompt(...args: Parameters<RuntimeSelfie["rewriteSelfiePrompt"]>) { return this.inAgentContext(() => this.selfie.rewriteSelfiePrompt(...args)); }
  collectSelfieChatReferenceImages(...args: Parameters<RuntimeSelfie["collectSelfieChatReferenceImages"]>) { return this.selfie.collectSelfieChatReferenceImages(...args); }
  loadSelfieReferenceImages(...args: Parameters<RuntimeSelfie["loadSelfieReferenceImages"]>) { return this.selfie.loadSelfieReferenceImages(...args); }
  prepareGroupThreadContext(...args: Parameters<RuntimeGroupThreads["prepareGroupThreadContext"]>) { return this.inAgentContext(() => this.groupThreads.prepareGroupThreadContext(...args)); }
  groupThreadPromptContext(...args: Parameters<RuntimeGroupThreads["promptContext"]>) { return this.groupThreads.promptContext(...args); }
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
