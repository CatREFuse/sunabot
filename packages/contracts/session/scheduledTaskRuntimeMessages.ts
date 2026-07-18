import { randomUUID } from "node:crypto";
import type { MessageScopeV1 } from "../messaging/messages.js";
import type { EnvelopeV1 } from "./runtimeMessages.js";

export const MAX_SCHEDULED_CALLBACK_MENTIONS = 20;
export const MAX_SCHEDULED_CALLBACK_TEXT_LENGTH = 100_000;

export interface ScheduledCallbackTargetV1 {
  conversationId: string;
  accountId: string;
  scope: MessageScopeV1;
  userId: number;
  groupId?: number;
  mentionUserIds: number[];
}

export interface ScheduledCallbackPayloadV1 {
  type: "scheduled_callback";
  taskId: string;
  taskRevision: number;
  runId: string;
  taskName: string;
  scheduledFor: string;
  triggeredAt: string;
  text: string;
  target: ScheduledCallbackTargetV1;
}

export type ScheduledCallbackDeliveryEnvelopeV1 = EnvelopeV1<
  "runtime.scheduled_callback_delivery",
  ScheduledCallbackPayloadV1
>;

export type ScheduledCallbackOutboxEnvelopeV1 = EnvelopeV1<
  "runtime.scheduled_callback_outbox",
  ScheduledCallbackPayloadV1
>;

export interface ScheduledEnvelopeOptions {
  conversationId: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  id?: string;
}

export function scheduledCallbackDeliveryEnvelope(
  payload: ScheduledCallbackPayloadV1,
  options: ScheduledEnvelopeOptions
): ScheduledCallbackDeliveryEnvelopeV1 {
  return envelope("runtime.scheduled_callback_delivery", payload, options);
}

export function scheduledCallbackOutboxEnvelope(
  payload: ScheduledCallbackPayloadV1,
  options: ScheduledEnvelopeOptions
): ScheduledCallbackOutboxEnvelopeV1 {
  return envelope("runtime.scheduled_callback_outbox", payload, options);
}

export function decodeScheduledCallbackDelivery(value: unknown) {
  return decodeEnvelope(value, "runtime.scheduled_callback_delivery");
}

export function decodeScheduledCallbackOutbox(value: unknown) {
  return decodeEnvelope(value, "runtime.scheduled_callback_outbox");
}

function decodeEnvelope(
  value: unknown,
  expectedType: "runtime.scheduled_callback_delivery" | "runtime.scheduled_callback_outbox"
): ScheduledCallbackPayloadV1 {
  const root = record(value);
  if (root.schemaVersion !== 1 || root.type !== expectedType) {
    throw invalid("Scheduled callback envelope is invalid.");
  }
  const payload = record(root.payload);
  if (payload.type !== "scheduled_callback") throw invalid("Scheduled callback type is invalid.");
  const target = decodeTarget(payload.target);
  const text = requiredString(payload.text, "text", MAX_SCHEDULED_CALLBACK_TEXT_LENGTH, true);
  if (!text.trim()) throw invalid("Scheduled callback text is empty.");
  return {
    type: "scheduled_callback",
    taskId: requiredString(payload.taskId, "taskId", 80),
    taskRevision: positiveSafeInteger(payload.taskRevision, "taskRevision"),
    runId: requiredString(payload.runId, "runId", 80),
    taskName: requiredString(payload.taskName, "taskName", 120),
    scheduledFor: isoTime(payload.scheduledFor, "scheduledFor"),
    triggeredAt: isoTime(payload.triggeredAt, "triggeredAt"),
    text,
    target
  };
}

function decodeTarget(value: unknown): ScheduledCallbackTargetV1 {
  const target = record(value);
  const conversationId = requiredString(target.conversationId, "target.conversationId", 160);
  const accountId = requiredString(target.accountId, "target.accountId", 128);
  const scope = target.scope;
  if (scope !== "private" && scope !== "user_group" && scope !== "bot_group") {
    throw invalid("Scheduled callback target scope is invalid.");
  }
  const userId = positiveSafeInteger(target.userId, "target.userId");
  const groupId = target.groupId == null ? undefined : positiveSafeInteger(target.groupId, "target.groupId");
  const mentionUserIds = positiveIntegerArray(target.mentionUserIds, "target.mentionUserIds");
  if (scope === "private") {
    if (groupId != null || mentionUserIds.length) {
      throw invalid("Private scheduled callback targets cannot contain a group or mentions.");
    }
  } else if (groupId == null) {
    throw invalid("Group scheduled callback targets require groupId.");
  }
  assertConversationIdentity(conversationId, accountId, scope, userId, groupId);
  return {
    conversationId,
    accountId,
    scope,
    userId,
    ...(groupId == null ? {} : { groupId }),
    mentionUserIds
  };
}

function assertConversationIdentity(
  conversationId: string,
  accountId: string,
  scope: MessageScopeV1,
  userId: number,
  groupId?: number
) {
  const match = conversationId.match(/^(?:account:([A-Za-z0-9_-]+):)?(private|group):(\d+)$/);
  if (!match) throw invalid("Scheduled callback conversationId is invalid.");
  if (match[1] && match[1] !== accountId) {
    throw invalid("Scheduled callback accountId does not match conversationId.");
  }
  if (scope === "private") {
    if (match[2] !== "private" || Number(match[3]) !== userId) {
      throw invalid("Scheduled callback private target does not match conversationId.");
    }
    return;
  }
  if (match[2] !== "group" || Number(match[3]) !== groupId) {
    throw invalid("Scheduled callback group target does not match conversationId.");
  }
}

function envelope<TType extends string>(
  type: TType,
  payload: ScheduledCallbackPayloadV1,
  options: ScheduledEnvelopeOptions
): EnvelopeV1<TType, ScheduledCallbackPayloadV1> {
  return {
    schemaVersion: 1,
    id: options.id ?? randomUUID(),
    type,
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    conversationId: options.conversationId,
    correlationId: options.correlationId,
    ...(options.causationId ? { causationId: options.causationId } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    payload
  };
}

function positiveIntegerArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > MAX_SCHEDULED_CALLBACK_MENTIONS) {
    throw invalid(`${field} is invalid.`);
  }
  const values = value.map((item) => positiveSafeInteger(item, field));
  if (new Set(values).size !== values.length) throw invalid(`${field} contains duplicates.`);
  return values;
}

function positiveSafeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid(`${field} is invalid.`);
  return Number(value);
}

function requiredString(value: unknown, field: string, maxLength: number, preserveWhitespace = false) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw invalid(`${field} is invalid.`);
  }
  return preserveWhitespace ? value : value.trim();
}

function isoTime(value: unknown, field: string) {
  const text = requiredString(value, field, 80);
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${field} is invalid.`);
  return new Date(text).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Scheduled callback value is invalid.");
  return value as Record<string, unknown>;
}

function invalid(message: string) {
  return Object.assign(new Error(message), { code: "SCHEDULED_CALLBACK_INVALID" });
}
