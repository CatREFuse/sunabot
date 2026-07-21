import { createHash } from "node:crypto";
import { imageMediaAsset, type AttachmentExtractionContext, type IncomingAttachment } from "../../packages/contracts/media/media.js";
import type {
  InboundMessageV1,
  MessageDetailsV1,
  SenderIdentityV1
} from "../../packages/contracts/messaging/messages.js";
import { pendingAttachments } from "../../services/media/attachments/service.js";
import {
  extractOneBotForwardMessageIds,
  renderOneBotMessage
} from "./inboundMessageContent.js";
import type { OneBotEvent, OneBotMessageSegment } from "./protocol.js";

const DEFAULT_ATTACHMENT_NAME = "未命名文件";
const MAX_ATTACHMENT_NAME_LENGTH = 180;
const MAX_FILE_IDENTIFIER_LENGTH = 2_048;

interface NormalizedFileSegment {
  name: string;
  fileId?: string;
  sizeBytes?: number;
  url?: string;
  busId?: number;
}

export function parseOneBotInboundMessage(event: OneBotEvent): InboundMessageV1 | undefined {
  if (event.post_type !== "message" || !event.user_id || !event.message_type) return undefined;

  const selfId = event.self_id;
  const message = event.message ?? event.raw_message ?? "";
  const rendered = renderOneBotMessage(message, { selfId });
  return {
    schemaVersion: 1,
    scope: event.message_type === "private" ? "private" : detectGroupScope(event),
    ...(positiveInteger(event.message_id) ? { messageId: positiveInteger(event.message_id) } : {}),
    time: eventTime(event.time),
    userId: event.user_id,
    ...(positiveInteger(event.group_id) ? { groupId: positiveInteger(event.group_id) } : {}),
    ...(positiveInteger(selfId) ? { selfId: positiveInteger(selfId) } : {}),
    sender: senderIdentity(event.sender ?? {}, event.user_id),
    text: rendered.text,
    media: rendered.imageUrls.map(imageMediaAsset),
    attachments: pendingAttachments(extractOneBotAttachments(message, {
      source: "message",
      messageId: event.message_id,
      groupId: event.group_id,
      userId: event.user_id
    })),
    replyMessageIds: extractReplyMessageIds(message),
    quoteReferences: [],
    mentionedSelf: isMentioned(message, selfId)
  };
}

export function extractOneBotMessageDetails(
  payload: unknown,
  context: AttachmentExtractionContext = { source: "quote" }
): MessageDetailsV1 {
  const root = record(payload);
  const data = record(root.data);
  const payloadSource = Object.keys(data).length ? data : root;
  const message = readOneBotMessage(payloadSource.message) ?? readOneBotMessage(payloadSource.raw_message) ?? "";
  const rendered = renderOneBotMessage(message);
  const userId = positiveInteger(payloadSource.user_id) ?? context.userId ?? 0;
  const attachmentContext: AttachmentExtractionContext = {
    source: context.source ?? "quote",
    messageId: context.messageId ?? positiveInteger(payloadSource.message_id),
    groupId: context.groupId ?? positiveInteger(payloadSource.group_id),
    userId: context.userId ?? positiveInteger(payloadSource.user_id)
  };
  return {
    text: rendered.text,
    media: rendered.imageUrls.map(imageMediaAsset),
    attachments: pendingAttachments(extractOneBotAttachments(message, attachmentContext)),
    replyMessageIds: extractReplyMessageIds(message),
    sender: senderIdentity(record(payloadSource.sender), userId)
  };
}

export async function hydrateOneBotForwardContent(
  incoming: InboundMessageV1,
  event: OneBotEvent,
  loadForward: (messageId: string) => Promise<unknown>
) {
  const message = event.message ?? event.raw_message ?? "";
  const forwardIds = extractOneBotForwardMessageIds(message);
  if (!forwardIds.length) return incoming;
  const forwardPayloads = new Map<string, unknown>();
  await Promise.all(forwardIds.map(async (messageId) => {
    try {
      forwardPayloads.set(messageId, await loadForward(messageId));
    } catch (error) {
      console.error("[onebot] forward message hydration failed", { messageId, error });
    }
  }));
  const rendered = renderOneBotMessage(message, {
    selfId: event.self_id,
    forwardPayloads
  });
  incoming.text = rendered.text;
  incoming.media = rendered.imageUrls.map(imageMediaAsset);
  return incoming;
}

export function extractOneBotSender(payload: unknown, fallbackUserId: number): SenderIdentityV1 {
  const root = record(payload);
  const data = record(root.data);
  return senderIdentity(Object.keys(data).length ? data : root, fallbackUserId);
}

export function extractOneBotReceiptMessageId(payload: unknown) {
  const root = record(payload);
  const data = record(root.data);
  const messageId = positiveInteger(data.message_id ?? root.message_id);
  return messageId == null ? undefined : String(messageId);
}

export function extractOneBotAttachments(
  message: string | OneBotMessageSegment[],
  context: AttachmentExtractionContext = {}
): IncomingAttachment[] {
  const segments = typeof message === "string"
    ? extractCqFileData(message)
    : message.filter((segment) => segment.type === "file").map((segment) => segment.data ?? {});
  const attachments = new Map<string, IncomingAttachment>();

  for (const data of segments) {
    const normalized = normalizeFileSegment(data);
    const dedupeKey = attachmentDedupeKey(normalized);
    const existing = attachments.get(dedupeKey);
    if (existing) {
      attachments.set(dedupeKey, mergeAttachment(existing, normalized));
      continue;
    }
    const attachment: IncomingAttachment = {
      id: stableAttachmentId(dedupeKey, context),
      source: context.source ?? "message",
      name: normalized.name
    };
    if (normalized.fileId) attachment.fileId = normalized.fileId;
    if (normalized.sizeBytes !== undefined) attachment.sizeBytes = normalized.sizeBytes;
    if (normalized.url) attachment.url = normalized.url;
    if (normalized.busId !== undefined) attachment.busId = normalized.busId;
    const groupId = nonNegativeInteger(context.groupId);
    const userId = nonNegativeInteger(context.userId);
    if (groupId !== undefined) attachment.groupId = groupId;
    if (userId !== undefined) attachment.userId = userId;
    attachments.set(dedupeKey, attachment);
  }
  return [...attachments.values()];
}

export function sanitizeAttachmentName(value: unknown) {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .trim();
  if (!cleaned) return DEFAULT_ATTACHMENT_NAME;
  return [...cleaned].slice(0, MAX_ATTACHMENT_NAME_LENGTH).join("");
}

function detectGroupScope(event: OneBotEvent): "user_group" | "bot_group" {
  const subType = String(event.sub_type ?? "");
  const senderRole = String(event.sender?.role ?? "");
  return subType === "bot_group" || senderRole === "bot" ? "bot_group" : "user_group";
}

function isMentioned(message: string | OneBotMessageSegment[], selfId?: number) {
  if (!selfId) return false;
  if (typeof message === "string") {
    for (const match of message.matchAll(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g)) {
      if (match[1] === String(selfId) || match[1] === "all") return true;
    }
    return false;
  }
  return message.some((segment) => segment.type === "at" && [String(selfId), "all"].includes(String(segment.data?.qq ?? "")));
}

function extractReplyMessageIds(message: string | OneBotMessageSegment[]) {
  if (typeof message === "string") {
    const ids: number[] = [];
    for (const match of message.matchAll(/\[CQ:reply,([^\]]+)\]/g)) {
      const id = Number(parseCqParams(match[1] ?? "").id);
      if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    return uniqueNumbers(ids);
  }
  return uniqueNumbers(message.filter((segment) => segment.type === "reply")
    .map((segment) => Number(segment.data?.id)).filter((id) => Number.isInteger(id) && id > 0));
}

function senderIdentity(sender: Record<string, unknown>, fallbackUserId: number): SenderIdentityV1 {
  const id = nonEmptyString(sender.user_id) || String(fallbackUserId || "");
  const nickname = nonEmptyString(sender.nickname);
  const card = nonEmptyString(sender.card);
  const displayName = card || nickname || id;
  return {
    id,
    ...(nickname ? { nickname } : {}),
    ...(card ? { card } : {}),
    ...(displayName ? { displayName } : {})
  };
}

function eventTime(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : new Date().toISOString();
}

function normalizeFileSegment(data: Record<string, unknown>): NormalizedFileSegment {
  const rawFile = normalizedString(data.file);
  const explicitUrl = httpUrl(data.url);
  const fileUrl = httpUrl(rawFile);
  const explicitFileId = safeFileIdentifier(data.file_id);
  const fileId = explicitFileId || (rawFile && !fileUrl ? safeFileIdentifier(rawFile) : undefined);
  const nameSource = normalizedString(data.name) || fileNameFromUrl(fileUrl) || rawFile || explicitFileId;
  return {
    name: sanitizeAttachmentName(nameSource),
    fileId,
    sizeBytes: nonNegativeInteger(data.file_size),
    url: explicitUrl ?? fileUrl,
    busId: nonNegativeInteger(data.busid)
  };
}

function extractCqFileData(message: string) {
  const values: Record<string, unknown>[] = [];
  for (const match of message.matchAll(/\[CQ:file(?:,([^\]]*))?\]/gi)) values.push(parseCqParams(match[1] ?? ""));
  return values;
}

function parseCqParams(input: string) {
  const params: Record<string, string> = {};
  for (const part of input.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (key) params[key] = decodeCqValue(part.slice(separator + 1));
  }
  return params;
}

function decodeCqValue(value: string) {
  return value.replace(/&#44;/g, ",").replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&amp;/g, "&");
}

function attachmentDedupeKey(attachment: NormalizedFileSegment) {
  if (attachment.fileId) return `file:${attachment.fileId}`;
  if (attachment.url) return `url:${attachment.url}`;
  return ["meta", attachment.name, attachment.sizeBytes ?? "", attachment.busId ?? ""].join("\u0000");
}

function stableAttachmentId(dedupeKey: string, context: AttachmentExtractionContext) {
  const identity = [context.source ?? "message", context.messageId ?? "", context.groupId ?? "", context.userId ?? "", dedupeKey].join("\u0000");
  return `attachment_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function mergeAttachment(existing: IncomingAttachment, incoming: NormalizedFileSegment) {
  return { ...existing, fileId: existing.fileId ?? incoming.fileId, sizeBytes: existing.sizeBytes ?? incoming.sizeBytes, url: existing.url ?? incoming.url, busId: existing.busId ?? incoming.busId };
}

function readOneBotMessage(value: unknown): string | OneBotMessageSegment[] | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((item) => typeof record(item).type === "string")) return undefined;
  return value as OneBotMessageSegment[];
}

function normalizedString(value: unknown) {
  const result = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return result || undefined;
}

function safeFileIdentifier(value: unknown) {
  const result = normalizedString(value);
  if (!result || result.length > MAX_FILE_IDENTIFIER_LENGTH || /^(?:data:[^,]*;base64,|base64:\/\/)/i.test(result)) return undefined;
  return result;
}

function nonNegativeInteger(value: unknown) {
  const numberValue = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function nonEmptyString(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function httpUrl(value: unknown) {
  const candidate = normalizedString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function fileNameFromUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1);
    if (!segment) return undefined;
    try { return decodeURIComponent(segment); } catch { return segment; }
  } catch { return undefined; }
}

function uniqueNumbers(values: number[]) { return [...new Set(values)]; }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
