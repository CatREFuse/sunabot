import { normalizeTokenUsageRecord } from "./tokenUsage.js";

export const modelCallBehaviorIds = ["reply", "orchestrator", "memory", "other"] as const;
export const memoryModelCallKindIds = ["working_long_term", "user_profile"] as const;

export type ModelCallBehaviorId = typeof modelCallBehaviorIds[number];
export type MemoryModelCallKindId = typeof memoryModelCallKindIds[number];

export interface ModelCallMeasurement {
  conversationId: string;
  behavior: ModelCallBehaviorId;
  memoryKind: MemoryModelCallKindId | "";
  input: number;
  output: number;
  total: number;
  cachedInput: number;
  cacheReported: boolean;
}

export function modelCallMeasurement(record: Record<string, unknown>): ModelCallMeasurement | undefined {
  if (String(record.category ?? "") !== "model.response") return undefined;
  const metadata = asRecord(record.metadata);
  const memoryKind = normalizeMemoryKind(metadata?.memoryKind);
  const stage = String(metadata?.stage ?? "");
  const behavior: ModelCallBehaviorId = stage === "reply"
    ? "reply"
    : stage === "orchestrator"
      ? "orchestrator"
      : stage === "memory" && memoryKind
        ? "memory"
        : "other";
  const usage = normalizeTokenUsageRecord(record);
  return {
    conversationId: String(metadata?.conversationId ?? "").trim(),
    behavior,
    memoryKind: behavior === "memory" ? memoryKind ?? "" : "",
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    total: usage?.total ?? 0,
    cachedInput: usage?.cachedInput ?? 0,
    cacheReported: usage?.cacheReported ?? false
  };
}

function normalizeMemoryKind(value: unknown): MemoryModelCallKindId | undefined {
  const kind = String(value ?? "");
  if (kind === "working" || kind === "long_term" || kind === "working_long_term") {
    return "working_long_term";
  }
  return kind === "user_profile" ? kind : undefined;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
