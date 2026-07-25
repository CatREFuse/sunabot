import type { OutboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import { MAX_SEGMENTED_REPLY_BUBBLES } from "../../services/messaging/segmentedReply.js";
import type { ImageResult } from "../types.js";
import { appendReplySoftError } from "./replyModuleIsolation.js";

export interface SegmentedReplyDeliveryPart {
  text: string;
  images: ImageResult[];
  contentSegments?: OutboundMessageV1["contentSegments"];
  primary: boolean;
}

export function appendSegmentedDeliverySoftError(
  parts: SegmentedReplyDeliveryPart[],
  reason: string
) {
  let textIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (!parts[index]?.text) continue;
    textIndex = index;
    break;
  }
  if (textIndex >= 0) {
    const part = parts[textIndex]!;
    parts[textIndex] = {
      ...part,
      text: appendReplySoftError(part.text, reason)
    };
    return parts;
  }
  if (parts.length >= MAX_SEGMENTED_REPLY_BUBBLES) {
    throw segmentedReplyContractError(`分段回复最多包含 ${MAX_SEGMENTED_REPLY_BUBBLES} 个气泡。`);
  }
  parts.push({
    text: appendReplySoftError("", reason),
    images: [],
    primary: parts.length === 0
  });
  return parts;
}

export function sameReplySequence(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function segmentedReplyContractError(message: string) {
  return Object.assign(new Error(message), { code: "SEGMENTED_REPLY_CONTRACT_INVALID" });
}

export function isSegmentedReplyHardGateError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "SEGMENTED_REPLY_XML_INVALID"
    || code === "SEGMENTED_REPLY_CONTRACT_INVALID";
}

export function isEmojiToneContractError(error: unknown) {
  return error instanceof Error
    && error.message === "语气改写改变了表情标记，请重试。";
}
