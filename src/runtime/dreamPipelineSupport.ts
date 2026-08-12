import { createHash } from "node:crypto";
import { projectDreamContext } from "./dreamContextProjection.js";

export type DreamPipelineJsonObject = Record<string, unknown>;

export function digestDreamPipelineJson(value: unknown) {
  return digestDreamPipelineText(canonicalDreamPipelineJson(value));
}

export function isCurrentDreamPipelineInput(
  stored: DreamPipelineJsonObject,
  normalized: unknown
) {
  if (!isDreamPipelineObject(normalized)
    || !isDreamPipelineObject(normalized.payload)) return false;
  try {
    const payload = projectDreamContext(normalized.payload).payload;
    if (normalized.payload.fieldKnowledgeWritable === false
      && payload.fieldKnowledgeWritable === true) {
      payload.fieldKnowledgeWritable = false;
    }
    return digestDreamPipelineJson({ ...normalized, payload }) === digestDreamPipelineJson(stored);
  } catch {
    return false;
  }
}

export function digestDreamPipelineText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalDreamPipelineJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDreamPipelineJson).join(",")}]`;
  if (isDreamPipelineObject(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalDreamPipelineJson(value[key])}`
    ).join(",")}}`;
  }
  throw new Error("Dream input must contain JSON values only.");
}

export function toDreamPipelineJsonObject(
  value: unknown,
  field: string
): DreamPipelineJsonObject {
  const serialized = JSON.stringify(value);
  if (serialized == null) throw new Error(`${field} must be a JSON object.`);
  const parsed: unknown = JSON.parse(serialized);
  if (!isDreamPipelineObject(parsed)) throw new Error(`${field} must be a JSON object.`);
  canonicalDreamPipelineJson(parsed);
  return parsed;
}

export function validDreamPipelineDigest(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} must be a SHA-256 digest.`);
  }
  return value;
}

export function validDreamPipelineDate(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${field} is invalid.`);
  }
  return new Date(value.getTime());
}

export function validatedDreamTimeZone(value: string) {
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new Error(`Invalid Dream time zone: ${value}`);
  }
  return normalized;
}

export function boundedDreamPipelineId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || [...normalized].length > 128) throw new Error(`${field} is invalid.`);
  return normalized;
}

export function positiveDreamInterval(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 100) {
    throw new Error(`${field} must be at least 100ms.`);
  }
  return value;
}

export function isDreamPipelineObject(value: unknown): value is DreamPipelineJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function dreamPipelineErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error || "Dream run failed.");
}

export function isDreamPipelineAbortError(error: unknown) {
  return error instanceof Error
    && (error.name === "AbortError" || error.message === "The operation was aborted");
}

export function isRetryableDreamPipelineError(error: unknown) {
  if (!error || typeof error !== "object") return true;
  const declared = (error as { retryable?: unknown }).retryable;
  if (typeof declared === "boolean") return declared;
  const status = Number((error as { status?: unknown }).status);
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
