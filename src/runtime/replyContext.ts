import type { ProviderBashOptions } from "../../adapters/model/openaiProvider.js";
import type { MessageLookupContextV1, MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { AttachmentService } from "../../services/media/attachments/service.js";
import { inboundImageUrls, replaceInboundImageUrls } from "../../packages/contracts/messaging/messages.js";
import { isAdminSender, isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import { generateImgMediaHandle, type GenerateImgReferenceContext } from "../../services/tools/generateImgTool.js";
import {
  extractConfirmedBashApprovalId,
  type BashExecutionBackend
} from "../../services/tools/bashAudit.js";
import type { RuntimeToolCapabilityResolver } from "../../services/tools/bashCapability.js";
import type { WorkspaceBashRuntimePort } from "../../services/tools/bashRuntime.js";
import { resolveProjectPath } from "../config.js";
import type { AppConfig, ChatMessage, ConversationMessageQuote, ConversationRecord, ParsedIncomingMessage } from "../types.js";
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
  RECENT_CONTEXT_TOKEN_BUDGET,
  type AdminIdentity,
  type RuntimeBashAuditPort,
  type RuntimeConfigPort
} from "./runtimeContracts.js";

interface RuntimeReplyContextHost extends RuntimeConfigPort {
  readonly configEpoch: number;
  readonly conversationRecords: ReadonlyMap<string, ConversationRecord>;
  readonly attachmentService: Pick<AttachmentService, "cache">;
  readonly bashAudit?: RuntimeBashAuditPort;
  readonly bashRuntime?: WorkspaceBashRuntimePort;
  adminIdentity(): AdminIdentity;
  contextMessageLimit(): number;
  loadMessageDetails(
    gateway: MessagingPort,
    messageId: number,
    context?: MessageLookupContextV1
  ): ReturnType<MessagingPort["getMessage"]>;
}

type RuntimeHost = RuntimeReplyContextHost;

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
  captureSequence?: number,
  currentBatchFromSequence?: number
): GenerateImgReferenceContext {
  const record = this.conversationRecords.get(conversationRecordId(incoming));
  const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
  const candidates = (record?.messages ?? [])
    .filter((message) => !currentMessageId || message.id !== currentMessageId)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => captureSequence == null || Number(message.sequence ?? 0) < captureSequence)
    .filter((message) => (
      currentBatchFromSequence == null ||
      Number(message.sequence ?? 0) < currentBatchFromSequence ||
      incoming.scope === "private" ||
      message.userId === incoming.userId
    ))
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

export async function runtime_resolveProviderBashHandle(
  this: RuntimeHost,
  incoming: ParsedIncomingMessage,
  promptOverride: string | undefined,
  capabilityResolver?: RuntimeToolCapabilityResolver,
  backend: BashExecutionBackend = "docker"
): Promise<ProviderBashOptions | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const epoch = this.configEpoch;
    const config = deepFreeze(structuredClone(this.config));
    const auditPort = this.bashAudit;
    const candidate = resolveProviderBashCandidate(config, incoming, promptOverride, backend);
    if (!candidate || !auditPort || !capabilityResolver) return undefined;

    let auditAvailable = false;
    try {
      auditAvailable = await auditPort.available(config) === true;
    } catch {
      if (this.configEpoch !== epoch) continue;
      return undefined;
    }
    if (this.configEpoch !== epoch) continue;
    if (!auditAvailable) return undefined;

    let capabilityAvailable = false;
    try {
      const capabilities = await capabilityResolver({
        workspacePath: candidate.workspacePath,
        workspaceBashBackend: candidate.backend,
        workspaceBashAuditAvailable: true
      });
      capabilityAvailable = capabilities.workspaceBash === true;
    } catch {
      if (this.configEpoch !== epoch) continue;
      return undefined;
    }
    if (this.configEpoch !== epoch) continue;
    if (!capabilityAvailable) return undefined;

    const handle = Object.freeze({
      enabled: true as const,
      workspacePath: candidate.workspacePath,
      backend: candidate.backend,
      accessMode: candidate.accessMode,
      strictMode: candidate.strictMode,
      isAdmin: candidate.isAdmin,
      userRequest: candidate.userRequest,
      approvalContext: candidate.approvalContext,
      isCurrent: () => this.configEpoch === epoch,
      audit: async (input: Parameters<ProviderBashOptions["audit"]>[0]) => {
        if (this.configEpoch !== epoch) throw new Error("BASH_AUDIT_UNAVAILABLE");
        const result = await auditPort.run(config, {
          ...input,
          isAdmin: candidate.isAdmin,
          userRequest: candidate.userRequest
        });
        if (this.configEpoch !== epoch) throw new Error("BASH_AUDIT_UNAVAILABLE");
        return result;
      },
      ...(this.bashRuntime ? { runtime: this.bashRuntime } : {}),
      ...(candidate.confirmedApprovalId ? { confirmedApprovalId: candidate.confirmedApprovalId } : {})
    });
    if (this.configEpoch !== epoch) continue;
    return handle;
  }
  return undefined;
}

function resolveProviderBashCandidate(
  config: Readonly<AppConfig>,
  incoming: ParsedIncomingMessage,
  promptOverride: string | undefined,
  backend: BashExecutionBackend
) {
  const bash = config.bot.bash;
  const senderId = incoming.sender?.id?.trim();
  const administrator = isAdminSender(incoming.userId, config.bot.adminQq.trim());
  const privateConversation = incoming.scope === "private" && incoming.groupId === undefined;
  const groupConversation = (incoming.scope === "user_group" || incoming.scope === "bot_group")
    && Number.isSafeInteger(incoming.groupId)
    && Number(incoming.groupId) > 0;
  const webAdministratorPrivate = incoming.transport === "web"
    && administrator
    && privateConversation;
  const oneBotConversation = incoming.transport === undefined
    && Boolean(incoming.accountId?.trim())
    && Number.isSafeInteger(incoming.messageId)
    && Number(incoming.messageId) > 0
    && Number.isSafeInteger(incoming.selfId)
    && Number(incoming.selfId) > 0
    && (privateConversation || groupConversation);
  if (
    !bash.enabled
    || promptOverride !== undefined
    || (!webAdministratorPrivate && incoming.agentId !== config.persona.defaultAgentId)
    || (webAdministratorPrivate && incoming.agentId !== undefined
      && incoming.agentId !== config.persona.defaultAgentId)
    || !isReplySenderAllowed(incoming.userId)
    || senderId !== String(incoming.userId)
    || (!webAdministratorPrivate && !oneBotConversation)
    || (backend === "native" && !(webAdministratorPrivate || (administrator && privateConversation)))
  ) return undefined;

  const workspacePath = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspacePath) return undefined;
  const accountId = webAdministratorPrivate ? "web-admin" : incoming.accountId!.trim();

  const approvalContext = Object.freeze({
    backend,
    agentId: config.persona.defaultAgentId,
    accountId,
    transport: webAdministratorPrivate ? "web" : "onebot",
    conversationId: conversationRecordId(incoming),
    userId: String(incoming.userId),
    ...(groupConversation ? { groupId: String(incoming.groupId) } : {})
  });
  const confirmedApprovalId = extractConfirmedBashApprovalId(incoming.text);
  return Object.freeze({
    workspacePath,
    backend,
    accessMode: backend === "native" ? "admin" as const : "isolated" as const,
    strictMode: bash.strictMode,
    isAdmin: administrator,
    userRequest: incoming.text,
    approvalContext,
    ...(confirmedApprovalId ? { confirmedApprovalId } : {})
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function runtime_isAdminUser(this: RuntimeHost, userId: number) {
  return isAdminSender(userId, this.config.bot.adminQq);
}
