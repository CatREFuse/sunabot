import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
  ChatMessage,
  ConversationMessageStats,
  ConversationMessageQuote,
  ConversationRecord,
  ImageResult,
  ParsedIncomingMessage,
  ReasoningEffort
} from "../types.js";
import { resolveModelReasoningEffort } from "../admin/models.js";
import { AttachmentService } from "../../services/media/attachments/service.js";
import type {
  AttachmentExtractionContext,
  ParsedAttachment
} from "../../services/media/attachments/types.js";
import { CommandRouter, type CommandMatch } from "../../services/messaging/commandRouter.js";
import { isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import { getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "../config.js";
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
} from "../../packages/contracts/session/runtimeMessages.js";
import { applicationDataStore, sqliteMemoryPersistence } from "../../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import {
  ReplyGateEpochs,
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute,
  type ReplyGateSnapshot
} from "../../services/orchestration/groupReplyPolicy.js";
import { HookBus } from "../../services/messaging/hookBus.js";
import {
  applyMemoryBatchTransaction,
  formatMemoryMatchesForPrompt,
  isMemoryBatchCommitted,
  mergeUserProfileMemory,
  normalizeEventMemorySchema,
  readMemorySourceEntries,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  recallMemory,
  recoverMemoryTransactions,
  replaceWorkingMemoryFacts,
  resolveUserAddressName,
  type MemoryEntry,
  type MemoryFactInput
} from "../../services/memory/memoryService.js";
import {
  MemorySchedulerStore,
  type MemoryClaim,
  type MemoryQueuedMessage
} from "../../services/memory/memoryScheduler.js";
import {
  OpenAIProvider,
  type ProviderBashOptions,
  type ProviderCompleteOptions,
  type ProviderDeferredTurn
} from "../../adapters/model/openaiProvider.js";
import { probeProviderMultimodal } from "../../adapters/model/providerDiscovery.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import {
  inboundImageUrls,
  replaceInboundImageUrls,
  type MessageDetailsV1,
  type MessagingPort,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import { loadPersona, AgentPersona } from "../../services/agent/persona.js";
import { appendRequestLog } from "../requestLog.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import { ensurePromptTextFile, readPromptTextFile } from "../../services/agent/promptWorkspace.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../../services/agent/persona.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, PRIVATE_CONVERSATION_REPLY_PROMPT_FILE, GROUP_CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { clampInteger, indexedConversationMessages } from "./conversationMemoryHelpers.js";
import { conversationOrchestratorEnabled, conversationReplyEnabled, enrichMemoryEntriesWithConversations, isWebConversationId, normalizeConversationId, normalizeConversationLookupId, outboundForRecord } from "./messagingAttachmentHelpers.js";
import { conversationMemberNames } from "./selfieHelpers.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export async function runtime_initialize(this: RuntimeHost) {
    await this.attachmentService.initialize();
    await this.ensureAgentPromptFiles();
    await mergeUserProfileMemory(this.config);
    await recoverMemoryTransactions(this.config);
    await normalizeEventMemorySchema(this.config);
    await this.memoryScheduler.initialize();
    await this.seedMemoryScheduler();
    this.persona = await loadPersona(this.config);
    await this.refreshAttachmentCacheReferences();
    this.scheduleMemoryDrain();
  }
export function runtime_close(this: RuntimeHost) {
    if (this.memoryWakeTimer) clearTimeout(this.memoryWakeTimer);
    this.memoryWakeTimer = undefined;
    this.sessionCoordinator.stop();
    if (this.ownsSessionStore) this.sessionStore.close();
  }
export async function runtime_reload(this: RuntimeHost, config: AppConfig) {
    await this.ensureAgentPromptFiles(config);
    await mergeUserProfileMemory(config);
    this.memoryScheduler.setConfig(config);
    await recoverMemoryTransactions(config);
    await normalizeEventMemorySchema(config);
    await this.memoryScheduler.initialize();
    this.commitReload(await this.prepareReload(config));
    await this.seedMemoryScheduler();
    this.scheduleMemoryDrain();
  }
export async function runtime_prepareReload(this: RuntimeHost, config: AppConfig): Promise<RuntimeConfigSnapshot> {
    return {
      config: structuredClone(config),
      persona: await loadPersona(config)
    };
  }
export function runtime_commitReload(this: RuntimeHost, snapshot: RuntimeConfigSnapshot) {
    const previous = this.config;
    this.config = snapshot.config;
    this.memoryScheduler.setConfig(snapshot.config);
    this.persona = snapshot.persona;
    if (previous.bot.memory.messageThreshold !== this.config.bot.memory.messageThreshold) {
      this.scheduleMemoryDrain();
    }
    if (previous.bot.adminQq.trim() !== this.config.bot.adminQq.trim()) {
      this.cancelScopeReplies("private");
      this.cancelScopeReplies("user_group");
      this.cancelScopeReplies("bot_group");
    }
    if (previous.onebot.autoReplyPrivate && !this.config.onebot.autoReplyPrivate) {
      this.cancelScopeReplies("private");
    }
    if (previous.onebot.autoReplyUserGroup && !this.config.onebot.autoReplyUserGroup) {
      this.cancelScopeReplies("user_group");
    }
    if (previous.onebot.autoReplyBotGroup && !this.config.onebot.autoReplyBotGroup) {
      this.cancelScopeReplies("bot_group");
    }
    if (previous.bot.orchestrator.enabled && !this.config.bot.orchestrator.enabled) {
      this.cancelAllAmbientReplies();
    }
    if (this.activeGateway) {
      this.sessionCoordinator.resume();
    }
  }
export async function runtime_reloadPrompts(this: RuntimeHost, config: AppConfig) {
    this.config = config;
    this.persona = await loadPersona(config);
  }
export async function runtime_preparePromptReload(this: RuntimeHost, id: string, content: string, config: AppConfig): Promise<RuntimePromptSnapshot> {
    const personaFile = personaFileNameForAdminId(id);
    const persona = personaFile
      ? await loadPersona(config, { [personaFile]: content })
      : this.persona ?? await loadPersona(config);
    return { config: structuredClone(config), persona };
  }
export function runtime_commitPromptReload(this: RuntimeHost, snapshot: unknown) {
    this.commitReload(snapshot as RuntimePromptSnapshot);
  }
export function runtime_getPersonaStatus(this: RuntimeHost) {
    return {
      id: this.persona?.id ?? "plana",
      name: this.persona?.name ?? "普拉娜",
      memoryItems: this.persona?.memoryItems.length ?? 0
    };
  }
export function runtime_getProviderStatus(this: RuntimeHost) {
    const provider = getDefaultProvider(this.config);
    const openaiProvider = provider ? new OpenAIProvider(provider) : undefined;
    return {
      defaultProviderId: provider?.id ?? "",
      model: provider?.model ?? "",
      imageModel: provider?.imageModel ?? "",
      apiKeyConfigured: Boolean(openaiProvider?.hasApiKey())
    };
  }
export async function runtime_consolidateWorkingMemory(this: RuntimeHost) {
    const result = await this.mergeWorkingMemory({
      conversation: {
        id: "maintenance:working-memory",
        scope: "maintenance",
        title: "工作记忆整理"
      },
      participants: [],
      messages: [],
      metadata: { source: "sunabot.memory.merge" }
    });
    if (result.ok) this.persona = await loadPersona(this.config);
    return result;
  }
export function runtime_getProvider(this: RuntimeHost, providerId?: string) {
    const provider =
      (providerId ? this.config.providers.items.find((item) => item.id === providerId) : undefined) ??
      getDefaultProvider(this.config);
    if (!provider) {
      throw new Error("No provider configured.");
    }
    const resolved = resolveModelReasoningEffort(provider.model, provider.reasoningEffort, "medium");
    if (resolved.adjusted) {
      console.warn("[runtime] unsupported provider reasoning effort adjusted", {
        providerId: provider.id,
        model: provider.model,
        requested: provider.reasoningEffort,
        selected: resolved.effort
      });
    }
    return new OpenAIProvider({ ...provider, reasoningEffort: resolved.effort });
  }
export function runtime_getProviderForModel(this: RuntimeHost, model: string, requestedEffort?: ReasoningEffort) {
    const provider = getDefaultProvider(this.config);
    if (!provider) {
      throw new Error("No provider configured.");
    }
    const modelName = model.trim() || provider.model;
    const resolved = resolveModelReasoningEffort(modelName, requestedEffort, provider.reasoningEffort ?? "medium");
    if (resolved.adjusted) {
      console.warn("[runtime] unsupported reasoning effort adjusted", {
        model: modelName,
        requested: requestedEffort,
        selected: resolved.effort
      });
    }
    return new OpenAIProvider({
      ...provider,
      id: `${provider.id}:${modelName}`,
      label: `${provider.label} ${modelName}`,
      model: modelName,
      reasoningEffort: resolved.effort
    });
  }
export async function runtime_ensureAgentPromptFiles(this: RuntimeHost, config = this.config) {
    const legacyConversationPrompt = await readPromptTextFile(
      config,
      "system",
      CONVERSATION_REPLY_PROMPT_FILE,
      ADMIN_RUNTIME_PROMPT_DEFAULTS["conversation.private-reply"] ?? ""
    );
    await Promise.all([
      ensurePromptTextFile(
        config,
        "system",
        PRIVATE_CONVERSATION_REPLY_PROMPT_FILE,
        legacyConversationPrompt
      ),
      ensurePromptTextFile(
        config,
        "system",
        GROUP_CONVERSATION_REPLY_PROMPT_FILE,
        legacyConversationPrompt
      ),
      ensurePromptTextFile(
        config,
        "system",
        config.bot.memory.workMemoryCompressInPrompt,
        ADMIN_RUNTIME_PROMPT_DEFAULTS["memory.compress-in"] ?? ""
      ),
      ensurePromptTextFile(
        config,
        "system",
        config.bot.memory.workMemoryCompressOutPrompt,
        ADMIN_RUNTIME_PROMPT_DEFAULTS["memory.compress-out"] ?? ""
      ),
      ensurePromptTextFile(
        config,
        "system",
        config.bot.memory.userProfilePrompt,
        ADMIN_RUNTIME_PROMPT_DEFAULTS["memory.user-profile"] ?? ""
      ),
      ensurePromptTextFile(
        config,
        "system",
        config.bot.orchestrator.promptFile,
        ADMIN_RUNTIME_PROMPT_DEFAULTS["orchestrator.user-group"] ?? ""
      ),
      ensurePromptTextFile(
        config,
        "system",
        GROUP_CHAT_SUMMARY_PROMPT_FILE,
        ADMIN_RUNTIME_PROMPT_DEFAULTS["conversation.group-summary"] ?? ""
      ),
      ensurePromptTextFile(
        config,
        "persona",
        SELFIE_PROMPT_FILE,
        ADMIN_RUNTIME_PROMPT_DEFAULTS["image.selfie-rewrite"] ?? ""
      )
    ]);
  }
export function runtime_defaultPromptContent(this: RuntimeHost, id: string) {
    return ADMIN_RUNTIME_PROMPT_DEFAULTS[id] ?? "";
  }
export async function runtime_renderPromptRequest(this: RuntimeHost,
    id: string,
    variables: Readonly<Record<string, PromptVariableValue>>
  ): Promise<RenderedPromptRequest> {
    const definition = promptDefinitionById(id);
    if (!definition || definition.kind !== "final") {
      throw new Error(`Unknown final prompt: ${id}`);
    }
    const content = await readPromptTextFile(
      this.config,
      definition.scope,
      definition.fileName(this.config),
      ADMIN_RUNTIME_PROMPT_DEFAULTS[id]
    );
    const fragments = Object.fromEntries(
      Object.entries(ADMIN_PERSONA_FILES).map(([fragmentId, fileName]) => [
        fragmentId,
        this.persona?.files.find((file) => file.name === fileName)?.content ?? ""
      ])
    );
    return renderFinalPromptTemplate(parseFinalPromptTemplate(content), {
      ...fragments,
      ...variables
    });
  }
export async function runtime_completePrompt(this: RuntimeHost,
    provider: OpenAIProvider,
    request: RenderedPromptRequest,
    options: ProviderCompleteOptions = {}
  ) {
    const completeRequest = (provider as unknown as {
      completeRequest?: (request: RenderedPromptRequest, options?: ProviderCompleteOptions) => Promise<string>;
    }).completeRequest;
    if (typeof completeRequest === "function") {
      return completeRequest.call(provider, request, options);
    }
    const systemPrompt = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    return provider.complete(
      systemPrompt,
      request.messages.filter((message) => message.role !== "system"),
      options
    );
  }
export async function runtime_completePromptTurn(this: RuntimeHost,
    provider: OpenAIProvider,
    request: RenderedPromptRequest,
    options: ProviderCompleteOptions = {}
  ) {
    const configuration = (provider as unknown as { configuration?: () => ReturnType<OpenAIProvider["configuration"]> }).configuration?.();
    const preparedRequest = configuration
      ? await prepareVisionFallback(this, configuration, request, options)
      : request;
    const completeRequestTurn = (provider as unknown as {
      completeRequestTurn?: OpenAIProvider["completeRequestTurn"];
    }).completeRequestTurn;
    if (typeof completeRequestTurn === "function") {
      return completeRequestTurn.call(provider, preparedRequest, options);
    }
    return { kind: "completed" as const, text: await this.completePrompt(provider, preparedRequest, options) };
  }

async function prepareVisionFallback(
  runtime: RuntimeHost,
  providerConfig: ReturnType<OpenAIProvider["configuration"]>,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
) {
  const hasImages = request.messages.some((message) => message.imageUrls?.length || message.localImagePaths?.length);
  if (!hasImages) return request;
  const detectedMultimodal = providerConfig.multimodal === "auto" && providerConfig.detectedMultimodal == null
    ? await cachedMultimodalProbe(providerConfig)
    : providerConfig.detectedMultimodal;
  const needsFallback = providerConfig.multimodal === "disabled"
    || (providerConfig.multimodal === "auto" && detectedMultimodal === false);
  if (!needsFallback) return request;
  const helperConfig = runtime.config.providers.items.find((item) => item.id === providerConfig.visionProviderId);
  if (!helperConfig) throw new Error("当前模型不支持图片，请配置读图辅助 Provider。");
  const imageUrls = request.messages.flatMap((message) => message.imageUrls ?? []);
  const localImagePaths = request.messages.flatMap((message) => message.localImagePaths ?? []);
  const helper = new OpenAIProvider({
    ...helperConfig,
    id: `${helperConfig.id}:vision-helper`,
    model: providerConfig.visionModel?.trim() || helperConfig.model
  });
  const description = await helper.complete(
    "准确描述输入图片中的主体、文字、关系和与用户请求有关的细节，不要猜测不可见内容。",
    [{ role: "user", content: "请读取这些图片并给出可供另一个模型使用的描述。", imageUrls, localImagePaths }],
    { signal: options.signal, logContext: options.logContext }
  );
  const next = structuredClone(request);
  next.messages = next.messages.map((message) => ({ ...message, imageUrls: [], localImagePaths: [] }));
  const lastUser = [...next.messages].reverse().find((message) => message.role === "user");
  if (lastUser) lastUser.content = `${lastUser.content}\n\n<image_description>${description}</image_description>`;
  return next;
}

const multimodalProbeCache = new Map<string, boolean>();

async function cachedMultimodalProbe(provider: ReturnType<OpenAIProvider["configuration"]>) {
  const key = [provider.id, provider.kind, provider.model, provider.baseUrl ?? "", provider.apiKeyEnv].join("\0");
  const cached = multimodalProbeCache.get(key);
  if (cached != null) return cached;
  const result = await probeProviderMultimodal(provider);
  multimodalProbeCache.set(key, result.multimodal);
  return result.multimodal;
}
export function runtime_getConversationRecords(this: RuntimeHost) {
    return [...this.conversationRecords.values()]
      .filter((record) => !isWebConversationId(record.id))
      .sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt))
      .map((record) => this.publicConversationRecord(record));
  }
export function runtime_publicConversationRecord(this: RuntimeHost, record: ConversationRecord): ConversationRecord {
    const userMessages = indexedConversationMessages(record)
      .filter(({ message }) => message.role === "user");
    const pendingUserMessages = this.pendingOrchestratorUserMessages(record);
    const lastUserMessage = pendingUserMessages.at(-1) ?? userMessages.at(-1);
    const orchestratorEnabled = this.config.bot.orchestrator.enabled &&
      conversationReplyEnabled(record) &&
      conversationOrchestratorEnabled(record);
    const deciding = this.ambientReplies.get(record.id)?.deciding === true;
    return {
      ...record,
      replyEnabled: conversationReplyEnabled(record),
      orchestratorEnabled: conversationOrchestratorEnabled(record),
      orchestratorStatus: record.scope === "user_group"
        ? {
            active: orchestratorEnabled && (deciding || pendingUserMessages.length > 0),
            messageCount: pendingUserMessages.length,
            messageTarget: this.config.bot.orchestrator.messageThreshold + 1,
            activeWindowMs: this.config.bot.orchestrator.recentMessageWindowMs,
            lastMessageAt: lastUserMessage?.message.at ?? record.lastAt,
            lastCheckedAt: record.orchestratorCheckedAt
          }
        : undefined,
      messages: record.messages.slice(-12)
    };
  }
export function runtime_getConversationMessages(this: RuntimeHost, conversationId: string, options: { beforeSequence?: number; limit?: number } = {}) {
    const record = this.conversationRecords.get(normalizeConversationLookupId(conversationId));
    const limit = clampInteger(options.limit, 20, 1, 80);
    if (!record) {
      return {
        conversationId,
        messages: [],
        hasMore: false,
        memberNames: {}
      };
    }

    const beforeSequence = Number(options.beforeSequence);
    const candidates = Number.isFinite(beforeSequence)
      ? record.messages.filter((message) => Number(message.sequence ?? 0) < beforeSequence)
      : record.messages;
    const messages = candidates.slice(-limit);
    const firstSequence = messages[0]?.sequence;
    const hasMore = firstSequence == null
      ? false
      : record.messages.some((message) => Number(message.sequence ?? 0) < firstSequence);
    return {
      conversationId: record.id,
      messages,
      hasMore,
      nextBeforeSequence: firstSequence,
      memberNames: conversationMemberNames(record)
    };
  }
export function runtime_getConversationMessageStats(this: RuntimeHost, conversationId: string): ConversationMessageStats {
    const record = this.conversationRecords.get(normalizeConversationLookupId(conversationId));
    if (!record) return { total: 0, retained: 0, visible: 0, user: 0, assistant: 0, internal: 0 };
    let visible = 0;
    let user = 0;
    let assistant = 0;
    let internal = 0;
    for (const message of record.messages) {
      if (message.visibility === "internal" || message.eventKind === "orchestrator_decision") {
        internal += 1;
        continue;
      }
      visible += 1;
      if (message.role === "user") user += 1;
      if (message.role === "assistant") assistant += 1;
    }
    return {
      total: record.messageCount,
      retained: record.messages.length,
      visible,
      user,
      assistant,
      internal
    };
  }
export async function runtime_hydrateConversationIdentities(this: RuntimeHost, conversationId: string, gateway: MessagingPort) {
    const record = this.conversationRecords.get(normalizeConversationLookupId(conversationId));
    if (!record) return;
    const targets = record.messages.slice(-80).flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const userId = message.role === "assistant"
        ? Number(message.selfId ?? record.selfId ?? 0)
        : Number(message.userId ?? 0);
      if (!userId) return [];
      return [{ message, userId }];
    });

    let changed = false;
    for (let offset = 0; offset < targets.length; offset += 4) {
      await Promise.all(targets.slice(offset, offset + 4).map(async ({ message, userId }) => {
        const identity = await this.senderNameResolver.resolve({
          ...(record.accountId ? { accountId: record.accountId } : {}),
          userId,
          groupId: record.groupId,
          sender: {
            id: String(userId),
            ...(message.senderNickname ? { nickname: message.senderNickname } : {}),
            ...(message.senderCard ? { card: message.senderCard } : {})
          }
        }, gateway);
        if (identity.nickname && message.senderNickname !== identity.nickname) {
          message.senderNickname = identity.nickname;
          changed = true;
        }
        if (identity.card && message.senderCard !== identity.card) {
          message.senderCard = identity.card;
          changed = true;
        }
        if (identity.displayName && message.senderName !== identity.displayName) {
          message.senderName = identity.displayName;
          changed = true;
        }
      }));
    }
    if (changed) this.persistConversationRecords();
  }
export function runtime_enrichMemoryEntries(this: RuntimeHost, entries: MemoryEntry[]) {
    return enrichMemoryEntriesWithConversations(entries, [...this.conversationRecords.values()]);
  }
export function runtime_setConversationReplyEnabled(this: RuntimeHost, input: ConversationReplyUpdateInput) {
    const record = this.upsertConversationRecordForReplySetting(input);
    if (typeof input.replyEnabled === "boolean") {
      record.replyEnabled = input.replyEnabled;
    }
    if (record.scope === "user_group" && typeof input.orchestratorEnabled === "boolean") {
      record.orchestratorEnabled = input.orchestratorEnabled;
      if (!record.orchestratorEnabled) this.cancelAmbientReply(record.id);
    }
    if (!conversationReplyEnabled(record)) {
      record.memoryCompressedThroughMessageCount = record.messageCount;
      this.replyGates.invalidateConversation(record.id);
      this.activeDirectControllers.get(record.id)?.abort(new Error("conversation replies disabled"));
      this.cancelAmbientReply(record.id);
    }
    this.persistConversationRecords();
    return this.publicConversationRecord(record);
  }
export async function runtime_announceServiceOnline(this: RuntimeHost, gateway: MessagingPort, message: string) {
    const targets = this.getActiveConversationRecords();
    let sent = 0;
    for (const record of targets) {
      try {
        if (record.groupId) {
          await gateway.send(outboundForRecord(record, message));
        } else {
          await gateway.send(outboundForRecord(record, message));
        }
        this.recordServiceMessage(record, message);
        sent += 1;
      } catch (error) {
        console.error("[runtime] service online announcement failed", {
          conversationId: record.id,
          userId: record.userId,
          groupId: record.groupId,
          error
        });
      }
    }
    return { total: targets.length, sent };
  }

export class RuntimeLifecycle {
  constructor(private readonly host: RuntimeHost) {}
  initialize(...args: Parameters<typeof runtime_initialize>) { return runtime_initialize.call(this.host, ...args); }
  close(...args: Parameters<typeof runtime_close>) { return runtime_close.call(this.host, ...args); }
  reload(...args: Parameters<typeof runtime_reload>) { return runtime_reload.call(this.host, ...args); }
  prepareReload(...args: Parameters<typeof runtime_prepareReload>) { return runtime_prepareReload.call(this.host, ...args); }
  commitReload(...args: Parameters<typeof runtime_commitReload>) { return runtime_commitReload.call(this.host, ...args); }
  reloadPrompts(...args: Parameters<typeof runtime_reloadPrompts>) { return runtime_reloadPrompts.call(this.host, ...args); }
  preparePromptReload(...args: Parameters<typeof runtime_preparePromptReload>) { return runtime_preparePromptReload.call(this.host, ...args); }
  commitPromptReload(...args: Parameters<typeof runtime_commitPromptReload>) { return runtime_commitPromptReload.call(this.host, ...args); }
  getPersonaStatus(...args: Parameters<typeof runtime_getPersonaStatus>) { return runtime_getPersonaStatus.call(this.host, ...args); }
  getProviderStatus(...args: Parameters<typeof runtime_getProviderStatus>) { return runtime_getProviderStatus.call(this.host, ...args); }
  consolidateWorkingMemory(...args: Parameters<typeof runtime_consolidateWorkingMemory>) { return runtime_consolidateWorkingMemory.call(this.host, ...args); }
  getProvider(...args: Parameters<typeof runtime_getProvider>) { return runtime_getProvider.call(this.host, ...args); }
  getProviderForModel(...args: Parameters<typeof runtime_getProviderForModel>) { return runtime_getProviderForModel.call(this.host, ...args); }
  ensureAgentPromptFiles(...args: Parameters<typeof runtime_ensureAgentPromptFiles>) { return runtime_ensureAgentPromptFiles.call(this.host, ...args); }
  defaultPromptContent(...args: Parameters<typeof runtime_defaultPromptContent>) { return runtime_defaultPromptContent.call(this.host, ...args); }
  renderPromptRequest(...args: Parameters<typeof runtime_renderPromptRequest>) { return runtime_renderPromptRequest.call(this.host, ...args); }
  completePrompt(...args: Parameters<typeof runtime_completePrompt>) { return runtime_completePrompt.call(this.host, ...args); }
  completePromptTurn(...args: Parameters<typeof runtime_completePromptTurn>) { return runtime_completePromptTurn.call(this.host, ...args); }
  getConversationRecords(...args: Parameters<typeof runtime_getConversationRecords>) { return runtime_getConversationRecords.call(this.host, ...args); }
  publicConversationRecord(...args: Parameters<typeof runtime_publicConversationRecord>) { return runtime_publicConversationRecord.call(this.host, ...args); }
  getConversationMessages(...args: Parameters<typeof runtime_getConversationMessages>) { return runtime_getConversationMessages.call(this.host, ...args); }
  getConversationMessageStats(...args: Parameters<typeof runtime_getConversationMessageStats>) { return runtime_getConversationMessageStats.call(this.host, ...args); }
  hydrateConversationIdentities(...args: Parameters<typeof runtime_hydrateConversationIdentities>) { return runtime_hydrateConversationIdentities.call(this.host, ...args); }
  enrichMemoryEntries(...args: Parameters<typeof runtime_enrichMemoryEntries>) { return runtime_enrichMemoryEntries.call(this.host, ...args); }
  setConversationReplyEnabled(...args: Parameters<typeof runtime_setConversationReplyEnabled>) { return runtime_setConversationReplyEnabled.call(this.host, ...args); }
  announceServiceOnline(...args: Parameters<typeof runtime_announceServiceOnline>) { return runtime_announceServiceOnline.call(this.host, ...args); }
}
