import { randomUUID } from "node:crypto";
import type { ImageResult } from "../media/media.js";
import {
  decodeInboundMessageV1,
  type InboundMessageV1,
  type OutboundContentSegmentV1
} from "../messaging/messages.js";
import {
  readCommandInvocationV1,
  type CommandInvocationV1
} from "../messaging/commands.js";
import {
  inboundConversationIdV1,
  inboundMessageIdentityV1
} from "../messaging/incomingIdentity.js";

export {
  conversationAssetEnvelope,
  decodeConversationAsset,
  type ConversationAssetOutboxEnvelope,
  type ConversationAssetOutboxPayload,
  type ConversationAssetTargetV1,
  type QueuedConversationAssetRootIdentityV1,
  type QueuedConversationAssetV2
} from "./conversationAssetRuntimeMessages.js";

export const MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS = 64;
export const SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT = "设置结果未确认，请重新查询当前设置";

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
  followUps?: RuntimeReplyFollowUpSnapshotV1[];
  contextThroughSequence?: number;
  preparationKey?: string;
  replyGate: ReplyGateSnapshotV1;
  replyQuote: ReplyQuoteSnapshotV1;
  commandInvocation?: CommandInvocationV1;
  orchestratorResult?: UserGroupOrchestratorResultV1;
}

export interface RuntimeReplyFollowUpSnapshotV1 {
  incoming: InboundMessageV1;
  captureSequence: number;
}

export interface RuntimeReplyDebounceEventPayload {
  type: "reply_debounce";
  route: RuntimeIncomingReplyEventPayload["route"];
  conversationId: string;
  incoming: InboundMessageV1;
  captureSequence: number;
  followUps?: RuntimeReplyFollowUpSnapshotV1[];
  preparationKey?: string;
  replyGate: ReplyGateSnapshotV1;
  replyQuote: ReplyQuoteSnapshotV1;
  commandInvocation?: CommandInvocationV1;
  orchestratorResult?: UserGroupOrchestratorResultV1;
}

export interface UserGroupOrchestratorResultV1 {
  schemaVersion: 1;
  reason: string;
  replyToMessageId: string;
}

export interface ReplyQuoteSnapshotV1 {
  enabled: boolean;
  replyToMessageId: number | null;
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
    contextThroughSequence?: number;
    replyGate?: ReplyGateSnapshotV1;
    replyQuote?: ReplyQuoteSnapshotV1;
    threadContext?: GroupThreadContextSnapshotV1;
    orchestratorResult?: UserGroupOrchestratorResultV1;
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
  contentSegments?: OutboundContentSegmentV1[];
  isAdmin: boolean;
  quoteReply?: boolean;
  replyToMessageId?: number | null;
  logRunId?: string;
  messageOrigin?: AssistantMessageOrigin;
  toolNames?: string[];
  deliverySemantics?: "system_config_confirmation";
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
export type RuntimeReplyDebounceEnvelope = EnvelopeV1<"runtime.reply_debounce", RuntimeReplyDebounceEventPayload>;
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

export function replyDebounceEnvelope(
  payload: RuntimeReplyDebounceEventPayload,
  options: EnvelopeOptions
): RuntimeReplyDebounceEnvelope {
  return envelope("runtime.reply_debounce", payload, options);
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
  const {
    followUps: rawFollowUps,
    replyGate: rawReplyGate,
    replyQuote: rawReplyQuote,
    commandInvocation: rawCommandInvocation,
    orchestratorResult: rawOrchestratorResult,
    ...payloadFields
  } = payload;
  const captureSequence = requiredPositiveInteger(payload.captureSequence, "captureSequence");
  const incoming = decodeInboundMessageV1(payload.incoming);
  const followUps = decodeReplyFollowUps(rawFollowUps, incoming, captureSequence);
  const contextThroughSequence = optionalPositiveInteger(
    payload.contextThroughSequence,
    "contextThroughSequence"
  );
  validateSequenceRange(
    followUps?.at(-1)?.captureSequence ?? captureSequence,
    contextThroughSequence
  );
  validateReplyRoute(payload.route);
  const replyGate = decodeReplyGateSnapshot(rawReplyGate, incoming, true)!;
  const replyQuote = decodeReplyQuoteSnapshot(rawReplyQuote, incoming, true)!;
  const commandInvocation = decodeCommandInvocation(rawCommandInvocation, payload.route, incoming);
  const orchestratorResult = decodeUserGroupOrchestratorResult(rawOrchestratorResult, payload.route);
  return {
    ...payloadFields,
    incoming,
    captureSequence,
    ...(followUps == null ? {} : { followUps }),
    ...(contextThroughSequence == null ? {} : { contextThroughSequence }),
    replyGate,
    replyQuote,
    ...(commandInvocation ? { commandInvocation } : {}),
    ...(orchestratorResult ? { orchestratorResult } : {})
  } as RuntimeIncomingReplyEventPayload;
}

export function decodeReplyDebounce(value: unknown): RuntimeReplyDebounceEventPayload {
  const payload = decode(value, "runtime.reply_debounce", "reply_debounce");
  const {
    preparationKey: rawPreparationKey,
    followUps: rawFollowUps,
    replyGate: rawReplyGate,
    replyQuote: rawReplyQuote,
    commandInvocation: rawCommandInvocation,
    orchestratorResult: rawOrchestratorResult,
    ...payloadFields
  } = payload;
  validateReplyRoute(payload.route);
  const preparationKey = optionalString(rawPreparationKey, "preparationKey");
  const incoming = decodeInboundMessageV1(payload.incoming);
  const conversationId = requiredString(payload.conversationId, "conversationId");
  if (conversationId !== inboundConversationIdV1(incoming)) {
    throw contractError("contract_field_invalid", "持久化消息字段 conversationId 无效。");
  }
  const captureSequence = requiredPositiveInteger(payload.captureSequence, "captureSequence");
  const followUps = decodeReplyFollowUps(rawFollowUps, incoming, captureSequence);
  const replyGate = decodeReplyGateSnapshot(rawReplyGate, incoming, true)!;
  const replyQuote = decodeReplyQuoteSnapshot(rawReplyQuote, incoming, true)!;
  const commandInvocation = decodeCommandInvocation(rawCommandInvocation, payload.route, incoming);
  const orchestratorResult = decodeUserGroupOrchestratorResult(rawOrchestratorResult, payload.route);
  return {
    ...payloadFields,
    conversationId,
    incoming,
    captureSequence,
    ...(followUps == null ? {} : { followUps }),
    ...(preparationKey == null ? {} : { preparationKey }),
    replyGate,
    replyQuote,
    ...(commandInvocation ? { commandInvocation } : {}),
    ...(orchestratorResult ? { orchestratorResult } : {})
  } as RuntimeReplyDebounceEventPayload;
}

export function decodeToolCompletion(value: unknown): AsyncToolCompletionPayload {
  const payload = decode(value, "runtime.tool_result", "tool_result");
  const originalRequest = isRecord(payload.originalRequest) ? payload.originalRequest : {};
  const {
    captureSequence: rawCaptureSequence,
    contextThroughSequence: rawContextThroughSequence,
    replyGate: rawReplyGate,
    replyQuote: rawReplyQuote,
    threadContext: rawThreadContext,
    orchestratorResult: rawOrchestratorResult,
    ...originalRequestFields
  } = originalRequest;
  const captureSequence = optionalPositiveInteger(rawCaptureSequence, "captureSequence");
  const contextThroughSequence = optionalPositiveInteger(
    rawContextThroughSequence,
    "contextThroughSequence"
  );
  validateSequenceRange(captureSequence, contextThroughSequence);
  const incoming = decodeInboundMessageV1(originalRequestFields.incoming);
  const threadContext = readGroupThreadContextSnapshot(rawThreadContext);
  const orchestratorResult = readUserGroupOrchestratorResult(rawOrchestratorResult);
  if (rawOrchestratorResult != null && (!orchestratorResult || incoming.scope !== "user_group")) {
    throw contractError("contract_field_invalid", "持久化消息字段 orchestratorResult 无效。");
  }
  const requiresFrozenReply = captureSequence != null || contextThroughSequence != null;
  const replyGate = decodeReplyGateSnapshot(rawReplyGate, incoming, requiresFrozenReply);
  const replyQuote = decodeReplyQuoteSnapshot(rawReplyQuote, incoming, requiresFrozenReply);
  return {
    ...payload,
    originalRequest: {
      ...originalRequestFields,
      incoming,
      ...(captureSequence == null ? {} : { captureSequence }),
      ...(contextThroughSequence == null ? {} : { contextThroughSequence }),
      ...(replyGate == null ? {} : { replyGate }),
      ...(replyQuote == null ? {} : { replyQuote }),
      ...(threadContext ? { threadContext } : {}),
      ...(orchestratorResult ? { orchestratorResult } : {})
    }
  } as unknown as AsyncToolCompletionPayload;
}

export function decodeAssistantReply(value: unknown): AssistantReplyOutboxPayload {
  const payload = decode(value, "runtime.assistant_reply", "assistant_reply");
  const {
    threadContext: rawThreadContext,
    replyToMessageId: rawReplyToMessageId,
    deliverySemantics: rawDeliverySemantics,
    contentSegments: rawContentSegments,
    ...payloadFields
  } = payload;
  if (rawDeliverySemantics !== undefined && rawDeliverySemantics !== "system_config_confirmation") {
    throw contractError("contract_field_invalid", "持久化消息字段 deliverySemantics 无效。");
  }
  const threadContext = readGroupThreadContextSnapshot(rawThreadContext);
  const hasReplyTargetField = Object.hasOwn(payload, "replyToMessageId");
  const replyToMessageId = rawReplyToMessageId === null
    ? null
    : positiveSafeInteger(rawReplyToMessageId) ? Number(rawReplyToMessageId) : null;
  const contentSegments = decodeReplyContentSegments(
    rawContentSegments,
    payloadFields.text,
    payloadFields.generatedImages
  );
  return {
    ...payloadFields,
    incoming: decodeInboundMessageV1(payloadFields.incoming),
    ...(hasReplyTargetField ? { replyToMessageId } : {}),
    ...(rawDeliverySemantics === "system_config_confirmation"
      ? { deliverySemantics: rawDeliverySemantics }
      : {}),
    ...(contentSegments ? { contentSegments } : {}),
    ...(threadContext ? { threadContext } : {})
  } as AssistantReplyOutboxPayload;
}

function decodeReplyContentSegments(
  value: unknown,
  text: unknown,
  generatedImages: unknown
): OutboundContentSegmentV1[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || !Array.isArray(generatedImages)) {
    throw contractError("contract_field_invalid", "持久化消息字段 contentSegments 无效。");
  }
  const segments: OutboundContentSegmentV1[] = [];
  const imageIndexes = new Set<number>();
  let joinedText = "";
  for (const item of value) {
    if (!isRecord(item)) {
      throw contractError("contract_field_invalid", "持久化消息字段 contentSegments 无效。");
    }
    const keys = Object.keys(item).sort().join(",");
    if (item.type === "text") {
      if (keys !== "text,type" || typeof item.text !== "string" || !item.text) {
        throw contractError("contract_field_invalid", "持久化消息字段 contentSegments 无效。");
      }
      if (segments.at(-1)?.type === "text") {
        throw contractError("contract_field_invalid", "持久化消息字段 contentSegments 无效。");
      }
      segments.push({ type: "text", text: item.text });
      joinedText += item.text;
      continue;
    }
    if (item.type !== "image" || keys !== "imageIndex,type"
      || !Number.isSafeInteger(item.imageIndex)
      || Number(item.imageIndex) < 0
      || Number(item.imageIndex) >= generatedImages.length
      || imageIndexes.has(Number(item.imageIndex))) {
      throw contractError("contract_field_invalid", "持久化消息字段 contentSegments 无效。");
    }
    const imageIndex = Number(item.imageIndex);
    imageIndexes.add(imageIndex);
    segments.push({ type: "image", imageIndex });
  }
  if (joinedText !== text || imageIndexes.size !== generatedImages.length) {
    throw contractError("contract_field_invalid", "持久化消息字段 contentSegments 无效。");
  }
  return segments;
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

export function readUserGroupOrchestratorResult(
  value: unknown
): UserGroupOrchestratorResultV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1
    || !boundedSnapshotString(value.reason, 1_000)
    || !boundedSnapshotString(value.replyToMessageId, 256)) return undefined;
  return {
    schemaVersion: 1,
    reason: value.reason.trim(),
    replyToMessageId: value.replyToMessageId
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

function requiredPositiveInteger(value: unknown, name: string) {
  if (!positiveSafeInteger(value)) {
    throw contractError("contract_field_invalid", `持久化消息字段 ${name} 无效。`);
  }
  return Number(value);
}

function optionalPositiveInteger(value: unknown, name: string) {
  if (value == null) return undefined;
  return requiredPositiveInteger(value, name);
}

function optionalString(value: unknown, name: string) {
  if (value == null) return undefined;
  return requiredString(value, name);
}

function validateReplyRoute(value: unknown) {
  if (value !== "direct" && value !== "command" && value !== "ambient") {
    throw contractError("contract_field_invalid", "持久化消息字段 route 无效。");
  }
}

function decodeCommandInvocation(
  value: unknown,
  route: unknown,
  incoming: InboundMessageV1
): CommandInvocationV1 | undefined {
  if (route !== "command") {
    if (value == null) return undefined;
    throw contractError("contract_field_invalid", "持久化消息字段 commandInvocation 无效。");
  }
  const invocation = readCommandInvocationV1(value);
  if (!invocation || invocation.rawText !== incoming.text) {
    throw contractError("contract_field_invalid", "持久化消息字段 commandInvocation 无效。");
  }
  return invocation;
}

function decodeUserGroupOrchestratorResult(
  value: unknown,
  route: unknown
): UserGroupOrchestratorResultV1 | undefined {
  if (value == null) return undefined;
  const result = readUserGroupOrchestratorResult(value);
  if (route !== "ambient" || !result) {
    throw contractError("contract_field_invalid", "持久化消息字段 orchestratorResult 无效。");
  }
  return result;
}

function decodeReplyQuoteSnapshot(
  value: unknown,
  incoming: InboundMessageV1,
  required: boolean
): ReplyQuoteSnapshotV1 | undefined {
  if (value == null) {
    if (!required) return undefined;
    throw contractError("contract_field_invalid", "持久化消息字段 replyQuote 无效。");
  }
  if (!isRecord(value) || typeof value.enabled !== "boolean"
    || !Object.hasOwn(value, "replyToMessageId")) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyQuote 无效。");
  }
  const replyToMessageId = value.replyToMessageId === null
    ? null
    : positiveSafeInteger(value.replyToMessageId) ? Number(value.replyToMessageId) : undefined;
  if (replyToMessageId === undefined || value.enabled !== (replyToMessageId !== null)
    || (value.enabled && (incoming.messageId == null || replyToMessageId !== incoming.messageId))) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyQuote 无效。");
  }
  return { enabled: value.enabled, replyToMessageId };
}

function decodeReplyGateSnapshot(
  value: unknown,
  incoming: InboundMessageV1,
  required: boolean
): ReplyGateSnapshotV1 | undefined {
  if (value == null) {
    if (!required) return undefined;
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate 无效。");
  }
  if (!isRecord(value) || typeof value.generation !== "string" || !value.generation.trim()
    || value.scope !== incoming.scope
    || value.conversationId !== inboundConversationIdV1(incoming)
    || !nonNegativeInteger(value.scopeEpoch)
    || !nonNegativeInteger(value.conversationEpoch)) {
    throw contractError("contract_field_invalid", "持久化消息字段 replyGate 无效。");
  }
  return {
    generation: value.generation,
    scope: incoming.scope,
    conversationId: value.conversationId,
    scopeEpoch: Number(value.scopeEpoch),
    conversationEpoch: Number(value.conversationEpoch)
  };
}

function decodeReplyFollowUps(
  value: unknown,
  trigger: InboundMessageV1,
  triggerSequence: number
): RuntimeReplyFollowUpSnapshotV1[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw contractError("contract_field_invalid", "持久化消息字段 followUps 无效。");
  }
  if (value.length > MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS) {
    throw contractError("contract_field_invalid", "持久化消息字段 followUps 超过最大数量。");
  }
  const identities = new Set([inboundMessageIdentityV1(trigger)]);
  let previousSequence = triggerSequence;
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw contractError("contract_field_invalid", `持久化消息字段 followUps[${index}] 无效。`);
    }
    const incoming = decodeInboundMessageV1(raw.incoming);
    const captureSequence = requiredPositiveInteger(
      raw.captureSequence,
      `followUps[${index}].captureSequence`
    );
    if (captureSequence <= previousSequence) {
      throw contractError(
        "contract_field_invalid",
        "持久化消息字段 followUps.captureSequence 必须严格递增。"
      );
    }
    if (!sameDebounceSender(trigger, incoming)) {
      throw contractError(
        "contract_field_invalid",
        "持久化消息字段 followUps 发送者或会话不匹配。"
      );
    }
    const identity = inboundMessageIdentityV1(incoming);
    if (identities.has(identity)) {
      throw contractError("contract_field_invalid", "持久化消息字段 followUps 包含重复消息。");
    }
    identities.add(identity);
    previousSequence = captureSequence;
    return { incoming, captureSequence };
  });
}

function sameDebounceSender(left: InboundMessageV1, right: InboundMessageV1) {
  return left.agentId === right.agentId
    && left.accountId === right.accountId
    && left.scope === right.scope
    && left.userId === right.userId
    && left.groupId === right.groupId
    && left.selfId === right.selfId;
}

function validateSequenceRange(
  captureSequence: number | undefined,
  contextThroughSequence: number | undefined
) {
  if (
    captureSequence != null &&
    contextThroughSequence != null &&
    contextThroughSequence < captureSequence
  ) {
    throw contractError(
      "contract_field_invalid",
      "持久化消息字段 contextThroughSequence 不能早于 captureSequence。"
    );
  }
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
