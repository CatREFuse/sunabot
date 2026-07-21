import type {
  DreamCanonicalMemoryV1,
  DreamLongTermReviewV1,
  DreamModelOutputExpectations,
  DreamModelOutputV1,
  DreamPersonaAdjustmentKind,
  DreamPersonaAdjustmentV1,
  DreamPersonaTargetFile,
  DreamWorkingReviewV1
} from "./types.js";
import { DREAM_PERSONA_STATEMENT_MAX_CHARS } from "./policy.js";

export const DREAM_TEXT_MIN_CODE_POINTS = 160;
export const DREAM_TEXT_MAX_CODE_POINTS = 260;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LONG_TERM_ACTIONS = new Set(["retain", "rewrite", "merge", "archive"]);
const WORKING_ACTIONS = new Set(["retain", "rewrite", "merge", "promote", "discard"]);
const PERSONA_KINDS = new Set<DreamPersonaAdjustmentKind>([
  "habit",
  "communication_preference",
  "relationship_tendency"
]);
const PERSONA_TARGETS = new Set<DreamPersonaTargetFile>(["PREFERENCE.md", "RELATION.md"]);

export function parseDreamModelOutput(
  text: string,
  expected: DreamModelOutputExpectations
): DreamModelOutputV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Dream output is not valid JSON: ${errorMessage(error)}`);
  }
  return normalizeDreamModelOutput(value, expected);
}

export function normalizeDreamModelOutput(
  value: unknown,
  expected: DreamModelOutputExpectations
): DreamModelOutputV1 {
  const expectedIds = normalizeExpectations(expected);
  const record = strictRecord(value, "Dream output must be an object.");
  exactKeys(
    record,
    ["schemaVersion", "dream", "longTermReviews", "workingReviews", "personaAdjustment"],
    "output"
  );
  if (record.schemaVersion !== 1) throw new Error("Dream output schemaVersion must be 1.");
  const dreamRecord = strictRecord(record.dream, "dream must be an object.");
  exactKeys(dreamRecord, ["text", "factuality"], "dream");
  if (dreamRecord.factuality !== "imagined") throw new Error("dream.factuality must be imagined.");
  const dreamText = boundedText(
    dreamRecord.text,
    "dream.text",
    DREAM_TEXT_MIN_CODE_POINTS,
    DREAM_TEXT_MAX_CODE_POINTS
  );

  if (!Array.isArray(record.longTermReviews)) throw new Error("longTermReviews must be an array.");
  if (!Array.isArray(record.workingReviews)) throw new Error("workingReviews must be an array.");
  const longTermReviews = record.longTermReviews.map((item, index) => normalizeLongTermReview(item, index));
  const workingReviews = record.workingReviews.map((item, index) => normalizeWorkingReview(item, index));
  assertCompletePartition(
    longTermReviews.map((item) => item.sourceIds),
    expectedIds.longTermMemoryIds,
    "longTermReviews"
  );
  assertCompletePartition(
    workingReviews.map((item) => item.sourceIds),
    expectedIds.workingMemoryIds,
    "workingReviews"
  );
  const personaAdjustment = normalizePersonaAdjustment(
    record.personaAdjustment,
    new Set(expectedIds.personaEvidenceIds)
  );

  return {
    schemaVersion: 1,
    dream: { text: dreamText, factuality: "imagined" },
    longTermReviews,
    workingReviews,
    personaAdjustment
  };
}

function normalizeLongTermReview(value: unknown, index: number): DreamLongTermReviewV1 {
  const field = `longTermReviews[${index}]`;
  const record = strictRecord(value, `${field} must be an object.`);
  exactKeys(
    record,
    [
      "sourceIds",
      "action",
      "canonical",
      "importance",
      "futureRelevance",
      "emotionalSalience",
      "confidence",
      "reason"
    ],
    field
  );
  if (typeof record.action !== "string" || !LONG_TERM_ACTIONS.has(record.action)) {
    throw new Error(`${field}.action is invalid.`);
  }
  const action = record.action as DreamLongTermReviewV1["action"];
  const sourceIds = normalizedIds(record.sourceIds, `${field}.sourceIds`);
  const canonical = normalizeCanonical(record.canonical, `${field}.canonical`);
  assertReviewShape(action, sourceIds, canonical, field);
  return {
    sourceIds,
    action,
    canonical,
    importance: unitScore(record.importance, `${field}.importance`),
    futureRelevance: unitScore(record.futureRelevance, `${field}.futureRelevance`),
    emotionalSalience: unitScore(record.emotionalSalience, `${field}.emotionalSalience`),
    confidence: unitScore(record.confidence, `${field}.confidence`),
    reason: boundedText(record.reason, `${field}.reason`, 1, 500)
  };
}

function normalizeWorkingReview(value: unknown, index: number): DreamWorkingReviewV1 {
  const field = `workingReviews[${index}]`;
  const record = strictRecord(value, `${field} must be an object.`);
  exactKeys(record, ["sourceIds", "action", "canonical", "confidence", "reason"], field);
  if (typeof record.action !== "string" || !WORKING_ACTIONS.has(record.action)) {
    throw new Error(`${field}.action is invalid.`);
  }
  const action = record.action as DreamWorkingReviewV1["action"];
  const sourceIds = normalizedIds(record.sourceIds, `${field}.sourceIds`);
  const canonical = normalizeCanonical(record.canonical, `${field}.canonical`);
  assertReviewShape(action, sourceIds, canonical, field);
  return {
    sourceIds,
    action,
    canonical,
    confidence: unitScore(record.confidence, `${field}.confidence`),
    reason: boundedText(record.reason, `${field}.reason`, 1, 500)
  };
}

function normalizePersonaAdjustment(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>
): DreamPersonaAdjustmentV1 | null {
  if (value === null) return null;
  const record = strictRecord(value, "personaAdjustment must be an object or null.");
  exactKeys(record, ["kind", "targetFile", "statement", "evidenceMemoryIds"], "personaAdjustment");
  if (typeof record.kind !== "string" || !PERSONA_KINDS.has(record.kind as DreamPersonaAdjustmentKind)) {
    throw new Error("personaAdjustment.kind is invalid.");
  }
  if (typeof record.targetFile !== "string" || !PERSONA_TARGETS.has(record.targetFile as DreamPersonaTargetFile)) {
    throw new Error("personaAdjustment.targetFile is invalid.");
  }
  const kind = record.kind as DreamPersonaAdjustmentKind;
  const targetFile = record.targetFile as DreamPersonaTargetFile;
  if (
    (kind === "relationship_tendency" && targetFile !== "RELATION.md")
    || (kind !== "relationship_tendency" && targetFile !== "PREFERENCE.md")
  ) {
    throw new Error("personaAdjustment kind and targetFile do not match.");
  }
  const evidenceMemoryIds = normalizedIds(record.evidenceMemoryIds, "personaAdjustment.evidenceMemoryIds");
  if (evidenceMemoryIds.length < 3) {
    throw new Error("personaAdjustment requires at least 3 evidence memories.");
  }
  const unsupported = evidenceMemoryIds.find((id) => !allowedEvidenceIds.has(id));
  if (unsupported) throw new Error(`personaAdjustment contains unknown or imagined evidence id ${unsupported}.`);
  return {
    kind,
    targetFile,
    statement: boundedText(
      record.statement,
      "personaAdjustment.statement",
      1,
      DREAM_PERSONA_STATEMENT_MAX_CHARS
    ),
    evidenceMemoryIds
  };
}

function normalizeCanonical(value: unknown, field: string): DreamCanonicalMemoryV1 | null {
  if (value === null) return null;
  const record = strictRecord(value, `${field} must be an object or null.`);
  exactKeys(record, ["fact"], field);
  return { fact: boundedText(record.fact, `${field}.fact`, 1, 1_000) };
}

function assertReviewShape(
  action: DreamLongTermReviewV1["action"] | DreamWorkingReviewV1["action"],
  sourceIds: string[],
  canonical: DreamCanonicalMemoryV1 | null,
  field: string
) {
  if (action === "merge") {
    if (sourceIds.length < 2) throw new Error(`${field}.merge requires at least 2 sourceIds.`);
    if (!canonical) throw new Error(`${field}.merge requires canonical memory.`);
    return;
  }
  if (sourceIds.length !== 1) throw new Error(`${field}.${action} requires exactly 1 sourceId.`);
  if (action === "promote" || action === "rewrite") {
    if (!canonical) throw new Error(`${field}.${action} requires canonical memory.`);
    return;
  }
  if (canonical) throw new Error(`${field}.${action} canonical must be null.`);
}

function normalizeExpectations(expected: DreamModelOutputExpectations) {
  return {
    longTermMemoryIds: expectedIds(expected.longTermMemoryIds, "longTermMemoryIds"),
    workingMemoryIds: expectedIds(expected.workingMemoryIds, "workingMemoryIds"),
    personaEvidenceIds: expectedIds(expected.personaEvidenceIds, "personaEvidenceIds")
  };
}

function expectedIds(values: readonly string[], field: string) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const normalized = values.map((value, index) => memoryId(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates.`);
  return normalized;
}

function normalizedIds(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new Error(`${field} must contain 1 to 24 ids.`);
  }
  const ids = value.map((item, index) => memoryId(item, `${field}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${field} must not contain duplicates.`);
  return ids;
}

function assertCompletePartition(groups: string[][], expectedIds: readonly string[], field: string) {
  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  for (const id of groups.flat()) {
    if (!expected.has(id)) throw new Error(`${field} contains unknown memory id ${id}.`);
    if (seen.has(id)) throw new Error(`${field} contains duplicate memory id ${id}.`);
    seen.add(id);
  }
  const missing = expectedIds.find((id) => !seen.has(id));
  if (missing) throw new Error(`${field} is missing memory id ${missing}.`);
}

function memoryId(value: unknown, field: string) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function boundedText(value: unknown, field: string, minCodePoints: number, maxCodePoints: number) {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) throw new Error(`${field} must be valid text.`);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < minCodePoints
    || length > maxCodePoints
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error(`${field} must contain ${minCodePoints} to ${maxCodePoints} Unicode code points.`);
  }
  return normalized;
}

function unitScore(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a number from 0 to 1.`);
  }
  return value;
}

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function strictRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], field: string) {
  const expected = new Set(keys);
  const unexpected = Object.keys(record).find((key) => !expected.has(key));
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (unexpected) throw new Error(`${field} contains unsupported field ${unexpected}.`);
  if (missing) throw new Error(`${field} is missing field ${missing}.`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
