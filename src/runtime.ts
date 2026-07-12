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
import { getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "./config.js";
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
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtime/runtimeContracts.js";
import { RuntimeLifecycle } from "./runtime/lifecycle.js";
import { RuntimeIntake } from "./runtime/intake.js";
import { RuntimeReply } from "./runtime/reply.js";
import { RuntimeOrchestration } from "./runtime/orchestration.js";
import { RuntimeMemoryPipeline } from "./runtime/memoryPipeline.js";
import { RuntimeDelivery } from "./runtime/delivery.js";
import { RuntimeConversations } from "./runtime/conversations.js";
import { RuntimeSelfie } from "./runtime/selfie.js";
import { TaskLimiter, errorMessage, loadConversationRecords } from "./runtime/infrastructure.js";
export * from "./runtime/runtimeContracts.js";
export * from "./runtime/runtimeHelpers.js";

export class SunaRuntime {
  persona?: AgentPersona;
  config: AppConfig;
  readonly conversationRecords = new Map(loadConversationRecords().map((record) => [record.id, record]));
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
  private readonly delivery: RuntimeDelivery;
  private readonly conversations: RuntimeConversations;
  private readonly selfie: RuntimeSelfie;
  constructor(config: AppConfig, options: SunaRuntimeOptions = {}) {
      configureMemoryPersistence(sqliteMemoryPersistence);
      this.config = config;
      this.memoryScheduler = new MemorySchedulerStore(config);
      this.attachmentService = options.attachmentService ?? new AttachmentService(getRootDir(), {
        cacheRoot: getWorkspacePath(WORKSPACE_LAYOUT.attachmentCache),
        cacheOptions: { trustedResolvedAddress: isTrustedQqFakeIp }
      });
      this.ownsSessionStore = !options.sessionStore;
      this.sessionStore = options.sessionStore ?? new SessionStore({
        databasePath: process.env.VITEST
          ? ":memory:"
          : getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue)
      });
      this.sessionCoordinator = new SessionCoordinator({
        store: this.sessionStore,
        handleEvent: (event, context) => this.processSessionEvent(event, context.signal),
        deliverOutbox: (outbox, context) => this.deliverSessionOutbox(outbox, context.signal),
        codexRunner: options.codexRunner ?? new CodexToolRunner(),
        cleanupCodexProcess: cleanupPersistedCodexProcess,
        runDeferredTool: (job, signal) => this.processDeferredToolJob(job, signal),
        observeCodexToolUsage: async (observation) => {
          await appendRequestLog({
            category: "model.response",
            action: "codex.tool.complete",
            providerKind: "codex-cli",
            model: observation.model,
            response: {
              ok: observation.ok,
              status: observation.status,
              usage: observation.usage
            },
            metadata: { jobId: observation.jobId }
          });
        },
        codexSettings: () => ({
          enabled: this.config.bot.tools.codex.enabled,
          model: this.config.bot.tools.codex.model,
          executable: this.config.bot.tools.codex.codexExecutable,
          timeoutMs: this.config.bot.tools.codex.timeoutMs,
          maxConcurrency: this.config.bot.tools.codex.maxConcurrency,
          workspacePath: resolveProjectPath(this.config.persona.agentWorkspace) ?? getRootDir(),
          jobRoot: getWorkspacePath(WORKSPACE_LAYOUT.codexJobs)
        }),
        turnTimeoutMs: DIRECT_REPLY_TIMEOUT_MS + 5_000,
        maxSessionConcurrency: 4,
        isDisconnectedError: (error) => error instanceof OutboxDisconnectedError ||
          /OneBot is not connected|websocket.*closed/i.test(errorMessage(error))
      });
      this.commandRouter = new CommandRouter<RuntimeCommandContext>([
        {
          id: "group-summary",
          names: ["总结群聊"],
          handler: async ({ channelKey, incoming, gateway, signal, isCurrent, delivery }) => {
            await this.replyWithGroupChatSummary(channelKey, incoming, gateway, signal, isCurrent, delivery);
          }
        }
      ]);
        this.lifecycle = new RuntimeLifecycle(this);
      this.intake = new RuntimeIntake(this);
      this.reply = new RuntimeReply(this);
      this.orchestration = new RuntimeOrchestration(this);
      this.memory = new RuntimeMemoryPipeline(this);
      this.delivery = new RuntimeDelivery(this);
      this.conversations = new RuntimeConversations(this);
      this.selfie = new RuntimeSelfie(this);
  }
  initialize(...args: Parameters<RuntimeLifecycle["initialize"]>) { return this.lifecycle.initialize(...args); }
  close(...args: Parameters<RuntimeLifecycle["close"]>) { return this.lifecycle.close(...args); }
  reload(...args: Parameters<RuntimeLifecycle["reload"]>) { return this.lifecycle.reload(...args); }
  prepareReload(...args: Parameters<RuntimeLifecycle["prepareReload"]>) { return this.lifecycle.prepareReload(...args); }
  commitReload(...args: Parameters<RuntimeLifecycle["commitReload"]>) { return this.lifecycle.commitReload(...args); }
  reloadPrompts(...args: Parameters<RuntimeLifecycle["reloadPrompts"]>) { return this.lifecycle.reloadPrompts(...args); }
  preparePromptReload(...args: Parameters<RuntimeLifecycle["preparePromptReload"]>) { return this.lifecycle.preparePromptReload(...args); }
  commitPromptReload(...args: Parameters<RuntimeLifecycle["commitPromptReload"]>) { return this.lifecycle.commitPromptReload(...args); }
  getPersonaStatus(...args: Parameters<RuntimeLifecycle["getPersonaStatus"]>) { return this.lifecycle.getPersonaStatus(...args); }
  getProviderStatus(...args: Parameters<RuntimeLifecycle["getProviderStatus"]>) { return this.lifecycle.getProviderStatus(...args); }
  consolidateWorkingMemory(...args: Parameters<RuntimeLifecycle["consolidateWorkingMemory"]>) { return this.lifecycle.consolidateWorkingMemory(...args); }
  getProvider(...args: Parameters<RuntimeLifecycle["getProvider"]>) { return this.lifecycle.getProvider(...args); }
  getProviderForModel(...args: Parameters<RuntimeLifecycle["getProviderForModel"]>) { return this.lifecycle.getProviderForModel(...args); }
  ensureAgentPromptFiles(...args: Parameters<RuntimeLifecycle["ensureAgentPromptFiles"]>) { return this.lifecycle.ensureAgentPromptFiles(...args); }
  defaultPromptContent(...args: Parameters<RuntimeLifecycle["defaultPromptContent"]>) { return this.lifecycle.defaultPromptContent(...args); }
  renderPromptRequest(...args: Parameters<RuntimeLifecycle["renderPromptRequest"]>) { return this.lifecycle.renderPromptRequest(...args); }
  completePrompt(...args: Parameters<RuntimeLifecycle["completePrompt"]>) { return this.lifecycle.completePrompt(...args); }
  completePromptTurn(...args: Parameters<RuntimeLifecycle["completePromptTurn"]>) { return this.lifecycle.completePromptTurn(...args); }
  getConversationRecords(...args: Parameters<RuntimeLifecycle["getConversationRecords"]>) { return this.lifecycle.getConversationRecords(...args); }
  publicConversationRecord(...args: Parameters<RuntimeLifecycle["publicConversationRecord"]>) { return this.lifecycle.publicConversationRecord(...args); }
  getConversationMessages(...args: Parameters<RuntimeLifecycle["getConversationMessages"]>) { return this.lifecycle.getConversationMessages(...args); }
  hydrateConversationIdentities(...args: Parameters<RuntimeLifecycle["hydrateConversationIdentities"]>) { return this.lifecycle.hydrateConversationIdentities(...args); }
  enrichMemoryEntries(...args: Parameters<RuntimeLifecycle["enrichMemoryEntries"]>) { return this.lifecycle.enrichMemoryEntries(...args); }
  setConversationReplyEnabled(...args: Parameters<RuntimeLifecycle["setConversationReplyEnabled"]>) { return this.lifecycle.setConversationReplyEnabled(...args); }
  announceServiceOnline(...args: Parameters<RuntimeLifecycle["announceServiceOnline"]>) { return this.lifecycle.announceServiceOnline(...args); }
  hydrateConversationRecords(...args: Parameters<RuntimeIntake["hydrateConversationRecords"]>) { return this.intake.hydrateConversationRecords(...args); }
  performHydrateConversationRecords(...args: Parameters<RuntimeIntake["performHydrateConversationRecords"]>) { return this.intake.performHydrateConversationRecords(...args); }
  handleInboundMessage(...args: Parameters<RuntimeIntake["handleInboundMessage"]>) { return this.intake.handleInboundMessage(...args); }
  processSessionEvent(...args: Parameters<RuntimeIntake["processSessionEvent"]>) { return this.intake.processSessionEvent(...args); }
  processIncomingReplyEvent(...args: Parameters<RuntimeIntake["processIncomingReplyEvent"]>) { return this.intake.processIncomingReplyEvent(...args); }
  deliverSessionOutbox(...args: Parameters<RuntimeIntake["deliverSessionOutbox"]>) { return this.intake.deliverSessionOutbox(...args); }
  requireActiveGateway(...args: Parameters<RuntimeIntake["requireActiveGateway"]>) { return this.intake.requireActiveGateway(...args); }
  handleIncomingMessage(...args: Parameters<RuntimeIntake["handleIncomingMessage"]>) { return this.intake.handleIncomingMessage(...args); }
  prepareIncomingMessage(...args: Parameters<RuntimeIntake["prepareIncomingMessage"]>) { return this.intake.prepareIncomingMessage(...args); }
  replyToIncoming(...args: Parameters<RuntimeReply["replyToIncoming"]>) { return this.reply.replyToIncoming(...args); }
  replyWithGroupChatSummary(...args: Parameters<RuntimeReply["replyWithGroupChatSummary"]>) { return this.reply.replyWithGroupChatSummary(...args); }
  replyToToolCompletion(...args: Parameters<RuntimeReply["replyToToolCompletion"]>) { return this.reply.replyToToolCompletion(...args); }
  processDeferredToolJob(...args: Parameters<RuntimeReply["processDeferredToolJob"]>) { return this.reply.processDeferredToolJob(...args); }
  attachReplyReferences(...args: Parameters<RuntimeReply["attachReplyReferences"]>) { return this.reply.attachReplyReferences(...args); }
  loadMessageDetails(...args: Parameters<RuntimeReply["loadMessageDetails"]>) { return this.reply.loadMessageDetails(...args); }
  loadQuoteReferences(...args: Parameters<RuntimeReply["loadQuoteReferences"]>) { return this.reply.loadQuoteReferences(...args); }
  selectRelevantAttachments(...args: Parameters<RuntimeReply["selectRelevantAttachments"]>) { return this.reply.selectRelevantAttachments(...args); }
  refreshAttachmentCacheReferences(...args: Parameters<RuntimeReply["refreshAttachmentCacheReferences"]>) { return this.reply.refreshAttachmentCacheReferences(...args); }
  buildRecentContextMessages(...args: Parameters<RuntimeReply["buildRecentContextMessages"]>) { return this.reply.buildRecentContextMessages(...args); }
  contextMessageLimit(...args: Parameters<RuntimeReply["contextMessageLimit"]>) { return this.reply.contextMessageLimit(...args); }
  retainedConversationMessageLimit(...args: Parameters<RuntimeReply["retainedConversationMessageLimit"]>) { return this.reply.retainedConversationMessageLimit(...args); }
  groupReplyOptions(...args: Parameters<RuntimeReply["groupReplyOptions"]>) { return this.reply.groupReplyOptions(...args); }
  buildProviderBashOptions(...args: Parameters<RuntimeReply["buildProviderBashOptions"]>) { return this.reply.buildProviderBashOptions(...args); }
  isAdminUser(...args: Parameters<RuntimeReply["isAdminUser"]>) { return this.reply.isAdminUser(...args); }
  adminIdentity(...args: Parameters<RuntimeOrchestration["adminIdentity"]>) { return this.orchestration.adminIdentity(...args); }
  isReplySenderAllowed(...args: Parameters<RuntimeOrchestration["isReplySenderAllowed"]>) { return this.orchestration.isReplySenderAllowed(...args); }
  isDuplicateIncoming(...args: Parameters<RuntimeOrchestration["isDuplicateIncoming"]>) { return this.orchestration.isDuplicateIncoming(...args); }
  markIncomingSeen(...args: Parameters<RuntimeOrchestration["markIncomingSeen"]>) { return this.orchestration.markIncomingSeen(...args); }
  resolveIncomingReplyRoute(...args: Parameters<RuntimeOrchestration["resolveIncomingReplyRoute"]>) { return this.orchestration.resolveIncomingReplyRoute(...args); }
  isReplyTaskCurrent(...args: Parameters<RuntimeOrchestration["isReplyTaskCurrent"]>) { return this.orchestration.isReplyTaskCurrent(...args); }
  cancelScopeReplies(...args: Parameters<RuntimeOrchestration["cancelScopeReplies"]>) { return this.orchestration.cancelScopeReplies(...args); }
  cancelAllAmbientReplies(...args: Parameters<RuntimeOrchestration["cancelAllAmbientReplies"]>) { return this.orchestration.cancelAllAmbientReplies(...args); }
  resumeUserGroupOrchestrators(...args: Parameters<RuntimeOrchestration["resumeUserGroupOrchestrators"]>) { return this.orchestration.resumeUserGroupOrchestrators(...args); }
  suspendUserGroupOrchestrators(...args: Parameters<RuntimeOrchestration["suspendUserGroupOrchestrators"]>) { return this.orchestration.suspendUserGroupOrchestrators(...args); }
  patchIncomingMessage(...args: Parameters<RuntimeOrchestration["patchIncomingMessage"]>) { return this.orchestration.patchIncomingMessage(...args); }
  shouldRunUserGroupchatOrchestrator(...args: Parameters<RuntimeOrchestration["shouldRunUserGroupchatOrchestrator"]>) { return this.orchestration.shouldRunUserGroupchatOrchestrator(...args); }
  pendingOrchestratorUserMessages(...args: Parameters<RuntimeOrchestration["pendingOrchestratorUserMessages"]>) { return this.orchestration.pendingOrchestratorUserMessages(...args); }
  scheduleAmbientIdleReply(...args: Parameters<RuntimeOrchestration["scheduleAmbientIdleReply"]>) { return this.orchestration.scheduleAmbientIdleReply(...args); }
  cancelAmbientIdleTimer(...args: Parameters<RuntimeOrchestration["cancelAmbientIdleTimer"]>) { return this.orchestration.cancelAmbientIdleTimer(...args); }
  queueAmbientReply(...args: Parameters<RuntimeOrchestration["queueAmbientReply"]>) { return this.orchestration.queueAmbientReply(...args); }
  pumpAmbientReply(...args: Parameters<RuntimeOrchestration["pumpAmbientReply"]>) { return this.orchestration.pumpAmbientReply(...args); }
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
  drainMemoryScheduler(...args: Parameters<RuntimeMemoryPipeline["drainMemoryScheduler"]>) { return this.memory.drainMemoryScheduler(...args); }
  projectMemoryCursor(...args: Parameters<RuntimeMemoryPipeline["projectMemoryCursor"]>) { return this.memory.projectMemoryCursor(...args); }
  sendAssistantReply(...args: Parameters<RuntimeDelivery["sendAssistantReply"]>) { return this.delivery.sendAssistantReply(...args); }
  replyDeliveryDraft(...args: Parameters<RuntimeDelivery["replyDeliveryDraft"]>) { return this.delivery.replyDeliveryDraft(...args); }
  deliverReplyOutbox(...args: Parameters<RuntimeDelivery["deliverReplyOutbox"]>) { return this.delivery.deliverReplyOutbox(...args); }
  sendErrorReply(...args: Parameters<RuntimeDelivery["sendErrorReply"]>) { return this.delivery.sendErrorReply(...args); }
  incomingCaptureSequence(...args: Parameters<RuntimeConversations["incomingCaptureSequence"]>) { return this.conversations.incomingCaptureSequence(...args); }
  recordIncomingMessage(...args: Parameters<RuntimeConversations["recordIncomingMessage"]>) { return this.conversations.recordIncomingMessage(...args); }
  recordAssistantRequestStarted(...args: Parameters<RuntimeConversations["recordAssistantRequestStarted"]>) { return this.conversations.recordAssistantRequestStarted(...args); }
  recordAssistantMessage(...args: Parameters<RuntimeConversations["recordAssistantMessage"]>) { return this.conversations.recordAssistantMessage(...args); }
  ensureConversationRecord(...args: Parameters<RuntimeConversations["ensureConversationRecord"]>) { return this.conversations.ensureConversationRecord(...args); }
  upsertConversationRecordForReplySetting(...args: Parameters<RuntimeConversations["upsertConversationRecordForReplySetting"]>) { return this.conversations.upsertConversationRecordForReplySetting(...args); }
  persistConversationRecords(...args: Parameters<RuntimeConversations["persistConversationRecords"]>) { return this.conversations.persistConversationRecords(...args); }
  markConversationMessagesAsRecordedOnly(...args: Parameters<RuntimeConversations["markConversationMessagesAsRecordedOnly"]>) { return this.conversations.markConversationMessagesAsRecordedOnly(...args); }
  getActiveConversationRecords(...args: Parameters<RuntimeConversations["getActiveConversationRecords"]>) { return this.conversations.getActiveConversationRecords(...args); }
  recordServiceMessage(...args: Parameters<RuntimeConversations["recordServiceMessage"]>) { return this.conversations.recordServiceMessage(...args); }
  processMemoryClaim(...args: Parameters<RuntimeMemoryPipeline["processMemoryClaim"]>) { return this.memory.processMemoryClaim(...args); }
  enrichParticipantAddressNames(...args: Parameters<RuntimeMemoryPipeline["enrichParticipantAddressNames"]>) { return this.memory.enrichParticipantAddressNames(...args); }
  mergeConversationWorkingMemory(...args: Parameters<RuntimeMemoryPipeline["mergeConversationWorkingMemory"]>) { return this.memory.mergeConversationWorkingMemory(...args); }
  mergeWorkingMemory(...args: Parameters<RuntimeMemoryPipeline["mergeWorkingMemory"]>) { return this.memory.mergeWorkingMemory(...args); }
  requestWorkingMemoryMerge(...args: Parameters<RuntimeMemoryPipeline["requestWorkingMemoryMerge"]>) { return this.memory.requestWorkingMemoryMerge(...args); }
  compressUserProfiles(...args: Parameters<RuntimeMemoryPipeline["compressUserProfiles"]>) { return this.memory.compressUserProfiles(...args); }
  readRelevantUserProfiles(...args: Parameters<RuntimeSelfie["readRelevantUserProfiles"]>) { return this.selfie.readRelevantUserProfiles(...args); }
  runSelfie(...args: Parameters<RuntimeSelfie["runSelfie"]>) { return this.selfie.runSelfie(...args); }
  rewriteSelfiePrompt(...args: Parameters<RuntimeSelfie["rewriteSelfiePrompt"]>) { return this.selfie.rewriteSelfiePrompt(...args); }
  collectSelfieChatReferenceImages(...args: Parameters<RuntimeSelfie["collectSelfieChatReferenceImages"]>) { return this.selfie.collectSelfieChatReferenceImages(...args); }
  loadSelfieReferenceImages(...args: Parameters<RuntimeSelfie["loadSelfieReferenceImages"]>) { return this.selfie.loadSelfieReferenceImages(...args); }
}
