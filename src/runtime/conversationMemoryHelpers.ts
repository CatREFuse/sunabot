import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
  ChatMessage,
  ConversationMessageQuote,
  ConversationRecord,
  ImageResult,
  ParsedIncomingMessage,
  ReasoningEffort
} from "../types.js";
import { resolveModelReasoningEffort } from "../admin/models.js";
import { AttachmentService } from "../../services/media/attachments/service.js";
import type {
  AttachmentExtractionContext,
  ParsedAttachment
} from "../../services/media/attachments/types.js";
import { CommandRouter, type CommandMatch } from "../../services/messaging/commandRouter.js";
import { isAdminSender, isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import { getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "../config.js";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeToolCompletion,
  incomingReplyEnvelope,
  type AssistantReplyOutboxEnvelope,
  type AssistantReplyOutboxPayload,
  type AsyncToolCompletionPayload,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import { applicationDataStore, sqliteMemoryPersistence } from "../../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import {
  ReplyGateEpochs,
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute,
  type ReplyGateSnapshot
} from "../../services/orchestration/groupReplyPolicy.js";
import { HookBus } from "../../services/messaging/hookBus.js";
import {
  applyMemoryBatchTransaction,
  ensureAgentTextFile,
  formatMemoryMatchesForPrompt,
  isMemoryBatchCommitted,
  mergeUserProfileMemory,
  normalizeEventMemorySchema,
  readAgentTextFile,
  readMemorySourceEntries,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  recallMemory,
  recoverMemoryTransactions,
  replaceWorkingMemoryFacts,
  resolveUserAddressName,
  type MemoryEntry,
  type MemoryFactInput
} from "../../services/memory/memoryService.js";
import {
  MemorySchedulerStore,
  type MemoryClaim,
  type MemoryQueuedMessage
} from "../../services/memory/memoryScheduler.js";
import {
  OpenAIProvider,
  type ProviderBashOptions,
  type ProviderCompleteOptions,
  type ProviderDeferredTurn
} from "../../adapters/model/openaiProvider.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import {
  inboundImageUrls,
  replaceInboundImageUrls,
  type MessageDetailsV1,
  type MessagingPort,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import { loadPersona, AgentPersona } from "../../services/agent/persona.js";
import { appendRequestLog } from "../requestLog.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { generateImgMediaHandle } from "../../services/tools/generateImgTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../../services/agent/persona.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { conversationRecordId, escapeRegExp, formatAttachmentListForContext, formatQuoteReferencesForContext, matchesMentionName, readRecord, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { conversationLastText, conversationTitle } from "./selfieHelpers.js";
import {
  hasForbiddenMemoryRecallPhrase,
  hasInvalidQqIdentity,
  hasMemoryIdentity,
  hasOnlyTrustedMemoryIdentityMarkers,
  hasUntrustedMemoryQq,
  isRoleFirstPersonMemory,
  isRoleFirstPersonProfile,
  normalizeQqId,
  normalizeQqIds,
  replaceReportedMemoryIdentity,
  resolveFactUsers,
  trustedParticipantName
} from "./conversationMemoryIdentity.js";

export { normalizeQqId, normalizeQqIds, resolveFactUsers } from "./conversationMemoryIdentity.js";

export function resolveRuntimePersonaName(personaName: string | undefined, configuredName: string | undefined) {
  return personaName?.trim() || configuredName?.trim() || "助手";
}

export function estimatePromptTokens(text: string) {
  let tokens = 0;
  for (const character of text) {
    if (/^[\x00-\x7F]$/.test(character)) {
      tokens += /\s/.test(character) ? 0.25 : 0.5;
    } else {
      tokens += 1;
    }
  }
  return Math.ceil(tokens);
}
export function isExplicitWakeMessage(text: string, commandPrefixes: string[], mentionNames: string[]) {
  const trimmed = text.trim();
  return commandPrefixes.some((prefix) => prefix && trimmed.startsWith(prefix)) ||
    mentionNames.some((name) => name && matchesMentionName(trimmed, name));
}
export function hasIncomingReplyContent(incoming: ParsedIncomingMessage) {
  return Boolean(
    incoming.text.trim() ||
    inboundImageUrls(incoming).length ||
    incoming.attachments.length ||
    incoming.mentionedSelf
  );
}
export function collectGroupChatSummaryMessages(
  record: ConversationRecord | undefined,
  incoming: ParsedIncomingMessage,
  contextThroughSequence?: number
) {
  if (!record) return [];
  const now = Date.now();
  const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
  return record.messages
    .filter((message) => message.id !== currentMessageId)
    .filter((message) => (
      contextThroughSequence == null || (
        Number.isSafeInteger(message.sequence) &&
        Number(message.sequence) <= contextThroughSequence
      )
    ))
    .filter((message) => {
      const at = Date.parse(message.at);
      return Number.isFinite(at) && now - at <= GROUP_CHAT_SUMMARY_WINDOW_MS;
    })
    .filter((message) => message.role === "user" || message.role === "assistant")
    .flatMap((message) => {
      const text = groupSummaryMessageText(message);
      if (!text) return [];
      return [{
        sequence: message.sequence,
        at: message.at,
        role: message.role,
        userId: message.userId,
        senderName: message.role === "assistant"
          ? resolveRuntimePersonaName(message.senderName, undefined)
          : message.senderName,
        text
      }];
    });
}
export function groupSummaryMessageText(message: ConversationRecord["messages"][number]) {
  const text = stripImageTokens(message.text);
  const quotes = (message.quoteReferences ?? [])
    .map((quote) => {
      const quoteText = stripImageTokens(quote.text ?? "");
      if (!quoteText) return "";
      const sender = quote.senderName ? `${quote.senderName} ` : "";
      return `${sender}#${quote.messageId} ${quoteText}`;
    })
    .filter(Boolean);
  if (text && quotes.length) return `${text} 引用：${quotes.join("；")}`;
  if (text) return text;
  if (quotes.length) return `引用：${quotes.join("；")}`;
  return "";
}
export function stripImageTokens(text: string) {
  return text
    .replace(/\[图片\]/g, "")
    .replace(/\[消息\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function collectBatchUsers(
  batch: Array<{ sequence: number; message: ConversationRecord["messages"][number] }>,
  admin: AdminIdentity
) {
  const users = new Map<string, BatchUserInfo>();
  for (const { message } of batch) {
    if (message.role !== "user" || message.userId == null) continue;
    const userId = String(message.userId);
    const existing = users.get(userId);
    const currentName = normalizeParticipantName(message.senderName, userId) || existing?.currentName || "";
    const names = uniqueStrings([...(existing?.names ?? []), currentName].filter(Boolean));
    const isAdmin = isAdminUserId(userId, admin);
    users.set(userId, {
      userId,
      names,
      currentName,
      addressName: isAdmin ? admin.name : currentName || userId,
      isAdmin
    });
  }
  return [...users.values()];
}
export function formatIncomingUserLabel(incoming: ParsedIncomingMessage, admin: AdminIdentity) {
  const userId = String(incoming.userId);
  if (isAdminUserId(userId, admin)) return `${admin.name}(${admin.userId})`;
  const name = normalizeParticipantName(senderDisplayName(incoming.sender), userId);
  return name ? `${name}(${userId})` : userId;
}
export function buildUserProfileRecallQuery(incoming: ParsedIncomingMessage, text: string, admin: AdminIdentity) {
  const userId = String(incoming.userId);
  const name = normalizeParticipantName(senderDisplayName(incoming.sender), userId);
  return [userId, name, isAdminUserId(userId, admin) ? admin.name : "", text].filter(Boolean).join(" ");
}
export function buildWorkingMemoryRecallQuery(incoming: ParsedIncomingMessage, text: string) {
  return [
    conversationRecordId(incoming),
    incoming.groupId == null ? "" : String(incoming.groupId),
    String(incoming.userId),
    conversationTitle(incoming),
    text
  ].filter(Boolean).join(" ");
}
export function formatBatchUserLabel(user: BatchUserInfo) {
  return `QQ ${user.userId}（${user.addressName}）`;
}
export function isMemoryEntryRelatedToUsers(entry: MemoryEntry, userIds: Set<string>) {
  if (entry.userId && userIds.has(entry.userId)) return true;
  if (entry.userIds?.some((userId) => userIds.has(userId))) return true;
  return [...userIds].some((userId) => entry.text.includes(userId));
}
export function normalizeParticipantName(value: unknown, userId: string) {
  const name = String(value ?? "").trim();
  return name && name !== userId ? name : "";
}
export function buildUserPrompt(
  incoming: ParsedIncomingMessage,
  text: string,
  isAdmin: boolean,
  admin: AdminIdentity,
  attachmentContext = ""
) {
  const boundedAttachmentContext = truncateToEstimatedTokens(attachmentContext, 5_120);
  const currentTextBudget = Math.max(1_024, 6_144 - estimatePromptTokens(boundedAttachmentContext));
  const boundedText = truncateToEstimatedTokens(text, currentTextBudget);
  const scopeName = incoming.scope === "private" ? "私聊" : incoming.scope === "user_group" ? "用户群聊" : "bot群聊";
  const groupLine = incoming.groupId ? `群号：${incoming.groupId}\n` : "";
  const roleLine = isAdmin ? `角色：管理员；称呼：${admin.name}\n` : "";
  const imageCount = inboundImageUrls(incoming).length;
  const imageLine = imageCount ? `图片：${imageCount} 张，可作为生图参考图\n` : "";
  const quoteLine = incoming.quoteReferences.length ? `引用：${formatQuoteReferencesForContext(incoming.quoteReferences)}\n` : "";
  const attachmentLine = boundedAttachmentContext ? `文件内容：\n${boundedAttachmentContext}\n` : "";
  return `消息场景：${scopeName}\n${groupLine}用户：${formatIncomingUserLabel(incoming, admin)}\n${roleLine}${imageLine}${quoteLine}${attachmentLine}内容：${boundedText}`;
}

export function buildMemoryPromptVariables(input: {
  working: MemoryEntry[];
  longTerm: MemoryEntry[];
  userProfile: MemoryEntry[];
}) {
  return {
    "memory.working": formatPromptMemory(input.working),
    "memory.long_term": formatPromptMemory(input.longTerm),
    "memory.user_profile": formatPromptMemory(input.userProfile)
  };
}

function formatPromptMemory(entries: MemoryEntry[]) {
  return truncateToEstimatedTokens(formatMemoryMatchesForPrompt(entries), 2_048);
}
export function truncateToEstimatedTokens(text: string, budget: number) {
  if (!text || estimatePromptTokens(text) <= budget) return text;
  let used = 0;
  let output = "";
  for (const character of text) {
    const cost = /^[\x00-\x7F]$/.test(character) ? (/\s/.test(character) ? 0.25 : 0.5) : 1;
    if (Math.ceil(used + cost) > budget) break;
    output += character;
    used += cost;
  }
  return `${output.trimEnd()}\n[内容已截断]`;
}
export function toContextChatMessage(message: ConversationRecord["messages"][number], isAdmin: boolean, admin: AdminIdentity): ChatMessage {
  const speaker = formatContextSpeaker(message, isAdmin, admin);
  const quoteText = message.quoteReferences?.length ? ` 引用：${formatQuoteReferencesForContext(message.quoteReferences)}` : "";
  const imageHandles = (message.imageUrls ?? []).map((_, index) => generateImgMediaHandle(message.id, index));
  const imageText = imageHandles.length
    ? ` 图片：${imageHandles.length} 张（媒体句柄：${imageHandles.join("、")}）`
    : "";
  const attachmentText = message.attachments?.length
    ? ` 文件：${formatAttachmentListForContext(message.attachments)}`
    : "";
  const body = `${message.text}${quoteText}${imageText}${attachmentText}`;
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.groupId == null
      ? `${formatContextTime(message.at)} ${speaker}：${body}`
      : `${formatGroupContextMessageHeader(message)}\n${body}`,
    imageUrls: message.imageUrls
  };
}
export function formatGroupContextMessageHeader(message: ConversationRecord["messages"][number]) {
  const uid = message.role === "assistant"
    ? message.selfId ?? message.userId
    : message.userId;
  const displayName = String(message.senderName || "").trim() || (message.role === "assistant" ? "助手" : "用户");
  const replyToMessageId = message.replyMessageIds?.[0] ?? message.quoteReferences?.[0]?.messageId;
  const fields = [
    `timestamp=${formatGroupContextMetadataValue(formatContextTime(message.at) || message.at)}`,
    `sequence=${formatGroupContextMetadataValue(message.sequence ?? "unknown")}`,
    `message_id=${formatGroupContextMetadataValue(message.id)}`,
    `display_name=${formatGroupContextMetadataValue(displayName)}`,
    `uid=${formatGroupContextMetadataValue(uid ?? "unknown")}`
  ];
  if (replyToMessageId != null) {
    fields.push(`reply_to_message_id=${formatGroupContextMetadataValue(replyToMessageId)}`);
  }
  return `[${fields.join(" | ")}]`;
}
export function formatGroupContextMetadataValue(value: unknown) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("|", "%7C")
    .replaceAll("[", "%5B")
    .replaceAll("]", "%5D")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
export function parseGroupContextMetadataValue(value: string) {
  return value
    .replaceAll("%0D", "\r")
    .replaceAll("%0A", "\n")
    .replaceAll("%7C", "|")
    .replaceAll("%5B", "[")
    .replaceAll("%5D", "]")
    .replaceAll("%25", "%");
}
export function formatContextSpeaker(message: ConversationRecord["messages"][number], isAdmin: boolean, admin: AdminIdentity) {
  const name = String(message.senderName || "").trim();
  if (message.role === "assistant") return name || "助手";
  const fallback = message.userId == null ? "用户" : String(message.userId);
  if (isAdmin) return `${admin.name}(${fallback})`;
  const userLabel = !name || name === fallback ? `用户 ${fallback}` : `用户 ${name}(${fallback})`;
  return userLabel;
}
export function formatContextTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 16);
}
export function appendConversationMessage(
  record: ConversationRecord,
  message: ConversationRecord["messages"][number],
  retainedLimit = MAX_STORED_CONVERSATION_MESSAGES
) {
  const sequence = record.messageCount + 1;
  record.messages.push({ ...message, sequence: message.sequence ?? sequence });
  record.messages = record.messages.slice(-Math.max(1, retainedLimit));
  record.messageCount = sequence;
  record.lastAt = message.at;
  record.lastText = conversationLastText(message);
  record.selfId = message.selfId ?? record.selfId;
}
export function indexedConversationMessages(record: ConversationRecord) {
  const firstSequence = Math.max(1, record.messageCount - record.messages.length + 1);
  return record.messages.map((message, index) => ({
    sequence: typeof message.sequence === "number" ? message.sequence : firstSequence + index,
    message
  }));
}
export function isMemoryEligibleConversationMessage(message: ConversationRecord["messages"][number]) {
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.visibility === "internal" || message.eventKind === "orchestrator_decision") return false;
  if (message.requestStatus === "running" || message.requestStatus === "failed") return false;
  return Boolean(message.text.trim());
}
export function parseWorkingMemoryMergeOutput(text: string): WorkingMemoryMergeOutput | null {
  const parsed = parseModelJson(text);
  if (Array.isArray(parsed)) {
    return {
      facts: normalizeMemoryFacts(parsed),
      allPreviousMemoriesInvalidated: false
    };
  }
  const record = readRecord(parsed);
  if (!Array.isArray(record.facts)) return null;
  return {
    facts: normalizeMemoryFacts(record.facts),
    allPreviousMemoriesInvalidated: record.allPreviousMemoriesInvalidated === true
  };
}
export function invalidWorkingMemoryClear(output: WorkingMemoryMergeOutput, previousCount: number) {
  return output.allPreviousMemoriesInvalidated && (output.facts.length > 0 || previousCount === 0);
}
export function parseMemoryFactOutput(text: string): MemoryFactInput[] | null {
  const parsed = parseModelJson(text);
  if (Array.isArray(parsed)) return normalizeMemoryFacts(parsed);
  const record = readRecord(parsed);
  const values = record.profiles ?? record.facts ?? record.memories ?? record.items;
  return Array.isArray(values) ? normalizeMemoryFacts(values) : null;
}
export function normalizeMemoryFacts(values: unknown[]): MemoryFactInput[] {
  const facts: MemoryFactInput[] = [];
  for (const value of values) {
    const record = readRecord(value);
    const rawFact = record.fact ?? record.text ?? record.summary ?? record.memory ?? record.impression ?? record.profile;
    if (hasForbiddenMemoryRecallPhrase(rawFact)) continue;
    const id = stringValue(record.id);
    const fact = normalizeMemoryFactText(rawFact);
    if (!fact) continue;
    const time = stringValue(record.time ?? record.at ?? record.createdAt ?? record.date);
    const rawUserId = record.userId ?? record.qq ?? record.qqId;
    const rawUserIds = record.userIds ?? record.user_ids ?? record.qqs;
    if (hasInvalidQqIdentity(rawUserId) || hasInvalidQqIdentity(rawUserIds)) continue;
    const userId = normalizeQqId(rawUserId);
    const userIds = uniqueStrings([
      ...normalizeQqIds(rawUserIds),
      ...(userId ? [userId] : [])
    ]);
    const userName = stringValue(record.userName ?? record.user_name ?? record.name ?? record.nickname ?? record.card);
    const addressName = stringValue(record.addressName ?? record.address_name ?? record.salutation);
    const occurredAt = stringValue(record.occurredAt ?? record.occurred_at);
    const occurredEndAtValue = record.occurredEndAt ?? record.occurred_end_at;
    const occurredEndAt = occurredEndAtValue == null ? undefined : stringValue(occurredEndAtValue);
    const observedAt = stringValue(record.observedAt ?? record.observed_at);
    const sourceWorkingMemoryIds = normalizeStringIds(record.sourceWorkingMemoryIds ?? record.source_working_memory_ids);
    const sourceCandidateIds = normalizeStringIds(record.sourceCandidateIds ?? record.source_candidate_ids);
    const eventType = stringValue(record.eventType ?? record.event_type);
    const subjectKey = stringValue(record.subjectKey ?? record.subject_key);
    const eventKey = stringValue(record.eventKey ?? record.event_key);
    const eventFingerprint = stringValue(record.eventFingerprint ?? record.event_fingerprint);
    const longTermId = stringValue(record.longTermId ?? record.long_term_id);
    const batchId = stringValue(record.batchId ?? record.batch_id);
    facts.push({
      id: id || undefined,
      fact,
      time: time || undefined,
      occurredAt: occurredAt || undefined,
      occurredEndAt: occurredEndAt || undefined,
      observedAt: observedAt || undefined,
      userId: userId || undefined,
      userIds: userIds.length ? userIds : undefined,
      userName: userName || undefined,
      addressName: addressName || undefined,
      sourceWorkingMemoryIds: sourceWorkingMemoryIds.length ? sourceWorkingMemoryIds : undefined,
      sourceCandidateIds: sourceCandidateIds.length ? sourceCandidateIds : undefined,
      eventType: eventType || undefined,
      subjectKey: subjectKey || undefined,
      eventKey: eventKey || undefined,
      eventFingerprint: eventFingerprint || undefined,
      longTermId: longTermId || undefined,
      batchId: batchId || undefined,
      promoteToLongTerm: record.promoteToLongTerm === true || record.promote_to_long_term === true
    });
  }
  return facts;
}
export function attachUsersToMemoryFacts(facts: MemoryFactInput[], participants: BatchUserInfo[]) {
  return facts.flatMap((fact) => {
    if (hasForbiddenMemoryRecallPhrase(fact.fact)) return [];
    if (hasUntrustedMemoryQq(fact, participants)) return [];
    const relatedUsers = resolveFactUsers(fact, participants);
    if (!relatedUsers.length) return [fact];

    const identities = relatedUsers.flatMap((user) => {
      const userName = trustedParticipantName(user);
      return userName ? [{ userId: user.userId, userName }] : [];
    });
    if (identities.length !== relatedUsers.length) return [];
    const normalizedFact = identities.length === 1
      ? replaceReportedMemoryIdentity(fact.fact, identities[0]!, fact.userName)
      : fact.fact;
    if (identities.some((identity) => !hasMemoryIdentity(normalizedFact, identity))) return [];
    if (!hasOnlyTrustedMemoryIdentityMarkers(normalizedFact, participants)) return [];
    if (!isRoleFirstPersonMemory(normalizedFact, identities)) return [];
    const primaryName = identities[0]?.userName;
    return [{
      ...fact,
      fact: normalizedFact,
      userId: fact.userId ?? (relatedUsers.length === 1 ? relatedUsers[0]!.userId : undefined),
      userIds: uniqueStrings(relatedUsers.map((user) => user.userId)),
      userName: primaryName
    }];
  });
}
export function normalizeUserProfileFacts(facts: MemoryFactInput[], participants: BatchUserInfo[]) {
  return facts.flatMap((fact) => {
    if (hasForbiddenMemoryRecallPhrase(fact.fact)) return [];
    if (hasUntrustedMemoryQq(fact, participants)) return [];
    const relatedUsers = resolveFactUsers(fact, participants);
    if (!relatedUsers.length) return [];
    const identities = relatedUsers.flatMap((user) => {
      const userName = trustedParticipantName(user);
      return userName ? [{ userId: user.userId, userName }] : [];
    });
    if (identities.length !== relatedUsers.length) return [];
    const normalizedFact = identities.length === 1
      ? replaceReportedMemoryIdentity(fact.fact, identities[0]!, fact.userName)
      : fact.fact;
    if (identities.some((identity) => !hasMemoryIdentity(normalizedFact, identity))) return [];
    if (!hasOnlyTrustedMemoryIdentityMarkers(normalizedFact, participants)) return [];
    if (!isRoleFirstPersonProfile(normalizedFact, identities)) return [];
    return relatedUsers.flatMap((user) => {
      const userName = trustedParticipantName(user);
      if (!userName) return [];
      const addressName = user.isAdmin ? user.addressName : fact.addressName || user.addressName;
      const strippedFact = normalizeMemoryFactText(stripUserProfilePrefix(normalizedFact, user.userId, userName));
      const identity = { userId: user.userId, userName };
      if (!hasMemoryIdentity(strippedFact, identity)) return [];
      if (!isRoleFirstPersonProfile(strippedFact, [identity])
        || (!strippedFact.includes(user.userId) && !strippedFact.includes(userName))) return [];
      return {
        ...fact,
        fact: strippedFact,
        userId: user.userId,
        userIds: [user.userId],
        userName,
        addressName
      };
    });
  });
}
export function normalizeMemoryFactText(value: unknown) {
  return stringValue(value);
}
export function stripUserProfilePrefix(text: string, userId: string, userName: string) {
  const idPattern = escapeRegExp(userId);
  const namePattern = userName ? `(?:[（(]${escapeRegExp(userName)}[）)])?` : "(?:[（(][^）)]*[）)])?";
  const exactPrefix = new RegExp(`^\\s*(?:QQ\\s*)?${idPattern}\\s*${namePattern}\\s*[:：]\\s*`);
  const genericPrefix = /^\s*QQ\s*\d{5,}\s*(?:[（(][^）)]*[）)])?\s*[:：]\s*/;
  return stringValue(text)
    .split(/\r?\n/)
    .map((line) => line.replace(exactPrefix, "").replace(genericPrefix, "").trim())
    .filter(Boolean)
    .join("\n");
}
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = tryParseJson(trimmed.slice(objectStart, objectEnd + 1));
    if (parsed !== undefined) return parsed;
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    const parsed = tryParseJson(trimmed.slice(arrayStart, arrayEnd + 1));
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}
export function tryParseJson(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
export function stringValue(value: unknown) {
  return String(value ?? "").trim();
}
export function normalizeStringIds(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : stringValue(value)
      .split(/[\s,，、]+/)
      .filter(Boolean);
  return uniqueStrings(values.map(stringValue).filter(Boolean));
}
export function adminIdentityFromBot(bot: AppConfig["bot"]): AdminIdentity {
  return {
    userId: stringValue(bot.adminQq),
    name: stringValue(bot.adminName) || DEFAULT_ADMIN_NAME
  };
}
export function isAdminUserId(value: unknown, admin: AdminIdentity) {
  return isAdminSender(String(value ?? "").trim(), admin.userId);
}
export function uniqueMemoryEntries(entries: MemoryEntry[]) {
  const seen = new Set<string>();
  const result: MemoryEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.source}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}
export function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), min), max);
}
