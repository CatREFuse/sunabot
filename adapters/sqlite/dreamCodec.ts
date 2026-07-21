import type {
  ClaimDailyDreamRunInput,
  DreamMemoryArchive,
  DreamPersonaStatus,
  DreamRun,
  DreamRunStatus,
  JsonObject,
  JsonValue,
  MemoryRecallStats
} from "./dreamTypes.js";

type SqlRow = Record<string, unknown>;

const MAX_JSON_BYTES = 1_048_576;
const CANONICAL_MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function mapRecallStats(row: SqlRow): MemoryRecallStats {
  return {
    recordId: normalizeId(String(row.record_id), "stored recordId"),
    recallCount: nonNegativeInteger(Number(row.recall_count), "stored recallCount"),
    distinctRecallDays: nonNegativeInteger(Number(row.distinct_recall_days), "stored distinctRecallDays"),
    lastRecalledAt: nullableTimestamp(row.last_recalled_at, "last_recalled_at"),
    lastRecallLocalDate: row.last_recall_local_date == null
      ? null
      : normalizeLocalDate(String(row.last_recall_local_date), "last_recall_local_date"),
    trackingStartedAt: normalizeTimestamp(row.tracking_started_at, "tracking_started_at"),
    lastReviewedAt: nullableTimestamp(row.last_reviewed_at, "last_reviewed_at"),
    importance: nullableScore(row.importance, "importance"),
    futureRelevance: nullableScore(row.future_relevance, "future_relevance"),
    emotionalSalience: nullableScore(row.emotional_salience, "emotional_salience")
  };
}

export function mapRun(row: SqlRow): DreamRun {
  const status = normalizeRunStatus(String(row.status));
  const personaStatus = normalizePersonaStatus(String(row.persona_status), true);
  const output = nullableJsonObject(row.output_json, "output_json");
  const result = nullableJsonObject(row.result_json, "result_json");
  const dreamText = nullableBoundedText(row.dream_text, "dream_text", 1, 4096);
  const workingMemoryId = row.working_memory_id == null
    ? null
    : normalizeCanonicalMemoryId(String(row.working_memory_id), "stored workingMemoryId");
  const workerId = row.worker_id == null ? null : normalizeWorkerId(String(row.worker_id));
  const leaseUntil = nullableTimestamp(row.lease_until, "lease_until");
  const completedAt = nullableTimestamp(row.completed_at, "completed_at");
  const failedAt = nullableTimestamp(row.failed_at, "failed_at");
  if (status === "running" && (output != null || dreamText != null || result != null)) {
    throw new Error("Stored running dream contains generated or consolidated data.");
  }
  if ((status === "generated" || status === "consolidated" || status === "completed") &&
    (output == null || dreamText == null)) {
    throw new Error(`Stored ${status} dream is missing generated data.`);
  }
  if ((status === "consolidated" || status === "completed") && (result == null || workingMemoryId == null)) {
    throw new Error(`Stored ${status} dream is missing consolidation data.`);
  }
  if ((status === "running" || status === "generated" || status === "consolidated") &&
    (workerId == null || leaseUntil == null)) {
    throw new Error(`Stored ${status} dream is missing its lease owner.`);
  }
  if (status === "completed" && completedAt == null) throw new Error("Stored completed dream has no completion time.");
  if (status === "failed" && failedAt == null) throw new Error("Stored failed dream has no failure time.");
  return {
    id: normalizeId(String(row.id), "stored runId"),
    localDate: normalizeLocalDate(String(row.local_date), "stored localDate"),
    scheduledFor: normalizeTimestamp(row.scheduled_for, "scheduled_for"),
    timeZone: normalizeTimeZone(String(row.time_zone)),
    window: {
      start: normalizeTimestamp(row.window_start, "window_start"),
      end: normalizeTimestamp(row.window_end, "window_end")
    },
    status,
    workerId,
    leaseUntil,
    attemptCount: positiveInteger(Number(row.attempt_count), "stored attemptCount"),
    seed: boundedText(String(row.seed), "stored seed", 1, 128),
    inputDigest: normalizeDigest(String(row.input_digest)),
    input: parseJsonObject(row.input_json, "input_json"),
    output,
    dreamText,
    workingMemoryId,
    persona: nullableJsonObject(row.persona_json, "persona_json"),
    personaStatus,
    result,
    errorCode: nullableBoundedText(row.error_code, "error_code", 1, 80),
    errorText: nullableBoundedText(row.error_text, "error_text", 1, 65_536),
    nextRetryAt: nullableTimestamp(row.next_retry_at, "next_retry_at"),
    createdAt: normalizeTimestamp(row.created_at, "created_at"),
    updatedAt: normalizeTimestamp(row.updated_at, "updated_at"),
    generatedAt: nullableTimestamp(row.generated_at, "generated_at"),
    consolidatedAt: nullableTimestamp(row.consolidated_at, "consolidated_at"),
    personaUpdatedAt: nullableTimestamp(row.persona_updated_at, "persona_updated_at"),
    completedAt,
    failedAt
  };
}

export function mapArchive(row: SqlRow): DreamMemoryArchive {
  return {
    recordId: normalizeCanonicalMemoryId(String(row.record_id), "stored recordId"),
    runId: normalizeId(String(row.run_id), "stored runId"),
    data: parseJsonObject(row.data_json, "archive data_json"),
    reason: boundedText(String(row.reason), "stored reason", 1, 2048),
    archivedAt: normalizeTimestamp(row.archived_at, "archived_at"),
    purgeAfter: normalizeTimestamp(row.purge_after, "purge_after")
  };
}

export function normalizeClaim(
  input: ClaimDailyDreamRunInput,
  idFactory: () => string,
  clock: () => Date
) {
  const now = validDate(input.now ?? clock(), input.now ? "now" : "clock");
  const start = normalizeTimestamp(input.window?.start, "window.start");
  const end = normalizeTimestamp(input.window?.end, "window.end");
  if (start >= end) throw new Error("Dream window start must be earlier than end.");
  const leaseMs = normalizeLease(input.leaseMs);
  return {
    id: normalizeId(input.id ?? idFactory(), "runId"),
    localDate: normalizeLocalDate(input.localDate, "localDate"),
    scheduledFor: normalizeTimestamp(input.scheduledFor, "scheduledFor"),
    timeZone: normalizeTimeZone(input.timeZone),
    window: { start, end },
    workerId: normalizeWorkerId(input.workerId),
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
    seed: boundedText(input.seed, "seed", 1, 128),
    inputDigest: normalizeDigest(input.inputDigest),
    inputJson: encodeJsonObject(input.input, "input"),
    force: input.force === true,
    nowIso: now.toISOString()
  };
}

export function assertSameOccurrence(existing: DreamRun, input: ReturnType<typeof normalizeClaim>) {
  if (existing.scheduledFor !== input.scheduledFor || existing.timeZone !== input.timeZone ||
    existing.window.start !== input.window.start || existing.window.end !== input.window.end ||
    existing.seed !== input.seed || existing.inputDigest !== input.inputDigest) {
    throw new Error(`Dream run occurrence collision for ${existing.localDate}.`);
  }
}

function normalizeRunStatus(value: string): DreamRunStatus {
  if (value === "running" || value === "generated" || value === "consolidated" ||
    value === "completed" || value === "failed") return value;
  throw new Error(`Stored dream run status is invalid: ${value}`);
}

export function normalizePersonaStatus(value: string, allowPending: boolean): DreamPersonaStatus {
  if ((allowPending && value === "pending") || value === "none" || value === "proposed" ||
    value === "applied" || value === "skipped" || value === "failed") return value;
  throw new Error(`Dream persona status is invalid: ${value}`);
}

export function normalizeId(value: string, field: string) {
  return boundedText(value, field, 1, 128);
}

export function normalizeCanonicalMemoryId(value: string, field: string) {
  const normalized = normalizeId(value, field);
  if (!CANONICAL_MEMORY_ID_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a canonical memory ID.`);
  }
  return normalized;
}

export function normalizeStoredMemoryId(value: string, field: string) {
  return normalizeId(value, field);
}

export function tryStoredMemoryId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const length = [...normalized].length;
  return length >= 1 && length <= 128 ? normalized : null;
}

export function normalizeWorkerId(value: string) {
  return boundedText(value, "workerId", 1, 128);
}

function normalizeDigest(value: string) {
  const normalized = boundedText(value, "inputDigest", 64, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("inputDigest must be a SHA-256 hex digest.");
  return normalized;
}

function normalizeTimeZone(value: string) {
  const normalized = boundedText(value, "timeZone", 1, 80);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA time zone: ${normalized}`);
  }
  return normalized;
}

export function normalizeLocalDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a calendar date.`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be an ISO timestamp.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${field} must be an ISO timestamp.`);
  return timestamp.toISOString();
}

function nullableTimestamp(value: unknown, field: string) {
  return value == null ? null : normalizeTimestamp(value, field);
}

export function validDate(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${field} is invalid.`);
  return new Date(value.getTime());
}

export function boundedText(value: string, field: string, minimum: number, maximum: number) {
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < minimum || length > maximum) {
    throw new Error(`${field} must contain between ${minimum} and ${maximum} characters.`);
  }
  return normalized;
}

function nullableBoundedText(value: unknown, field: string, minimum: number, maximum: number) {
  return value == null ? null : boundedText(String(value), field, minimum, maximum);
}

export function normalizedScore(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be between 0 and 1.`);
  return value;
}

function nullableScore(value: unknown, field: string) {
  return value == null ? null : normalizedScore(Number(value), `stored ${field}`);
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function normalizeLease(value: number) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 86_400_000) {
    throw new Error("leaseMs must be between 100 and 86400000.");
  }
  return value;
}

export function listLimit(value: number | undefined) {
  if (value == null) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("Dream list limit must be between 1 and 100.");
  }
  return value;
}

export function encodeJsonObject(value: JsonObject, field: string) {
  assertJsonValue(value, field, new Set(), 0);
  if (Array.isArray(value) || value == null || typeof value !== "object") {
    throw new Error(`${field} must be a JSON object.`);
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    throw new Error(`${field} exceeds ${MAX_JSON_BYTES} bytes.`);
  }
  return encoded;
}

function parseJsonObject(value: unknown, field: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`Stored Dream ${field} is invalid JSON.`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Stored Dream ${field} must be a JSON object.`);
  assertJsonValue(parsed, `stored ${field}`, new Set(), 0);
  if (Buffer.byteLength(String(value), "utf8") > MAX_JSON_BYTES) {
    throw new Error(`Stored Dream ${field} exceeds ${MAX_JSON_BYTES} bytes.`);
  }
  return parsed;
}

function nullableJsonObject(value: unknown, field: string) {
  return value == null ? null : parseJsonObject(value, field);
}

function assertJsonValue(value: unknown, field: string, seen: Set<object>, depth: number): asserts value is JsonValue {
  if (depth > 32) throw new Error(`${field} exceeds the maximum JSON depth.`);
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} contains a non-finite number.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${field} contains a non-JSON value.`);
  if (seen.has(value)) throw new Error(`${field} contains a circular reference.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, field, seen, depth + 1);
  } else {
    if (!isPlainObject(value)) throw new Error(`${field} contains a non-plain object.`);
    for (const item of Object.values(value)) assertJsonValue(item, field, seen, depth + 1);
  }
  seen.delete(value);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function jsonEquals(left: JsonObject | null, right: JsonObject | null) {
  if (left == null || right == null) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
