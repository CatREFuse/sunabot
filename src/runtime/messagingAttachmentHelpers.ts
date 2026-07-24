import { nanoid } from "nanoid";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import {
  inboundConversationIdV1,
  inboundMessageIdentityV1
} from "../../packages/contracts/messaging/incomingIdentity.js";
import {
  type MessageDetailsV1,
  type MessagingPort,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import type {
  ParsedAttachment
} from "../../services/media/attachments/types.js";
import {
  type MemoryEntry
} from "../../services/memory/memoryService.js";
import {
  ConversationMessageQuote,
  ConversationRecord,
  ImageResult,
  ParsedIncomingMessage
} from "../types.js";
import { ConversationReplyUpdateInput, HYDRATE_MESSAGE_WINDOW_MS } from "./runtimeContracts.js";

export function restoredGroupIncoming(
  record: ConversationRecord,
  message: ConversationRecord["messages"][number]
): ParsedIncomingMessage | undefined {
  const incoming = restoredConversationIncoming(record, message);
  return incoming?.groupId ? incoming : undefined;
}
export function restoredConversationIncoming(
  record: ConversationRecord,
  message: ConversationRecord["messages"][number]
): ParsedIncomingMessage | undefined {
  if (!message.userId || (record.scope !== "private" && !record.groupId)) return undefined;
  const numericMessageId = Number(message.id);
  return {
    schemaVersion: 1,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.accountId ? { accountId: record.accountId } : {}),
    scope: record.scope,
    ...(Number.isSafeInteger(numericMessageId) && numericMessageId > 0 ? { messageId: numericMessageId } : {}),
    time: message.at,
    userId: message.userId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    selfId: message.selfId ?? record.selfId,
    sender: {
      id: String(message.userId),
      ...(message.senderNickname ?? message.senderName ? { nickname: message.senderNickname ?? message.senderName } : {}),
      ...(message.senderCard ? { card: message.senderCard } : {}),
      ...(message.senderName ? { displayName: message.senderName } : {})
    },
    text: message.text,
    media: (message.imageUrls ?? []).map(imageMediaAsset),
    attachments: message.attachments ?? [],
    replyMessageIds: message.replyMessageIds ?? [],
    quoteReferences: message.quoteReferences ?? [],
    mentionedSelf: false
  };
}
export const WEB_CHAT_CONVERSATION_ID = "web:admin";

export function conversationRecordId(incoming: ParsedIncomingMessage) {
  return inboundConversationIdV1(incoming);
}
export function outboundForIncoming(
  incoming: ParsedIncomingMessage,
  text: string,
  images: ImageResult[] = [],
  replyToMessageId?: number,
  contentSegments?: OutboundMessageV1["contentSegments"],
  mentionUserIds?: readonly number[]
): OutboundMessageV1 {
  return {
    schemaVersion: 1,
    id: nanoid(),
    conversationId: conversationRecordId(incoming),
    ...(incoming.agentId ? { agentId: incoming.agentId } : {}),
    ...(incoming.accountId ? { accountId: incoming.accountId } : {}),
    scope: incoming.scope,
    userId: incoming.userId,
    ...(incoming.groupId ? { groupId: incoming.groupId } : {}),
    text,
    media: images.map(generatedImageMediaAsset).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset)),
    ...(contentSegments?.length ? { contentSegments: contentSegments.map((segment) => ({ ...segment })) } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(mentionUserIds?.length ? { mentionUserIds: [...mentionUserIds] } : {})
  };
}
export function outboundForRecord(record: ConversationRecord, text: string): OutboundMessageV1 {
  return {
    schemaVersion: 1,
    id: nanoid(),
    conversationId: record.id,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.accountId ? { accountId: record.accountId } : {}),
    scope: record.scope,
    userId: record.userId,
    ...(record.groupId ? { groupId: record.groupId } : {}),
    text,
    media: []
  };
}
export function attachmentSourcePort(port: MessagingPort) {
  const candidate = port as MessagingPort & Partial<AttachmentSourcePort>;
  if (typeof candidate.resolveAttachment !== "function" || typeof candidate.resolveAttachmentFallback !== "function") {
    throw new Error("Messaging adapter does not support attachment resolution.");
  }
  return candidate as MessagingPort & AttachmentSourcePort;
}
export function persistentIncomingKey(incoming: ParsedIncomingMessage) {
  return `${incoming.selfId ?? ""}:${conversationRecordId(incoming)}:${inboundMessageIdentityV1(incoming)}`;
}
export function incomingConversationMessageId(incoming: ParsedIncomingMessage) {
  return incoming.messageId == null
    ? inboundMessageIdentityV1(incoming)
    : String(incoming.messageId);
}
export function queueIncomingSnapshot(incoming: ParsedIncomingMessage): ParsedIncomingMessage {
  return {
    ...incoming,
    sender: { ...incoming.sender },
    media: incoming.media.map((asset) => ({ ...asset })),
    attachments: incoming.attachments.map((attachment) => ({ ...attachment })),
    replyMessageIds: [...incoming.replyMessageIds],
    quoteReferences: incoming.quoteReferences.map((quote) => ({
      ...quote,
      media: quote.media?.map((asset) => ({ ...asset })),
      imageUrls: quote.imageUrls ? [...quote.imageUrls] : undefined,
      attachments: quote.attachments?.map((attachment) => ({ ...attachment }))
    }))
  };
}
export function incomingAttachmentReferenceScope(incoming: ParsedIncomingMessage) {
  const messageId = incoming.messageId == null
    ? `event-${incoming.time}`
    : String(incoming.messageId);
  return `${conversationRecordId(incoming)}/${messageId}`;
}
export function conversationReplyEnabled(record: Pick<ConversationRecord, "replyEnabled">) {
  return record.replyEnabled !== false;
}
export function conversationOrchestratorEnabled(record: Pick<ConversationRecord, "orchestratorEnabled"> | undefined) {
  return record?.orchestratorEnabled !== false;
}
export function normalizeConversationOrchestratorResponseTimeMs(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 1_000 && Number(value) <= 3_600_000
    ? Number(value)
    : undefined;
}
export function conversationOrchestratorResponseTimeMs(
  record: Pick<
    ConversationRecord,
    "orchestratorResponseTimeOverrideEnabled" | "orchestratorResponseTimeMs"
  > | undefined,
  defaultResponseTimeMs: number
) {
  if (record?.orchestratorResponseTimeOverrideEnabled === true) {
    const override = normalizeConversationOrchestratorResponseTimeMs(record.orchestratorResponseTimeMs);
    if (override !== undefined) return override;
  }
  return defaultResponseTimeMs;
}
export function conversationDirectorEventsEnabled(
  record: Pick<ConversationRecord, "directorEventsEnabled"> | undefined
) {
  return record?.directorEventsEnabled === true;
}
export function normalizeConversationId(value: unknown) {
  const text = String(value ?? "").trim();
  return /^(?:account:[A-Za-z0-9_-]+:)?(?:private|group):\d+$/.test(text) ? text : "";
}
export function normalizeConversationLookupId(value: unknown) {
  const text = String(value ?? "").trim();
  return text === WEB_CHAT_CONVERSATION_ID ? text : normalizeConversationId(text);
}
export function isWebConversationId(value: unknown) {
  return String(value ?? "").trim() === WEB_CHAT_CONVERSATION_ID;
}
export function conversationDescriptorFromInput(input: ConversationReplyUpdateInput) {
  const id = normalizeConversationId(input.id);
  const parsedId = parseConversationId(id);
  const scope = normalizeConversationScope(input.scope) ?? parsedId?.scope;
  const userId = normalizePositiveInteger(input.userId) || parsedId?.userId || 0;
  const groupId = normalizePositiveInteger(input.groupId) || parsedId?.groupId;
  const title = String(input.title ?? "").trim();
  const accountPrefix = parsedId?.accountId && parsedId.accountId !== "primary"
    ? `account:${parsedId.accountId}:`
    : "";

  if (scope === "private" && userId > 0) {
    return {
      id: `${accountPrefix}private:${userId}`,
      scope,
      title: title || String(userId),
      userId,
      groupId: undefined
    };
  }
  if ((scope === "user_group" || scope === "bot_group") && groupId && groupId > 0) {
    return {
      id: `${accountPrefix}group:${groupId}`,
      scope,
      title: title || String(groupId),
      userId: userId > 0 ? userId : 0,
      groupId
    };
  }

  throw new Error("会话无效。");
}
export function parseConversationId(id: string) {
  const match = id.match(/^(?:account:([A-Za-z0-9_-]+):)?(private|group):(\d+)$/);
  if (!match) return null;
  const accountId = match[1];
  const numberValue = Number(match[3]);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
  if (match[2] === "private") {
    return { scope: "private" as const, userId: numberValue, groupId: undefined, accountId };
  }
  return { scope: "user_group" as const, userId: 0, groupId: numberValue, accountId };
}

export function conversationAccountId(conversationId: string) {
  return parseConversationId(conversationId)?.accountId ?? "primary";
}
export function normalizeConversationScope(value: unknown): ConversationRecord["scope"] | undefined {
  return value === "private" || value === "user_group" || value === "bot_group" ? value : undefined;
}
export function normalizePositiveInteger(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.trunc(numberValue));
}
export function normalizeOutgoingReplyText(text: string) {
  return text
    .replace(/file:\/\/\/?[^\s\]\)]+/g, "")
    .replace(/\/[^\s\]\)]+workspace\/artifacts\/images\/[^\s\]\)]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function matchesMentionName(text: string, name: string) {
  const mentionName = name.trim();
  if (!mentionName) return false;
  return text.toLowerCase().includes(mentionName.toLowerCase());
}
export function isUsableImageUrl(value: string) {
  return /^https?:\/\//i.test(value) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}
export function toConversationQuote(messageId: number, details: MessageDetailsV1): ConversationMessageQuote {
  const imageUrls = details.media.flatMap((asset) => asset.url ? [asset.url] : []);
  return {
    messageId,
    text: details.text || (imageUrls.length ? "[图片]" : details.attachments.length ? "[文件]" : undefined),
    media: details.media,
    imageUrls,
    attachments: details.attachments,
    senderName: details.sender.displayName
  };
}
export function mergeConversationMessageDetails(
  message: ConversationRecord["messages"][number],
  details: MessageDetailsV1,
  imageUrls: string[],
  quoteReferences: ConversationMessageQuote[]
) {
  let changed = false;
  if (details.text && (!message.text.trim() || message.text === "[消息]")) {
    message.text = details.text;
    changed = true;
  }
  if (setOptionalStringArray(message, "imageUrls", imageUrls)) changed = true;
  if (setOptionalString(message, "senderName", details.sender.displayName)) changed = true;
  if (setOptionalString(message, "senderNickname", details.sender.nickname)) changed = true;
  if (setOptionalString(message, "senderCard", details.sender.card)) changed = true;
  if (setOptionalAttachmentArray(message, details.attachments)) changed = true;
  if (setOptionalNumberArray(message, "replyMessageIds", details.replyMessageIds)) changed = true;
  if (setOptionalQuoteArray(message, quoteReferences)) changed = true;
  return changed;
}
export function setOptionalString(
  message: ConversationRecord["messages"][number],
  key: "senderName" | "senderNickname" | "senderCard",
  value: string | undefined
) {
  const next = String(value ?? "").trim();
  if (!next || message[key] === next) return false;
  message[key] = next;
  return true;
}
export function setOptionalStringArray(
  message: ConversationRecord["messages"][number],
  key: "imageUrls",
  values: string[]
) {
  const next = uniqueStrings(values);
  if (!next.length) return false;
  if (arraysEqual(message[key] ?? [], next)) return false;
  message[key] = next;
  return true;
}
export function setOptionalNumberArray(
  message: ConversationRecord["messages"][number],
  key: "replyMessageIds",
  values: number[]
) {
  const next = uniqueNumbers(values);
  if (!next.length) return false;
  if (arraysEqual(message[key] ?? [], next)) return false;
  message[key] = next;
  return true;
}
function uniqueNumbers(values: number[]) {
  return [...new Set(values)];
}
export function setOptionalAttachmentArray(
  message: ConversationRecord["messages"][number],
  values: ParsedAttachment[]
) {
  const next = mergeAttachments(message.attachments ?? [], values).map(sanitizeAttachmentForPersistence);
  if (!next.length) return false;
  if (JSON.stringify(message.attachments ?? []) === JSON.stringify(next)) return false;
  message.attachments = next;
  return true;
}
export function setOptionalQuoteArray(message: ConversationRecord["messages"][number], values: ConversationMessageQuote[]) {
  const next = mergeQuoteReferences(message.quoteReferences ?? [], values);
  if (!next.length) return false;
  if (JSON.stringify(message.quoteReferences ?? []) === JSON.stringify(next)) return false;
  message.quoteReferences = next;
  return true;
}
export function formatQuoteReferencesForContext(references: ConversationMessageQuote[]) {
  return references.map((reference) => {
    const sender = reference.senderName ? `${reference.senderName} ` : "";
    const text = reference.text || (reference.imageUrls?.length ? "[图片]" : reference.attachments?.length ? "[文件]" : "[消息]");
    const files = reference.attachments?.length
      ? ` 文件：${formatAttachmentListForContext(reference.attachments)}`
      : "";
    return `${sender}#${reference.messageId} ${text}${files}`;
  }).join("；");
}
export function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
export function isNumericMessageId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0;
}
export function isRecentMessageForHydration(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= HYDRATE_MESSAGE_WINDOW_MS;
}
export function validTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
export function enrichMemoryEntriesWithConversations(entries: MemoryEntry[], records: ConversationRecord[]) {
  const identities = new Map<string, {
    nickname?: { value: string; at: number };
    cards: Map<number, { card: string; lastSeenAt: string; at: number }>;
  }>();
  for (const record of records) {
    for (const message of record.messages) {
      if (message.role !== "user" || !message.userId) continue;
      const userId = String(message.userId);
      const at = validTimestamp(message.at);
      const identity = identities.get(userId) ?? {
        cards: new Map<number, { card: string; lastSeenAt: string; at: number }>(),
        nickname: undefined
      };
      const nickname = String(message.senderNickname ?? "").trim();
      if (nickname && (!identity.nickname || at >= identity.nickname.at)) {
        identity.nickname = { value: nickname, at };
      }
      const card = String(message.senderCard ?? "").trim();
      if (card && message.groupId) {
        const existing = identity.cards.get(message.groupId);
        if (!existing || at >= existing.at) {
          identity.cards.set(message.groupId, { card, lastSeenAt: message.at, at });
        }
      }
      identities.set(userId, identity);
    }
  }

  return entries.map((entry) => {
    if (!entry.userId) return entry;
    const identity = identities.get(String(entry.userId));
    const userNickname = identity?.nickname?.value || String(entry.userName ?? "").trim() || undefined;
    const groupCards = [...(identity?.cards.entries() ?? [])]
      .map(([groupId, value]) => ({ groupId, card: value.card, lastSeenAt: value.lastSeenAt }))
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) || left.groupId - right.groupId);
    return { ...entry, userNickname, groupCards: groupCards.length ? groupCards : undefined };
  });
}
export function arraysEqual<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
export function uniqueQuotes(values: readonly ConversationMessageQuote[]): ConversationMessageQuote[] {
  return mergeQuoteReferences([], values);
}
export function mergeQuoteReferences(
  current: readonly ConversationMessageQuote[],
  incoming: readonly ConversationMessageQuote[]
) {
  const result = current.map((quote) => ({
    ...quote,
    imageUrls: quote.imageUrls ? uniqueStrings(quote.imageUrls) : undefined,
    attachments: quote.attachments ? uniqueAttachments(quote.attachments) : undefined
  }));
  const indexByMessageId = new Map(result.map((quote, index) => [quote.messageId, index]));
  for (const quote of incoming) {
    const index = indexByMessageId.get(quote.messageId);
    if (index == null) {
      indexByMessageId.set(quote.messageId, result.length);
      result.push({
        ...quote,
        imageUrls: quote.imageUrls ? uniqueStrings(quote.imageUrls) : undefined,
        attachments: quote.attachments ? uniqueAttachments(quote.attachments) : undefined
      });
      continue;
    }
    const existing = result[index]!;
    result[index] = {
      ...existing,
      ...quote,
      text: quote.text || existing.text,
      senderName: quote.senderName || existing.senderName,
      imageUrls: uniqueStrings([...(existing.imageUrls ?? []), ...(quote.imageUrls ?? [])]),
      attachments: mergeAttachments(existing.attachments ?? [], quote.attachments ?? [])
    };
  }
  return result;
}
export function replaceQuoteAttachments(
  quotes: ConversationMessageQuote[],
  attachments: ParsedAttachment[]
) {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return quotes.map((quote) => ({
    ...quote,
    attachments: quote.attachments?.map((attachment) => byId.get(attachment.id) ?? attachment)
  }));
}
export function mergeAttachments(
  current: readonly ParsedAttachment[],
  incoming: readonly ParsedAttachment[]
) {
  const byId = new Map(current.map((attachment) => [attachment.id, attachment]));
  for (const attachment of incoming) {
    const existing = byId.get(attachment.id);
    if (!existing || attachmentStatusRank(attachment.status) >= attachmentStatusRank(existing.status)) {
      byId.set(attachment.id, attachment);
    }
  }
  return [...byId.values()];
}
export function uniqueAttachments(values: readonly ParsedAttachment[]) {
  return mergeAttachments([], values);
}
export function attachmentStatusRank(status: ParsedAttachment["status"]) {
  if (status === "ready") return 5;
  if (status === "partial") return 4;
  if (status === "failed" || status === "too_large" || status === "unsupported") return 3;
  return 1;
}
export function usableAttachments(values: readonly ParsedAttachment[]) {
  return values.filter((attachment) => attachment.status === "ready" || attachment.status === "partial");
}
export function conversationMessageAttachments(message: ConversationRecord["messages"][number]) {
  return uniqueAttachments([
    ...(message.attachments ?? []),
    ...(message.quoteReferences ?? []).flatMap((quote) => quote.attachments ?? [])
  ]);
}
export function sanitizeAttachmentForPersistence(attachment: ParsedAttachment): ParsedAttachment {
  const { url: _temporaryUrl, ...persisted } = attachment;
  return {
    ...persisted,
    fileId: safePersistedFileIdentifier(persisted.fileId),
    textPreview: persistedAttachmentPreview(persisted),
    visualPagePaths: persisted.visualPagePaths?.slice(0, 12)
  };
}
export function persistedAttachmentPreview(attachment: ParsedAttachment) {
  const preview = attachment.textPreview?.slice(0, 2_000);
  if (!preview) return undefined;
  const totalCharacters = attachment.textCharacterCount;
  if (
    !Number.isSafeInteger(totalCharacters) ||
    totalCharacters == null ||
    totalCharacters <= 0 ||
    preview.length < totalCharacters
  ) {
    return preview;
  }
  const partialLength = Math.min(512, Math.floor(totalCharacters / 2));
  return partialLength > 0 ? `${preview.slice(0, partialLength)}…` : undefined;
}
export function safePersistedFileIdentifier(value: string | undefined) {
  const result = value?.trim();
  if (!result || result.length > 2_048) return undefined;
  if (/^(?:data:[^,]*;base64,|base64:\/\/|https?:\/\/|file:)/i.test(result)) return undefined;
  return result;
}
export function persistedAttachments(values: readonly ParsedAttachment[]) {
  return uniqueAttachments(values).map(sanitizeAttachmentForPersistence);
}
export function persistedQuoteReferences(values: readonly ConversationMessageQuote[]) {
  return uniqueQuotes(values).map((quote) => ({
    ...quote,
    attachments: quote.attachments ? persistedAttachments(quote.attachments) : undefined
  }));
}
export function formatAttachmentListForContext(values: readonly ParsedAttachment[]) {
  return values.map((attachment) => `${attachment.name}（${attachmentStatusLabel(attachment.status)}）`).join("、");
}
export function attachmentStatusLabel(status: ParsedAttachment["status"]) {
  if (status === "ready") return "已读取";
  if (status === "partial") return "部分读取";
  if (status === "too_large") return "超过 256 MB";
  if (status === "unsupported") return "格式不支持";
  if (status === "failed") return "读取失败";
  return "处理中";
}
export function normalizeAttachmentLookupText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}
export function selectRelevantConversationAttachments(
  incoming: ParsedIncomingMessage,
  record: ConversationRecord | undefined,
  contextMessageLimit: number,
  query: string,
  contextThroughSequence?: number,
  contextFromSequence?: number
) {
  const direct = uniqueAttachments(incoming.attachments);
  if (record && contextThroughSequence != null && contextFromSequence != null) {
    const windowAttachments = record.messages
      .filter((message) => message.role === "user")
      .filter((message) => (
        incoming.scope === "private" || message.userId === incoming.userId
      ))
      .filter((message) => {
        const sequence = Number(message.sequence ?? 0);
        return Number.isSafeInteger(sequence) &&
          sequence >= contextFromSequence && sequence <= contextThroughSequence;
      })
      .flatMap((message) => usableAttachments(conversationMessageAttachments(message)));
    return uniqueAttachments([...direct, ...windowAttachments]).slice(0, 4);
  }
  if (direct.length) return direct.slice(0, 4);
  if (!record) return [];

  const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
  const recentMessages = record.messages
    .filter((message) => message.role === "user")
    .filter((message) => !currentMessageId || message.id !== currentMessageId)
    .filter((message) => (
      contextThroughSequence == null || Number(message.sequence ?? 0) <= contextThroughSequence
    ))
    .slice(-Math.max(1, contextMessageLimit))
    .reverse();
  const normalizedQuery = normalizeAttachmentLookupText(query);

  for (const message of recentMessages) {
    const matches = usableAttachments(conversationMessageAttachments(message)).filter((attachment) => {
      const fileName = normalizeAttachmentLookupText(attachment.name);
      return Boolean(fileName && normalizedQuery.includes(fileName));
    });
    const mostRecentMatch = matches.at(-1);
    if (mostRecentMatch) return [mostRecentMatch];
  }

  for (const message of recentMessages) {
    const attachments = usableAttachments(conversationMessageAttachments(message));
    if (attachments.length) return uniqueAttachments(attachments).slice(0, 4);
  }
  return [];
}
export function positiveIntegerOrUndefined(value: unknown) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}
export function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
