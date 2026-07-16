import type { ProviderBashOptions } from "../../adapters/model/openaiProvider.js";
import type { MessageLookupContextV1, MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { inboundImageUrls, replaceInboundImageUrls } from "../../packages/contracts/messaging/messages.js";
import { isAdminSender } from "../../services/messaging/replySenderPolicy.js";
import { generateImgMediaHandle, type GenerateImgReferenceContext } from "../../services/tools/generateImgTool.js";
import { getRootDir, resolveProjectPath } from "../config.js";
import type { SunaRuntime } from "../runtime.js";
import type { ChatMessage, ConversationMessageQuote, ParsedIncomingMessage } from "../types.js";
import { clampInteger, estimatePromptTokens, isAdminUserId, toContextChatMessage } from "./conversationMemoryHelpers.js";
import {
  conversationMessageAttachments,
  conversationRecordId,
  selectRelevantConversationAttachments,
  toConversationQuote,
  uniqueAttachments,
  uniqueQuotes,
  uniqueStrings
} from "./messagingAttachmentHelpers.js";
import {
  DEFAULT_CONTEXT_MESSAGE_LIMIT,
  MAX_HISTORY_CONTEXT_IMAGES,
  MAX_STORED_CONVERSATION_MESSAGES,
  RECENT_CONTEXT_TOKEN_BUDGET
} from "./runtimeContracts.js";

type RuntimeHost = SunaRuntime;

export async function runtime_attachReplyReferences(
  this: RuntimeHost,
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
        ...(incoming.accountId ? { accountId: incoming.accountId } : {}),
        source: "quote",
        groupId: incoming.groupId,
        userId: incoming.userId
      });
      imageUrls.push(...details.media.flatMap((asset) => asset.url ? [asset.url] : []));
      incoming.attachments.push(...details.attachments);
      quoteReferences.push(toConversationQuote(messageId, details));
    } catch (error) {
      console.error("[runtime] load replied message failed", { messageId, error });
    }
  }
  replaceInboundImageUrls(incoming, uniqueStrings(imageUrls));
  incoming.attachments = uniqueAttachments(incoming.attachments);
  incoming.quoteReferences = uniqueQuotes(quoteReferences);
}

export async function runtime_loadMessageDetails(
  this: RuntimeHost,
  gateway: MessagingPort,
  messageId: number,
  context: MessageLookupContextV1 = { source: "quote" }
) {
  return gateway.getMessage(messageId, context);
}

export async function runtime_loadQuoteReferences(
  this: RuntimeHost,
  gateway: MessagingPort,
  messageIds: number[],
  context: MessageLookupContextV1 = { source: "quote" }
) {
  const quoteReferences: ConversationMessageQuote[] = [];
  for (const messageId of messageIds.slice(0, 2)) {
    try {
      quoteReferences.push(toConversationQuote(messageId, await this.loadMessageDetails(gateway, messageId, context)));
    } catch (error) {
      console.error("[runtime] load quote reference failed", { messageId, error });
    }
  }
  return uniqueQuotes(quoteReferences);
}

export function runtime_selectRelevantAttachments(
  this: RuntimeHost,
  incoming: ParsedIncomingMessage,
  query: string,
  contextThroughSequence?: number,
  contextFromSequence?: number
) {
  const record = this.conversationRecords.get(conversationRecordId(incoming));
  return selectRelevantConversationAttachments(
    incoming,
    record,
    this.contextMessageLimit(),
    query,
    contextThroughSequence,
    contextFromSequence
  );
}

export async function runtime_refreshAttachmentCacheReferences(this: RuntimeHost) {
  const references: Array<{ cacheKey: string; reference: string }> = [];
  for (const record of this.conversationRecords.values()) {
    for (const message of record.messages.slice(-this.contextMessageLimit())) {
      for (const attachment of conversationMessageAttachments(message)) {
        if (!attachment.cacheKey) continue;
        references.push({ cacheKey: attachment.cacheKey, reference: `${record.id}/${message.id}/${attachment.id}` });
      }
    }
  }
  await this.attachmentService.cache.rebuildReferences(references);
}

export function runtime_buildRecentContextMessages(
  this: RuntimeHost,
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

export function runtime_generateImgReferenceContext(
  this: RuntimeHost,
  incoming: ParsedIncomingMessage,
  captureSequence?: number
): GenerateImgReferenceContext {
  const record = this.conversationRecords.get(conversationRecordId(incoming));
  const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
  const candidates = (record?.messages ?? [])
    .filter((message) => !currentMessageId || message.id !== currentMessageId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => captureSequence == null || Number(message.sequence ?? 0) < captureSequence)
    .slice(-this.contextMessageLimit());
  const mediaByHandle: Record<string, string> = {};
  for (const message of candidates) {
    for (const [index, imageUrl] of (message.imageUrls ?? []).slice(0, 4).entries()) {
      if (imageUrl) mediaByHandle[generateImgMediaHandle(message.id, index)] = imageUrl;
    }
  }
  const sameUserLatestFirst = [...candidates]
    .reverse()
    .filter((message) => String(message.userId ?? "") === String(incoming.userId));
  const previousOutput = sameUserLatestFirst
    .find((message) => message.role === "assistant" && Boolean(message.imageUrls?.length));
  return {
    currentImageUrls: inboundImageUrls(incoming).slice(0, 4),
    previousOutputImageUrls: uniqueStrings(previousOutput?.imageUrls ?? []).slice(0, 4),
    historyImageUrls: uniqueStrings(sameUserLatestFirst.flatMap((message) => message.imageUrls ?? [])).slice(0, 4),
    mediaByHandle
  };
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
  if ((this.config.bot.quoteGroupReplyExcludedUserIds ?? []).includes(String(incoming.userId))) return {};
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
  return isAdminSender(userId, this.config.bot.adminQq);
}
