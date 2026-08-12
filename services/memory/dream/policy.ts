import type {
  DreamArchivePolicyResult,
  DreamArchiveRejectionReason,
  DreamLongTermArchiveCandidate,
  DreamPersonaAdjustmentV1,
  DreamPersonaEvidence,
  DreamPersonaImpressionLevel,
  DreamPersonaPolicyResult,
  DreamPersonaRejectionReason
} from "./types.js";
import { normalizeText } from "../domain/normalizers.js";
import {
  isSafeDreamPersonaStatement,
  normalizeDreamPersonaTopicKey
} from "./personaImpressions.js";

export const DREAM_ARCHIVE_MIN_DORMANCY_DAYS = 90;
export const DREAM_ARCHIVE_RECALL_DAY_EXTENSION_DAYS = 30;
export const DREAM_ARCHIVE_MAX_RECALL_EXTENSION_DAYS = 180;
export const DREAM_ARCHIVE_MIN_TRACKING_DAYS = DREAM_ARCHIVE_MIN_DORMANCY_DAYS;
export const DREAM_ARCHIVE_LOW_SCORE_MAX = 0.25;
export const DREAM_PERSONA_MIN_EVIDENCE_EVENTS = 2;
export const DREAM_PERSONA_MIN_CONTEXTS = 2;
export const DREAM_PERSONA_STABLE_MIN_EVIDENCE_EVENTS = 3;
export const DREAM_PERSONA_STABLE_MIN_CONTEXTS = 2;
export const DREAM_PERSONA_STABLE_MIN_SPAN_DAYS = 3;
export const DREAM_PERSONA_CORE_MIN_EVIDENCE_EVENTS = 4;
export const DREAM_PERSONA_CORE_MIN_CONTEXTS = 3;
export const DREAM_PERSONA_CORE_MIN_SPAN_DAYS = 7;
export const DREAM_PERSONA_MIN_IMPACT_SCORE = 0.65;

const DAY_MS = 24 * 60 * 60 * 1_000;
const HIGH_IMPACT_EVENT_TYPES = new Set([
  "boundary",
  "commitment",
  "conflict",
  "goal",
  "identity",
  "relationship",
  "relationship_change",
  "safety"
]);

export function dreamPersonaImpactScore(
  record: Record<string, unknown>,
  scores?: {
    importance?: number | null;
    futureRelevance?: number | null;
    emotionalSalience?: number | null;
  } | null
) {
  const values: number[] = [];
  for (const value of [
    scores?.importance,
    scores?.futureRelevance,
    scores?.emotionalSalience,
    record.importance,
    record.futureRelevance,
    record.emotionalSalience,
    record.relationshipImpact
  ]) {
    if (validScore(value)) values.push(value);
  }
  if (record.relationshipImpact === true || HIGH_IMPACT_EVENT_TYPES.has(normalizeText(record.eventType).toLowerCase())) {
    values.push(1);
  }
  return values.length ? Math.max(...values) : 0;
}

export function evaluateDreamArchiveCandidate(
  candidate: DreamLongTermArchiveCandidate,
  now = new Date()
): DreamArchivePolicyResult {
  const reasons: DreamArchiveRejectionReason[] = [];
  const nowTime = now.getTime();
  const trackingStartedAt = Date.parse(candidate.trackingStartedAt);
  const lastRecalledAt = candidate.lastRecalledAt == null
    ? null
    : Date.parse(candidate.lastRecalledAt);
  if (
    !Number.isFinite(nowTime)
    || !Number.isSafeInteger(candidate.recallCount)
    || candidate.recallCount < 0
    || !Number.isSafeInteger(candidate.distinctRecallDays)
    || candidate.distinctRecallDays < 0
    || candidate.distinctRecallDays > candidate.recallCount
    || !Number.isFinite(trackingStartedAt)
    || trackingStartedAt > nowTime
    || (candidate.recallCount === 0 && candidate.lastRecalledAt !== null)
    || (candidate.recallCount > 0 && (
      lastRecalledAt === null
      || !Number.isFinite(lastRecalledAt)
      || lastRecalledAt < trackingStartedAt
      || lastRecalledAt > nowTime
    ))
    || !validScore(candidate.importance)
    || !validScore(candidate.futureRelevance)
    || !validScore(candidate.emotionalSalience)
    || !validBooleanFields(candidate)
  ) {
    reasons.push("invalid_candidate");
    return { eligible: false, reasons };
  }
  const recallExtensionDays = Math.min(
    candidate.distinctRecallDays * DREAM_ARCHIVE_RECALL_DAY_EXTENSION_DAYS,
    DREAM_ARCHIVE_MAX_RECALL_EXTENSION_DAYS
  );
  const requiredDormancyDays = DREAM_ARCHIVE_MIN_DORMANCY_DAYS + recallExtensionDays;
  const dormancyAnchor = lastRecalledAt ?? trackingStartedAt;
  if (nowTime - dormancyAnchor < requiredDormancyDays * DAY_MS) {
    reasons.push("dormancy_too_short");
  }
  if (candidate.importance > DREAM_ARCHIVE_LOW_SCORE_MAX) reasons.push("importance_too_high");
  if (candidate.futureRelevance > DREAM_ARCHIVE_LOW_SCORE_MAX) reasons.push("future_relevance_too_high");
  if (candidate.emotionalSalience > DREAM_ARCHIVE_LOW_SCORE_MAX) reasons.push("emotional_salience_too_high");
  if (candidate.hasActiveReferences) reasons.push("active_reference");
  if (candidate.protectedFromDream) reasons.push("protected");
  if (candidate.manuallyPinned) reasons.push("manually_pinned");
  if (candidate.unique) reasons.push("unique");
  return { eligible: reasons.length === 0, reasons };
}

export function evaluateDreamPersonaAdjustment(
  adjustment: DreamPersonaAdjustmentV1,
  evidence: readonly DreamPersonaEvidence[],
  options: { now?: Date } = {}
): DreamPersonaPolicyResult {
  const reasons: DreamPersonaRejectionReason[] = [];
  const now = options.now ?? new Date();
  const nowTime = now.getTime();
  if (!validAdjustment(adjustment)) reasons.push("unsupported_adjustment");
  else if (!isSafeDreamPersonaStatement(adjustment.statement)) reasons.push("unsafe_adjustment");

  const evidenceIds = Array.isArray(adjustment.evidenceMemoryIds)
    ? adjustment.evidenceMemoryIds
    : [];
  if (evidenceIds.length < DREAM_PERSONA_MIN_EVIDENCE_EVENTS || new Set(evidenceIds).size !== evidenceIds.length) {
    reasons.push("insufficient_evidence");
  }
  const evidenceById = new Map<string, DreamPersonaEvidence>();
  for (const item of evidence) {
    if (!evidenceById.has(item.id)) evidenceById.set(item.id, item);
  }
  const selected = evidenceIds.map((id) => evidenceById.get(id));
  if (selected.some((item) => !item)) reasons.push("missing_evidence");
  const available = selected.filter((item): item is DreamPersonaEvidence => Boolean(item));
  if (available.some((item) => item.factuality !== "factual")) reasons.push("imagined_evidence");
  if (available.some((item) => !validScore(item.impactScore) || item.impactScore < DREAM_PERSONA_MIN_IMPACT_SCORE)) {
    reasons.push("insufficient_impact");
  }

  const eventIds = new Set(available.map((item) => item.eventId.trim()).filter(Boolean));
  if (eventIds.size < DREAM_PERSONA_MIN_EVIDENCE_EVENTS) reasons.push("insufficient_independent_events");
  const contexts = new Set(available.map((item) => item.context.trim()).filter(Boolean));
  if (contexts.size < DREAM_PERSONA_MIN_CONTEXTS) reasons.push("insufficient_contexts");

  const evidenceTimes = available.map((item) => Date.parse(item.occurredAt));
  if (
    !Number.isFinite(nowTime)
    || evidenceTimes.some((timestamp) => !Number.isFinite(timestamp) || timestamp > nowTime)
  ) {
    reasons.push("invalid_evidence_time");
  }
  const uniqueReasons = [...new Set(reasons)];
  const level = uniqueReasons.length === 0
    ? highestSupportedPersonaLevel(eventIds.size, contexts.size, evidenceTimes)
    : null;
  return { eligible: level !== null, reasons: uniqueReasons, level };
}

function validAdjustment(adjustment: DreamPersonaAdjustmentV1) {
  if (!adjustment || typeof adjustment !== "object") return false;
  const statement = typeof adjustment.statement === "string" ? adjustment.statement.trim() : "";
  if (!statement) return false;
  if (!normalizeDreamPersonaTopicKey(adjustment.topicKey, adjustment.kind)) return false;
  if (adjustment.kind === "relationship_tendency") return adjustment.targetFile === "RELATION.md";
  return (
    (adjustment.kind === "habit" || adjustment.kind === "communication_preference")
    && adjustment.targetFile === "PREFERENCE.md"
  );
}

function highestSupportedPersonaLevel(
  independentEvents: number,
  contexts: number,
  evidenceTimes: readonly number[]
): DreamPersonaImpressionLevel {
  const spanDays = evidenceTimes.length > 1
    ? (Math.max(...evidenceTimes) - Math.min(...evidenceTimes)) / DAY_MS
    : 0;
  if (
    independentEvents >= DREAM_PERSONA_CORE_MIN_EVIDENCE_EVENTS
    && contexts >= DREAM_PERSONA_CORE_MIN_CONTEXTS
    && spanDays >= DREAM_PERSONA_CORE_MIN_SPAN_DAYS
  ) {
    return "core";
  }
  if (
    independentEvents >= DREAM_PERSONA_STABLE_MIN_EVIDENCE_EVENTS
    && contexts >= DREAM_PERSONA_STABLE_MIN_CONTEXTS
    && spanDays >= DREAM_PERSONA_STABLE_MIN_SPAN_DAYS
  ) {
    return "stable";
  }
  return "observation";
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validBooleanFields(candidate: DreamLongTermArchiveCandidate) {
  return [
    candidate.hasActiveReferences,
    candidate.protectedFromDream,
    candidate.manuallyPinned,
    candidate.unique
  ].every((value) => typeof value === "boolean");
}
