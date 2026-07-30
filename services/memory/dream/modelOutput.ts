import type {
  DreamCanonicalMemoryV1,
  DreamFieldKnowledgeV1,
  DreamLongTermReviewV1,
  DreamModelOutputExpectations,
  DreamModelOutputV1,
  DreamPersonaAdjustmentKind,
  DreamPersonaAdjustmentV1,
  DreamPersonaTargetFile,
  DreamWorkingReviewV1
} from "./types.js";
import {
  DREAM_PERSONA_STATEMENT_MAX_CHARS,
  normalizeDreamPersonaTopicKey
} from "./personaImpressions.js";

export const DREAM_TEXT_MIN_CODE_POINTS = 1;
export const DREAM_TEXT_MAX_CODE_POINTS = 4_096;
export const DREAM_RAW_OUTPUT_MAX_CODE_POINTS = 64_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const LONG_TERM_ACTIONS = new Set(["retain", "rewrite", "merge", "archive"]);
const WORKING_ACTIONS = new Set(["retain", "rewrite", "merge", "promote", "discard"]);
const PERSONA_KINDS = new Set<DreamPersonaAdjustmentKind>([
  "habit",
  "communication_preference",
  "relationship_tendency"
]);
const PERSONA_TARGETS = new Set<DreamPersonaTargetFile>(["PREFERENCE.md", "RELATION.md"]);
const FIELD_KNOWLEDGE_MAX_CODE_POINTS = 16_000;

export function parseDreamModelOutput(
  text: string,
  expected: DreamModelOutputExpectations
): DreamModelOutputV1 {
  const rawOutput = generatedText(text, DREAM_RAW_OUTPUT_MAX_CODE_POINTS);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return normalizeDreamModelOutputValue(value, expected, rawOutput);
}

export function normalizeDreamModelOutput(
  value: unknown,
  expected: DreamModelOutputExpectations
): DreamModelOutputV1 {
  const record = optionalRecord(value);
  const rawOutput = generatedText(record?.rawOutput, DREAM_RAW_OUTPUT_MAX_CODE_POINTS);
  return normalizeDreamModelOutputValue(value, expected, rawOutput);
}

function normalizeDreamModelOutputValue(
  value: unknown,
  expected: DreamModelOutputExpectations,
  rawOutput: string
): DreamModelOutputV1 {
  const expectedIds = normalizeExpectations(expected);
  const record = optionalRecord(value);
  const dreamText = dreamNarrative(value, record, rawOutput);
  const longTermReviews = normalizeReviewPartition(
    record?.longTermReviews ?? record?.long_term_reviews,
    expectedIds.longTermMemoryIds,
    "long_term"
  );
  const workingReviews = normalizeReviewPartition(
    record?.workingReviews ?? record?.working_reviews,
    expectedIds.workingMemoryIds,
    "working"
  );
  const personaAdjustment = normalizePersonaAdjustment(
    record?.personaAdjustment ?? record?.persona_adjustment ?? null,
    new Set(expectedIds.personaEvidenceIds)
  );
  const fieldKnowledge = normalizeFieldKnowledge(
    record?.fieldKnowledge ?? record?.field_knowledge ?? null,
    new Set(expectedIds.fieldKnowledgeEvidenceIds)
  );

  return {
    schemaVersion: 1,
    dream: { text: dreamText, factuality: "imagined" },
    longTermReviews,
    workingReviews,
    personaAdjustment,
    fieldKnowledge,
    ...(rawOutput ? { rawOutput } : {})
  };
}

function normalizeFieldKnowledge(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>
): DreamFieldKnowledgeV1 | null {
  if (value === null) return null;
  const record = optionalRecord(value);
  if (!record) return null;
  const content = generatedText(
    record.content ?? record.document ?? record.text,
    FIELD_KNOWLEDGE_MAX_CODE_POINTS
  );
  if (!validFieldKnowledgeHeadings(content)) return null;
  const requestedIds = generatedIds(record.evidenceMemoryIds ?? record.evidence_memory_ids);
  const evidenceMemoryIds = requestedIds.filter((id) => allowedEvidenceIds.has(id));
  if (requestedIds.length > 0 && evidenceMemoryIds.length === 0) return null;
  return { content, evidenceMemoryIds };
}

function validFieldKnowledgeHeadings(content: string) {
  const headings = content.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^#{1,2}\s/u.test(line));
  const expected = ["# 场域知识", "## 使用边界", "## 场域约定"];
  return headings.length === expected.length
    && headings.every((heading, index) => heading === expected[index]);
}

function dreamNarrative(
  value: unknown,
  record: Record<string, unknown> | undefined,
  rawOutput: string
) {
  const dream = record?.dream;
  const dreamRecord = optionalRecord(dream);
  const candidates = [
    dreamRecord?.text,
    dreamRecord?.content,
    typeof dream === "string" ? dream : undefined,
    record?.text,
    record?.content,
    record?.narrative,
    typeof value === "string" ? value : undefined,
    rawOutput,
    serializableText(value)
  ];
  for (const candidate of candidates) {
    const text = generatedText(candidate, DREAM_TEXT_MAX_CODE_POINTS);
    if (text) return text;
  }
  return "这次没有留下清晰的梦境片段。";
}

function normalizeReviewPartition(
  value: unknown,
  expectedIds: readonly string[],
  kind: "long_term"
): DreamLongTermReviewV1[];
function normalizeReviewPartition(
  value: unknown,
  expectedIds: readonly string[],
  kind: "working"
): DreamWorkingReviewV1[];
function normalizeReviewPartition(
  value: unknown,
  expectedIds: readonly string[],
  kind: "long_term" | "working"
): Array<DreamLongTermReviewV1 | DreamWorkingReviewV1> {
  const remaining = new Set(expectedIds);
  const reviews: Array<DreamLongTermReviewV1 | DreamWorkingReviewV1> = [];
  for (const candidate of reviewCandidates(value)) {
    const record = optionalRecord(candidate.value);
    if (!record) continue;
    const sourceIds = generatedIds(
      record.sourceIds ?? record.source_ids ?? candidate.fallbackId
    ).filter((id) => remaining.has(id));
    if (!sourceIds.length) continue;
    const action = generatedAction(record.action, kind);
    const canonical = normalizeCanonical(record.canonical);
    const normalized = normalizeReviewAction(kind, sourceIds, action, canonical, record);
    for (const review of normalized) {
      reviews.push(review);
      review.sourceIds.forEach((id) => remaining.delete(id));
    }
  }
  for (const id of expectedIds) {
    if (remaining.has(id)) reviews.push(retainReview(kind, id));
  }
  return reviews;
}

function normalizePersonaAdjustment(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>
): DreamPersonaAdjustmentV1 | null {
  if (value === null) return null;
  const record = optionalRecord(value);
  if (!record) return null;
  if (typeof record.kind !== "string" || !PERSONA_KINDS.has(record.kind as DreamPersonaAdjustmentKind)) {
    return null;
  }
  if (typeof record.targetFile !== "string" || !PERSONA_TARGETS.has(record.targetFile as DreamPersonaTargetFile)) {
    return null;
  }
  const kind = record.kind as DreamPersonaAdjustmentKind;
  const targetFile = record.targetFile as DreamPersonaTargetFile;
  if (
    (kind === "relationship_tendency" && targetFile !== "RELATION.md")
    || (kind !== "relationship_tendency" && targetFile !== "PREFERENCE.md")
  ) {
    return null;
  }
  const topicKey = normalizeDreamPersonaTopicKey(record.topicKey ?? record.topic_key);
  if (!topicKey) return null;
  const requestedEvidenceIds = generatedIds(record.evidenceMemoryIds ?? record.evidence_memory_ids);
  if (requestedEvidenceIds.some((id) => !allowedEvidenceIds.has(id))) return null;
  const evidenceMemoryIds = requestedEvidenceIds;
  if (evidenceMemoryIds.length < 2) return null;
  const statement = generatedText(record.statement, DREAM_PERSONA_STATEMENT_MAX_CHARS + 1);
  if (!statement || Array.from(statement).length > DREAM_PERSONA_STATEMENT_MAX_CHARS) return null;
  return {
    kind,
    targetFile,
    topicKey,
    statement,
    evidenceMemoryIds
  };
}

function normalizeReviewAction(
  kind: "long_term" | "working",
  sourceIds: string[],
  action: DreamLongTermReviewV1["action"] | DreamWorkingReviewV1["action"],
  canonical: DreamCanonicalMemoryV1 | null,
  record: Record<string, unknown>
) {
  if (
    (action === "merge" && (sourceIds.length < 2 || !canonical))
    || ((action === "rewrite" || action === "promote") && (sourceIds.length !== 1 || !canonical))
    || (action !== "merge" && action !== "rewrite" && action !== "promote" && sourceIds.length !== 1)
  ) {
    return sourceIds.map((id) => retainReview(kind, id));
  }
  const safeCanonical = action === "retain" || action === "archive" || action === "discard"
    ? null
    : canonical;
  if (kind === "long_term") {
    return [{
      sourceIds,
      action: action as DreamLongTermReviewV1["action"],
      canonical: safeCanonical,
      importance: generatedScore(record.importance, 1),
      futureRelevance: generatedScore(record.futureRelevance ?? record.future_relevance, 1),
      emotionalSalience: generatedScore(record.emotionalSalience ?? record.emotional_salience, 1),
      confidence: generatedScore(record.confidence, 0),
      reason: generatedText(record.reason, 500)
    } satisfies DreamLongTermReviewV1];
  }
  return [{
    sourceIds,
    action: action as DreamWorkingReviewV1["action"],
    canonical: safeCanonical,
    confidence: generatedScore(record.confidence, 0),
    reason: generatedText(record.reason, 500)
  } satisfies DreamWorkingReviewV1];
}

function retainReview(kind: "long_term" | "working", id: string) {
  if (kind === "long_term") {
    return {
      sourceIds: [id],
      action: "retain",
      canonical: null,
      importance: 1,
      futureRelevance: 1,
      emotionalSalience: 1,
      confidence: 0,
      reason: ""
    } satisfies DreamLongTermReviewV1;
  }
  return {
    sourceIds: [id],
    action: "retain",
    canonical: null,
    confidence: 0,
    reason: ""
  } satisfies DreamWorkingReviewV1;
}

function normalizeExpectations(expected: DreamModelOutputExpectations) {
  return {
    longTermMemoryIds: expectedIds(expected.longTermMemoryIds, "longTermMemoryIds"),
    workingMemoryIds: expectedIds(expected.workingMemoryIds, "workingMemoryIds"),
    personaEvidenceIds: expectedIds(expected.personaEvidenceIds, "personaEvidenceIds"),
    fieldKnowledgeEvidenceIds: expectedIds(
      expected.fieldKnowledgeEvidenceIds ?? [],
      "fieldKnowledgeEvidenceIds"
    )
  };
}

function expectedIds(values: readonly string[], field: string) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const normalized = values.map((value, index) => memoryId(value, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} must not contain duplicates.`);
  return normalized;
}

function reviewCandidates(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => ({ value: item, fallbackId: undefined }));
  const record = optionalRecord(value);
  if (!record) return [];
  return Object.entries(record).map(([fallbackId, item]) => ({ value: item, fallbackId }));
}

function generatedIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => (
    typeof item === "string" && ID_PATTERN.test(item.trim()) ? [item.trim()] : []
  )))].slice(0, 24);
}

function generatedAction(value: unknown, kind: "long_term" | "working") {
  if (typeof value !== "string") return "retain";
  if (kind === "long_term" && LONG_TERM_ACTIONS.has(value)) {
    return value as DreamLongTermReviewV1["action"];
  }
  if (kind === "working" && WORKING_ACTIONS.has(value)) {
    return value as DreamWorkingReviewV1["action"];
  }
  return "retain";
}

function normalizeCanonical(value: unknown): DreamCanonicalMemoryV1 | null {
  const record = optionalRecord(value);
  const fact = generatedText(
    typeof value === "string" ? value : record?.fact ?? record?.text ?? record?.content,
    1_000
  );
  return fact ? { fact } : null;
}

function memoryId(value: unknown, field: string) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function generatedText(value: unknown, maxCodePoints: number) {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replaceAll("<!-- sunabot-workmemory:item", "sunabot-workmemory:item")
    .trim();
  if (!normalized) return "";
  return Array.from(normalized).slice(0, maxCodePoints).join("");
}

function generatedScore(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function serializableText(value: unknown) {
  try {
    return typeof value === "undefined" ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
