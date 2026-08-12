import type { MediaAssetRefV1, ParsedAttachment } from "../media/media.js";
import { imageMediaAsset } from "../media/media.js";

export type MessageScopeV1 = "private" | "user_group" | "bot_group";

export interface MessagingConnectionContextV1 {
  accountId: string;
  selfId?: string;
}

export interface SenderIdentityV1 {
  id: string;
  nickname?: string;
  card?: string;
  displayName?: string;
}

export interface MessageQuoteV1 {
  messageId: number;
  text?: string;
  media?: MediaAssetRefV1[];
  imageUrls?: string[];
  attachments?: ParsedAttachment[];
  senderName?: string;
}

export interface InboundMessageV1 {
  schemaVersion: 1;
  transport?: "onebot" | "web";
  agentId?: string;
  accountId?: string;
  scope: MessageScopeV1;
  messageId?: number;
  time: string;
  userId: number;
  groupId?: number;
  selfId?: number;
  sender: SenderIdentityV1;
  text: string;
  media: MediaAssetRefV1[];
  attachments: ParsedAttachment[];
  replyMessageIds: number[];
  quoteReferences: MessageQuoteV1[];
  mentionedSelf: boolean;
}

export type OutboundContentSegmentV1 =
  | { type: "text"; text: string }
  | { type: "image"; imageIndex: number }
  | { type: "sticker"; imageIndex: number };

export interface OutboundMessageV1 {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  agentId?: string;
  accountId?: string;
  scope: MessageScopeV1;
  userId: number;
  groupId?: number;
  text: string;
  media: MediaAssetRefV1[];
  contentSegments?: OutboundContentSegmentV1[];
  replyToMessageId?: number;
  mentionUserIds?: number[];
  idempotencyKey?: string;
}

export interface MessagingStatusV1 {
  connected: boolean;
  connections: number;
  selfIds: string[];
  accounts?: Array<{ accountId: string; selfId?: string; connectedAt: string }>;
  connectedAt?: string;
  lastEventAt?: string;
  lastMessageEventAt?: string;
}

export interface MessagingReceiptV1 {
  accepted: true;
  messageId?: string;
}

export type OutboundConversationAssetKindV1 = "file" | "image" | "voice";

export const MAX_OUTBOUND_CONVERSATION_ASSET_INLINE_BYTES = 32 * 1024 * 1024;

export interface PreparedOutboundConversationAssetV1 {
  kind: OutboundConversationAssetKindV1;
  name: string;
  source: string;
  byteLength: number;
  sha256?: string;
  mimeType?: string;
}

export interface OutboundConversationAssetV1 {
  accountId?: string;
  scope: MessageScopeV1;
  userId: number;
  groupId?: number;
  asset: PreparedOutboundConversationAssetV1;
}

export interface PokeTargetV1 {
  accountId?: string;
  userId: number;
  groupId?: number;
}

export interface SenderLookupV1 {
  accountId?: string;
  userId: number;
  groupId?: number;
  current?: SenderIdentityV1;
}

export interface MessageLookupContextV1 {
  accountId?: string;
  source?: "message" | "quote" | "group_upload";
  groupId?: number;
  userId?: number;
}

export interface MessageDetailsV1 {
  text: string;
  media: MediaAssetRefV1[];
  attachments: ParsedAttachment[];
  replyMessageIds: number[];
  sender: SenderIdentityV1;
}

export interface ContactIdentityV1 {
  userId: number;
  nickname: string;
  remark: string;
}

export interface GroupIdentityV1 {
  groupId: number;
  groupName: string;
}

export interface ConversationDirectorySnapshotV1 {
  friendsReady: boolean;
  groupsReady: boolean;
  friends: ContactIdentityV1[];
  groups: GroupIdentityV1[];
}

export interface ConversationDirectoryPort {
  conversationDirectoryGeneration(accountId?: string): string;
  loadConversationDirectory(accountId?: string): Promise<ConversationDirectorySnapshotV1>;
}

export interface ConversationIdentityMessage {
  role: "user" | "assistant" | "event";
  userId?: number;
  senderName?: string;
  senderNickname?: string;
}

export interface ConversationRecord {
  id: string;
  accountId?: string;
  groupId?: number;
  userId: number;
  title: string;
  lastAt: string;
  messages: readonly ConversationIdentityMessage[];
}

export interface MessagingPort {
  getStatus(): MessagingStatusV1;
  send(message: OutboundMessageV1): Promise<MessagingReceiptV1>;
  sendConversationAsset?(message: OutboundConversationAssetV1): Promise<MessagingReceiptV1>;
  poke?(target: PokeTargetV1): Promise<MessagingReceiptV1>;
  resolveSender(input: SenderLookupV1): Promise<SenderIdentityV1>;
  getMessage(messageId: number, context?: MessageLookupContextV1): Promise<MessageDetailsV1>;
}

export type OutboundBubbleV1 =
  | { schemaVersion: 1; type: "message"; message: OutboundMessageV1 }
  | { schemaVersion: 1; type: "asset"; asset: OutboundConversationAssetV1 };

export function outboundMessageBubble(message: OutboundMessageV1): OutboundBubbleV1 {
  return { schemaVersion: 1, type: "message", message };
}

export function outboundAssetBubble(asset: OutboundConversationAssetV1): OutboundBubbleV1 {
  return { schemaVersion: 1, type: "asset", asset };
}

export function sendOutboundBubble(port: MessagingPort, bubble: OutboundBubbleV1) {
  if (bubble.schemaVersion !== 1) throw contractError("contract_version_unsupported", "不支持的出站气泡版本。");
  if (bubble.type === "message") return port.send(bubble.message);
  if (!port.sendConversationAsset) throw contractError("contract_capability_unavailable", "当前消息适配器不支持资源气泡。");
  return port.sendConversationAsset(bubble.asset);
}

export function inboundImageUrls(message: Pick<InboundMessageV1, "media">) {
  if (Array.isArray(message.media)) return message.media.flatMap((asset) => asset.url ? [asset.url] : []);
  const legacy = (message as unknown as { imageUrls?: unknown }).imageUrls;
  return Array.isArray(legacy) ? legacy.filter((value): value is string => typeof value === "string") : [];
}

export function inboundImageAltTexts(message: Pick<InboundMessageV1, "media">) {
  return Array.isArray(message.media)
    ? message.media.flatMap((asset) => asset.url ? [asset.altText?.trim() ?? ""] : [])
    : [];
}

export function replaceInboundImageUrls(
  message: InboundMessageV1,
  urls: readonly string[],
  altTexts: readonly string[] = inboundImageAltTexts(message)
) {
  const byUrl = new Map<string, string>();
  urls.forEach((url, index) => {
    const normalized = url.trim();
    if (normalized && !byUrl.has(normalized)) byUrl.set(normalized, altTexts[index]?.trim() ?? "");
  });
  message.media = [...byUrl].map(([url, altText]) => imageMediaAsset(url, altText));
}

export function decodeInboundMessageV1(value: unknown): InboundMessageV1 {
  const input = record(value);
  if (input.schemaVersion != null && input.schemaVersion !== 1) {
    throw contractError("contract_version_unsupported", `不支持的入站消息版本：${String(input.schemaVersion)}`);
  }

  const legacyEvent = record(input.event);
  const scope = messageScope(input.scope);
  const userId = positiveInteger(input.userId ?? legacyEvent.user_id);
  if (!scope || !userId) throw contractError("contract_field_invalid", "入站消息 scope 或 userId 无效。");

  const senderSource = record(input.sender);
  const legacySender = record(legacyEvent.sender);
  const sender = normalizeSender(
    Object.keys(senderSource).length ? senderSource : legacySender,
    userId
  );
  const media = Array.isArray(input.media)
    ? input.media.map(normalizeMediaAsset).filter((asset): asset is MediaAssetRefV1 => Boolean(asset))
    : stringArray(input.imageUrls).map((url) => imageMediaAsset(url));

  return {
    schemaVersion: 1,
    ...(input.transport === "web" ? { transport: "web" as const } : {}),
    ...(typeof input.agentId === "string" && input.agentId.trim() ? { agentId: input.agentId.trim() } : {}),
    ...(typeof input.accountId === "string" && input.accountId.trim() ? { accountId: input.accountId.trim() } : {}),
    scope,
    ...(positiveInteger(input.messageId ?? legacyEvent.message_id) ? {
      messageId: positiveInteger(input.messageId ?? legacyEvent.message_id)
    } : {}),
    time: normalizedTime(input.time ?? legacyEvent.time),
    userId,
    ...(positiveInteger(input.groupId ?? legacyEvent.group_id) ? {
      groupId: positiveInteger(input.groupId ?? legacyEvent.group_id)
    } : {}),
    ...(positiveInteger(input.selfId ?? legacyEvent.self_id) ? {
      selfId: positiveInteger(input.selfId ?? legacyEvent.self_id)
    } : {}),
    sender,
    text: String(input.text ?? ""),
    media,
    attachments: arrayOfRecords(input.attachments) as unknown as ParsedAttachment[],
    replyMessageIds: positiveIntegers(input.replyMessageIds),
    quoteReferences: normalizeQuotes(input.quoteReferences),
    mentionedSelf: input.mentionedSelf === true
  };
}

function normalizeQuotes(value: unknown): MessageQuoteV1[] {
  return arrayOfRecords(value).flatMap((quote) => {
    const messageId = positiveInteger(quote.messageId);
    if (!messageId) return [];
    const imageUrls = stringArray(quote.imageUrls);
    const media = Array.isArray(quote.media)
      ? quote.media.map(normalizeMediaAsset).filter((asset): asset is MediaAssetRefV1 => Boolean(asset))
      : imageUrls.map((url) => imageMediaAsset(url));
    return [{
      messageId,
      ...(typeof quote.text === "string" ? { text: quote.text } : {}),
      ...(media.length ? { media, imageUrls: media.flatMap((asset) => asset.url ? [asset.url] : []) } : {}),
      ...(Array.isArray(quote.attachments) ? {
        attachments: arrayOfRecords(quote.attachments) as unknown as ParsedAttachment[]
      } : {}),
      ...(typeof quote.senderName === "string" && quote.senderName.trim() ? { senderName: quote.senderName.trim() } : {})
    }];
  });
}

function normalizeMediaAsset(value: unknown): MediaAssetRefV1 | undefined {
  const asset = record(value);
  if (asset.schemaVersion !== 1 || asset.kind !== "image") return undefined;
  if (asset.source === "shared_file" && typeof asset.filePath === "string" && asset.filePath.trim()) {
    return {
      schemaVersion: 1,
      kind: "image",
      source: "shared_file",
      filePath: asset.filePath,
      ...(typeof asset.url === "string" && asset.url.trim() ? { url: asset.url } : {}),
      ...(typeof asset.altText === "string" && asset.altText.trim() ? { altText: asset.altText.trim() } : {})
    };
  }
  if ((asset.source === "remote_url" || asset.source === "inline_data") && typeof asset.url === "string" && asset.url.trim()) {
    return {
      schemaVersion: 1,
      kind: "image",
      source: asset.source,
      url: asset.url,
      ...(typeof asset.altText === "string" && asset.altText.trim() ? { altText: asset.altText.trim() } : {})
    };
  }
  return undefined;
}

function normalizeSender(value: Record<string, unknown>, fallbackUserId: number): SenderIdentityV1 {
  const id = nonEmptyString(value.id ?? value.user_id) || String(fallbackUserId);
  const nickname = nonEmptyString(value.nickname);
  const card = nonEmptyString(value.card);
  const displayName = nonEmptyString(value.displayName) || card || nickname || id;
  return {
    id,
    ...(nickname ? { nickname } : {}),
    ...(card ? { card } : {}),
    ...(displayName ? { displayName } : {})
  };
}

function messageScope(value: unknown): MessageScopeV1 | undefined {
  return value === "private" || value === "user_group" || value === "bot_group" ? value : undefined;
}

function normalizedTime(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function positiveIntegers(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(positiveInteger).filter((item): item is number => Boolean(item)))]
    : [];
}

function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length) : [];
}

function nonEmptyString(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contractError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
