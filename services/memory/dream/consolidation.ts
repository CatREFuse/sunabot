import {
  computeMemoryEventFingerprint,
  computeMemoryEventKey,
  isMemoryCausalChainKey,
  normalizeAddressNames,
  normalizeIsoTimestamp,
  normalizeStringArray,
  normalizeText,
  normalizeUserIds,
  sha256,
  uniqueStrings
} from "../domain/normalizers.js";
import { dreamPersonaImpactScore, evaluateDreamArchiveCandidate } from "./policy.js";
import type {
  DreamModelOutputV1,
  DreamPersonaEvidence
} from "./types.js";

export type DreamMemoryRecord = Record<string, unknown>;

export const DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE = 0.9;

export interface DreamRecallStatsSnapshot {
  recordId: string;
  recallCount: number;
  distinctRecallDays: number;
  lastRecalledAt: string | null;
  trackingStartedAt: string;
  lastReviewedAt: string | null;
  importance: number | null;
  futureRelevance: number | null;
  emotionalSalience: number | null;
}

export interface DreamConsolidationInput {
  runId: string;
  localDate: string;
  scheduledFor: string;
  seed: string;
  now: Date;
  output: DreamModelOutputV1;
  workingRecords: readonly DreamMemoryRecord[];
  longTermRecords: readonly DreamMemoryRecord[];
  recallStats: readonly DreamRecallStatsSnapshot[];
  recentWindowHours?: number;
}

export interface DreamConsolidationPlan {
  workingMemoryId: string;
  working: DreamMemoryRecord[];
  longTerm: DreamMemoryRecord[];
  archives: Array<{
    recordId: string;
    data: DreamMemoryRecord;
    reason: string;
    recallSnapshot: {
      recallCount: number;
      distinctRecallDays: number;
      lastRecalledAt: string | null;
      trackingStartedAt: string;
    };
  }>;
  reviews: Array<{
    recordId: string;
    sourceIds: string[];
    importance: number;
    futureRelevance: number;
    emotionalSalience: number;
  }>;
  recallLineages: Array<{ targetId: string; sourceIds: string[] }>;
  personaEvidence: DreamPersonaEvidence[];
  result: {
    schemaVersion: 1;
    merged: number;
    archived: number;
    promoted: number;
    discarded: number;
    rewritten: number;
    retained: number;
  };
}


export function buildDreamConsolidationPlan(input: DreamConsolidationInput): DreamConsolidationPlan {
  const validNow = validDate(input.now);
  const now = validNow.toISOString();
  const recentCutoff = validNow.getTime() - recentWindowHours(input.recentWindowHours) * 60 * 60_000;
  const working = recordMap(input.workingRecords, "working");
  const longTerm = recordMap(input.longTermRecords, "long_term");
  const stats = new Map(input.recallStats.map((item) => [item.recordId, item]));
  const activeLongTermIds = new Set(
    input.workingRecords.flatMap((record) => [
      normalizeText(record.longTermId),
      ...normalizeStringArray(record.sourceLongTermMemoryIds)
    ]).filter(Boolean)
  );
  const archives: DreamConsolidationPlan["archives"] = [];
  const reviews: DreamConsolidationPlan["reviews"] = [];
  const recallLineages: DreamConsolidationPlan["recallLineages"] = [];
  let merged = 0;
  let archived = 0;
  let promoted = 0;
  let discarded = 0;
  let rewritten = 0;
  let retained = 0;

  for (const review of input.output.longTermReviews) {
    const records = softLinkedRecords(longTerm, review.sourceIds);
    if (!records) continue;
    if (review.action === "retain") {
      retained += 1;
      reviews.push(reviewUpdate(review.sourceIds[0]!, review.sourceIds, review));
      continue;
    }
    if (records.some((record) => recentFactualMemory(record, recentCutoff))) {
      retained += retainLongTermRecords(review, reviews);
      continue;
    }
    if (records.some(immutableMemory)) {
      retained += retainLongTermRecords(review, reviews);
      continue;
    }
    if (review.action === "rewrite") {
      const record = records[0]!;
      const targetId = recordId(record);
      longTerm.set(targetId, mergeMemoryRecords([record], targetId, review.canonical!.fact, now, {
        dreamRunId: input.runId
      }));
      reviews.push(reviewUpdate(targetId, review.sourceIds, review));
      rewritten += 1;
      continue;
    }
    if (review.action === "merge") {
      assertCompatibleReality(records);
      const stable = oldestRecord(records);
      const targetId = recordId(stable);
      for (const id of review.sourceIds) longTerm.delete(id);
      const canonical = mergeMemoryRecords(records, targetId, review.canonical!.fact, now, {
        dreamRunId: input.runId,
        sourceWorkingMemoryIds: records.flatMap((record) => normalizeStringArray(record.sourceWorkingMemoryIds))
      });
      longTerm.set(targetId, canonical);
      recallLineages.push({ targetId, sourceIds: review.sourceIds });
      reviews.push(reviewUpdate(targetId, review.sourceIds, review));
      merged += review.sourceIds.length - 1;
      continue;
    }

    const record = records[0]!;
    const recordStats = stats.get(review.sourceIds[0]!);
    if (!highConfidence(review.confidence) || !recordStats) {
      retained += retainLongTermRecords(review, reviews);
      continue;
    }
    const policy = evaluateDreamArchiveCandidate({
      recallCount: recordStats.recallCount,
      distinctRecallDays: recordStats.distinctRecallDays,
      lastRecalledAt: recordStats.lastRecalledAt,
      trackingStartedAt: recordStats.trackingStartedAt,
      importance: review.importance,
      futureRelevance: review.futureRelevance,
      emotionalSalience: review.emotionalSalience,
      hasActiveReferences: activeLongTermIds.has(review.sourceIds[0]!),
      protectedFromDream: protectedMemory(record),
      manuallyPinned: manualMemory(record),
      unique: record.unique === true
    }, input.now);
    if (!policy.eligible) {
      retained += 1;
      reviews.push(reviewUpdate(review.sourceIds[0]!, review.sourceIds, review));
      continue;
    }
    longTerm.delete(review.sourceIds[0]!);
    archives.push({
      recordId: review.sourceIds[0]!,
      data: {
        ...record,
        dreamArchive: {
          recallCount: recordStats.recallCount,
          distinctRecallDays: recordStats.distinctRecallDays,
          lastRecalledAt: recordStats.lastRecalledAt,
          trackingStartedAt: recordStats.trackingStartedAt,
          importance: review.importance,
          futureRelevance: review.futureRelevance,
          emotionalSalience: review.emotionalSalience
        }
      },
      reason: review.reason || "dream_archive_policy",
      recallSnapshot: {
        recallCount: recordStats.recallCount,
        distinctRecallDays: recordStats.distinctRecallDays,
        lastRecalledAt: recordStats.lastRecalledAt,
        trackingStartedAt: recordStats.trackingStartedAt
      }
    });
    archived += 1;
  }

  for (const review of input.output.workingReviews) {
    const records = softLinkedRecords(working, review.sourceIds);
    if (!records) continue;
    const oldDreams = records.filter((record) => isDreamMemory(record) && dreamDate(record) < input.localDate);
    if (records.some((record) => recentFactualMemory(record, recentCutoff))) {
      markMutableWorkingReviewed(working, records, now);
      retained += records.length;
      continue;
    }
    if (records.some(immutableMemory)) {
      markMutableWorkingReviewed(working, records, now);
      retained += records.length;
      continue;
    }
    if (oldDreams.length && oldDreams.length !== records.length) {
      throw new Error("Dream memory cannot be consolidated with factual working memory.");
    }
    const action = oldDreams.length ? "promote" : review.action;
    if (action === "retain") {
      markWorkingReviewed(working, records, now);
      retained += 1;
      continue;
    }
    if (action === "rewrite") {
      const record = records[0]!;
      const targetId = recordId(record);
      working.set(targetId, mergeMemoryRecords([record], targetId, review.canonical!.fact, now, {
        dreamRunId: input.runId,
        dreamReviewedAt: now
      }));
      rewritten += 1;
      continue;
    }
    if (action === "discard" && (
      !highConfidence(review.confidence)
      || protectedMemory(records[0]!)
      || manualMemory(records[0]!)
    )) {
      markWorkingReviewed(working, records, now);
      retained += 1;
      continue;
    }
    if (action === "discard") {
      working.delete(review.sourceIds[0]!);
      discarded += 1;
      continue;
    }
    if (action === "merge") {
      assertCompatibleReality(records);
      const stable = oldestRecord(records);
      const targetId = recordId(stable);
      for (const id of review.sourceIds) working.delete(id);
      working.set(targetId, mergeMemoryRecords(records, targetId, review.canonical!.fact, now, {
        dreamRunId: input.runId,
        dreamReviewedAt: now
      }));
      merged += review.sourceIds.length - 1;
      continue;
    }

    assertCompatibleReality(records);
    for (const id of review.sourceIds) working.delete(id);
    const canonicalText = review.canonical?.fact
      ?? records.map((record) => normalizeText(record.fact)).filter(Boolean).join("；");
    const targetId = promotedLongTermId(records, input.runId);
    const promotedRecord = mergeMemoryRecords(records, targetId, canonicalText, now, {
      dreamRunId: input.runId,
      dreamReviewedAt: now,
      sourceWorkingMemoryIds: review.sourceIds,
      promoteToLongTerm: false,
      longTermId: undefined
    });
    const existing = longTerm.get(targetId);
    const nextLongTerm = existing
      ? mergeMemoryRecords([existing, promotedRecord], targetId, canonicalText, now, {
          dreamRunId: input.runId,
          dreamReviewedAt: now,
          sourceWorkingMemoryIds: review.sourceIds
        })
      : promotedRecord;
    assertPromotedLongTermMapping(nextLongTerm, review.sourceIds, records, canonicalText, input.runId, now);
    longTerm.set(targetId, nextLongTerm);
    promoted += 1;
  }

  const workingMemoryId = `working_dream_${input.localDate.replaceAll("-", "_")}`;
  working.set(workingMemoryId, dreamWorkingMemory(input, workingMemoryId, now));
  const personaEvidence = buildPersonaEvidence(
    [...input.workingRecords, ...input.longTermRecords],
    input.recallStats
  );
  return {
    workingMemoryId,
    working: [...working.values()],
    longTerm: [...longTerm.values()],
    archives,
    reviews,
    recallLineages,
    personaEvidence,
    result: {
      schemaVersion: 1,
      merged,
      archived,
      promoted,
      discarded,
      rewritten,
      retained
    }
  };
}

export function buildPersonaEvidence(
  records: readonly DreamMemoryRecord[],
  recallStats: readonly DreamRecallStatsSnapshot[] = []
): DreamPersonaEvidence[] {
  const statsById = new Map(recallStats.map((item) => [item.recordId, item]));
  return records.flatMap((record) => {
    const id = recordId(record, false);
    const eventId = normalizeText(record.eventKey) || normalizeText(record.eventRef);
    const context = normalizeText(record.conversationId)
      || normalizeText(record.contextKey)
      || normalizeText(record.contextRef);
    const occurredAt = normalizeIsoTimestamp(record.occurredAt ?? record.createdAt);
    if (!id || !eventId || !context || !occurredAt || isDreamMemory(record)) return [];
    return [{
      id,
      eventId,
      context,
      occurredAt,
      factuality: "factual" as const,
      impactScore: dreamPersonaImpactScore(record, statsById.get(id))
    }];
  });
}

function softLinkedRecords(
  records: ReadonlyMap<string, DreamMemoryRecord>,
  sourceIds: readonly string[]
) {
  const linked = sourceIds.map((id) => records.get(id));
  return linked.some((record) => record == null)
    ? null
    : linked as DreamMemoryRecord[];
}

function dreamWorkingMemory(input: DreamConsolidationInput, id: string, now: string): DreamMemoryRecord {
  const eventKey = `dream:${input.localDate}`;
  const record: DreamMemoryRecord = {
    schemaVersion: 2,
    id,
    fact: input.output.dream.text,
    source: "sunabot.dream",
    memoryKind: "dream",
    realityStatus: "imagined",
    factuality: "imagined",
    eventType: "dream",
    subjectKey: `dream:${input.localDate}`,
    eventKey,
    occurredAt: input.scheduledFor,
    occurredEndAt: null,
    observedAt: now,
    createdAt: now,
    updatedAt: now,
    userIds: [],
    addressNames: [],
    sourceMemoryIds: uniqueStrings([
      ...input.output.workingReviews.flatMap((review) => review.sourceIds),
      ...input.output.longTermReviews.flatMap((review) => review.sourceIds)
    ]),
    dreamRunId: input.runId,
    dreamDate: input.localDate,
    dreamReviewedAt: now,
    randomSeed: input.seed,
    promoteToLongTerm: false
  };
  record.eventFingerprint = computeMemoryEventFingerprint({
    fact: record.fact,
    userIds: [],
    occurredAt: input.scheduledFor
  });
  return record;
}

function mergeMemoryRecords(
  records: readonly DreamMemoryRecord[],
  id: string,
  fact: string,
  now: string,
  overrides: DreamMemoryRecord
): DreamMemoryRecord {
  const stable = oldestRecord(records);
  const userIds = uniqueStrings(records.flatMap((record) => [
    ...normalizeUserIds(record.userIds),
    ...normalizeUserIds(record.userId)
  ])).sort();
  const eventType = sameText(records, "eventType") || normalizeText(stable.eventType) || "other";
  const subjectKey = sameText(records, "subjectKey") || normalizeText(stable.subjectKey);
  const eventKey = sameText(records, "eventKey");
  const causalChainKey = retainedCausalChainKey(records);
  const occurredAt = earliestTimestamp(records, "occurredAt");
  const occurredEndAt = latestTimestamp(records, "occurredEndAt");
  const next: DreamMemoryRecord = {
    ...stable,
    ...overrides,
    schemaVersion: 2,
    id,
    fact,
    userIds,
    addressNames: uniqueStrings(records.flatMap((record) => normalizeAddressNames(record.addressNames))).sort(),
    sourceWorkingMemoryIds: uniqueStrings([
      ...records.flatMap((record) => normalizeStringArray(record.sourceWorkingMemoryIds)),
      ...normalizeStringArray(overrides.sourceWorkingMemoryIds)
    ]).sort(),
    sourceCandidateIds: uniqueStrings(records.flatMap((record) => normalizeStringArray(record.sourceCandidateIds))).sort(),
    eventType,
    subjectKey,
    occurredAt: occurredAt || null,
    occurredEndAt: occurredEndAt || null,
    observedAt: earliestTimestamp(records, "observedAt") || null,
    createdAt: earliestTimestamp(records, "createdAt") || now,
    updatedAt: now,
    consolidatedBy: "sunabot.dream"
  };
  if (eventKey) next.eventKey = eventKey;
  else {
    delete next.eventKey;
    if (eventType && subjectKey) next.eventKey = computeMemoryEventKey(eventType, subjectKey, userIds);
  }
  if (causalChainKey) next.causalChainKey = causalChainKey;
  else delete next.causalChainKey;
  next.eventFingerprint = computeMemoryEventFingerprint({ fact: next.fact, userIds, occurredAt, occurredEndAt });
  delete next.addressName;
  delete next.address_name;
  delete next.salutation;
  if (overrides.longTermId === undefined) delete next.longTermId;
  return next;
}

function assertPromotedLongTermMapping(
  record: DreamMemoryRecord,
  sourceIds: readonly string[],
  sources: readonly DreamMemoryRecord[],
  canonicalFact: string,
  runId: string,
  updatedAt: string
) {
  const expectedUserIds = uniqueStrings(sources.flatMap((source) => [
    ...normalizeUserIds(source.userIds),
    ...normalizeUserIds(source.userId)
  ])).sort();
  const expectedAddressNames = uniqueStrings(
    sources.flatMap((source) => normalizeAddressNames(source.addressNames))
  ).sort();
  const expectedSourceIds = uniqueStrings([
    ...sources.flatMap((source) => normalizeStringArray(source.sourceWorkingMemoryIds)),
    ...sourceIds
  ]).sort();
  const expectedOccurredAt = earliestTimestamp(sources, "occurredAt");
  const expectedOccurredEndAt = latestTimestamp(sources, "occurredEndAt");
  const expectedEventType = sameText(sources, "eventType")
    || normalizeText(oldestRecord(sources).eventType)
    || "other";
  const expectedSubjectKey = sameText(sources, "subjectKey")
    || normalizeText(oldestRecord(sources).subjectKey);
  const expectedEventKey = sameText(sources, "eventKey")
    || (
      expectedEventType && expectedSubjectKey
        ? computeMemoryEventKey(expectedEventType, expectedSubjectKey, expectedUserIds)
        : ""
    );
  const expectedCausalChainKey = retainedCausalChainKey(sources);
  const expectedFingerprint = computeMemoryEventFingerprint({
    fact: canonicalFact,
    userIds: expectedUserIds,
    occurredAt: expectedOccurredAt,
    occurredEndAt: expectedOccurredEndAt
  });
  const valid = record.schemaVersion === 2
    && recordId(record, false) === promotedLongTermId(sources, runId)
    && record.fact === canonicalFact
    && JSON.stringify(normalizeStringArray(record.sourceWorkingMemoryIds).sort())
      === JSON.stringify(expectedSourceIds)
    && JSON.stringify(normalizeUserIds(record.userIds).sort()) === JSON.stringify(expectedUserIds)
    && JSON.stringify(normalizeAddressNames(record.addressNames).sort()) === JSON.stringify(expectedAddressNames)
    && normalizeIsoTimestamp(record.occurredAt) === expectedOccurredAt
    && normalizeIsoTimestamp(record.occurredEndAt) === expectedOccurredEndAt
    && normalizeText(record.eventKey) === expectedEventKey
    && normalizeText(record.causalChainKey) === expectedCausalChainKey
    && normalizeText(record.dreamRunId) === runId
    && normalizeText(record.consolidatedBy) === "sunabot.dream"
    && normalizeIsoTimestamp(record.updatedAt) === updatedAt
    && normalizeText(record.eventFingerprint) === expectedFingerprint;
  if (valid) return;
  throw Object.assign(
    new Error("Dream promotion did not satisfy the long-term memory mapping contract."),
    {
      code: "DREAM_CONSOLIDATION_MAPPING_INVALID",
      retryable: false
    }
  );
}

function reviewUpdate(
  recordIdValue: string,
  sourceIds: string[],
  review: DreamModelOutputV1["longTermReviews"][number]
) {
  return {
    recordId: recordIdValue,
    sourceIds,
    importance: review.importance,
    futureRelevance: review.futureRelevance,
    emotionalSalience: review.emotionalSalience
  };
}

function retainLongTermRecords(
  review: DreamModelOutputV1["longTermReviews"][number],
  reviews: DreamConsolidationPlan["reviews"]
) {
  for (const sourceId of review.sourceIds) {
    reviews.push(reviewUpdate(sourceId, [sourceId], review));
  }
  return review.sourceIds.length;
}

function markWorkingReviewed(
  working: Map<string, DreamMemoryRecord>,
  records: readonly DreamMemoryRecord[],
  now: string
) {
  for (const record of records) {
    working.set(recordId(record), { ...record, dreamReviewedAt: now });
  }
}

function markMutableWorkingReviewed(
  working: Map<string, DreamMemoryRecord>,
  records: readonly DreamMemoryRecord[],
  now: string
) {
  markWorkingReviewed(working, records.filter((record) => !immutableMemory(record)), now);
}

function highConfidence(confidence: number) {
  return confidence >= DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE;
}

function sharedValidCausalChainKey(records: readonly DreamMemoryRecord[]) {
  if (records.length < 2) return "";
  const values = records.map((record) => record.causalChainKey);
  if (!values.every(isMemoryCausalChainKey)) return "";
  return new Set(values).size === 1 ? values[0]! : "";
}

function retainedCausalChainKey(records: readonly DreamMemoryRecord[]) {
  if (records.length === 1) {
    const value = records[0]!.causalChainKey;
    return isMemoryCausalChainKey(value) ? value : "";
  }
  return sharedValidCausalChainKey(records);
}

function promotedLongTermId(records: readonly DreamMemoryRecord[], runId: string) {
  const dream = records.find(isDreamMemory);
  const date = dream ? dreamDate(dream) : "";
  if (date) return `long_term_dream_${date.replaceAll("-", "_")}`;
  return `long_term_${sha256(JSON.stringify({ runId, ids: records.map((record) => recordId(record)).sort() })).slice(0, 32)}`;
}

function protectedMemory(record: DreamMemoryRecord) {
  return record.protectedFromDream === true
    || record.protected === true
    || record.explicitRemember === true;
}

function manualMemory(record: DreamMemoryRecord) {
  const source = normalizeText(record.source).toLowerCase();
  return record.manuallyPinned === true
    || record.pinned === true
    || source === "manual"
    || source === "admin"
    || source === "sunabot.memory.ui"
    || source === "sunabot.memory.admin";
}

function immutableMemory(record: DreamMemoryRecord) {
  return manualMemory(record) || protectedMemory(record);
}

function isDreamMemory(record: DreamMemoryRecord) {
  return normalizeText(record.memoryKind) === "dream"
    || normalizeText(record.eventType) === "dream"
    || normalizeText(record.realityStatus) === "imagined"
    || normalizeText(record.factuality) === "imagined";
}

function recentFactualMemory(record: DreamMemoryRecord, cutoff: number) {
  if (isDreamMemory(record)) return false;
  for (const value of [
    record.occurredAt,
    record.observedAt,
    record.updatedAt,
    record.createdAt
  ]) {
    const timestamp = normalizeIsoTimestamp(value);
    if (timestamp) return Date.parse(timestamp) >= cutoff;
  }
  return false;
}

function dreamDate(record: DreamMemoryRecord) {
  return normalizeText(record.dreamDate) || normalizeIsoTimestamp(record.occurredAt).slice(0, 10);
}

function assertCompatibleReality(records: readonly DreamMemoryRecord[]) {
  const states = new Set(records.map((record) => isDreamMemory(record) ? "imagined" : "factual"));
  if (states.size > 1) throw new Error("Imagined and factual memories cannot be merged.");
}

function recordMap(records: readonly DreamMemoryRecord[], source: string) {
  const result = new Map<string, DreamMemoryRecord>();
  for (const record of records) {
    const id = recordId(record);
    if (result.has(id)) throw new Error(`Duplicate ${source} memory id ${id}.`);
    result.set(id, structuredClone(record));
  }
  return result;
}

function recordId(record: DreamMemoryRecord, required = true) {
  const id = normalizeText(record.id);
  if (!id && required) throw new Error("Dream consolidation requires stable memory ids.");
  return id;
}

function oldestRecord(records: readonly DreamMemoryRecord[]) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(normalizeText(left.createdAt));
    const rightTime = Date.parse(normalizeText(right.createdAt));
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return recordId(left).localeCompare(recordId(right));
  })[0]!;
}

function sameText(records: readonly DreamMemoryRecord[], field: string) {
  const values = uniqueStrings(records.map((record) => normalizeText(record[field])).filter(Boolean));
  return values.length === 1 ? values[0]! : "";
}

function earliestTimestamp(records: readonly DreamMemoryRecord[], field: string) {
  return timestampValues(records, field).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? "";
}

function latestTimestamp(records: readonly DreamMemoryRecord[], field: string) {
  return timestampValues(records, field).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "";
}

function timestampValues(records: readonly DreamMemoryRecord[], field: string) {
  return uniqueStrings(records.map((record) => normalizeIsoTimestamp(record[field])).filter(Boolean));
}

function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Dream consolidation time is invalid.");
  return value;
}

function recentWindowHours(value: number | undefined) {
  const hours = value ?? 24;
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) {
    throw new Error("Dream consolidation recentWindowHours must be an integer between 1 and 720.");
  }
  return hours;
}
