import { nanoid } from "nanoid";
import {
  AssistantMessageTrace,
  ConversationRecord,
  ParsedIncomingMessage,
  type AppConfig
} from "../types.js";
import { inboundImageUrls } from "../../packages/contracts/messaging/messages.js";
import { senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import {
  ACTIVE_CONVERSATION_WINDOW_MS,
  type ConversationReplyUpdateInput
} from "./runtimeContracts.js";
import {
  conversationDescriptorFromInput,
  conversationRecordId,
  conversationReplyEnabled,
  incomingConversationMessageId,
  isWebConversationId,
  normalizeConversationId,
  persistedAttachments,
  persistedQuoteReferences
} from "./messagingAttachmentHelpers.js";
import { appendConversationMessage, resolveRuntimePersonaName } from "./conversationMemoryHelpers.js";
import { conversationLastText, conversationTitle } from "./selfieHelpers.js";
import {
  saveConversationRecordStrict,
  saveConversationRecords
} from "./infrastructure.js";

interface RuntimeHost {
  readonly config: AppConfig;
  readonly conversationRecords: Map<string, ConversationRecord>;
  readonly persona?: { name: string };
  ensureConversationRecord(incoming: ParsedIncomingMessage, at: string): ConversationRecord;
  isAdminUser(userId: ParsedIncomingMessage["userId"]): boolean;
  persistConversationRecords(): void;
  protectedConversationIds(): ReadonlySet<string>;
  retainedConversationMessageLimit(): number;
}

export function runtime_incomingCaptureSequence(this: RuntimeHost, incoming: ParsedIncomingMessage) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    const messageId = incomingConversationMessageId(incoming);
    const existing = record?.messages.find((message) => (
      message.role === "user" && message.id === messageId
    ));
    return typeof existing?.sequence === "number"
      ? existing.sequence
      : (record?.messageCount ?? 0) + 1;
  }
export function runtime_recordIncomingMessage(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    options: { expectedSequence?: number; persist?: boolean } = {}
  ) {
    const at = incoming.time;
    const record = this.ensureConversationRecord(incoming, at);
    const messageId = incomingConversationMessageId(incoming);
    const existing = record.messages.find((message) => (
      message.role === "user" && message.id === messageId
    ));
    if (existing || (
      options.expectedSequence != null &&
      record.messageCount >= options.expectedSequence
    )) return record;

    const senderName = senderDisplayName(incoming.sender);
    const identity = senderIdentity(incoming.sender);
    appendConversationMessage(record, {
      id: messageId,
      role: "user",
      text: incoming.text || (inboundImageUrls(incoming).length ? "[图片]" : incoming.attachments.length ? "[文件]" : "[消息]"),
      at,
      userId: incoming.userId,
      groupId: incoming.groupId,
      senderName,
      senderNickname: identity.nickname || undefined,
      senderCard: identity.card || undefined,
      isAdmin: this.isAdminUser(incoming.userId),
      selfId: incoming.selfId,
      imageUrls: inboundImageUrls(incoming),
      attachments: persistedAttachments(incoming.attachments),
      replyMessageIds: incoming.replyMessageIds,
      quoteReferences: persistedQuoteReferences(incoming.quoteReferences)
    }, this.retainedConversationMessageLimit());
    if (options.persist !== false) this.persistConversationRecords();
    return record;
  }
export function runtime_recordAssistantRequestStarted(this: RuntimeHost, incoming: ParsedIncomingMessage, logRunId: string) {
    const at = new Date().toISOString();
    const record = this.ensureConversationRecord(incoming, at);
    appendConversationMessage(record, {
      id: nanoid(),
      role: "assistant",
      text: "正在输入…",
      at,
      userId: incoming.userId,
      groupId: incoming.groupId,
      senderName: resolveRuntimePersonaName(this.persona?.name, this.config.persona.name),
      selfId: incoming.selfId,
      logRunId,
      actionSummary: "日志",
      requestStatus: "running"
    }, this.retainedConversationMessageLimit());
    this.persistConversationRecords();
    return record;
  }
export function runtime_recordAssistantMessage(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    text: string,
    imageUrls: string[] = [],
    logRunId?: string,
    requestStatus?: "failed",
    trace: AssistantMessageTrace = {},
    options: { persist?: boolean; messageId?: string; replyMessageIds?: number[] } = {}
  ) {
    const at = new Date().toISOString();
    const record = this.ensureConversationRecord(incoming, at);
    const stableMessageId = options.messageId?.trim();
    if (stableMessageId) {
      const existing = record.messages.find((item) => item.role === "assistant" && item.id === stableMessageId);
      if (existing) return record;
    }
    const message = {
      id: stableMessageId || nanoid(),
      role: "assistant",
      text,
      at,
      userId: incoming.userId,
      groupId: incoming.groupId,
      senderName: resolveRuntimePersonaName(this.persona?.name, this.config.persona.name),
      selfId: incoming.selfId,
      imageUrls,
      replyMessageIds: options.replyMessageIds,
      logRunId,
      messageOrigin: trace.messageOrigin,
      toolNames: normalizedToolNames(trace.toolNames),
      actionSummary: logRunId ? "日志" : undefined,
      requestStatus
    } satisfies ConversationRecord["messages"][number];
    const pending = logRunId
      ? [...record.messages].reverse().find((item) => item.logRunId === logRunId && item.requestStatus === "running")
      : undefined;
    if (pending) {
      const sequence = pending.sequence;
      Object.assign(pending, message, { id: stableMessageId || pending.id, sequence });
      record.lastAt = at;
      record.lastText = conversationLastText(pending);
      record.selfId = incoming.selfId ?? record.selfId;
    } else {
      appendConversationMessage(record, message, this.retainedConversationMessageLimit());
    }
    if (options.persist !== false) this.persistConversationRecords();
    return record;
  }
export function runtime_recordAssistantTurnTools(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    logRunId: string,
    toolNames: readonly string[]
  ) {
    const normalized = normalizedToolNames(toolNames);
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    if (!normalized || !record) return;
    let changed = false;
    for (const message of record.messages) {
      if (message.role !== "assistant" || message.logRunId !== logRunId) continue;
      if (sameStrings(message.toolNames, normalized)) continue;
      message.toolNames = [...normalized];
      changed = true;
    }
    if (changed) this.persistConversationRecords();
  }
export function runtime_discardAssistantRequest(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    logRunId: string
  ) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    if (!record) return false;
    const index = record.messages.findIndex((message) => (
      message.role === "assistant"
      && message.logRunId === logRunId
      && message.requestStatus === "running"
    ));
    if (index < 0) return false;
    const [removed] = record.messages.splice(index, 1);
    if (removed?.sequence === record.messageCount) {
      record.messageCount = Math.max(0, record.messageCount - 1);
    }
    const last = record.messages.at(-1);
    if (last) {
      record.lastAt = last.at;
      record.lastText = conversationLastText(last);
      record.selfId = last.selfId ?? record.selfId;
    }
    this.persistConversationRecords();
    return true;
  }
export function runtime_ensureConversationRecord(this: RuntimeHost, incoming: ParsedIncomingMessage, at: string) {
    const id = conversationRecordId(incoming);
    const existing = this.conversationRecords.get(id);
    if (existing) return existing;

    const record: ConversationRecord = {
      id,
      agentId: incoming.agentId,
      accountId: incoming.accountId,
      scope: incoming.scope,
      title: conversationTitle(incoming),
      userId: incoming.userId,
      groupId: incoming.groupId,
      selfId: incoming.selfId,
      replyEnabled: false,
      messageCount: 0,
      lastAt: at,
      lastText: "",
      messages: []
    };
    this.conversationRecords.set(id, record);
    return record;
  }
export function runtime_upsertConversationRecordForReplySetting(this: RuntimeHost, input: ConversationReplyUpdateInput) {
    const id = normalizeConversationId(input.id);
    const existing = id ? this.conversationRecords.get(id) : undefined;
    if (existing) return existing;

    const descriptor = conversationDescriptorFromInput(input);
    const existingByDescriptor = this.conversationRecords.get(descriptor.id);
    if (existingByDescriptor) return existingByDescriptor;

    const now = new Date().toISOString();
    const record: ConversationRecord = {
      id: descriptor.id,
      scope: descriptor.scope,
      title: descriptor.title,
      userId: descriptor.userId,
      groupId: descriptor.groupId,
      replyEnabled: false,
      messageCount: 0,
      lastAt: now,
      lastText: "",
      messages: []
    };
    this.conversationRecords.set(record.id, record);
    return record;
  }
export function runtime_persistConversationRecords(this: RuntimeHost) {
    saveConversationRecords(
      [...this.conversationRecords.values()],
      this.config,
      this.protectedConversationIds()
    );
  }
export function runtime_persistConversationRecordStrict(
  this: RuntimeHost,
  record: ConversationRecord
) {
    saveConversationRecordStrict(record, this.config);
  }
export function runtime_markConversationMessagesAsRecordedOnly(this: RuntimeHost, record: ConversationRecord) {
    record.memoryCompressedThroughMessageCount = record.messageCount;
    this.persistConversationRecords();
  }
export function runtime_getActiveConversationRecords(this: RuntimeHost) {
    const now = Date.now();
    return [...this.conversationRecords.values()]
      .filter((record) => !isWebConversationId(record.id))
      .filter((record) => record.scope === "private" && !record.groupId)
      .filter((record) => this.isAdminUser(record.userId))
      .filter((record) => conversationReplyEnabled(record))
      .filter((record) => record.messages.length > 0)
      .filter((record) => {
        const lastAt = Date.parse(record.lastAt);
        return Number.isFinite(lastAt) && now - lastAt <= ACTIVE_CONVERSATION_WINDOW_MS;
      })
      .sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt))
      .slice(0, 30);
  }
export function runtime_recordServiceMessage(this: RuntimeHost, record: ConversationRecord, text: string) {
    appendConversationMessage(record, {
      id: nanoid(),
      role: "assistant",
      text,
      at: new Date().toISOString(),
      userId: record.userId,
      groupId: record.groupId,
      senderName: resolveRuntimePersonaName(this.persona?.name, this.config.persona.name),
      selfId: record.selfId,
      messageOrigin: "text"
    }, this.retainedConversationMessageLimit());
    this.persistConversationRecords();
  }

function normalizedToolNames(toolNames: readonly string[] | undefined) {
  if (!toolNames?.length) return undefined;
  const unique = [...new Set(toolNames.map((name) => name.trim()).filter(Boolean))];
  return unique.length ? unique : undefined;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]) {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}
