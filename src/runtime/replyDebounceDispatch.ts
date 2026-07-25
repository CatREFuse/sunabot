import type { AsyncToolCompletionPayload } from "../../packages/contracts/session/runtimeMessages.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { readReplyGateSnapshot, type ReplyGateSnapshot } from "../../services/orchestration/groupReplyPolicy.js";
import { GENERATE_IMG_TOOL_NAME } from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import type { ImageResult, ParsedIncomingMessage } from "../types.js";
import type { runtime_replyDeliveryDraft } from "./delivery.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import {
  buildAsyncToolCompletionPrompt,
  isAbortError,
  isRuntimeIncomingMessage,
  sanitizeErrorDetail
} from "./infrastructure.js";
import { appendReplySoftError } from "./replyModuleIsolation.js";
import type { ReplyDelivery } from "./runtimeContracts.js";
import type { ToneRewriteContext } from "./tone.js";

type AsyncToolCallbackOptions = Pick<AsyncToolCompletionPayload["originalRequest"], "captureSequence" | "contextThroughSequence" | "threadContext" | "orchestratorResult"> & { signal: AbortSignal; isCurrent: () => boolean; delivery: ReplyDelivery; skipGroupThreadPreparation: true; messageOrigin: "async_tool_callback"; seedToolNames: string[]; };

interface ToolCompletionRuntimeHost { isReplyTaskCurrent(incoming: ParsedIncomingMessage, gate: ReplyGateSnapshot, signal?: AbortSignal): boolean; rewriteToneText(text: string, context?: ToneRewriteContext): Promise<string>; isAdminUser(userId: number): boolean; replyDeliveryDraft(...args: Parameters<typeof runtime_replyDeliveryDraft>): ReturnType<typeof runtime_replyDeliveryDraft>; replyToIncoming(channelKey: string, incoming: ParsedIncomingMessage, gateway: MessagingPort, options: AsyncToolCallbackOptions): Promise<unknown>; }

export async function runtime_replyToToolCompletion(
  this: ToolCompletionRuntimeHost,
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
  const gate = readReplyGateSnapshot(payload.originalRequest.replyGate, incoming.scope, channelKey);
  const replyQuote = payload.originalRequest.replyQuote;
  if (!gate || !replyQuote) {
    delivery.terminalStatus = "no_reply";
    return;
  }
  delivery.replyQuote = replyQuote;
  delivery.mentionUserIds = payload.originalRequest.mentionUserIds;
  const isCurrent = () => this.isReplyTaskCurrent(incoming, gate, signal);
  if (!isCurrent()) return;
  if (payload.toolName === GENERATE_IMG_TOOL_NAME || payload.toolName === SELFIE_TOOL_NAME) {
    const result = readDeferredImageResult(payload.outcome.result);
    const text = result.image
      ? ""
      : `图片生成失败：${sanitizeErrorDetail(result.error || "没有可用图片")}`;
    let tonedText = text;
    try {
      tonedText = await this.rewriteToneText(text, {
        incoming,
        signal,
        logContext: {
          conversationId: channelKey,
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId)
        }
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (text) tonedText = appendReplySoftError(text, "表达优化暂不可用");
    }
    delivery.outbox.push(this.replyDeliveryDraft(
      incoming,
      tonedText,
      this.isAdminUser(incoming.userId),
      result.image ? [result.image] : [],
      undefined,
      `tool-image:${payload.toolJobId}`,
      true,
      {
        messageOrigin: "async_tool_callback",
        toolNames: [payload.toolName]
      },
      delivery.replyQuote,
      undefined,
      delivery.mentionUserIds
    ));
    return;
  }
  const callbackIncoming = {
    ...incoming,
    text: buildAsyncToolCompletionPrompt(payload)
  };
  await this.replyToIncoming(channelKey, callbackIncoming, gateway, {
    signal,
    isCurrent,
    delivery,
    captureSequence: payload.originalRequest.captureSequence,
    contextThroughSequence: payload.originalRequest.contextThroughSequence,
    threadContext: payload.originalRequest.threadContext,
    orchestratorResult: payload.originalRequest.orchestratorResult,
    skipGroupThreadPreparation: true,
    messageOrigin: "async_tool_callback",
    seedToolNames: [payload.toolName]
  });
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
