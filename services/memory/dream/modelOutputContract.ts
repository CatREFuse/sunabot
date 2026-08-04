import {
  DREAM_RAW_OUTPUT_MAX_CODE_POINTS,
  DREAM_TEXT_MAX_CODE_POINTS
} from "./modelOutput.js";
import {
  DREAM_PERSONA_STATEMENT_MAX_CHARS,
  isSafeDreamPersonaStatement,
  normalizeDreamPersonaTopicKey
} from "./personaImpressions.js";
import type {
  DreamFieldKnowledgeV1,
  DreamLongTermReviewV1,
  DreamModelOutputExpectations,
  DreamModelOutputV1,
  DreamPersonaAdjustmentKind,
  DreamPersonaAdjustmentV1,
  DreamPersonaTargetFile,
  DreamWorkingReviewV1,
  DreamMinimalModelOutput
} from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const LONG_TERM_ACTIONS = new Set<DreamLongTermReviewV1["action"]>([
  "retain",
  "rewrite",
  "merge",
  "archive"
]);
const WORKING_ACTIONS = new Set<DreamWorkingReviewV1["action"]>([
  "retain",
  "rewrite",
  "merge",
  "promote",
  "discard"
]);
const PERSONA_KINDS = new Set<DreamPersonaAdjustmentKind>([
  "habit",
  "communication_preference",
  "relationship_tendency"
]);
const PERSONA_TARGETS = new Set<DreamPersonaTargetFile>([
  "PREFERENCE.md",
  "RELATION.md"
]);
const REVIEW_REASON_MAX_CODE_POINTS = 500;
const FIELD_KNOWLEDGE_MAX_CODE_POINTS = 16_000;
const MAX_SOURCE_IDS_PER_REVIEW = 24;
const LEGACY_HOST_IDENTITY_ALIAS_PATTERN =
  /(?:人物-[a-f0-9]{10,}|(?:person|profile|context|event|causal|subject|task|schedule|impression):[a-f0-9]{24})/iu;
const MINIMAL_TOP_LEVEL_KEYS = [
  "workingMemoryCompression",
  "longTermMemoryAdditions",
  "dreamDescription"
] as const;
const MAX_LONG_TERM_ADDITIONS = 64;
const MINIMAL_WORKING_MEMORY_MAX_CODE_POINTS = 4_000;

type JsonObject = Record<string, unknown>;

export class DreamModelOutputContractError extends Error {
  readonly code = "DREAM_OUTPUT_CONTRACT_INVALID";
  readonly retryable = true;

  constructor(message: string) {
    super(`Dream output contract is invalid: ${message}`);
    this.name = "DreamModelOutputContractError";
  }
}

export function parseStrictMinimalDreamModelOutput(
  text: string
): DreamMinimalModelOutput {
  if (typeof text !== "string" || codePointLength(text) > DREAM_RAW_OUTPUT_MAX_CODE_POINTS) {
    fail("response must be bounded JSON text");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("response must be valid JSON");
  }
  const root = objectValue(value, "$");
  if (containsLegacyHostIdentityAlias(root)) {
    fail("response contains a legacy host-generated identity alias");
  }
  const rootKeys = Object.keys(root);
  if (
    rootKeys.length !== MINIMAL_TOP_LEVEL_KEYS.length
    || rootKeys.some((key, index) => key !== MINIMAL_TOP_LEVEL_KEYS[index])
  ) {
    fail(`top-level fields must appear in this order: ${MINIMAL_TOP_LEVEL_KEYS.join(", ")}`);
  }
  const workingMemoryCompression = boundedString(
    root.workingMemoryCompression,
    "$.workingMemoryCompression",
    MINIMAL_WORKING_MEMORY_MAX_CODE_POINTS,
    false
  );
  const longTermMemoryAdditions = minimalLongTermAdditions(root.longTermMemoryAdditions);
  const dreamDescription = boundedString(
    root.dreamDescription,
    "$.dreamDescription",
    DREAM_TEXT_MAX_CODE_POINTS,
    true
  );
  return {
    workingMemoryCompression,
    longTermMemoryAdditions,
    dreamDescription
  };
}

function minimalLongTermAdditions(
  value: unknown
): DreamMinimalModelOutput["longTermMemoryAdditions"] {
  if (!Array.isArray(value) || value.length > MAX_LONG_TERM_ADDITIONS) {
    fail(`$.longTermMemoryAdditions must contain at most ${MAX_LONG_TERM_ADDITIONS} items`);
  }
  return value.map((item, index) => boundedString(
    item,
    `$.longTermMemoryAdditions[${index}]`,
    DREAM_TEXT_MAX_CODE_POINTS,
    true
  ));
}

export function parseStrictDreamModelOutput(
  text: string,
  expected: DreamModelOutputExpectations
): DreamModelOutputV1 {
  if (typeof text !== "string" || codePointLength(text) > DREAM_RAW_OUTPUT_MAX_CODE_POINTS) {
    fail("response must be bounded JSON text");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("response must be valid JSON");
  }
  const root = objectValue(value, "$");
  if (containsLegacyHostIdentityAlias(root)) {
    fail("response contains a legacy host-generated identity alias");
  }
  exactKeys(root, [
    "schemaVersion",
    "dream",
    "longTermReviews",
    "workingReviews",
    "personaAdjustment",
    "fieldKnowledge"
  ], "$");
  if (root.schemaVersion !== 1) fail("$.schemaVersion must equal 1");

  const expectedIds = strictExpectations(expected);
  const dream = dreamValue(root.dream);
  const longTermReviews = reviewPartition(
    root.longTermReviews,
    expectedIds.longTerm,
    expectedIds.working,
    "longTermReviews"
  );
  const workingReviews = reviewPartition(
    root.workingReviews,
    expectedIds.working,
    expectedIds.longTerm,
    "workingReviews"
  );
  const personaAdjustment = personaValue(
    root.personaAdjustment,
    expectedIds.personaEvidence
  );
  const fieldKnowledge = fieldKnowledgeValue(
    root.fieldKnowledge,
    expectedIds.fieldKnowledgeEvidence,
    expectedIds.fieldKnowledgeWritable
  );

  return {
    schemaVersion: 1,
    dream,
    longTermReviews,
    workingReviews,
    personaAdjustment,
    fieldKnowledge,
    rawOutput: text
  };
}

export function containsLegacyHostIdentityAlias(value: unknown): boolean {
  if (typeof value === "string") return LEGACY_HOST_IDENTITY_ALIAS_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsLegacyHostIdentityAlias);
  if (value == null || typeof value !== "object") return false;
  return Object.values(value as JsonObject).some(containsLegacyHostIdentityAlias);
}

function dreamValue(value: unknown): DreamModelOutputV1["dream"] {
  const record = objectValue(value, "$.dream");
  exactKeys(record, ["text", "factuality"], "$.dream");
  const text = boundedString(
    record.text,
    "$.dream.text",
    DREAM_TEXT_MAX_CODE_POINTS,
    true
  );
  if (record.factuality !== "imagined") {
    fail("$.dream.factuality must equal imagined");
  }
  return { text, factuality: "imagined" };
}

function reviewPartition(
  value: unknown,
  expectedIds: ReadonlySet<string>,
  otherPartitionIds: ReadonlySet<string>,
  kind: "longTermReviews"
): DreamLongTermReviewV1[];
function reviewPartition(
  value: unknown,
  expectedIds: ReadonlySet<string>,
  otherPartitionIds: ReadonlySet<string>,
  kind: "workingReviews"
): DreamWorkingReviewV1[];
function reviewPartition(
  value: unknown,
  expectedIds: ReadonlySet<string>,
  otherPartitionIds: ReadonlySet<string>,
  kind: "longTermReviews" | "workingReviews"
): Array<DreamLongTermReviewV1 | DreamWorkingReviewV1> {
  if (!Array.isArray(value)) fail(`$.${kind} must be an array`);
  if (value.length > expectedIds.size) fail(`$.${kind} contains too many reviews`);
  const covered = new Set<string>();
  const reviews = value.map((item, index) => {
    const path = `$.${kind}[${index}]`;
    const record = objectValue(item, path);
    if (kind === "longTermReviews") {
      exactKeys(record, [
        "sourceIds",
        "action",
        "canonical",
        "importance",
        "futureRelevance",
        "emotionalSalience",
        "confidence",
        "reason"
      ], path);
    } else {
      exactKeys(record, [
        "sourceIds",
        "action",
        "canonical",
        "confidence",
        "reason"
      ], path);
    }
    const sourceIds = reviewSourceIds(
      record.sourceIds,
      expectedIds,
      otherPartitionIds,
      covered,
      `${path}.sourceIds`
    );
    const action = reviewAction(record.action, kind, `${path}.action`);
    const canonical = reviewCanonical(
      record.canonical,
      action,
      sourceIds.length,
      `${path}.canonical`
    );
    const confidence = score(record.confidence, `${path}.confidence`);
    const reason = boundedString(
      record.reason,
      `${path}.reason`,
      REVIEW_REASON_MAX_CODE_POINTS,
      false
    );
    if (kind === "longTermReviews") {
      return {
        sourceIds,
        action: action as DreamLongTermReviewV1["action"],
        canonical,
        importance: score(record.importance, `${path}.importance`),
        futureRelevance: score(record.futureRelevance, `${path}.futureRelevance`),
        emotionalSalience: score(record.emotionalSalience, `${path}.emotionalSalience`),
        confidence,
        reason
      } satisfies DreamLongTermReviewV1;
    }
    return {
      sourceIds,
      action: action as DreamWorkingReviewV1["action"],
      canonical,
      confidence,
      reason
    } satisfies DreamWorkingReviewV1;
  });
  if (covered.size !== expectedIds.size) {
    fail(`$.${kind} must cover every expected source id exactly once`);
  }
  return reviews;
}

function reviewSourceIds(
  value: unknown,
  expectedIds: ReadonlySet<string>,
  otherPartitionIds: ReadonlySet<string>,
  covered: Set<string>,
  path: string
) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_SOURCE_IDS_PER_REVIEW
  ) {
    fail(`${path} must contain between 1 and ${MAX_SOURCE_IDS_PER_REVIEW} ids`);
  }
  const local = new Set<string>();
  return value.map((item, index) => {
    const id = memoryId(item, `${path}[${index}]`);
    if (local.has(id) || covered.has(id)) fail(`${path} contains a duplicate source id`);
    if (otherPartitionIds.has(id)) fail(`${path} contains an id from the other memory partition`);
    if (!expectedIds.has(id)) fail(`${path} contains an unknown source id`);
    local.add(id);
    covered.add(id);
    return id;
  });
}

function reviewAction(
  value: unknown,
  kind: "longTermReviews" | "workingReviews",
  path: string
) {
  if (typeof value !== "string") fail(`${path} must be a string`);
  const allowed = kind === "longTermReviews" ? LONG_TERM_ACTIONS : WORKING_ACTIONS;
  if (!allowed.has(value as never)) fail(`${path} is unsupported`);
  return value as DreamLongTermReviewV1["action"] | DreamWorkingReviewV1["action"];
}

function reviewCanonical(
  value: unknown,
  action: DreamLongTermReviewV1["action"] | DreamWorkingReviewV1["action"],
  sourceCount: number,
  path: string
) {
  const needsCanonical = action === "rewrite" || action === "merge" || action === "promote";
  if (action === "merge" && sourceCount < 2) fail(`${path} requires at least two merge sources`);
  if (action !== "merge" && sourceCount !== 1) fail(`${path} requires exactly one source`);
  if (!needsCanonical) {
    if (value !== null) fail(`${path} must be null for ${action}`);
    return null;
  }
  const record = objectValue(value, path);
  exactKeys(record, ["fact"], path);
  return {
    fact: boundedString(record.fact, `${path}.fact`, DREAM_TEXT_MAX_CODE_POINTS, true)
  };
}

function personaValue(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>
): DreamPersonaAdjustmentV1 | null {
  if (value === null) return null;
  const record = objectValue(value, "$.personaAdjustment");
  exactKeys(record, [
    "kind",
    "targetFile",
    "topicKey",
    "statement",
    "evidenceMemoryIds"
  ], "$.personaAdjustment");
  if (
    typeof record.kind !== "string"
    || !PERSONA_KINDS.has(record.kind as DreamPersonaAdjustmentKind)
  ) {
    fail("$.personaAdjustment.kind is unsupported");
  }
  if (
    typeof record.targetFile !== "string"
    || !PERSONA_TARGETS.has(record.targetFile as DreamPersonaTargetFile)
  ) {
    fail("$.personaAdjustment.targetFile is unsupported");
  }
  const kind = record.kind as DreamPersonaAdjustmentKind;
  const targetFile = record.targetFile as DreamPersonaTargetFile;
  if (
    (kind === "relationship_tendency" && targetFile !== "RELATION.md")
    || (kind !== "relationship_tendency" && targetFile !== "PREFERENCE.md")
  ) {
    fail("$.personaAdjustment targetFile does not match kind");
  }
  const topicKey = normalizeDreamPersonaTopicKey(record.topicKey);
  if (!topicKey || topicKey !== record.topicKey) {
    fail("$.personaAdjustment.topicKey is invalid");
  }
  const statement = boundedString(
    record.statement,
    "$.personaAdjustment.statement",
    DREAM_PERSONA_STATEMENT_MAX_CHARS,
    true
  );
  if (statement !== statement.trim() || !isSafeDreamPersonaStatement(statement)) {
    fail("$.personaAdjustment.statement is unsafe");
  }
  const evidenceMemoryIds = structuredIds(
    record.evidenceMemoryIds,
    "$.personaAdjustment.evidenceMemoryIds",
    2
  );
  if (evidenceMemoryIds.some((id) => !allowedEvidenceIds.has(id))) {
    fail("$.personaAdjustment.evidenceMemoryIds contains an unknown id");
  }
  return { kind, targetFile, topicKey, statement, evidenceMemoryIds };
}

function fieldKnowledgeValue(
  value: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
  writable: boolean
): DreamFieldKnowledgeV1 | null {
  if (!writable) {
    if (value !== null) {
      fail("$.fieldKnowledge must be null when field knowledge is not writable");
    }
    return null;
  }
  if (value === null) return null;
  const record = objectValue(value, "$.fieldKnowledge");
  exactKeys(record, ["content", "evidenceMemoryIds"], "$.fieldKnowledge");
  const content = boundedString(
    record.content,
    "$.fieldKnowledge.content",
    FIELD_KNOWLEDGE_MAX_CODE_POINTS,
    true
  );
  const headings = content.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^#{1,2}\s/u.test(line));
  const expectedHeadings = ["# 场域知识", "## 使用边界", "## 场域约定"];
  if (
    headings.length !== expectedHeadings.length
    || headings.some((heading, index) => heading !== expectedHeadings[index])
  ) {
    fail("$.fieldKnowledge.content has invalid headings");
  }
  const requestedEvidenceIds = structuredIds(
    record.evidenceMemoryIds,
    "$.fieldKnowledge.evidenceMemoryIds",
    0
  );
  if (requestedEvidenceIds.some((id) => !allowedEvidenceIds.has(id))) {
    fail("$.fieldKnowledge.evidenceMemoryIds contains an unknown id");
  }
  return {
    content,
    evidenceMemoryIds: requestedEvidenceIds
  };
}

function structuredIds(
  value: unknown,
  path: string,
  minimum: number
) {
  if (
    !Array.isArray(value)
    || value.length < minimum
    || value.length > MAX_SOURCE_IDS_PER_REVIEW
  ) {
    fail(`${path} has an invalid item count`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const id = memoryId(item, `${path}[${index}]`);
    if (seen.has(id)) fail(`${path} contains a duplicate id`);
    seen.add(id);
    return id;
  });
}

function strictExpectations(expected: DreamModelOutputExpectations) {
  const longTerm = expectationIds(expected.longTermMemoryIds, "longTermMemoryIds");
  const working = expectationIds(expected.workingMemoryIds, "workingMemoryIds");
  if ([...longTerm].some((id) => working.has(id))) {
    throw new Error("Dream memory expectation partitions must not overlap.");
  }
  return {
    longTerm,
    working,
    personaEvidence: expectationIds(expected.personaEvidenceIds, "personaEvidenceIds"),
    fieldKnowledgeEvidence: expectationIds(
      expected.fieldKnowledgeEvidenceIds ?? [],
      "fieldKnowledgeEvidenceIds"
    ),
    fieldKnowledgeWritable: expected.fieldKnowledgeWritable === true
  };
}

function expectationIds(values: readonly string[], field: string) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const result = new Set<string>();
  values.forEach((value, index) => {
    const id = memoryId(value, `${field}[${index}]`, false);
    if (result.has(id)) throw new Error(`${field} must not contain duplicates.`);
    result.add(id);
  });
  return result;
}

function exactKeys(record: JsonObject, keys: readonly string[], path: string) {
  const allowed = new Set(keys);
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fail(`${path} is missing ${key}`);
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path} contains an unknown field`);
  }
}

function objectValue(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as JsonObject;
}

function memoryId(value: unknown, path: string, output = true) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    if (output) fail(`${path} must be a valid memory id`);
    throw new Error(`${path} must be a valid memory id.`);
  }
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
  nonempty: boolean
) {
  if (typeof value !== "string" || codePointLength(value) > maximum) {
    fail(`${path} must be a string no longer than ${maximum} characters`);
  }
  if (nonempty && !value.trim()) fail(`${path} must not be empty`);
  return value;
}

function score(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must be between 0 and 1`);
  }
  return value;
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function fail(message: string): never {
  throw new DreamModelOutputContractError(message);
}
