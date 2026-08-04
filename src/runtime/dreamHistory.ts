import { CronExpressionParser } from "cron-parser";
import { DREAM_SCHEDULE_CRON } from "../../services/memory/dream/public.js";

type JsonObject = Record<string, unknown>;
export const DREAM_HISTORY_MAX_ATTEMPTS = 3;
const DREAM_STABLE_ERROR_CODES = new Set([
  "DREAM_ADMIN_QQ_UNAVAILABLE",
  "DREAM_ALREADY_COMPLETED",
  "DREAM_ATTEMPT_LIMIT",
  "DREAM_BUSY",
  "DREAM_CONSOLIDATION_MAPPING_INVALID",
  "DREAM_FIELD_KNOWLEDGE_ROLLBACK_CONFLICT",
  "DREAM_INPUT_INVALID",
  "DREAM_LEASE_LOST",
  "DREAM_LONG_TERM_ADD_ONLY_VIOLATION",
  "DREAM_NOTIFICATION_FAILED",
  "DREAM_OUTPUT_CONTRACT_INVALID",
  "DREAM_OUTPUT_MISSING",
  "DREAM_PROMPT_SCHEMA_INVALID",
  "DREAM_RESULT_CONFLICT",
  "DREAM_RUN_FAILED",
  "DREAM_SNAPSHOT_CONFLICT",
  "DREAM_WORKING_MEMORY_ROLLBACK_CONFLICT"
]);

export interface DreamHistorySource {
  id: string;
  localDate: string;
  status: "running" | "generated" | "consolidated" | "completed" | "failed";
  dreamText: string | null;
  scheduledFor: string;
  completedAt: string | null;
  personaStatus: "pending" | "none" | "proposed" | "applied" | "skipped" | "failed";
  persona?: JsonObject | null;
  result: JsonObject | null;
  attemptCount: number;
  errorCode: string | null;
  errorText: string | null;
  nextRetryAt: string | null;
  failedAt: string | null;
}

export function dreamHistoryItem(run: DreamHistorySource) {
  const summary = dreamRunSummary(run.result);
  const errorCode = safeDreamErrorCode(run.errorCode);
  const errorText = errorCode ? dreamFailureText(errorCode) : "";
  return {
    id: run.id,
    date: run.localDate,
    status: run.status === "consolidated" ? "generated" as const : run.status,
    attemptCount: safeAttemptCount(run.attemptCount),
    maxAttempts: DREAM_HISTORY_MAX_ATTEMPTS as 3,
    ...(run.dreamText ? { dreamText: run.dreamText } : {}),
    scheduledFor: run.scheduledFor,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorText ? { errorText } : {}),
    ...(run.nextRetryAt ? { nextRetryAt: run.nextRetryAt } : {}),
    ...(run.failedAt ? { failedAt: run.failedAt } : {}),
    ...(summary ? { summary } : {})
  };
}

export function dreamRunSummary(result: JsonObject | null) {
  if (!result) return undefined;
  const working = objectValue(result.workingMemoryCompression);
  const longTerm = objectValue(result.longTermMemoryAdditions);
  const workingMemoryReduced = nonNegativeNumber(working.reducedBy);
  const longTermAdded = nonNegativeNumber(longTerm.added);
  return workingMemoryReduced == null
    || longTermAdded == null
    ? undefined
    : { workingMemoryReduced, longTermAdded };
}

export function nextDreamScheduledAt(now: Date, timeZone: string) {
  return CronExpressionParser.parse(DREAM_SCHEDULE_CRON, { currentDate: now, tz: timeZone })
    .next().toDate().toISOString();
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function safeAttemptCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function safeDreamErrorCode(value: unknown) {
  if (value == null) return "";
  return typeof value === "string" && DREAM_STABLE_ERROR_CODES.has(value)
    ? value
    : "DREAM_RUN_FAILED";
}

export function dreamErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "DREAM_RUN_FAILED";
  return safeDreamErrorCode((error as { code?: unknown }).code) || "DREAM_RUN_FAILED";
}

export function dreamFailureText(code: string) {
  switch (code) {
    case "DREAM_OUTPUT_CONTRACT_INVALID":
      return "Dream 输出格式校验未通过。";
    case "DREAM_ATTEMPT_LIMIT":
      return "Dream 处理连续失败 3 次。";
    case "DREAM_PROMPT_SCHEMA_INVALID":
      return "Dream 提示词配置校验未通过。";
    case "DREAM_SNAPSHOT_CONFLICT":
      return "Dream 记忆已发生变化，请重试。";
    case "DREAM_NOTIFICATION_FAILED":
      return "Dream 通知发送失败。";
    case "DREAM_LEASE_LOST":
      return "Dream 处理租约已失效。";
    case "DREAM_LONG_TERM_ADD_ONLY_VIOLATION":
      return "Dream 长期记忆仅允许新增。";
    default:
      return "Dream 处理失败。";
  }
}
