import { createHash } from "node:crypto";
import type { OneBotMessageSegment } from "../../../src/types.js";
import type { AttachmentExtractionContext, IncomingAttachment } from "./types.js";

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

export function extractOneBotAttachments(
  message: string | OneBotMessageSegment[],
  context: AttachmentExtractionContext = {}
): IncomingAttachment[] {
  const segments = typeof message === "string"
    ? extractCqFileData(message)
    : message
      .filter((segment) => segment.type === "file")
      .map((segment) => segment.data ?? {});
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
  for (const match of message.matchAll(/\[CQ:file(?:,([^\]]*))?\]/gi)) {
    values.push(parseCqParams(match[1] ?? ""));
  }
  return values;
}

function parseCqParams(input: string) {
  const params: Record<string, unknown> = {};
  for (const part of input.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (!key) continue;
    params[key] = decodeCqValue(part.slice(separator + 1));
  }
  return params;
}

function decodeCqValue(value: string) {
  return value
    .replace(/&#44;/g, ",")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&amp;/g, "&");
}

function attachmentDedupeKey(attachment: NormalizedFileSegment) {
  if (attachment.fileId) return `file:${attachment.fileId}`;
  if (attachment.url) return `url:${attachment.url}`;
  return [
    "meta",
    attachment.name,
    attachment.sizeBytes ?? "",
    attachment.busId ?? ""
  ].join("\u0000");
}

function stableAttachmentId(dedupeKey: string, context: AttachmentExtractionContext) {
  const identity = [
    context.source ?? "message",
    context.messageId == null ? "" : String(context.messageId),
    context.groupId == null ? "" : String(context.groupId),
    context.userId == null ? "" : String(context.userId),
    dedupeKey
  ].join("\u0000");
  return `attachment_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function mergeAttachment(existing: IncomingAttachment, incoming: NormalizedFileSegment) {
  return {
    ...existing,
    fileId: existing.fileId ?? incoming.fileId,
    sizeBytes: existing.sizeBytes ?? incoming.sizeBytes,
    url: existing.url ?? incoming.url,
    busId: existing.busId ?? incoming.busId
  };
}

function normalizedString(value: unknown) {
  const result = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return result || undefined;
}

function safeFileIdentifier(value: unknown) {
  const result = normalizedString(value);
  if (!result || result.length > MAX_FILE_IDENTIFIER_LENGTH) return undefined;
  if (/^(?:data:[^,]*;base64,|base64:\/\/)/i.test(result)) return undefined;
  return result;
}

function nonNegativeInteger(value: unknown) {
  const numberValue = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) return undefined;
  return numberValue;
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
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  } catch {
    return undefined;
  }
}
