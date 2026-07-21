import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
  AppConfig,
  AssistantMessageTrace,
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
  type ReplyQuoteSnapshotV1,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import type { OutboxBubbleSequenceV1 } from "../../packages/contracts/session/assistantReplyMetadata.js";
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
  outboundMessageBubble,
  replaceInboundImageUrls,
  sendOutboundBubble,
  type MessageDetailsV1,
  type MessagingPort,
  type MessagingReceiptV1,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import { loadPersona, AgentPersona } from "../../services/agent/persona.js";
import { appendRequestLog, appendRequestLogStrict } from "../requestLog.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type OutboxDeliveryContext,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import { waitForOutboxBubble } from "../../services/sessions/outboxBubblePacing.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../../services/agent/persona.js";
import {
  isEmojiFileName,
  prepareEmojiReply,
  replanEmojiMarkers,
  type EmojiMarkerPlan
} from "../../services/emojis/emojiCatalog.js";
import {
  parseSegmentedReplyXml,
  type SegmentedReplyNodeV1
} from "../../services/messaging/segmentedReply.js";
import type { ToneAvailableAssetV1 } from "../../services/agent/toneReplyPrompt.js";
import {
  planAgentEmojiMarkers
} from "../emojis/emojiAssets.js";
import { prepareEmojiDeliveryImages } from "../emojis/emojiDeliveryAssets.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { conversationRecordId, normalizeOutgoingReplyText, outboundForIncoming, persistentIncomingKey, queueIncomingSnapshot } from "./messagingAttachmentHelpers.js";
import { formatErrorReply, saveConversationRecordsStrict } from "./infrastructure.js";
import { rewritePlannedEmojiText } from "./emojiReply.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export async function runtime_sendAssistantReply(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    text: string,
    isAdmin: boolean,
    generatedImages: ImageResult[] = [],
    logRunId?: string,
    isCurrent: () => boolean = () => true,
    delivery?: ReplyDelivery,
    quoteReply = true,
    trace: AssistantMessageTrace = { messageOrigin: "text" },
    deliveryTiming: "buffered" | "immediate" = "buffered",
    signal?: AbortSignal,
    emojiPlan?: EmojiMarkerPlan,
    singleMessage = false
  ) {
    if (
      !this.isReplySenderAllowed(incoming.userId) ||
      !isCurrent()
    ) return undefined;
    const plannedEmojiReply = emojiPlan ?? planAgentEmojiMarkers(text, this.config);
    const beforeReply = await this.hooks.run("before_reply", {
      channel: channelKey,
      text,
      context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
    });
    const toneContext = {
          incoming,
          signal,
          logContext: {
            conversationId: conversationRecordId(incoming),
            incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
            runId: logRunId
          }
        };
    let replyText: string;
    let outboundImageAssets: ImageResult[];
    let deliveryParts: Array<{
      text: string;
      images: ImageResult[];
      contentSegments?: OutboundMessageV1["contentSegments"];
      primary: boolean;
    }>;
    if (this.config.bot.tone.enabled && this.config.bot.tone.segmentedReply) {
      const currentEmojiPlan = replanEmojiMarkers(beforeReply.text, plannedEmojiReply);
      const availableImages = generatedImages.filter((image) => image.url || image.filePath);
      const assets: ToneAvailableAssetV1[] = availableImages.map((_, index) => ({
        kind: "image",
        src: segmentedImageSource(index)
      }));
      const rewritten = await this.rewriteToneDelivery(
        beforeReply.text,
        assets,
        toneContext,
        currentEmojiPlan.expectedMarkers
      );
      deliveryParts = await segmentedReplyDeliveryParts(
        this.config,
        rewritten.content,
        currentEmojiPlan,
        availableImages
      );
      replyText = deliveryParts.flatMap((part) => part.text ? [part.text] : []).join("\n");
      outboundImageAssets = deliveryParts.flatMap((part) => part.images);
    } else {
      const rewritten = await rewritePlannedEmojiText(
        beforeReply.text,
        plannedEmojiReply,
        (value) => this.rewriteToneText(value, toneContext)
      );
      const normalizedText = normalizeOutgoingReplyText(rewritten.text).trim();
      const preparedReply = prepareEmojiReply(
        normalizedText,
        replanEmojiMarkers(normalizedText, rewritten.plan),
        generatedImages.filter((image) => image.url || image.filePath)
      );
      const emojiImages = await prepareEmojiDeliveryImages(this.config, plannedEmojiReply);
      preparedReply.images.splice(0, emojiImages.length, ...emojiImages);
      outboundImageAssets = preparedReply.images;
      replyText = preparedReply.text;
      deliveryParts = emojiDeliveryParts(
        replyText,
        outboundImageAssets,
        emojiImages.length,
        preparedReply.contentSegments,
        this.config.bot.emojiSendSeparately
      );
    }
    if (singleMessage && deliveryParts.length > 1) {
      deliveryParts = [{ text: replyText, images: outboundImageAssets, primary: true }];
    }
    const generatedImageUrls = generatedImages.flatMap((image) => image.url ? [image.url] : []);
    if (!replyText && !outboundImageAssets.length) {
      throw new Error("模型回复为空。");
    }
    if (!isCurrent()) return undefined;

    if (delivery) {
      const drafts = deliveryParts.map((part, index) => this.replyDeliveryDraft(
          incoming,
          part.text,
          isAdmin,
          part.images,
          logRunId,
          undefined,
          part.primary ? quoteReply : false,
          trace,
          part.primary ? delivery.replyQuote : undefined,
          part.contentSegments,
          part.primary ? delivery.mentionUserIds : undefined,
          deliveryParts.length > 1 ? {
            schemaVersion: 1,
            index,
            total: deliveryParts.length
          } : undefined
        ));
      if (deliveryTiming === "immediate" && delivery.emitOutbox) {
        for (const [index, draft] of drafts.entries()) {
          const part = deliveryParts[index]!;
          draft.dedupeFingerprint = immediateReplyFingerprint(
          incoming,
          part.text,
          part.images,
          part.primary ? quoteReply : false,
          draft.payload.payload.replyToMessageId,
          trace,
          part.contentSegments
          );
          await delivery.emitOutbox(draft);
        }
      } else {
        delivery.outbox.push(...drafts);
      }
      return undefined;
    }

    const replyToMessageId = quoteReply ? this.groupReplyOptions(incoming).replyToMessageId : undefined;
    let receipt: MessagingReceiptV1 | undefined;
    for (const part of deliveryParts) {
      const currentReceipt = await sendOutboundBubble(gateway, outboundMessageBubble(outboundForIncoming(
        incoming,
        part.text,
        part.images,
        part.primary ? replyToMessageId : undefined,
        part.contentSegments,
        part.primary ? undefined : []
      )));
      receipt ??= currentReceipt;
    }

    const pureEmojiReply = !replyText
      && outboundImageAssets.length > 0
      && outboundImageAssets.every(isEmojiImageResult);
    const record = pureEmojiReply ? undefined : this.recordAssistantMessage(
        incoming,
        replyText || "[图片]",
        generatedImageUrls,
        logRunId,
        undefined,
        trace,
        {
          ...(receipt?.messageId ? { messageId: receipt.messageId } : {}),
          ...(replyToMessageId == null ? {} : { replyMessageIds: [replyToMessageId] })
        }
      );
    if (logRunId) {
      await appendRequestLog({
        category: "runtime.action",
        action: "reply.sent",
        request: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId
        },
        response: {
          textChars: replyText.length,
          generatedImageCount: generatedImageUrls.length
        },
        metadata: {
          conversationId: conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          runId: logRunId,
          stage: "reply"
        }
      });
    }

    await this.hooks.run("after_reply", {
      channel: channelKey,
      text: replyText,
      context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
    });

    return record;
  }
export function runtime_replyDeliveryDraft(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    text: string,
    isAdmin: boolean,
    generatedImages: ImageResult[] = [],
    logRunId?: string,
    dedupeKey?: string,
    quoteReply = true,
    trace: AssistantMessageTrace = { messageOrigin: "text" },
    replyQuote?: ReplyQuoteSnapshotV1,
    contentSegments?: OutboundMessageV1["contentSegments"],
    mentionUserIds?: readonly number[],
    bubbleSequence?: OutboxBubbleSequenceV1
  ): ReplyDeliveryDraft {
    const replyToMessageId = resolveReplyToMessageId(this, incoming, quoteReply, replyQuote);
    return {
      kind: "onebot.reply",
      payload: assistantReplyEnvelope({
        type: "assistant_reply",
        incoming: queueIncomingSnapshot(incoming),
        text,
        generatedImages,
        ...(contentSegments?.length ? { contentSegments: contentSegments.map((segment) => ({ ...segment })) } : {}),
        isAdmin,
        quoteReply,
        replyToMessageId: replyToMessageId ?? null,
        logRunId,
        messageOrigin: trace.messageOrigin ?? "text",
        toolNames: trace.toolNames?.length ? [...new Set(trace.toolNames)] : undefined,
        ...(mentionUserIds?.length ? { mentionUserIds: [...mentionUserIds] } : {}),
        ...(bubbleSequence ? { bubbleSequence } : {}),
        replyGate: this.replyGates.capture(incoming.scope, conversationRecordId(incoming))
      }, {
        conversationId: conversationRecordId(incoming),
        correlationId: logRunId ?? `onebot:${incoming.messageId ?? persistentIncomingKey(incoming)}`,
        idempotencyKey: dedupeKey
      }),
      dedupeKey
    };
  }
export async function runtime_deliverReplyOutbox(
  this: RuntimeHost,
  payload: AssistantReplyOutboxPayload,
  gateway: MessagingPort | undefined,
  delivery?: OutboxDeliveryContext
) {
  const incoming = payload.incoming;
  const replyToMessageId = durableReplyToMessageId(this, payload, incoming);
  const generatedImageAssets = payload.generatedImages.filter((image) => image.url || image.filePath);
  const generatedImageUrls = generatedImageAssets
    .filter((image) => !isEmojiImageResult(image))
    .flatMap((image) => image.url ? [image.url] : []);
  const containsEmoji = generatedImageAssets.some(isEmojiImageResult);
  const pureEmojiReply = !payload.text
    && containsEmoji
    && generatedImageAssets.every(isEmojiImageResult);
  let remoteReceipt = delivery?.remoteReceipt;
  if (delivery?.phase === "send" || !delivery) {
      if (!gateway) throw new OutboxDisconnectedError("OneBot is not connected.");
      if (delivery) await waitForOutboxBubble(payload.bubbleSequence, delivery.signal);
      const sendReply = () => sendOutboundBubble(gateway, outboundMessageBubble(outboundForIncoming(
        incoming,
        payload.text,
        generatedImageAssets,
        replyToMessageId,
        payload.contentSegments,
        payload.mentionUserIds
      )));
    if (delivery) remoteReceipt = await delivery.sendRemote(sendReply);
    else remoteReceipt = await sendReply();
  }

    const settleConversation = (idempotencyKey?: string) => {
      if (pureEmojiReply) return undefined;
      const outboundMessageId = messagingReceiptMessageId(delivery?.remoteReceipt ?? remoteReceipt);
      const record = this.recordAssistantMessage(
        incoming,
        payload.text || "[图片]",
        generatedImageUrls,
        payload.logRunId,
        undefined,
        {
          messageOrigin: payload.messageOrigin,
          toolNames: payload.toolNames
        },
        {
          ...(idempotencyKey
            ? { persist: false, messageId: outboundMessageId ?? idempotencyKey }
            : outboundMessageId ? { messageId: outboundMessageId } : {}),
          ...(replyToMessageId == null ? {} : { replyMessageIds: [replyToMessageId] })
        }
      );
      if (idempotencyKey) {
        saveConversationRecordsStrict(
          [...this.conversationRecords.values()],
          idempotencyKey,
          this.config,
          this.protectedConversationIds()
        );
      } else {
        this.scheduleMemoryCompression(record);
      }
      return record;
    };
    if (delivery) {
      await delivery.settleStep("conversation_projection", settleConversation);
      await delivery.settleStep("memory_enqueue", async () => {
        if (pureEmojiReply) return;
        const record = this.conversationRecords.get(conversationRecordId(incoming));
        if (!record) throw new Error(`Conversation projection is missing: ${conversationRecordId(incoming)}`);
        await this.enqueueConversationMemory(record);
        this.scheduleMemoryDrain();
      });
    } else settleConversation();

    const settleRequestLog = () => payload.logRunId ? appendRequestLog({
        category: "runtime.action",
        action: "reply.sent",
        request: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId
        },
        response: {
          textChars: payload.text.length,
          generatedImageCount: generatedImageUrls.length
        },
        metadata: {
          conversationId: conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          runId: payload.logRunId,
          stage: "reply"
        }
      }) : undefined;
    if (delivery) await delivery.settleStep("request_log", (idempotencyKey) => payload.logRunId
      ? appendRequestLogStrict({
          category: "runtime.action",
          action: "reply.sent",
          request: {
            scope: incoming.scope,
            userId: incoming.userId,
            groupId: incoming.groupId
          },
          response: {
            textChars: payload.text.length,
            generatedImageCount: generatedImageUrls.length
          },
          metadata: {
            conversationId: conversationRecordId(incoming),
            incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
            runId: payload.logRunId,
            stage: "reply"
          }
        }, idempotencyKey)
      : undefined);
    else await settleRequestLog();

    const afterReplyPayload = {
      channel: conversationRecordId(incoming),
      text: payload.text,
      context: {
        scope: incoming.scope,
        userId: incoming.userId,
        groupId: incoming.groupId,
        isAdmin: payload.isAdmin
      }
    };
    if (delivery) {
      await this.hooks.runEach("after_reply", afterReplyPayload, async (handlerId, invoke) => {
        await delivery.settleEffectStep(`after_reply:${handlerId}`, (idempotencyKey) => invoke({
          ...afterReplyPayload,
          context: { ...afterReplyPayload.context, idempotencyKey }
        }));
      });
    } else await this.hooks.run("after_reply", afterReplyPayload);
  }
export async function runtime_sendErrorReply(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    error: unknown,
    isCurrent: () => boolean = () => true,
    logRunId?: string,
    delivery?: ReplyDelivery,
    trace: AssistantMessageTrace = { messageOrigin: "text" },
    signal?: AbortSignal
  ) {
    if (
      !this.isReplySenderAllowed(incoming.userId) ||
      !isCurrent()
    ) return;
    const message = await this.rewriteToneText(formatErrorReply(error), {
      incoming,
      signal,
      logContext: {
        conversationId: conversationRecordId(incoming),
        incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
        runId: logRunId
      }
    });
    try {
      if (!isCurrent()) return;
      if (delivery) {
        delivery.outbox.push(this.replyDeliveryDraft(
          incoming,
          message,
          this.isAdminUser(incoming.userId),
          [],
          logRunId,
          undefined,
          true,
          trace,
          delivery.replyQuote,
          undefined,
          delivery.mentionUserIds
        ));
        return;
      }
      const replyToMessageId = this.groupReplyOptions(incoming).replyToMessageId;
      const receipt = await sendOutboundBubble(gateway, outboundMessageBubble(outboundForIncoming(
        incoming,
        message,
        [],
        replyToMessageId
      )));
      this.recordAssistantMessage(
        incoming,
        message,
        [],
        logRunId,
        logRunId ? "failed" : undefined,
        trace,
        {
          ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          ...(replyToMessageId == null ? {} : { replyMessageIds: [replyToMessageId] })
        }
      );
    } catch (error) {
      console.error("[runtime] error reply failed", {
        messageId: incoming.messageId,
        userId: incoming.userId,
        groupId: incoming.groupId,
        error
      });
    }
  }

export class RuntimeDelivery {
  constructor(private readonly host: RuntimeHost) {}
  sendAssistantReply(...args: Parameters<typeof runtime_sendAssistantReply>) { return runtime_sendAssistantReply.call(this.host, ...args); }
  replyDeliveryDraft(...args: Parameters<typeof runtime_replyDeliveryDraft>) { return runtime_replyDeliveryDraft.call(this.host, ...args); }
  deliverReplyOutbox(...args: Parameters<typeof runtime_deliverReplyOutbox>) { return runtime_deliverReplyOutbox.call(this.host, ...args); }
  sendErrorReply(...args: Parameters<typeof runtime_sendErrorReply>) { return runtime_sendErrorReply.call(this.host, ...args); }
}

function messagingReceiptMessageId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
}

function durableReplyToMessageId(
  runtime: RuntimeHost,
  payload: AssistantReplyOutboxPayload,
  incoming: ParsedIncomingMessage
) {
  if (Object.hasOwn(payload, "replyToMessageId")) {
    return Number.isSafeInteger(payload.replyToMessageId) && Number(payload.replyToMessageId) > 0
      ? Number(payload.replyToMessageId)
      : undefined;
  }
  return payload.quoteReply === false ? undefined : runtime.groupReplyOptions(incoming).replyToMessageId;
}

function resolveReplyToMessageId(
  runtime: RuntimeHost,
  incoming: ParsedIncomingMessage,
  quoteReply: boolean,
  replyQuote?: ReplyQuoteSnapshotV1
) {
  if (!quoteReply) return undefined;
  if (replyQuote) {
    return replyQuote.enabled ? replyQuote.replyToMessageId ?? undefined : undefined;
  }
  return runtime.groupReplyOptions(incoming).replyToMessageId;
}

function immediateReplyFingerprint(
  incoming: ParsedIncomingMessage,
  text: string,
  generatedImages: ImageResult[],
  quoteReply: boolean,
  replyToMessageId: number | null | undefined,
  trace: AssistantMessageTrace,
  contentSegments?: OutboundMessageV1["contentSegments"]
) {
  return createHash("sha256").update(JSON.stringify({
    target: {
      scope: incoming.scope,
      messageId: incoming.messageId,
      userId: incoming.userId,
      groupId: incoming.groupId,
      selfId: incoming.selfId,
      accountId: incoming.accountId,
      agentId: incoming.agentId
    },
    text,
    generatedImages: generatedImages.map(({ url, filePath }) => ({ url, filePath })),
    contentSegments,
    quoteReply,
    replyToMessageId,
    messageOrigin: trace.messageOrigin
  })).digest("hex");
}

function segmentedImageSource(index: number) {
  return `asset:image:${index}`;
}

async function segmentedReplyDeliveryParts(
  config: AppConfig,
  xml: string,
  emojiPlan: EmojiMarkerPlan,
  images: readonly ImageResult[]
) {
  const nodes: SegmentedReplyNodeV1[] = xml.trim()
    ? parseSegmentedReplyXml(xml).nodes
    : images.map((_, index) => ({ type: "image" as const, src: segmentedImageSource(index) }));
  const actualMarkers = nodes.flatMap((node) => node.type === "expression" ? [node.marker] : []);
  if (!sameSequence(actualMarkers, emojiPlan.expectedMarkers)) {
    throw segmentedReplyContractError("分段回复改变了原有表情标记。");
  }
  const actualAssets = nodes.flatMap((node) => (
    node.type === "image" || node.type === "voice" || node.type === "file"
      ? [{ type: node.type, src: node.src }]
      : []
  ));
  const expectedAssets = images.map((_, index) => ({
    type: "image" as const,
    src: segmentedImageSource(index)
  }));
  if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
    throw segmentedReplyContractError("分段回复改变了本轮媒体资源。");
  }
  const emojiImages = await prepareEmojiDeliveryImages(config, emojiPlan);
  let emojiIndex = 0;
  return nodes.map((node, index) => {
    if (node.type === "dialog") {
      const text = normalizeOutgoingReplyText(node.text).trim();
      if (!text) throw segmentedReplyContractError("分段回复包含空文字气泡。");
      return { text, images: [], primary: index === 0 };
    }
    if (node.type === "expression") {
      const image = emojiImages[emojiIndex++];
      if (!image) throw segmentedReplyContractError("分段回复表情资源缺失。");
      return {
        text: "",
        images: [image],
        contentSegments: [{ type: "sticker" as const, imageIndex: 0 }],
        primary: index === 0
      };
    }
    if (node.type === "image") {
      const imageIndex = Number(node.src.slice("asset:image:".length));
      const image = images[imageIndex];
      if (!Number.isSafeInteger(imageIndex) || imageIndex < 0 || !image) {
        throw segmentedReplyContractError("分段回复图片资源无效。");
      }
      return { text: "", images: [{ ...image }], primary: index === 0 };
    }
    throw segmentedReplyContractError("分段回复引用了未提供的资源。");
  });
}

function sameSequence(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function segmentedReplyContractError(message: string) {
  return Object.assign(new Error(message), { code: "SEGMENTED_REPLY_CONTRACT_INVALID" });
}

function emojiDeliveryParts(
  text: string,
  images: readonly ImageResult[],
  emojiImageCount: number,
  contentSegments: OutboundMessageV1["contentSegments"],
  sendSeparately: boolean
) {
  if (!sendSeparately || emojiImageCount === 0) {
    return [{
      text,
      images: [...images],
      contentSegments,
      primary: true
    }];
  }

  const parts: Array<{
    text: string;
    images: ImageResult[];
    contentSegments?: OutboundMessageV1["contentSegments"];
    primary: boolean;
  }> = [];
  const generatedImages = images.slice(emojiImageCount);
  if (text || generatedImages.length) {
    parts.push({ text, images: generatedImages, primary: true });
  }
  parts.push({
    text: "",
    images: images.slice(0, emojiImageCount),
    contentSegments: images.slice(0, emojiImageCount).map((_, imageIndex) => ({
      type: "sticker" as const,
      imageIndex
    })),
    primary: parts.length === 0
  });
  return parts;
}

function isEmojiImageResult(image: Pick<ImageResult, "url" | "filePath">) {
  return [image.filePath, image.url].some((value) => {
    if (!value) return false;
    try {
      return isEmojiFileName(path.basename(decodeURIComponent(value)));
    } catch {
      return false;
    }
  });
}
