import {
  normalizeIsoTimestamp,
  normalizeText,
  sha256,
  uniqueStrings
} from "../domain/normalizers.js";
import type {
  DreamMemoryRecord,
  DreamRecallStatsSnapshot
} from "./consolidation.js";
import type { DreamFactuality } from "./types.js";
import { DREAM_PERSONA_MIN_IMPACT_SCORE, dreamPersonaImpactScore } from "./policy.js";

export const DREAM_RECENT_MEMORY_HOURS = 24;
export const DREAM_RECENT_MEMORY_DAYS = DREAM_RECENT_MEMORY_HOURS / 24;
export const DREAM_RECENT_MEMORY_SELECTION = 24;
export const DREAM_OLDER_MEMORY_SELECTION = 12;
export const DREAM_MEMORY_BUCKET_SELECTION = DREAM_OLDER_MEMORY_SELECTION;
export const DREAM_MAX_MEMORY_SELECTION = 48;
export const DREAM_MAX_RECENT_MEMORY_HOURS = 720;

export interface DreamMemorySelectionSettings {
  recentWindowHours: number;
  recentMemoryLimit: number;
  olderMemoryLimit: number;
}

export type DreamSelectionReason =
  | "recent_fragment"
  | "remote_anchor"
  | "never_recalled_tracked"
  | "low_recall"
  | "important"
  | "future_relevant"
  | "emotionally_salient"
  | "active_task_or_commitment"
  | "dream_material"
  | "review_due"
  | "seeded_association";

export type DreamSelectionLane =
  | "recent"
  | "remote"
  | "recall"
  | "salience"
  | "task"
  | "dream"
  | "review"
  | "seeded_mix";

export interface DreamSelectionScoreComponents {
  ageDays: number | null;
  recency: number;
  remoteness: number;
  recallNeed: number;
  importance: number;
  futureRelevance: number;
  emotionalSalience: number;
  taskRelevance: number;
  dreamMaterial: number;
  reviewNeed: number;
  seededAssociation: number;
}

export interface DreamSelectedMemory {
  id: string;
  source: "working" | "long_term";
  factuality: DreamFactuality;
  record: DreamMemoryRecord;
  recallStats: DreamRecallStatsSnapshot | null;
  score: number;
  scoreComponents: DreamSelectionScoreComponents;
  reasons: DreamSelectionReason[];
  selectedBy: DreamSelectionLane;
}

export interface DreamMemorySelectionInput {
  seed: string;
  now: Date;
  workingRecords: readonly DreamMemoryRecord[];
  longTermRecords: readonly DreamMemoryRecord[];
  recallStats: readonly DreamRecallStatsSnapshot[];
  recentWindowHours?: number;
  recentMemoryLimit?: number;
  olderMemoryLimit?: number;
}

export interface DreamMemorySelection {
  selectedWorking: DreamSelectedMemory[];
  selectedLongTerm: DreamSelectedMemory[];
  personaEvidenceIds: string[];
  fieldKnowledgeEvidenceIds: string[];
  sourceMemoryIds: string[];
}

type Candidate = Omit<DreamSelectedMemory, "selectedBy">;

const DAY_MS = 24 * 60 * 60 * 1_000;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REMOTE_ANCHOR_DAYS = 180;
const SALIENCE_THRESHOLD = 0.65;
const FIELD_KNOWLEDGE_EVENT_TYPES = new Set([
  "boundary",
  "commitment",
  "convention",
  "rule",
  "safety",
  "preference",
  "relationship",
  "relationship_change"
]);

export function selectDreamMemories(input: DreamMemorySelectionInput): DreamMemorySelection {
  const seed = validSeed(input.seed);
  const now = validNow(input.now);
  const settings = selectionSettings(input);
  const recordIds = validateRecords(input.workingRecords, input.longTermRecords);
  const statsById = validateRecallStats(input.recallStats, recordIds.longTerm, now);
  const recentWindowDays = settings.recentWindowHours / 24;
  const recentCutoff = now.getTime() - recentWindowDays * DAY_MS;

  const workingCandidates = input.workingRecords.map((record) => buildCandidate(
    record,
    "working",
    null,
    seed,
    now,
    recentWindowDays
  ));
  const longTermCandidates = input.longTermRecords.map((record) => buildCandidate(
    record,
    "long_term",
    statsById.get(normalizeText(record.id)) ?? null,
    seed,
    now,
    recentWindowDays
  ));

  const candidates = [...workingCandidates, ...longTermCandidates];
  const selected = [
    ...selectRecentCandidates(
      candidates.filter((candidate) => recentMemory(candidate, recentCutoff)),
      settings.recentMemoryLimit
    ),
    ...selectOlderCandidates(
      candidates.filter((candidate) => !recentMemory(candidate, recentCutoff)),
      settings.olderMemoryLimit
    )
  ];
  const selectedWorking = selected.filter((item) => item.source === "working");
  const selectedLongTerm = selected.filter((item) => item.source === "long_term");
  return {
    selectedWorking,
    selectedLongTerm,
    personaEvidenceIds: selected
      .filter((item) => eligiblePersonaEvidence(item.record, item.factuality, item.recallStats, now))
      .map((item) => item.id),
    fieldKnowledgeEvidenceIds: selected
      .filter((item) => eligibleFieldKnowledgeEvidence(item.record, item.factuality))
      .map((item) => item.id),
    sourceMemoryIds: uniqueStrings(selected.map((item) => item.id))
  };
}

function buildCandidate(
  record: DreamMemoryRecord,
  source: DreamSelectedMemory["source"],
  recallStats: DreamRecallStatsSnapshot | null,
  seed: string,
  now: Date,
  recentWindowDays: number
): Candidate {
  const id = normalizeText(record.id);
  const factuality = memoryFactuality(record);
  const ageDays = memoryAgeDays(record, now);
  const importance = scoreValue(recallStats?.importance, record.importance);
  const futureRelevance = scoreValue(recallStats?.futureRelevance, record.futureRelevance);
  const emotionalSalience = scoreValue(recallStats?.emotionalSalience, record.emotionalSalience);
  const taskRelevance = taskMemory(record) ? 1 : 0;
  const dreamMaterial = factuality === "imagined" ? 1 : 0;
  const components: DreamSelectionScoreComponents = {
    ageDays: ageDays === null ? null : rounded(ageDays),
    recency: ageDays === null ? 0 : rounded(1 / (1 + ageDays / (source === "working" ? 7 : 30))),
    remoteness: ageDays === null ? 0 : rounded(Math.min(ageDays / 365, 1)),
    recallNeed: rounded(recallNeed(recallStats, now)),
    importance,
    futureRelevance,
    emotionalSalience,
    taskRelevance,
    dreamMaterial,
    reviewNeed: reviewNeedValue(
      source === "long_term" ? recallStats?.lastReviewedAt ?? record.dreamReviewedAt : record.dreamReviewedAt,
      now
    ),
    seededAssociation: rounded(seededFraction(seed, `${source}:${id}`))
  };
  const score = source === "working"
    ? workingScore(components)
    : longTermScore(components);
  return {
    id,
    source,
    factuality,
    record: structuredClone(record),
    recallStats: recallStats ? structuredClone(recallStats) : null,
    score,
    scoreComponents: components,
    reasons: selectionReasons(components, factuality, recallStats, ageDays, recentWindowDays)
  };
}

function selectRecentCandidates(
  candidates: readonly Candidate[],
  limit: number
): DreamSelectedMemory[] {
  return [...candidates].sort((left, right) => (
    sourcePriority(right) - sourcePriority(left)
    || right.scoreComponents.taskRelevance - left.scoreComponents.taskRelevance
    || recentRelevance(right.scoreComponents) - recentRelevance(left.scoreComponents)
    || right.scoreComponents.seededAssociation - left.scoreComponents.seededAssociation
    || left.id.localeCompare(right.id)
  )).slice(0, limit).map((candidate) => ({ ...candidate, selectedBy: "recent" }));
}

function selectOlderCandidates(
  candidates: readonly Candidate[],
  limit: number
): DreamSelectedMemory[] {
  return [...candidates].sort((left, right) => (
    olderRelevance(right.scoreComponents) - olderRelevance(left.scoreComponents)
    || right.scoreComponents.seededAssociation - left.scoreComponents.seededAssociation
    || left.id.localeCompare(right.id)
  )).slice(0, limit).map((candidate) => ({ ...candidate, selectedBy: "remote" }));
}

function sourcePriority(candidate: Candidate) {
  return candidate.source === "working" ? 1 : 0;
}

function recentRelevance(value: DreamSelectionScoreComponents) {
  return rounded(
    value.futureRelevance * 0.3
    + value.importance * 0.25
    + value.emotionalSalience * 0.2
    + value.recency * 0.15
    + value.reviewNeed * 0.1
  );
}

function olderRelevance(value: DreamSelectionScoreComponents) {
  return rounded(
    value.recallNeed * 0.25
    + value.importance * 0.2
    + value.futureRelevance * 0.2
    + value.emotionalSalience * 0.15
    + value.taskRelevance * 0.1
    + value.reviewNeed * 0.1
  );
}

function recentMemory(candidate: Candidate, cutoff: number) {
  const timestamp = firstTimestamp(
    candidate.record.occurredAt,
    candidate.record.observedAt,
    candidate.record.updatedAt,
    candidate.record.createdAt
  );
  return Boolean(timestamp) && Date.parse(timestamp) >= cutoff;
}

function selectionReasons(
  components: DreamSelectionScoreComponents,
  factuality: DreamFactuality,
  recallStats: DreamRecallStatsSnapshot | null,
  ageDays: number | null,
  recentWindowDays: number
): DreamSelectionReason[] {
  const reasons: DreamSelectionReason[] = [];
  if (ageDays !== null && ageDays <= recentWindowDays) {
    reasons.push("recent_fragment");
  }
  if (components.ageDays !== null && components.ageDays >= REMOTE_ANCHOR_DAYS) reasons.push("remote_anchor");
  if (recallStats?.recallCount === 0) reasons.push("never_recalled_tracked");
  else if (recallStats && recallStats.recallCount <= 2) reasons.push("low_recall");
  if (components.importance >= SALIENCE_THRESHOLD) reasons.push("important");
  if (components.futureRelevance >= SALIENCE_THRESHOLD) reasons.push("future_relevant");
  if (components.emotionalSalience >= SALIENCE_THRESHOLD) reasons.push("emotionally_salient");
  if (components.taskRelevance === 1) reasons.push("active_task_or_commitment");
  if (factuality === "imagined") reasons.push("dream_material");
  if (components.reviewNeed >= 0.5) reasons.push("review_due");
  reasons.push("seeded_association");
  return reasons;
}

function workingScore(value: DreamSelectionScoreComponents) {
  return rounded(
    value.recency * 0.38
    + value.remoteness * 0.04
    + value.importance * 0.11
    + value.futureRelevance * 0.12
    + value.emotionalSalience * 0.12
    + value.taskRelevance * 0.13
    + value.dreamMaterial * 0.1
  );
}

function longTermScore(value: DreamSelectionScoreComponents) {
  return olderRelevance(value);
}

function recallNeed(stats: DreamRecallStatsSnapshot | null, now: Date) {
  if (!stats) return 0;
  if (stats.recallCount === 0) return 1;
  const countNeed = 1 / (1 + stats.recallCount);
  const lastRecalledAt = stats.lastRecalledAt ? Date.parse(stats.lastRecalledAt) : Number.NaN;
  const staleNeed = Number.isFinite(lastRecalledAt)
    ? Math.min(Math.max((now.getTime() - lastRecalledAt) / DAY_MS / 180, 0), 1)
    : 1;
  return countNeed * 0.65 + staleNeed * 0.35;
}

function memoryAgeDays(record: DreamMemoryRecord, now: Date) {
  const timestamp = firstTimestamp(record.occurredAt, record.observedAt, record.updatedAt, record.createdAt);
  if (!timestamp) return null;
  return Math.max((now.getTime() - Date.parse(timestamp)) / DAY_MS, 0);
}

function firstTimestamp(...values: unknown[]) {
  for (const value of values) {
    const timestamp = normalizeIsoTimestamp(value);
    if (timestamp) return timestamp;
  }
  return "";
}

function scoreValue(primary: unknown, fallback: unknown) {
  if (validUnitScore(primary)) return rounded(Number(primary));
  if (validUnitScore(fallback)) return rounded(Number(fallback));
  return 0;
}

function validUnitScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function reviewNeedValue(value: unknown, now: Date) {
  if (value === null || value === undefined || value === "") return 1;
  const reviewedAt = normalizeIsoTimestamp(value);
  if (!reviewedAt || Date.parse(reviewedAt) > now.getTime()) {
    throw new Error("Dream memory review timestamp is invalid.");
  }
  return rounded(Math.min((now.getTime() - Date.parse(reviewedAt)) / DAY_MS / 90, 1));
}

function taskMemory(record: DreamMemoryRecord) {
  const eventType = normalizeText(record.eventType).toLowerCase();
  return record.promoteToLongTerm === true
    || record.hasActiveReferences === true
    || [
      "task",
      "goal",
      "commitment",
      "relationship",
      "relationship_change",
      "conflict",
      "safety",
      "boundary"
    ].includes(eventType);
}

function memoryFactuality(record: DreamMemoryRecord): DreamFactuality {
  return isImagined(record) ? "imagined" : "factual";
}

function isImagined(record: DreamMemoryRecord) {
  return normalizeText(record.memoryKind).toLowerCase() === "dream"
    || normalizeText(record.eventType).toLowerCase() === "dream"
    || normalizeText(record.realityStatus).toLowerCase() === "imagined"
    || normalizeText(record.factuality).toLowerCase() === "imagined";
}

function eligiblePersonaEvidence(
  record: DreamMemoryRecord,
  factuality: DreamFactuality,
  recallStats: DreamRecallStatsSnapshot | null,
  now: Date
) {
  if (factuality !== "factual") return false;
  const declaredFactuality = normalizeText(record.factuality).toLowerCase();
  const realityStatus = normalizeText(record.realityStatus).toLowerCase();
  if (declaredFactuality && declaredFactuality !== "factual") return false;
  if (realityStatus && realityStatus !== "factual") return false;
  if (!normalizeText(record.eventKey)) return false;
  if (!normalizeText(record.conversationId) && !normalizeText(record.contextKey)) return false;
  if (dreamPersonaImpactScore(record, recallStats) < DREAM_PERSONA_MIN_IMPACT_SCORE) return false;
  const occurredAt = firstTimestamp(record.occurredAt, record.createdAt);
  return Boolean(occurredAt) && Date.parse(occurredAt) <= now.getTime();
}

function eligibleFieldKnowledgeEvidence(
  record: DreamMemoryRecord,
  factuality: DreamFactuality
) {
  if (factuality !== "factual") return false;
  const declaredFactuality = normalizeText(record.factuality).toLowerCase();
  const realityStatus = normalizeText(record.realityStatus).toLowerCase();
  if (declaredFactuality && declaredFactuality !== "factual") return false;
  if (realityStatus && realityStatus !== "factual") return false;
  if (!FIELD_KNOWLEDGE_EVENT_TYPES.has(normalizeText(record.eventType).toLowerCase())) return false;
  return [
    record.conversationId,
    record.contextKey,
    record.contextRef,
    record.conversationScope,
    record.scope
  ].some((value) => Boolean(normalizeText(value)));
}

function validateRecords(
  workingRecords: readonly DreamMemoryRecord[],
  longTermRecords: readonly DreamMemoryRecord[]
) {
  if (!Array.isArray(workingRecords) || !Array.isArray(longTermRecords)) {
    throw new Error("Dream selection memories must be arrays.");
  }
  const all = new Set<string>();
  const longTerm = new Set<string>();
  for (const [source, records] of [
    ["working", workingRecords],
    ["long-term", longTermRecords]
  ] as const) {
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`Dream selection ${source} memory must be an object.`);
      }
      const id = normalizeText(record.id);
      if (!MEMORY_ID_PATTERN.test(id)) throw new Error(`Dream selection ${source} memory id is invalid.`);
      if (!normalizeText(record.fact)) throw new Error(`Dream selection memory ${id} has no fact.`);
      if (all.has(id)) throw new Error(`Duplicate dream selection memory id ${id}.`);
      all.add(id);
      if (source === "long-term") longTerm.add(id);
    }
  }
  return { all, longTerm };
}

function validateRecallStats(
  recallStats: readonly DreamRecallStatsSnapshot[],
  longTermIds: ReadonlySet<string>,
  now: Date
) {
  if (!Array.isArray(recallStats)) throw new Error("Dream selection recallStats must be an array.");
  const result = new Map<string, DreamRecallStatsSnapshot>();
  for (const stats of recallStats) {
    if (!stats || typeof stats !== "object") throw new Error("Dream selection recall stats must be objects.");
    const id = normalizeText(stats.recordId);
    if (!longTermIds.has(id)) throw new Error(`Dream selection recall stats reference unknown memory ${id}.`);
    if (result.has(id)) throw new Error(`Duplicate dream selection recall stats for ${id}.`);
    if (
      !Number.isSafeInteger(stats.recallCount)
      || stats.recallCount < 0
      || !Number.isSafeInteger(stats.distinctRecallDays)
      || stats.distinctRecallDays < 0
      || stats.distinctRecallDays > stats.recallCount
    ) {
      throw new Error(`Dream selection recall counts for ${id} are invalid.`);
    }
    const trackingStartedAt = parsePastTimestamp(stats.trackingStartedAt, now);
    const lastRecalledAt = parseOptionalPastTimestamp(stats.lastRecalledAt, now);
    const lastReviewedAt = parseOptionalPastTimestamp(stats.lastReviewedAt, now);
    if (
      (stats.recallCount === 0 && lastRecalledAt !== null)
      || (stats.recallCount > 0 && lastRecalledAt === null)
      || !validNullableScore(stats.importance)
      || !validNullableScore(stats.futureRelevance)
      || !validNullableScore(stats.emotionalSalience)
    ) {
      throw new Error(`Dream selection recall stats for ${id} are inconsistent.`);
    }
    result.set(id, {
      ...structuredClone(stats),
      recordId: id,
      trackingStartedAt,
      lastRecalledAt,
      lastReviewedAt
    });
  }
  return result;
}

function parsePastTimestamp(value: unknown, now: Date) {
  const timestamp = normalizeIsoTimestamp(value);
  if (!timestamp || Date.parse(timestamp) > now.getTime()) {
    throw new Error("Dream selection recall timestamp is invalid.");
  }
  return timestamp;
}

function parseOptionalPastTimestamp(value: unknown, now: Date) {
  if (value === null || value === undefined || value === "") return null;
  return parsePastTimestamp(value, now);
}

function validNullableScore(value: unknown) {
  return value === null || validUnitScore(value);
}

function validSeed(value: unknown) {
  const seed = normalizeText(value);
  if (!seed || Array.from(seed).length > 512) throw new Error("Dream selection seed is invalid.");
  return seed;
}

function selectionSettings(input: DreamMemorySelectionInput): DreamMemorySelectionSettings {
  const recentWindowHours = selectionInteger(
    input.recentWindowHours ?? DREAM_RECENT_MEMORY_HOURS,
    "recentWindowHours",
    1,
    DREAM_MAX_RECENT_MEMORY_HOURS
  );
  const recentMemoryLimit = selectionInteger(
    input.recentMemoryLimit ?? DREAM_RECENT_MEMORY_SELECTION,
    "recentMemoryLimit",
    0,
    DREAM_MAX_MEMORY_SELECTION
  );
  const olderMemoryLimit = selectionInteger(
    input.olderMemoryLimit ?? DREAM_OLDER_MEMORY_SELECTION,
    "olderMemoryLimit",
    0,
    DREAM_MAX_MEMORY_SELECTION
  );
  if (recentMemoryLimit + olderMemoryLimit < 1 || recentMemoryLimit + olderMemoryLimit > DREAM_MAX_MEMORY_SELECTION) {
    throw new Error(`Dream selection total memory limit must be between 1 and ${DREAM_MAX_MEMORY_SELECTION}.`);
  }
  return { recentWindowHours, recentMemoryLimit, olderMemoryLimit };
}

function selectionInteger(value: unknown, field: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`Dream selection ${field} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

function validNow(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Dream selection time is invalid.");
  }
  return new Date(value.getTime());
}

function seededFraction(seed: string, key: string) {
  const hash = sha256(`${seed}\u0000${key}`);
  return Number.parseInt(hash.slice(0, 13), 16) / 0xfffffffffffff;
}

function rounded(value: number) {
  return Number(value.toFixed(6));
}
