import {
  inboundImageAltTexts,
  inboundImageUrls
} from "../../packages/contracts/messaging/messages.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import { senderDisplayName } from "../../services/conversations/senderName.js";
import {
  formatMemoryMatchesForPrompt,
  isMemoryCausalChainKey,
  type MemoryEntry,
  type MemoryFactInput
} from "../../services/memory/memoryService.js";
import { isAdminSender } from "../../services/messaging/replySenderPolicy.js";
import { generateImgMediaHandle } from "../../services/tools/generateImgTool.js";
import {
  AppConfig,
  ChatMessage,
  ConversationRecord,
  ParsedIncomingMessage
} from "../types.js";
import {
  normalizeQqId,
  normalizeQqIds,
  resolveFactUsers
} from "./conversationMemoryIdentity.js";
import { conversationRecordId, escapeRegExp, formatAttachmentListForContext, formatQuoteReferencesForContext, matchesMentionName, readRecord, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { AdminIdentity, BatchUserInfo, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_STORED_CONVERSATION_MESSAGES, WorkingMemoryMergeOutput } from "./runtimeContracts.js";
import { conversationLastText, conversationTitle } from "./selfieHelpers.js";

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
    .filter(isModelVisibleConversationMessage)
    .flatMap((message) => {
      const text = groupSummaryMessageText(message);
      if (!text) return [];
      return [{
        sequence: message.sequence,
        at: formatModelTimestamp(message.at),
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
      addressNames: uniqueStrings([isAdmin ? admin.name : "", currentName].filter(Boolean)),
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
  return `QQ ${user.userId}（${user.addressNames.join("、") || "暂无称呼"}）`;
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
  const timeZone = systemModelTimeZone();
  const messageTimeLine = `消息时间：${formatModelTimestamp(incoming.time, timeZone)} [${timeZone}]\n`;
  const groupLine = incoming.groupId ? `群号：${incoming.groupId}\n` : "";
  const roleLine = isAdmin ? `角色：管理员；称呼：${admin.name}\n` : "";
  const imageCount = inboundImageUrls(incoming).length;
  const imageHandles = incoming.messageId == null
    ? []
    : inboundImageUrls(incoming).slice(0, 4).map((_, index) => (
      generateImgMediaHandle(String(incoming.messageId), index)
    ));
  const imageLine = imageCount
    ? `图片：${imageCount} 张${inboundImageAltTexts(incoming).filter(Boolean).length ? `；内容：${inboundImageAltTexts(incoming).filter(Boolean).join("；")}` : ""}${imageHandles.length ? `；媒体句柄：${imageHandles.join("、")}` : ""}\n`
    : "";
  const quoteLine = incoming.quoteReferences.length ? `引用：${formatQuoteReferencesForContext(incoming.quoteReferences)}\n` : "";
  const attachmentLine = incoming.messageId == null || !incoming.attachments.length
    ? ""
    : `文件：${formatAttachmentListForContext(incoming.attachments, String(incoming.messageId))}\n`;
  const attachmentContentLine = boundedAttachmentContext ? `文件内容：\n${boundedAttachmentContext}\n` : "";
  return `消息场景：${scopeName}\n${messageTimeLine}${groupLine}用户：${formatIncomingUserLabel(incoming, admin)}\n${roleLine}${imageLine}${quoteLine}${attachmentLine}${attachmentContentLine}内容：${boundedText}`;
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
export function toContextChatMessage(
  message: ConversationRecord["messages"][number],
  isAdmin: boolean,
  admin: AdminIdentity,
  timeZone = systemModelTimeZone()
): ChatMessage {
  const speaker = formatContextSpeaker(message, isAdmin, admin);
  const quoteText = message.quoteReferences?.length ? ` 引用：${formatQuoteReferencesForContext(message.quoteReferences)}` : "";
  const imageHandles = (message.imageUrls ?? []).map((_, index) => generateImgMediaHandle(message.id, index));
  const imageText = imageHandles.length
    ? ` 图片：${imageHandles.length} 张${message.imageAltTexts?.filter(Boolean).length ? `（${message.imageAltTexts.filter(Boolean).join("；")}）` : ""}（媒体句柄：${imageHandles.join("、")}）`
    : "";
  const attachmentText = message.attachments?.length
    ? ` 文件：${formatAttachmentListForContext(message.attachments, message.id)}`
    : "";
  const body = `${message.text}${quoteText}${imageText}${attachmentText}`;
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.groupId == null
      ? `${formatContextTime(message.at, timeZone)} [${timeZone}] ${speaker}：${body}`
      : `${formatGroupContextMessageHeader(message, timeZone)}\n${body}`,
    imageUrls: message.imageUrls,
    imageAltTexts: message.imageAltTexts
  };
}
export function formatGroupContextMessageHeader(
  message: ConversationRecord["messages"][number],
  timeZone = systemModelTimeZone()
) {
  const uid = message.role === "assistant"
    ? message.selfId ?? message.userId
    : message.userId;
  const displayName = String(message.senderName || "").trim() || (message.role === "assistant" ? "助手" : "用户");
  const replyToMessageId = message.replyMessageIds?.[0] ?? message.quoteReferences?.[0]?.messageId;
  const fields = [
    `timestamp=${formatGroupContextMetadataValue(formatContextTime(message.at, timeZone) || message.at)}`,
    `timezone=${formatGroupContextMetadataValue(timeZone)}`,
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
export function formatContextTime(value: string, timeZone = systemModelTimeZone()) {
  return formatModelTimestamp(value, timeZone);
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
export function isModelVisibleConversationMessage(message: ConversationRecord["messages"][number]) {
  if (message.role !== "user" && message.role !== "assistant") return false;
  return message.visibility !== "internal" && message.eventKind !== "orchestrator_decision";
}
export function isMemoryEligibleConversationMessage(message: ConversationRecord["messages"][number]) {
  if (!isModelVisibleConversationMessage(message)) return false;
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
export function parseCompleteWorkingMemoryMergeOutput(text: string): WorkingMemoryMergeOutput | null {
  return parseWorkingMemoryMergeOutput(text);
}
export function parseMemoryFactOutput(text: string): MemoryFactInput[] | null {
  const parsed = parseModelJson(text);
  if (Array.isArray(parsed)) return normalizeMemoryFacts(parsed);
  const record = readRecord(parsed);
  const values = record.profiles ?? record.facts ?? record.memories ?? record.items;
  return Array.isArray(values) ? normalizeMemoryFacts(values) : null;
}
export function parseCompleteMemoryFactOutput(text: string): MemoryFactInput[] | null {
  return parseMemoryFactOutput(text);
}
export function normalizeMemoryFacts(values: unknown[]): MemoryFactInput[] {
  const facts: MemoryFactInput[] = [];
  for (const value of values) {
    const record = readRecord(value);
    const rawFact = record.fact ?? record.text ?? record.summary ?? record.memory ?? record.impression ?? record.profile;
    const id = stringValue(record.id);
    const fact = normalizeMemoryFactText(rawFact);
    if (!fact) continue;
    const time = stringValue(record.time ?? record.at ?? record.createdAt ?? record.date);
    const rawUserId = record.userId ?? record.qq ?? record.qqId;
    const rawUserIds = record.userIds ?? record.user_ids ?? record.qqs;
    const userId = normalizeQqId(rawUserId);
    const userIds = uniqueStrings([
      ...normalizeQqIds(rawUserIds),
      ...(userId ? [userId] : [])
    ]);
    const userName = stringValue(record.userName ?? record.user_name ?? record.name ?? record.nickname ?? record.card);
    const addressNames = normalizeAddressNameValues(record.addressNames ?? record.address_names);
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
    const rawCausalChainKey = record.causalChainKey ?? record.causal_chain_key;
    const causalChainKey = isMemoryCausalChainKey(rawCausalChainKey)
      ? stringValue(rawCausalChainKey)
      : "";
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
      addressNames: addressNames.length ? addressNames : undefined,
      addressName: addressName || undefined,
      sourceWorkingMemoryIds: sourceWorkingMemoryIds.length ? sourceWorkingMemoryIds : undefined,
      sourceCandidateIds: sourceCandidateIds.length ? sourceCandidateIds : undefined,
      eventType: eventType || undefined,
      subjectKey: subjectKey || undefined,
      eventKey: eventKey || undefined,
      causalChainKey: causalChainKey || undefined,
      eventFingerprint: eventFingerprint || undefined,
      longTermId: longTermId || undefined,
      batchId: batchId || undefined,
      promoteToLongTerm: record.promoteToLongTerm === true || record.promote_to_long_term === true
    });
  }
  return facts;
}
export function attachUsersToMemoryFacts(facts: MemoryFactInput[], participants: BatchUserInfo[]) {
  return facts.map((fact) => {
    const relatedUsers = resolveFactUsers(fact, participants);
    const addressNames = uniqueStrings([
      ...(fact.addressNames ?? []),
      ...(fact.addressName ? [fact.addressName] : [])
    ].map(stringValue).filter(Boolean));
    return {
      ...fact,
      userId: relatedUsers.length === 1 ? relatedUsers[0]!.userId : undefined,
      userIds: relatedUsers.length ? uniqueStrings(relatedUsers.map((user) => user.userId)) : undefined,
      addressNames: addressNames.length ? addressNames : undefined,
      addressName: undefined
    };
  });
}
export function normalizeUserProfileFacts(
  facts: MemoryFactInput[],
  participants: BatchUserInfo[],
  messages: Array<{ text: string }> = []
) {
  return validateUserProfileFacts(facts, participants, messages).accepted;
}

export type UserProfileValidationReasonCode =
  | "related_user_count"
  | "empty_fact";

export function validateUserProfileFacts(
  facts: MemoryFactInput[],
  participants: BatchUserInfo[],
  messages: Array<{ text: string }> = []
) {
  const accepted: MemoryFactInput[] = [];
  const rejected: Array<{ index: number; reasonCode: UserProfileValidationReasonCode }> = [];
  facts.forEach((fact, index) => {
    const result = validateUserProfileFact(fact, participants, messages);
    if ("fact" in result) accepted.push(result.fact);
    else rejected.push({ index, reasonCode: result.reasonCode });
  });
  return { accepted, rejected };
}

function validateUserProfileFact(
  fact: MemoryFactInput,
  participants: BatchUserInfo[],
  _messages: Array<{ text: string }>
): { fact: MemoryFactInput } | { reasonCode: UserProfileValidationReasonCode } {
  const relatedUsers = resolveFactUsers(fact, participants);
  if (relatedUsers.length !== 1) return { reasonCode: "related_user_count" };
  const user = relatedUsers[0]!;
  const proposedAddressNames = uniqueStrings([
    ...(fact.addressNames ?? []),
    ...(fact.addressName ? [fact.addressName] : [])
  ].map(stringValue).filter(Boolean));
  const addressNames = uniqueStrings([
    ...(user.addressNames ?? user.names ?? []),
    ...proposedAddressNames
  ]);
  const content = normalizeMemoryFactText(fact.fact);
  if (!content) return { reasonCode: "empty_fact" };
  return {
    fact: {
      ...fact,
      fact: content,
      userId: user.userId,
      userIds: [user.userId],
      userName: fact.userName || user.currentName || undefined,
      addressNames: addressNames.length ? addressNames : undefined,
      addressName: undefined
    }
  };
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
function normalizeAddressNameValues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map(stringValue).filter(Boolean));
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
