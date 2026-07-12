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
import { SessionStore, type OutboxRecord, type SessionEventRecord, type ToolJobRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import { GENERATE_IMG_TOOL_NAME, runGenerateImg } from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../../services/agent/persona.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { buildMemoryPromptVariables, buildUserProfileRecallQuery, buildUserPrompt, buildWorkingMemoryRecallQuery, clampInteger, collectGroupChatSummaryMessages, estimatePromptTokens, isAdminUserId, toContextChatMessage, uniqueMemoryEntries } from "./conversationMemoryHelpers.js";
import { conversationMessageAttachments, conversationRecordId, queueIncomingSnapshot, selectRelevantConversationAttachments, toConversationQuote, uniqueAttachments, uniqueQuotes, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { buildAsyncToolCompletionPrompt, errorMessage, isAbortError, isRuntimeIncomingMessage, sanitizeErrorDetail } from "./infrastructure.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export async function runtime_replyToIncoming(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    options: {
      captureSequence?: number;
      signal?: AbortSignal;
      isCurrent?: () => boolean;
      delivery?: ReplyDelivery;
      onDeferred?: (value: DeferredCodexTurn) => void;
      allowAsyncCodex?: boolean;
      allowAsyncImage?: boolean;
      allowImageTools?: boolean;
      promptOverride?: string;
    } = {}
  ) {
    const provider = this.getProvider();
    const persona = this.persona ?? (await loadPersona(this.config));
    const admin = this.adminIdentity();
    const isAdmin = isAdminUserId(incoming.userId, admin);
    const logRunId = nanoid();
    const logContext = {
      conversationId: conversationRecordId(incoming),
      incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
      runId: logRunId,
      stage: "reply"
    };
    let sent = false;
    let requestStarted = false;

    try {
      const beforeContext = await this.hooks.run("before_context", {
        channel: channelKey,
        text: options.promptOverride ?? incoming.text,
        context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
      });

      const exactUserProfile = await readUserProfileForUser(this.config, String(incoming.userId));
      const memoryResult = await recallMemory(this.config, {
        query: beforeContext.text,
        source: "long_term",
        limit: 8
      });
      const longTermMemoryMatches = memoryResult.ok ? memoryResult.matches : [];
      const workingMemoryResult = await recallMemory(this.config, {
        query: buildWorkingMemoryRecallQuery(incoming, beforeContext.text),
        source: "working",
        limit: 8
      });
      const workingMemoryMatches = workingMemoryResult.ok ? workingMemoryResult.matches : [];
      const userProfileResult = await recallMemory(this.config, {
        query: buildUserProfileRecallQuery(incoming, beforeContext.text, admin),
        source: "user_profile",
        limit: 6
      });
      const userProfileMemoryMatches = userProfileResult.ok ? userProfileResult.matches : [];
      const memoryMatches = uniqueMemoryEntries([
        ...(exactUserProfile ? [exactUserProfile] : []),
        ...workingMemoryMatches,
        ...longTermMemoryMatches,
        ...userProfileMemoryMatches
      ]);
      await appendRequestLog({
        category: "runtime.action",
        action: "memory.recall.before_reply",
        request: {
          longTermQuery: beforeContext.text,
          workingQuery: buildWorkingMemoryRecallQuery(incoming, beforeContext.text),
          userProfileQuery: buildUserProfileRecallQuery(incoming, beforeContext.text, admin)
        },
        response: {
          workingCount: workingMemoryMatches.length,
          longTermCount: longTermMemoryMatches.length,
          userProfileCount: userProfileMemoryMatches.length,
          exactUserProfile: Boolean(exactUserProfile),
          mergedCount: memoryMatches.length
        },
        metadata: logContext
      });
      const afterContext = await this.hooks.run("after_context", {
        channel: channelKey,
        text: beforeContext.text,
        context: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId,
          isAdmin,
          workingMemoryMatches: workingMemoryMatches.map((item) => ({
            id: item.id,
            text: item.text,
            score: item.score
          })),
          longTermMemoryMatches: longTermMemoryMatches.map((item) => ({
            id: item.id,
            text: item.text,
            score: item.score
          })),
          userProfileMemoryMatches: userProfileMemoryMatches.map((item) => ({
            id: item.id,
            text: item.text,
            score: item.score
          }))
        }
      });
      const selectedAttachments = this.selectRelevantAttachments(incoming, afterContext.text);
      const attachmentContext = selectedAttachments.length
        ? await this.attachmentService.buildModelContext(selectedAttachments, afterContext.text)
        : { text: "", localImagePaths: [], attachments: [] };
      const prompt = options.promptOverride
        ? [afterContext.text, attachmentContext.text].filter(Boolean).join("\n\n")
        : buildUserPrompt(
          incoming,
          afterContext.text,
          isAdmin,
          admin,
          attachmentContext.text
        );
      const promptRequest = await this.renderPromptRequest("conversation.reply", {
        ...buildConversationPromptVariables(this.config),
        ...buildMemoryPromptVariables({
          working: workingMemoryMatches,
          longTerm: longTermMemoryMatches,
          userProfile: userProfileMemoryMatches
        }),
        "messages_64": this.buildRecentContextMessages(incoming, options.captureSequence, 64),
        "conversation.messages": this.buildRecentContextMessages(incoming, options.captureSequence),
        "user.input": prompt
      });
      const currentUserMessage = [...promptRequest.messages].reverse().find((message) => message.role === "user");
      if (currentUserMessage) {
        currentUserMessage.imageUrls = inboundImageUrls(incoming).slice(0, MAX_CURRENT_CONTEXT_IMAGES);
        currentUserMessage.localImagePaths = attachmentContext.localImagePaths;
      }
      const selfieChatReferenceImageUrls = this.collectSelfieChatReferenceImages(incoming);
      const generatedImages: ImageResult[] = [];
      let assistantTextCount = 0;
      this.recordAssistantRequestStarted(incoming, logRunId);
      requestStarted = true;
      await appendRequestLog({
        category: "runtime.action",
        action: "reply.started",
        request: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId
        },
        response: { status: "running" },
        metadata: logContext
      });
      const toolCapabilities = await this.resolveToolCapabilities();
      const turn = await this.completePromptTurn(provider, promptRequest, {
        signal: options.signal,
        bash: this.buildProviderBashOptions(incoming, toolCapabilities.workspaceBash),
        bot: this.config.bot,
        generateImage: (prompt, size, quality, referenceImageUrls, childLogContext) => provider.generateImage(
          prompt,
          size,
          quality,
          referenceImageUrls,
          childLogContext ?? logContext
        ),
        onAssistantText: async (text) => {
          if (options.isCurrent && !options.isCurrent()) return;
          const quoteReply = assistantTextCount === 0;
          assistantTextCount += 1;
          const record = await this.sendAssistantReply(
            channelKey,
            incoming,
            gateway,
            text,
            isAdmin,
            [],
            logRunId,
            options.isCurrent,
            options.delivery,
            quoteReply
          );
          if (record) sent = true;
        },
        onImageGenerated: (image) => {
          generatedImages.push(image);
        },
        referenceImageUrls: inboundImageUrls(incoming),
        memory: {
          enabled: true,
          recall: (input) => recallMemory(this.config, input)
        },
        selfie: {
          enabled: true,
          referenceImageUrls: selfieChatReferenceImageUrls,
          run: (input) => this.runSelfie(input, provider, {
            chatReferenceImageUrls: selfieChatReferenceImageUrls,
            logContext
          })
        },
        asyncCodex: (options.allowAsyncCodex ?? true)
          && this.config.bot.tools.codex.enabled
          && toolCapabilities.codex,
        asyncImage: options.allowAsyncImage ?? true,
        imageTools: options.allowImageTools ?? true,
        logContext
      });
      if (options.isCurrent && !options.isCurrent()) return sent;
      if (turn.kind === "deferred") {
        const acknowledgement = turn.acknowledgement.trim();
        if (!acknowledgement) throw new Error("异步工具缺少 dispatch_message。");
        options.onDeferred?.({
          deferred: turn,
          originalRequest: {
            incoming: queueIncomingSnapshot(incoming),
            captureSequence: options.captureSequence
          },
          acknowledgement: this.replyDeliveryDraft(
            incoming,
            acknowledgement,
            isAdmin,
            [],
            logRunId,
            `tool-ack:${turn.toolCall.name}:${turn.toolCall.callId}`
          )
        });
        return sent;
      }
      const record = await this.sendAssistantReply(
        channelKey,
        incoming,
        gateway,
        turn.text,
        isAdmin,
        generatedImages,
        logRunId,
        options.isCurrent,
        options.delivery
      );
      if (record) {
        sent = true;
        this.scheduleMemoryCompression(record);
      }
      return sent;
    } catch (error) {
      const failure = options.signal?.reason ?? error;
      const aborted = options.signal?.aborted || isAbortError(error);
      await appendRequestLog({
        category: "runtime.action",
        action: aborted ? "reply.cancelled" : "reply.failed",
        response: {
          ok: false,
          error: sanitizeErrorDetail(errorMessage(failure))
        },
        metadata: logContext
      });
      if (aborted) {
        if (requestStarted) {
          const timedOut = /timed out|timeout/i.test(errorMessage(failure));
          this.recordAssistantMessage(
            incoming,
            timedOut ? "请求超时，请查看请求日志。" : "请求已取消。",
            [],
            logRunId,
            "failed"
          );
        }
        return sent;
      }
      console.error("[runtime] reply failed", {
        channel: channelKey,
        messageId: incoming.messageId,
        userId: incoming.userId,
        groupId: incoming.groupId,
        error
      });
      if (!options.isCurrent || options.isCurrent()) {
        await this.sendErrorReply(incoming, gateway, error, options.isCurrent, logRunId, options.delivery);
      }
      return sent;
    }
  }
export async function runtime_replyWithGroupChatSummary(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
    delivery?: ReplyDelivery
  ) {
    const admin = this.adminIdentity();
    const isAdmin = isAdminUserId(incoming.userId, admin);

    try {
      if (!incoming.groupId) {
        const record = await this.sendAssistantReply(
          channelKey, incoming, gateway, "只能在群聊里总结群聊。", isAdmin, [], undefined, isCurrent, delivery
        );
        if (record) this.scheduleMemoryCompression(record);
        return;
      }

      const record = this.conversationRecords.get(conversationRecordId(incoming));
      const summaryMessages = collectGroupChatSummaryMessages(record, incoming);
      if (!summaryMessages.length) {
        const replyRecord = await this.sendAssistantReply(
          channelKey, incoming, gateway, "最近 6 小时没有可总结的文字消息。", isAdmin, [], undefined, isCurrent, delivery
        );
        if (replyRecord) this.scheduleMemoryCompression(replyRecord);
        return;
      }

      const provider = this.getProvider();
      const now = new Date();
      const payload = {
        command: GROUP_CHAT_SUMMARY_COMMAND,
        conversation: {
          id: record?.id ?? conversationRecordId(incoming),
          scope: incoming.scope,
          title: record?.title ?? String(incoming.groupId),
          groupId: incoming.groupId,
          windowHours: 6,
          windowStart: new Date(now.getTime() - GROUP_CHAT_SUMMARY_WINDOW_MS).toISOString(),
          windowEnd: now.toISOString(),
          messageCount: summaryMessages.length
        },
        messages: summaryMessages
      };
      const promptRequest = await this.renderPromptRequest("conversation.group-summary", {
        "group.payload": payload
      });
      const reply = await this.completePrompt(provider, promptRequest, {
        signal,
        logContext: {
          conversationId: record?.id ?? conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          stage: "reply"
        }
      });
      const replyRecord = await this.sendAssistantReply(
        channelKey, incoming, gateway, reply, isAdmin, [], undefined, isCurrent, delivery
      );
      if (replyRecord) this.scheduleMemoryCompression(replyRecord);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      console.error("[runtime] group chat summary failed", {
        channel: channelKey,
        messageId: incoming.messageId,
        userId: incoming.userId,
        groupId: incoming.groupId,
        error
      });
      await this.sendErrorReply(incoming, gateway, error, isCurrent, undefined, delivery);
    }
  }
export async function runtime_replyToToolCompletion(this: RuntimeHost,
    payload: AsyncToolCompletionPayload,
    gateway: MessagingPort,
    signal: AbortSignal,
    delivery: ReplyDelivery
  ) {
    const incoming = payload.originalRequest?.incoming;
    if (!incoming || !isRuntimeIncomingMessage(incoming)) {
      throw new Error(`异步工具结果缺少原始请求：${payload.toolJobId}`);
    }
    const channelKey = conversationRecordId(incoming);
    const gate = this.replyGates.capture(incoming.scope, channelKey);
    const isCurrent = () => this.isReplyTaskCurrent(incoming, gate, signal);
    if (!isCurrent()) return;
    if (payload.toolName === GENERATE_IMG_TOOL_NAME || payload.toolName === SELFIE_TOOL_NAME) {
      const result = readDeferredImageResult(payload.outcome.result);
      const text = result.image
        ? ""
        : `图片生成失败：${sanitizeErrorDetail(result.error || "没有可用图片")}`;
      delivery.outbox.push(this.replyDeliveryDraft(
        incoming,
        text,
        this.isAdminUser(incoming.userId),
        result.image ? [result.image] : [],
        undefined,
        `tool-image:${payload.toolJobId}`
      ));
      return;
    }
    await this.replyToIncoming(channelKey, incoming, gateway, {
      signal,
      isCurrent,
      delivery,
      allowAsyncCodex: false,
      promptOverride: buildAsyncToolCompletionPrompt(payload)
    });
  }
export async function runtime_processDeferredToolJob(this: RuntimeHost, job: ToolJobRecord, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new Error("异步工具任务已取消。");
    const originalRequest = job.originalRequest as { incoming?: unknown };
    const incoming = originalRequest.incoming;
    if (!isRuntimeIncomingMessage(incoming)) {
      return { status: "failed" as const, error: { message: "异步图片任务缺少原始请求。" } };
    }
    const provider = this.getProvider();
    const logContext = {
      conversationId: conversationRecordId(incoming),
      incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
      runId: job.id,
      stage: "async_image_tool"
    };
    const input = job.arguments && typeof job.arguments === "object" && !Array.isArray(job.arguments)
      ? job.arguments as Record<string, unknown>
      : {};
    const result = job.toolName === GENERATE_IMG_TOOL_NAME
      ? await runGenerateImg(input, this.config.bot, (prompt, size, quality, referenceImageUrls, childLogContext) =>
          provider.generateImage(prompt, size, quality, referenceImageUrls, childLogContext ?? logContext), {
          referenceImageUrls: inboundImageUrls(incoming),
          logContext
        })
      : job.toolName === SELFIE_TOOL_NAME
        ? await this.runSelfie(input, provider, {
            chatReferenceImageUrls: this.collectSelfieChatReferenceImages(incoming),
            logContext
          })
        : { ok: false, error: `不支持的异步工具：${job.toolName}` };
    const record = result as { ok?: unknown; error?: unknown };
    return record.ok === true
      ? { status: "succeeded" as const, result }
      : { status: "failed" as const, result, error: { message: String(record.error ?? "图片生成失败。") } };
  }

function readDeferredImageResult(value: unknown) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as { image?: ImageResult; error?: unknown }
    : {};
  const image = result.image;
  return {
    image: image && (image.url || image.filePath) ? image : undefined,
    error: typeof result.error === "string" ? result.error : ""
  };
}
export async function runtime_attachReplyReferences(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    _signal?: AbortSignal
  ) {
    if (!incoming.replyMessageIds.length) return;

    const imageUrls: string[] = inboundImageUrls(incoming);
    const quoteReferences: ConversationMessageQuote[] = [...incoming.quoteReferences];
    for (const messageId of incoming.replyMessageIds.slice(0, 2)) {
      try {
        const details = await this.loadMessageDetails(gateway, messageId, {
          source: "quote",
          groupId: incoming.groupId,
          userId: incoming.userId
        });
        imageUrls.push(...details.media.flatMap((asset) => asset.url ? [asset.url] : []));
        incoming.attachments.push(...details.attachments);
        quoteReferences.push(toConversationQuote(messageId, details));
      } catch (error) {
        console.error("[runtime] load replied message failed", {
          messageId,
          error
        });
      }
    }

    replaceInboundImageUrls(incoming, uniqueStrings(imageUrls));
    incoming.attachments = uniqueAttachments(incoming.attachments);
    incoming.quoteReferences = uniqueQuotes(quoteReferences);
  }
export async function runtime_loadMessageDetails(this: RuntimeHost,
    gateway: MessagingPort,
    messageId: number,
    context: AttachmentExtractionContext = { source: "quote" }
  ) {
    return gateway.getMessage(messageId, context);
  }
export async function runtime_loadQuoteReferences(this: RuntimeHost,
    gateway: MessagingPort,
    messageIds: number[],
    context: AttachmentExtractionContext = { source: "quote" }
  ) {
    const quoteReferences: ConversationMessageQuote[] = [];
    for (const messageId of messageIds.slice(0, 2)) {
      try {
        const details = await this.loadMessageDetails(gateway, messageId, context);
        quoteReferences.push(toConversationQuote(messageId, details));
      } catch (error) {
        console.error("[runtime] load quote reference failed", {
          messageId,
          error
        });
      }
    }
    return uniqueQuotes(quoteReferences);
  }
export function runtime_selectRelevantAttachments(this: RuntimeHost, incoming: ParsedIncomingMessage, query: string) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    return selectRelevantConversationAttachments(
      incoming,
      record,
      this.contextMessageLimit(),
      query
    );
  }
export async function runtime_refreshAttachmentCacheReferences(this: RuntimeHost) {
    const references: Array<{ cacheKey: string; reference: string }> = [];
    for (const record of this.conversationRecords.values()) {
      for (const message of record.messages.slice(-this.contextMessageLimit())) {
        for (const attachment of conversationMessageAttachments(message)) {
          if (!attachment.cacheKey) continue;
          references.push({
            cacheKey: attachment.cacheKey,
            reference: `${record.id}/${message.id}/${attachment.id}`
          });
        }
      }
    }
    await this.attachmentService.cache.rebuildReferences(references);
  }
export function runtime_buildRecentContextMessages(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    captureSequence?: number,
    messageLimit = this.contextMessageLimit()
  ): ChatMessage[] {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    if (!record) return [];

    const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
    const admin = this.adminIdentity();
    const candidates = record.messages
      .filter((message) => !currentMessageId || message.id !== currentMessageId)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => captureSequence == null || Number(message.sequence ?? 0) < captureSequence)
      .slice(-clampInteger(messageLimit, this.contextMessageLimit(), 1, 120))
      .map((message) => toContextChatMessage(message, isAdminUserId(message.userId, admin), admin));
    const selected: ChatMessage[] = [];
    let usedTokens = 0;
    for (const message of candidates.reverse()) {
      const messageTokens = estimatePromptTokens(message.content);
      if (selected.length && usedTokens + messageTokens > RECENT_CONTEXT_TOKEN_BUDGET) break;
      selected.unshift(message);
      usedTokens += messageTokens;
    }
    let remainingImages = MAX_HISTORY_CONTEXT_IMAGES;
    const boundedImages = selected.map((message) => ({ ...message, imageUrls: [] as string[] }));
    for (let index = boundedImages.length - 1; index >= 0; index -= 1) {
      const message = selected[index]!;
      const imageUrls = (message.imageUrls ?? []).slice(0, remainingImages);
      remainingImages -= imageUrls.length;
      boundedImages[index] = { ...message, imageUrls };
    }
    return boundedImages;
  }
export function runtime_contextMessageLimit(this: RuntimeHost) {
    return clampInteger(this.config.bot.contextMessageLimit, DEFAULT_CONTEXT_MESSAGE_LIMIT, 1, 120);
  }
export function runtime_retainedConversationMessageLimit(this: RuntimeHost) {
    return Math.max(
      MAX_STORED_CONVERSATION_MESSAGES,
      this.contextMessageLimit() * 2,
      this.config.bot.memory.messageThreshold * 2 + 8
    );
  }
export function runtime_groupReplyOptions(this: RuntimeHost, incoming: ParsedIncomingMessage) {
    if (!this.config.bot.quoteGroupReplies || incoming.messageId == null) return {};
    return { replyToMessageId: incoming.messageId };
  }
export function runtime_buildProviderBashOptions(
  this: RuntimeHost,
  incoming: ParsedIncomingMessage,
  capabilityAvailable = false
): ProviderBashOptions | undefined {
    const bash = this.config.bot.bash;
    if (!bash.enabled || !capabilityAvailable) return undefined;
    if (incoming.groupId && !bash.allowGroup) return undefined;
    if (bash.adminOnly && !this.isAdminUser(incoming.userId)) return undefined;

    return {
      enabled: true,
      workspacePath: resolveProjectPath(this.config.persona.agentWorkspace) ?? getRootDir(),
      workspaceOnly: bash.workspaceOnly,
      blockedKeywords: bash.blockedKeywords
    };
  }
export function runtime_isAdminUser(this: RuntimeHost, userId: number) {
    return this.isReplySenderAllowed(userId);
  }

export class RuntimeReply {
  constructor(private readonly host: RuntimeHost) {}
  replyToIncoming(...args: Parameters<typeof runtime_replyToIncoming>) { return runtime_replyToIncoming.call(this.host, ...args); }
  replyWithGroupChatSummary(...args: Parameters<typeof runtime_replyWithGroupChatSummary>) { return runtime_replyWithGroupChatSummary.call(this.host, ...args); }
  replyToToolCompletion(...args: Parameters<typeof runtime_replyToToolCompletion>) { return runtime_replyToToolCompletion.call(this.host, ...args); }
  processDeferredToolJob(...args: Parameters<typeof runtime_processDeferredToolJob>) { return runtime_processDeferredToolJob.call(this.host, ...args); }
  attachReplyReferences(...args: Parameters<typeof runtime_attachReplyReferences>) { return runtime_attachReplyReferences.call(this.host, ...args); }
  loadMessageDetails(...args: Parameters<typeof runtime_loadMessageDetails>) { return runtime_loadMessageDetails.call(this.host, ...args); }
  loadQuoteReferences(...args: Parameters<typeof runtime_loadQuoteReferences>) { return runtime_loadQuoteReferences.call(this.host, ...args); }
  selectRelevantAttachments(...args: Parameters<typeof runtime_selectRelevantAttachments>) { return runtime_selectRelevantAttachments.call(this.host, ...args); }
  refreshAttachmentCacheReferences(...args: Parameters<typeof runtime_refreshAttachmentCacheReferences>) { return runtime_refreshAttachmentCacheReferences.call(this.host, ...args); }
  buildRecentContextMessages(...args: Parameters<typeof runtime_buildRecentContextMessages>) { return runtime_buildRecentContextMessages.call(this.host, ...args); }
  contextMessageLimit(...args: Parameters<typeof runtime_contextMessageLimit>) { return runtime_contextMessageLimit.call(this.host, ...args); }
  retainedConversationMessageLimit(...args: Parameters<typeof runtime_retainedConversationMessageLimit>) { return runtime_retainedConversationMessageLimit.call(this.host, ...args); }
  groupReplyOptions(...args: Parameters<typeof runtime_groupReplyOptions>) { return runtime_groupReplyOptions.call(this.host, ...args); }
  buildProviderBashOptions(...args: Parameters<typeof runtime_buildProviderBashOptions>) { return runtime_buildProviderBashOptions.call(this.host, ...args); }
  isAdminUser(...args: Parameters<typeof runtime_isAdminUser>) { return runtime_isAdminUser.call(this.host, ...args); }
}
