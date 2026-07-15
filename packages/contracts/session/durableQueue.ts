import type { CodexProcessIdentity } from "../tools/codex.js";
import type { EnvelopeV1 } from "./runtimeMessages.js";

export type DurableContractDisposition = "dead" | "needs-migration";

export class DurableContractError extends Error {
  constructor(
    readonly code: "durable_contract_invalid" | "durable_contract_needs_migration",
    readonly disposition: DurableContractDisposition,
    readonly family: string,
    message: string,
    readonly schemaVersion?: unknown
  ) {
    super(message);
    this.name = "DurableContractError";
  }
}

export type ToolJobTerminalStatus =
  | "succeeded"
  | "needs_input"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown";

export type OutboxDeliveryOutcome =
  | "sent"
  | "dead"
  | "delivery_unknown"
  | "unknown"
  | "retry"
  | "recovered";

export interface TurnRequestedPayloadV1 {
  kind: string;
  value: unknown;
}

export type TurnRequestedV1 = EnvelopeV1<"session.turn_requested", TurnRequestedPayloadV1>;

export interface TurnCommandPayloadV1 {
  outcome: string;
  result?: unknown;
  error?: unknown;
}

export type TurnCommandV1 = EnvelopeV1<"session.turn_command", TurnCommandPayloadV1>;

export interface ToolJobRequestedPayloadV1 {
  providerCallId: string;
  toolName: string;
  taskKind?: string;
  originTurnId: string;
  originalRequest: unknown;
  arguments: unknown;
}

export type ToolJobRequestedV1 = EnvelopeV1<"session.tool_job_requested", ToolJobRequestedPayloadV1>;

export interface ToolJobCompletedPayloadV1 {
  status: ToolJobTerminalStatus;
  result?: unknown;
  error?: unknown;
}

export type ToolJobCompletedV1 = EnvelopeV1<"session.tool_job_completed", ToolJobCompletedPayloadV1>;

export interface ToolJobProcessPayloadV1 {
  identity: CodexProcessIdentity;
}

export type ToolJobProcessV1 = EnvelopeV1<"session.tool_job_process", ToolJobProcessPayloadV1>;

export interface OutboxPayloadV1 {
  kind: string;
  value: unknown;
}

export type OutboxMessageV1 = EnvelopeV1<"session.outbox_message", OutboxPayloadV1>;

export interface OutboxDeliveryPayloadV1 {
  outcome: OutboxDeliveryOutcome;
  result?: unknown;
  error?: unknown;
}

export type OutboxDeliveryV1 = EnvelopeV1<"session.outbox_delivery", OutboxDeliveryPayloadV1>;

export interface OutboxRemoteReceiptPayloadV1 {
  receipt: unknown;
}

export type OutboxRemoteReceiptV1 = EnvelopeV1<"session.outbox_remote_receipt", OutboxRemoteReceiptPayloadV1>;

export interface OutboxSettleProgressPayloadV1 {
  completedSteps: string[];
}

export type OutboxSettleProgressV1 = EnvelopeV1<"session.outbox_settle_progress", OutboxSettleProgressPayloadV1>;

export interface DurableCodecContext {
  id: string;
  sessionId: string;
  occurredAt: number | string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
}

export function encodeSessionEventPayload(
  value: unknown,
  kind: string,
  context: DurableCodecContext
) {
  return stringifyEnvelope(envelope("session.turn_requested", { kind, value }, context));
}

export function decodeSessionEventPayload(value: unknown) {
  const parsed = parseStoredJson(value, "session-event");
  const envelopeValue = decodeEnvelope(parsed, "session.turn_requested", "session-event");
  if (!envelopeValue) return parsed;
  const payload = requiredRecord(envelopeValue.payload, "session-event", "payload");
  requiredText(payload.kind, "session-event", "payload.kind");
  return payload.value;
}

export function encodeTurnOutcome(
  outcome: string,
  result: unknown,
  error: unknown,
  context: DurableCodecContext
) {
  return stringifyEnvelope(envelope("session.turn_command", {
    outcome,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {})
  }, context));
}

export function decodeTurnOutcome(resultValue: unknown, errorValue: unknown) {
  if (resultValue == null && errorValue == null) return { result: undefined, error: undefined };
  const parsedResult = resultValue == null ? undefined : parseStoredJson(resultValue, "turn-command");
  const envelopeValue = parsedResult === undefined
    ? undefined
    : decodeEnvelope(parsedResult, "session.turn_command", "turn-command");
  if (!envelopeValue) {
    return {
      result: parsedResult,
      error: errorValue == null ? undefined : parseStoredJson(errorValue, "turn-command")
    };
  }
  const payload = requiredRecord(envelopeValue.payload, "turn-command", "payload");
  requiredText(payload.outcome, "turn-command", "payload.outcome");
  return { result: payload.result, error: payload.error };
}

export function encodeToolJobRequest(
  payload: ToolJobRequestedPayloadV1,
  context: DurableCodecContext
) {
  return stringifyEnvelope(envelope("session.tool_job_requested", payload, context));
}

export function decodeToolJobRequest(originalRequestValue: unknown, argumentsValue: unknown) {
  const parsedRequest = parseStoredJson(originalRequestValue, "tool-job-request");
  const envelopeValue = decodeEnvelope(parsedRequest, "session.tool_job_requested", "tool-job-request");
  if (!envelopeValue) {
    return {
      originalRequest: parsedRequest,
      arguments: parseStoredJson(argumentsValue, "tool-job-request")
    };
  }
  const payload = requiredRecord(envelopeValue.payload, "tool-job-request", "payload");
  requiredText(payload.providerCallId, "tool-job-request", "payload.providerCallId");
  requiredText(payload.toolName, "tool-job-request", "payload.toolName");
  requiredText(payload.originTurnId, "tool-job-request", "payload.originTurnId");
  return { originalRequest: payload.originalRequest, arguments: payload.arguments };
}

export function encodeToolJobCompletion(
  payload: ToolJobCompletedPayloadV1,
  context: DurableCodecContext
) {
  return stringifyEnvelope(envelope("session.tool_job_completed", payload, context));
}

export function decodeToolJobCompletion(resultValue: unknown, errorValue: unknown) {
  if (resultValue == null && errorValue == null) return { result: undefined, error: undefined };
  const parsedResult = resultValue == null ? undefined : parseStoredJson(resultValue, "tool-job-completion");
  const envelopeValue = parsedResult === undefined
    ? undefined
    : decodeEnvelope(parsedResult, "session.tool_job_completed", "tool-job-completion");
  if (!envelopeValue) {
    return {
      result: parsedResult,
      error: errorValue == null ? undefined : parseStoredJson(errorValue, "tool-job-completion")
    };
  }
  const payload = requiredRecord(envelopeValue.payload, "tool-job-completion", "payload");
  requiredTerminalStatus(payload.status, "tool-job-completion");
  return { result: payload.result, error: payload.error };
}

export function encodeToolJobProcess(identity: CodexProcessIdentity, context: DurableCodecContext) {
  return stringifyEnvelope(envelope("session.tool_job_process", { identity }, context));
}

export function decodeToolJobProcess(value: unknown): unknown {
  if (value == null) return undefined;
  const parsed = parseStoredJson(value, "tool-job-process");
  const envelopeValue = decodeEnvelope(parsed, "session.tool_job_process", "tool-job-process");
  if (!envelopeValue) return parsed;
  return requiredRecord(envelopeValue.payload, "tool-job-process", "payload").identity;
}

export function encodeOutboxPayload(value: unknown, kind: string, context: DurableCodecContext) {
  return stringifyEnvelope(envelope("session.outbox_message", { kind, value }, context));
}

export function decodeOutboxPayload(value: unknown) {
  const parsed = parseStoredJson(value, "outbox");
  const envelopeValue = decodeEnvelope(parsed, "session.outbox_message", "outbox");
  if (!envelopeValue) return parsed;
  const payload = requiredRecord(envelopeValue.payload, "outbox", "payload");
  requiredText(payload.kind, "outbox", "payload.kind");
  return payload.value;
}

export function encodeOutboxDelivery(
  payload: OutboxDeliveryPayloadV1,
  context: DurableCodecContext
) {
  return stringifyEnvelope(envelope("session.outbox_delivery", payload, context));
}

export function decodeOutboxDelivery(resultValue: unknown, errorValue: unknown) {
  if (resultValue == null && errorValue == null) return { result: undefined, error: undefined };
  const parsedResult = resultValue == null ? undefined : parseStoredJson(resultValue, "outbox-delivery");
  const envelopeValue = parsedResult === undefined
    ? undefined
    : decodeEnvelope(parsedResult, "session.outbox_delivery", "outbox-delivery");
  if (!envelopeValue) {
    return {
      result: parsedResult,
      error: errorValue == null ? undefined : parseStoredJson(errorValue, "outbox-delivery")
    };
  }
  const payload = requiredRecord(envelopeValue.payload, "outbox-delivery", "payload");
  requiredOutboxOutcome(payload.outcome, "outbox-delivery");
  return { result: payload.result, error: payload.error };
}

export function encodeOutboxRemoteReceipt(receipt: unknown, context: DurableCodecContext) {
  return stringifyEnvelope(envelope("session.outbox_remote_receipt", { receipt }, context));
}

export function decodeOutboxRemoteReceipt(value: unknown) {
  if (value == null) return undefined;
  const parsed = parseStoredJson(value, "outbox-remote-receipt");
  const envelopeValue = decodeEnvelope(
    parsed,
    "session.outbox_remote_receipt",
    "outbox-remote-receipt"
  );
  if (!envelopeValue) return parsed;
  return requiredRecord(envelopeValue.payload, "outbox-remote-receipt", "payload").receipt;
}

export function encodeOutboxSettleProgress(completedSteps: readonly string[], context: DurableCodecContext) {
  const normalized = completedSteps.map((step) => requiredText(
    step,
    "outbox-settle-progress",
    "payload.completedSteps"
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw invalid("outbox-settle-progress", "outbox-settle-progress contains duplicate steps.");
  }
  return stringifyEnvelope(envelope("session.outbox_settle_progress", {
    completedSteps: normalized
  }, context));
}

export function decodeOutboxSettleProgress(value: unknown) {
  if (value == null) return [];
  const parsed = parseStoredJson(value, "outbox-settle-progress");
  const envelopeValue = decodeEnvelope(
    parsed,
    "session.outbox_settle_progress",
    "outbox-settle-progress"
  );
  if (!envelopeValue) {
    if (!Array.isArray(parsed)) throw invalid("outbox-settle-progress", "outbox-settle-progress is invalid.");
    const completedSteps = parsed.map((step) => requiredText(step, "outbox-settle-progress", "step"));
    if (new Set(completedSteps).size !== completedSteps.length) {
      throw invalid("outbox-settle-progress", "outbox-settle-progress contains duplicate steps.");
    }
    return completedSteps;
  }
  const payload = requiredRecord(envelopeValue.payload, "outbox-settle-progress", "payload");
  if (!Array.isArray(payload.completedSteps)) {
    throw invalid("outbox-settle-progress", "outbox-settle-progress field completedSteps is invalid.");
  }
  const completedSteps = payload.completedSteps.map((step) => requiredText(
    step,
    "outbox-settle-progress",
    "payload.completedSteps"
  ));
  if (new Set(completedSteps).size !== completedSteps.length) {
    throw invalid("outbox-settle-progress", "outbox-settle-progress contains duplicate steps.");
  }
  return completedSteps;
}

function envelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  context: DurableCodecContext
): EnvelopeV1<TType, TPayload> {
  return {
    schemaVersion: 1,
    id: requiredText(context.id, type, "id"),
    type,
    occurredAt: isoTime(context.occurredAt, type),
    conversationId: requiredText(context.sessionId, type, "conversationId"),
    correlationId: requiredText(context.correlationId, type, "correlationId"),
    ...(context.causationId ? { causationId: context.causationId } : {}),
    ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
    payload
  };
}

function decodeEnvelope(value: unknown, expectedType: string, family: string) {
  if (!isRecord(value) || value.type !== expectedType) return undefined;
  if (value.schemaVersion !== 1) {
    throw new DurableContractError(
      "durable_contract_needs_migration",
      "needs-migration",
      family,
      `${family} schema version ${String(value.schemaVersion)} needs migration.`,
      value.schemaVersion
    );
  }
  requiredText(value.id, family, "id");
  requiredText(value.occurredAt, family, "occurredAt");
  requiredText(value.conversationId, family, "conversationId");
  requiredText(value.correlationId, family, "correlationId");
  requiredRecord(value.payload, family, "payload");
  return value;
}

function parseStoredJson(value: unknown, family: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw invalid(family, `${family} contains invalid JSON.`);
  }
}

function stringifyEnvelope(value: unknown) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not serializable");
    return encoded;
  } catch {
    throw invalid("durable-envelope", "Durable envelope is not JSON serializable.");
  }
}

function requiredRecord(value: unknown, family: string, field: string) {
  if (!isRecord(value)) throw invalid(family, `${family} field ${field} is invalid.`);
  return value;
}

function requiredText(value: unknown, family: string, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(family, `${family} field ${field} is invalid.`);
  }
  return value;
}

function requiredTerminalStatus(value: unknown, family: string): ToolJobTerminalStatus {
  switch (value) {
    case "succeeded": return "succeeded";
    case "needs_input": return "needs_input";
    case "failed": return "failed";
    case "timed_out": return "timed_out";
    case "cancelled": return "cancelled";
    case "unknown": return "unknown";
    default: throw invalid(family, `${family} terminal status is invalid.`);
  }
}

function requiredOutboxOutcome(value: unknown, family: string): OutboxDeliveryOutcome {
  switch (value) {
    case "sent": return "sent";
    case "dead": return "dead";
    case "delivery_unknown": return "delivery_unknown";
    case "unknown": return "unknown";
    case "retry": return "retry";
    case "recovered": return "recovered";
    default: throw invalid(family, `${family} delivery outcome is invalid.`);
  }
}

function isoTime(value: number | string, family: string) {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalid(family, `${family} occurredAt is invalid.`);
  return new Date(milliseconds).toISOString();
}

function invalid(family: string, message: string) {
  return new DurableContractError("durable_contract_invalid", "dead", family, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
