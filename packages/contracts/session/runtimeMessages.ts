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

export interface AsyncToolCompletionPayload {
  type: "tool_result";
  toolJobId: string;
  providerCallId: string;
  toolName: string;
  originalRequest: {
    incoming: InboundMessageV1;
    captureSequence?: number;
  };
  arguments: unknown;
  outcome: {
    status: string;
    result: unknown;
    error: unknown;
  };
}

export interface AssistantReplyOutboxPayload {
  type: "assistant_reply";
  incoming: InboundMessageV1;
  text: string;
  generatedImages: ImageResult[];
  isAdmin: boolean;
  quoteReply?: boolean;
  logRunId?: string;
}

export type RuntimeIncomingReplyEnvelope = EnvelopeV1<"runtime.incoming_reply", RuntimeIncomingReplyEventPayload>;
export type AsyncToolCompletionEnvelope = EnvelopeV1<"runtime.tool_result", AsyncToolCompletionPayload>;
export type AssistantReplyOutboxEnvelope = EnvelopeV1<"runtime.assistant_reply", AssistantReplyOutboxPayload>;

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
  return {
    ...payload,
    originalRequest: {
      ...originalRequest,
      incoming: decodeInboundMessageV1(originalRequest.incoming)
    }
  } as unknown as AsyncToolCompletionPayload;
}

export function decodeAssistantReply(value: unknown): AssistantReplyOutboxPayload {
  const payload = decode(value, "runtime.assistant_reply", "assistant_reply");
  return {
    ...payload,
    incoming: decodeInboundMessageV1(payload.incoming)
  } as AssistantReplyOutboxPayload;
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
