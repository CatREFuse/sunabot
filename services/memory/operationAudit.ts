import { randomUUID } from "node:crypto";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { memoryRepository } from "./persistence.js";

export type MemoryOperationSource = "working" | "long_term" | "user_profile" | "dream";
export type MemoryOperationActor =
  | "model_tool"
  | "admin"
  | "dream"
  | "system"
  | "memory_recall";
export type MemoryOperationOutcome =
  | "applied"
  | "unchanged"
  | "rejected"
  | "conflict"
  | "failed"
  | "reserved"
  | "recorded";

export interface MemoryOperationAuditInput {
  source: MemoryOperationSource;
  operation: string;
  actor: MemoryOperationActor;
  outcome: MemoryOperationOutcome;
  recordIds?: readonly string[];
  batchId?: string;
  conversationId?: string;
  conversationScope?: string;
  beforeCount?: number;
  afterCount?: number;
  changedCount?: number;
  beforeRevision?: string;
  afterRevision?: string;
  reasonCode?: string;
}

export interface MemoryOperationLogPage {
  logs: Record<string, unknown>[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export function listMemoryOperationLogs(
  config: Pick<AppConfig, "persona">,
  input: { page?: number; pageSize?: number } = {}
): MemoryOperationLogPage {
  const page = positiveInteger(input.page, 1, 100_000);
  const pageSize = positiveInteger(input.pageSize, 50, 100);
  const repository = memoryRepository(config);
  if (!repository.readMemoryOperationLogPage) {
    throw new Error("Memory operation log reader is unavailable.");
  }
  return repository.readMemoryOperationLogPage({ page, pageSize });
}

export function recordMemoryOperation(
  config: Pick<AppConfig, "persona">,
  input: MemoryOperationAuditInput
) {
  const source = input.source;
  const operation = boundedToken(input.operation, 80, "unknown");
  const batchId = boundedText(input.batchId, 256);
  const conversationId = boundedText(input.conversationId, 256);
  const conversationScope = boundedToken(input.conversationScope, 64);
  const recordIds = [...new Set((input.recordIds ?? [])
    .map((value) => boundedText(value, 128))
    .filter((value): value is string => Boolean(value)))]
    .slice(0, 100);
  const record = {
    id: `memory_operation_${randomUUID()}`,
    at: new Date().toISOString(),
    category: "memory.operation",
    action: `${source}.${operation}`,
    request: {
      source,
      operation,
      actor: input.actor,
      ...(recordIds.length ? { recordIds } : {}),
      ...(batchId ? { batchId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(conversationScope ? { conversationScope } : {})
    },
    response: {
      outcome: input.outcome,
      ...optionalCount("beforeCount", input.beforeCount),
      ...optionalCount("afterCount", input.afterCount),
      ...optionalCount("changedCount", input.changedCount),
      ...(boundedText(input.beforeRevision, 256) ? {
        beforeRevision: boundedText(input.beforeRevision, 256)
      } : {}),
      ...(boundedText(input.afterRevision, 256) ? {
        afterRevision: boundedText(input.afterRevision, 256)
      } : {}),
      ...(boundedToken(input.reasonCode, 120) ? {
        reasonCode: boundedToken(input.reasonCode, 120)
      } : {})
    },
    metadata: {
      agentId: boundedToken(config.persona.defaultAgentId, 128, "unknown"),
      stage: "memory",
      memorySource: source,
      ...(batchId ? { batchId } : {}),
      ...(conversationId ? { conversationId } : {})
    }
  };
  try {
    memoryRepository(config).appendMemoryOperationLog?.(record);
  } catch {
    console.error("[memory-audit] append failed", {
      source,
      operation,
      outcome: input.outcome
    });
  }
  return record;
}

function boundedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function boundedToken(value: unknown, maximum: number, fallback?: string) {
  const normalized = boundedText(value, maximum)
    ?.replace(/[^A-Za-z0-9._:-]/gu, "_")
    .replace(/_+/gu, "_");
  return normalized || fallback;
}

function optionalCount(key: string, value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? { [key]: Number(value) }
    : {};
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}
