import type { AsyncToolCompletionPayload } from "../../packages/contracts/session/runtimeMessages.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { readReplyGateSnapshot } from "../../services/orchestration/groupReplyPolicy.js";
import { GENERATE_IMG_TOOL_NAME } from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import type { SunaRuntime } from "../runtime.js";
import type { ImageResult } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import { buildAsyncToolCompletionPrompt, isRuntimeIncomingMessage, sanitizeErrorDetail } from "./infrastructure.js";
import type { ReplyDelivery } from "./runtimeContracts.js";

export async function runtime_replyToToolCompletion(
  this: SunaRuntime,
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
    const tonedText = await this.rewriteToneText(text, {
      incoming,
      signal,
      logContext: {
        conversationId: channelKey,
        incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId)
      }
    });
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
