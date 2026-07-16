import { randomUUID } from "node:crypto";
import type { ImageResult } from "../media/media.js";
import {
  decodeInboundMessageV1,
  type InboundMessageV1
} from "../messaging/messages.js";

export interface EnvelopeV1<TType extends string, TPayload> {
  schemaVersion: 1;
  id: string;
  type: TType;
  occurredAt: string;
  conversationId?: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  payload: TPayload;
}

export interface RuntimeIncomingReplyEventPayload {
  type: "incoming_reply";
  route: "direct" | "command" | "ambient";
  incoming: InboundMessageV1;
  captureSequence: number;
  preparationKey?: string;
}

export interface ReplyGateSnapshotV1 {
  generation: string;
  scope: "private" | "user_group" | "bot_group";
  conversationId: string;
  scopeEpoch: number;
  conversationEpoch: number;
}

export interface GroupThreadContextSnapshotV1 {
  schemaVersion: 1;
  revision: number;
  processedThroughSequence: number;
  activeThreadId?: string;
  omittedThreadCount?: number;
  threads: Array<{
    threadId: string;
    topic: string;
    status: "active" | "dormant" | "closed";
    participantUids: string[];
    omittedParticipantCount?: number;
    messageIds: string[];
    omittedMessageCount?: number;
  }>;
  messageAssignments: Array<{
    messageId: string;
    sequence: number;
    primaryThreadId: string;
    relatedThreadIds: string[];
    relation: "new" | "continue" | "reply" | "switch" | "bridge" | "unresolved";
    confidence: number;
  }>;
}

export interface AsyncToolCompletionPayload {
  type: "tool_result";
  toolJobId: string;
  providerCallId: string;
  toolName: string;
  originalRequest: {
    incoming: InboundMessageV1;
    captureSequence?: number;
    replyGate?: ReplyGateSnapshotV1;
    threadContext?: GroupThreadContextSnapshotV1;
  };
  arguments: unknown;
  outcome: {
    status: string;
    result: unknown;
    error: unknown;
  };
}

export type AssistantMessageOrigin =
  | "text"
  | "assistant_text"
  | "async_tool_dispatch"
  | "async_tool_callback";

export interface AssistantReplyOutboxPayload {
  type: "assistant_reply";
  incoming: InboundMessageV1;
  text: string;
  generatedImages: ImageResult[];
  isAdmin: boolean;
  quoteReply?: boolean;
  replyToMessageId?: number | null;
  logRunId?: string;
  messageOrigin?: AssistantMessageOrigin;
  toolNames?: string[];
  replyGate?: ReplyGateSnapshotV1;
  threadContext?: GroupThreadContextSnapshotV1;
}

export interface NoReplyPokeOutboxPayload {
  type: "no_reply_poke";
  incoming: InboundMessageV1;
  logRunId?: string;
  replyGate?: ReplyGateSnapshotV1;
}

export type RuntimeIncomingReplyEnvelope = EnvelopeV1<"runtime.incoming_reply", RuntimeIncomingReplyEventPayload>;
export type AsyncToolCompletionEnvelope = EnvelopeV1<"runtime.tool_result", AsyncToolCompletionPayload>;
export type AssistantReplyOutboxEnvelope = EnvelopeV1<"runtime.assistant_reply", AssistantReplyOutboxPayload>;
export type NoReplyPokeOutboxEnvelope = EnvelopeV1<"runtime.no_reply_poke", NoReplyPokeOutboxPayload>;

interface EnvelopeOptions {
  conversationId?: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  id?: string;
}

export function incomingReplyEnvelope(
  payload: RuntimeIncomingReplyEventPayload,
  options: EnvelopeOptions
): RuntimeIncomingReplyEnvelope {
  return envelope("runtime.incoming_reply", payload, options);
}

export function toolCompletionEnvelope(
  payload: AsyncToolCompletionPayload,
  options: EnvelopeOptions
): AsyncToolCompletionEnvelope {
  return envelope("runtime.tool_result", payload, options);
}

export function assistantReplyEnvelope(
  payload: AssistantReplyOutboxPayload,
  options: EnvelopeOptions
): AssistantReplyOutboxEnvelope {
  return envelope("runtime.assistant_reply", payload, options);
}

export function noReplyPokeEnvelope(
  payload: NoReplyPokeOutboxPayload,
  options: EnvelopeOptions
): NoReplyPokeOutboxEnvelope {
  return envelope("runtime.no_reply_poke", payload, options);
}

export function decodeIncomingReply(value: unknown): RuntimeIncomingReplyEventPayload {
  const payload = decode(value, "runtime.incoming_reply", "incoming_reply");
  return {
    ...payload,
    incoming: decodeInboundMessageV1(payload.incoming)
  } as RuntimeIncomingReplyEventPayload;
}

export function decodeToolCompletion(value: unknown): AsyncToolCompletionPayload {
  const payload = decode(value, "runtime.tool_result", "tool_result");
  const originalRequest = isRecord(payload.originalRequest) ? payload.originalRequest : {};
  const { threadContext: rawThreadContext, ...originalRequestFields } = originalRequest;
  const threadContext = readGroupThreadContextSnapshot(rawThreadContext);
  return {
    ...payload,
    originalRequest: {
      ...originalRequestFields,
      incoming: decodeInboundMessageV1(originalRequestFields.incoming),
      ...(threadContext ? { threadContext } : {})
    }
  } as unknown as AsyncToolCompletionPayload;
}

export function decodeAssistantReply(value: unknown): AssistantReplyOutboxPayload {
  const payload = decode(value, "runtime.assistant_reply", "assistant_reply");
  const {
    threadContext: rawThreadContext,
    replyToMessageId: rawReplyToMessageId,
    ...payloadFields
  } = payload;
  const threadContext = readGroupThreadContextSnapshot(rawThreadContext);
  const hasReplyTargetField = Object.hasOwn(payload, "replyToMessageId");
  const replyToMessageId = rawReplyToMessageId === null
    ? null
    : positiveSafeInteger(rawReplyToMessageId) ? Number(rawReplyToMessageId) : null;
  return {
    ...payloadFields,
    incoming: decodeInboundMessageV1(payloadFields.incoming),
    ...(hasReplyTargetField ? { replyToMessageId } : {}),
    ...(threadContext ? { threadContext } : {})
  } as AssistantReplyOutboxPayload;
}

export function readGroupThreadContextSnapshot(value: unknown): GroupThreadContextSnapshotV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (!nonNegativeInteger(value.revision) || !nonNegativeInteger(value.processedThroughSequence)) return undefined;
  if (value.activeThreadId != null && !validSnapshotThreadId(value.activeThreadId)) return undefined;
  if (!Array.isArray(value.threads) || !Array.isArray(value.messageAssignments)) return undefined;
  if (value.omittedThreadCount != null && !nonNegativeInteger(value.omittedThreadCount)) return undefined;
  if (value.threads.length > 72 || value.messageAssignments.length > 64) return undefined;
  const threads: GroupThreadContextSnapshotV1["threads"] = [];
  const threadIds = new Set<string>();
  for (const rawThread of value.threads) {
    if (!isRecord(rawThread) || !validSnapshotThreadId(rawThread.threadId)
      || threadIds.has(rawThread.threadId) || !validSnapshotTopic(rawThread.topic)) return undefined;
    if (rawThread.status !== "active" && rawThread.status !== "dormant" && rawThread.status !== "closed") return undefined;
    const participantUids = boundedStringArray(rawThread.participantUids, 16, 128);
    const messageIds = boundedStringArray(rawThread.messageIds, 16, 256);
    if (!participantUids || !messageIds
      || new Set(participantUids).size !== participantUids.length
      || new Set(messageIds).size !== messageIds.length) return undefined;
    if (rawThread.omittedParticipantCount != null
      && !nonNegativeInteger(rawThread.omittedParticipantCount)) return undefined;
    if (rawThread.omittedMessageCount != null && !nonNegativeInteger(rawThread.omittedMessageCount)) return undefined;
    threads.push({
      threadId: rawThread.threadId,
      topic: rawThread.topic,
      status: rawThread.status,
      participantUids,
      ...(rawThread.omittedParticipantCount == null
        ? {}
        : { omittedParticipantCount: Number(rawThread.omittedParticipantCount) }),
      messageIds,
      ...(rawThread.omittedMessageCount == null
        ? {}
        : { omittedMessageCount: Number(rawThread.omittedMessageCount) })
    });
    threadIds.add(rawThread.threadId);
  }
  if (value.activeThreadId != null) {
    const activeThread = threads.find((thread) => thread.threadId === value.activeThreadId);
    if (!activeThread || activeThread.status !== "active") return undefined;
  }
  const messageAssignments: GroupThreadContextSnapshotV1["messageAssignments"] = [];
  const assignmentMessageIds = new Set<string>();
  let previousSequence = 0;
  for (const rawAssignment of value.messageAssignments) {
    if (!isRecord(rawAssignment) || !boundedSnapshotString(rawAssignment.messageId, 256)
      || assignmentMessageIds.has(rawAssignment.messageId)
      || !Number.isSafeInteger(rawAssignment.sequence) || Number(rawAssignment.sequence) <= previousSequence
      || Number(rawAssignment.sequence) > Number(value.processedThroughSequence)
      || !validSnapshotThreadId(rawAssignment.primaryThreadId)
      || !threadIds.has(rawAssignment.primaryThreadId)) return undefined;
    const relatedThreadIds = boundedStringArray(rawAssignment.relatedThreadIds, 2, 39);
    if (!relatedThreadIds || new Set(relatedThreadIds).size !== relatedThreadIds.length
      || relatedThreadIds.some((threadId) => !validSnapshotThreadId(threadId)
        || !threadIds.has(threadId) || threadId === rawAssignment.primaryThreadId)
      || !threadRelation(rawAssignment.relation)
      || typeof rawAssignment.confidence !== "number" || !Number.isFinite(rawAssignment.confidence)
      || rawAssignment.confidence < 0 || rawAssignment.confidence > 1) return undefined;
    messageAssignments.push({
      messageId: rawAssignment.messageId,
      sequence: Number(rawAssignment.sequence),
      primaryThreadId: rawAssignment.primaryThreadId,
      relatedThreadIds,
      relation: rawAssignment.relation,
      confidence: rawAssignment.confidence
    });
    assignmentMessageIds.add(rawAssignment.messageId);
    previousSequence = Number(rawAssignment.sequence);
  }
  return {
    schemaVersion: 1,
    revision: Number(value.revision),
    processedThroughSequence: Number(value.processedThroughSequence),
    ...(typeof value.activeThreadId === "string" ? { activeThreadId: value.activeThreadId } : {}),
    ...(value.omittedThreadCount == null
      ? {}
      : { omittedThreadCount: Number(value.omittedThreadCount) }),
    threads,
    messageAssignments
  };
}

export function decodeNoReplyPoke(value: unknown): NoReplyPokeOutboxPayload {
  const payload = decode(value, "runtime.no_reply_poke", "no_reply_poke");
  return {
    ...payload,
    incoming: decodeInboundMessageV1(payload.incoming)
  } as NoReplyPokeOutboxPayload;
}

function envelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  options: EnvelopeOptions
): EnvelopeV1<TType, TPayload> {
  return {
    schemaVersion: 1,
    id: options.id ?? randomUUID(),
    type,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    correlationId: requiredString(options.correlationId, "correlationId"),
    ...(options.causationId ? { causationId: options.causationId } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    payload
  };
}

function decode(
  value: unknown,
  envelopeType: string,
  legacyType: string
): Record<string, unknown> {
  if (!isRecord(value)) throw contractError("contract_invalid", "持久化消息不是对象。");
  if ("schemaVersion" in value) {
    if (value.schemaVersion !== 1) {
      throw contractError("contract_version_unsupported", `不支持的持久化消息版本：${String(value.schemaVersion)}`);
    }
    if (value.type !== envelopeType || !isRecord(value.payload) || value.payload.type !== legacyType) {
      throw contractError("contract_type_invalid", `持久化消息类型与 ${envelopeType} 不匹配。`);
    }
    requiredString(value.id, "id");
    requiredString(value.occurredAt, "occurredAt");
    requiredString(value.correlationId, "correlationId");
    return value.payload;
  }
  if (value.type === legacyType) return value;
  throw contractError("contract_type_invalid", `旧持久化消息类型与 ${legacyType} 不匹配。`);
}

function contractError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems
    || value.some((item) => !boundedSnapshotString(item, maxLength))) return undefined;
  return [...value] as string[];
}

function boundedSnapshotString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && Array.from(value).length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function positiveSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validSnapshotThreadId(value: unknown): value is string {
  return typeof value === "string" && /^thread:[a-f0-9]{32}$/u.test(value);
}

function validSnapshotTopic(value: unknown): value is string {
  const length = typeof value === "string" ? Array.from(value.trim()).length : 0;
  return typeof value === "string" && length >= 8 && length <= 160
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value);
}

function threadRelation(value: unknown): value is GroupThreadContextSnapshotV1["messageAssignments"][number]["relation"] {
  return value === "new" || value === "continue" || value === "reply" || value === "switch"
    || value === "bridge" || value === "unresolved";
}
