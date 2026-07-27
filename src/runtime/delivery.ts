import { createHash } from "node:crypto";
import path from "node:path";
import {
  outboundMessageBubble,
  sendOutboundBubble,
  type MessagingPort,
  type MessagingReceiptV1,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import type { OutboxBubbleSequenceV1 } from "../../packages/contracts/session/assistantReplyMetadata.js";
import {
  assistantReplyEnvelope,
  type AssistantReplyOutboxPayload,
  type ReplyQuoteSnapshotV1
} from "../../packages/contracts/session/runtimeMessages.js";
import type { ToneAvailableAssetV1 } from "../../services/agent/toneReplyPrompt.js";
import {
  isEmojiFileName,
  prepareEmojiReply,
  replanEmojiMarkers,
  type EmojiMarkerPlan
} from "../../services/emojis/emojiCatalog.js";
import type { HookBus } from "../../services/messaging/hookBus.js";
import {
  MAX_SEGMENTED_REPLY_BUBBLES,
  parseSegmentedReplyXml,
  type SegmentedReplyNodeV1
} from "../../services/messaging/segmentedReply.js";
import type { ReplyGateEpochs } from "../../services/orchestration/groupReplyPolicy.js";
import { waitForOutboxBubble } from "../../services/sessions/outboxBubblePacing.js";
import {
  OutboxDisconnectedError,
  type OutboxDeliveryContext
} from "../../services/sessions/sessionCoordinator.js";
import {
  planAgentEmojiMarkers
} from "../emojis/emojiAssets.js";
import { SYSTEM_CONFIG_TOOL_NAME } from "../../services/tools/systemConfigTool.js";
import { prepareEmojiDeliveryImages } from "../emojis/emojiDeliveryAssets.js";
import { appendRequestLog, appendRequestLogStrict } from "../../adapters/observability/requestLog.js";
import {
  type AppConfig,
  type AssistantMessageTrace,
  type ConversationRecord,
  type ImageResult,
  type ParsedIncomingMessage
} from "../types.js";
import { rewritePlannedEmojiText } from "./emojiReply.js";
import { errorMessage, formatErrorReply, isAbortError, saveConversationRecordsStrict } from "./infrastructure.js";
import {
  conversationRecordId,
  normalizeOutgoingReplyText,
  outboundForIncoming,
  persistentIncomingKey,
  queueIncomingSnapshot
} from "./messagingAttachmentHelpers.js";
import {
  type ReplyDelivery,
  type ReplyDeliveryDraft
} from "./runtimeContracts.js";
import { appendReplySoftError } from "./replyModuleIsolation.js";
import {
  appendSegmentedDeliverySoftError,
  isEmojiToneContractError,
  isSegmentedReplyHardGateError,
  sameReplySequence,
  segmentedReplyContractError
} from "./segmentedReplyIsolation.js";
import type { ToneRewriteContext } from "./tone.js";
interface RuntimeHost {
  readonly config: AppConfig;
  readonly conversationRecords: Map<string, ConversationRecord>;
  readonly hooks: HookBus;
  readonly replyGates: ReplyGateEpochs;
  enqueueConversationMemory(record: ConversationRecord): Promise<void>;
  groupReplyOptions(incoming: ParsedIncomingMessage): { replyToMessageId?: number };
  isAdminUser(userId: number | string): boolean;
  isReplySenderAllowed(userId: number | string): boolean;
  protectedConversationIds(): ReadonlySet<string>;
  recordAssistantMessage(
    incoming: ParsedIncomingMessage,
    text: string,
    imageUrls?: string[],
    logRunId?: string,
    requestStatus?: "failed",
    trace?: AssistantMessageTrace,
    options?: { persist?: boolean; messageId?: string; replyMessageIds?: number[] }
  ): ConversationRecord;
  replyDeliveryDraft(
    incoming: ParsedIncomingMessage,
    text: string,
    isAdmin: boolean,
    generatedImages?: ImageResult[],
    logRunId?: string,
    dedupeKey?: string,
    quoteReply?: boolean,
    trace?: AssistantMessageTrace,
    replyQuote?: ReplyQuoteSnapshotV1,
    contentSegments?: OutboundMessageV1["contentSegments"],
    mentionUserIds?: readonly number[],
    bubbleSequence?: OutboxBubbleSequenceV1
  ): ReplyDeliveryDraft;
  rewriteToneDelivery(
    text: string,
    assets: readonly ToneAvailableAssetV1[],
    context?: ToneRewriteContext,
    emojiMarkers?: readonly string[]
  ): Promise<{ segmented: boolean; content: string }>;
  rewriteToneText(text: string, context?: ToneRewriteContext): Promise<string>;
  scheduleMemoryCompression(record: ConversationRecord): void;
  scheduleMemoryDrain(): void;
}

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
      const maxRetries = this.config.bot.tone.followMainModel
        ? this.config.normalReply.maxRetries
        : this.config.bot.tone.maxRetries;
      const hardGateErrors: string[] = [];
      try {
        for (let retry = 0; ; retry += 1) {
          signal?.throwIfAborted();
          const rewritten = await this.rewriteToneDelivery(
            beforeReply.text,
            assets,
            hardGateErrors.length
              ? {
                  ...toneContext,
                  hardGateRetry: {
                    attempt: retry + 1,
                    maxAttempts: maxRetries + 1,
                    errors: [...hardGateErrors]
                  }
                }
              : toneContext,
            currentEmojiPlan.expectedMarkers
          );
          try {
            deliveryParts = await segmentedReplyDeliveryParts(
              this.config,
              rewritten.content,
              currentEmojiPlan,
              availableImages
            );
            break;
          } catch (error) {
            if (!isSegmentedReplyHardGateError(error) || retry >= maxRetries) throw error;
            hardGateErrors.push(errorMessage(error));
          }
        }
      } catch (error) {
        if (
          signal?.aborted ||
          isAbortError(error) ||
          trace.toolNames?.includes(SYSTEM_CONFIG_TOOL_NAME)
        ) throw error;
        try {
          deliveryParts = appendSegmentedDeliverySoftError(
            await segmentedReplyDeliveryParts(
              this.config,
              beforeReply.text,
              currentEmojiPlan,
              availableImages
            ),
            "表达优化暂不可用"
          );
        } catch {
          throw error;
        }
      }
      replyText = deliveryParts.flatMap((part) => part.text ? [part.text] : []).join("\n");
      outboundImageAssets = deliveryParts.flatMap((part) => part.images);
    } else {
      let rewritten;
      try {
        rewritten = await rewritePlannedEmojiText(
          beforeReply.text,
          plannedEmojiReply,
          (value) => this.rewriteToneText(value, toneContext)
        );
      } catch (error) {
        if (
          signal?.aborted ||
          isAbortError(error) ||
          isEmojiToneContractError(error) ||
          trace.toolNames?.includes(SYSTEM_CONFIG_TOOL_NAME)
        ) throw error;
        rewritten = await rewritePlannedEmojiText(
          beforeReply.text,
          plannedEmojiReply,
          async (value) => value
        );
        rewritten.text = appendReplySoftError(rewritten.text, "表达优化暂不可用");
      }
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
    const sentImageUrls = [...new Set(outboundImageAssets.flatMap((image) => image.url ? [image.url] : []))];
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
    const record = this.recordAssistantMessage(
        incoming,
        replyText || "[图片]",
        sentImageUrls,
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

    return pureEmojiReply ? undefined : record;
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
      const outboundMessageId = messagingReceiptMessageId(delivery?.remoteReceipt ?? remoteReceipt);
      const record = this.recordAssistantMessage(
        incoming,
        payload.text || "[图片]",
        [...new Set(generatedImageAssets.flatMap((image) => image.url ? [image.url] : []))],
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
      } else if (!pureEmojiReply) {
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
    const fallbackMessage = formatErrorReply(error);
    let message: string;
    try {
      message = await this.rewriteToneText(fallbackMessage, {
        incoming,
        signal,
        logContext: {
          conversationId: conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          runId: logRunId
        }
      });
    } catch (toneError) {
      if (signal?.aborted || isAbortError(toneError)) throw toneError;
      message = fallbackMessage;
    }
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
  if (!sameReplySequence(actualMarkers, emojiPlan.expectedMarkers)) {
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
  const actualAssetsArePrefix = actualAssets.length <= expectedAssets.length
    && actualAssets.every((asset, index) => (
      asset.type === expectedAssets[index]?.type && asset.src === expectedAssets[index]?.src
    ));
  if (!actualAssetsArePrefix) {
    throw segmentedReplyContractError("分段回复改变了本轮媒体资源。");
  }
  const missingAssets = expectedAssets.slice(actualAssets.length);
  if (nodes.length + missingAssets.length > MAX_SEGMENTED_REPLY_BUBBLES) {
    throw segmentedReplyContractError(`分段回复最多包含 ${MAX_SEGMENTED_REPLY_BUBBLES} 个气泡。`);
  }
  nodes.push(...missingAssets);
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
