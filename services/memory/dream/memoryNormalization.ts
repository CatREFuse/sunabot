import {
  computeMemoryEventFingerprint,
  computeMemoryEventKey,
  normalizeAddressNames,
  normalizeText,
  normalizeUserIds,
  readMemoryCausalChainKey,
  sha256
} from "../domain/normalizers.js";
import type { DreamMemoryRecord } from "./consolidation.js";
import type { DreamRecallStatsSnapshot } from "./consolidation.js";

const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY_FACT_FIELDS = ["fact", "text", "content", "summary", "memory", "description", "value"];

export function normalizeDreamMemorySnapshot(input: {
  workingRecords: readonly DreamMemoryRecord[];
  longTermRecords: readonly DreamMemoryRecord[];
}) {
  const usedIds = new Set<string>();
  return {
    workingRecords: normalizeRecords(input.workingRecords, "working", usedIds),
    longTermRecords: normalizeRecords(input.longTermRecords, "long_term", usedIds)
  };
}

export function dreamRecallTrackingIds(records: readonly DreamMemoryRecord[]) {
  return uniqueStoredIds(records.flatMap((record) => {
    const id = storedMemoryId(record.id);
    return id == null ? [] : [id];
  }));
}

export function dreamRecallLookupIds(records: readonly DreamMemoryRecord[]) {
  return uniqueStoredIds(records.flatMap((record) => {
    const id = storedMemoryId(record.id);
    const legacyId = storedMemoryId(record.legacyMemoryId);
    return [id, legacyId].filter((value): value is string => value != null);
  }));
}

export function dreamLegacyRecallLineages(records: readonly DreamMemoryRecord[]) {
  const canonicalIds = new Set(records.flatMap((record) => {
    const id = canonicalMemoryId(record.id);
    return id == null ? [] : [id];
  }));
  const legacyCounts = new Map<string, number>();
  for (const record of records) {
    const sourceId = storedMemoryId(record.legacyMemoryId);
    if (sourceId != null) legacyCounts.set(sourceId, (legacyCounts.get(sourceId) ?? 0) + 1);
  }
  return records.flatMap((record) => {
    const targetId = canonicalMemoryId(record.id);
    const sourceId = storedMemoryId(record.legacyMemoryId);
    if (targetId == null || sourceId == null || sourceId === targetId || canonicalIds.has(sourceId) ||
      legacyCounts.get(sourceId) !== 1) return [];
    return [{ targetId, sourceIds: [sourceId] }];
  });
}

export function composeDreamRecallLineages(
  lineages: readonly { targetId: string; sourceIds: readonly string[] }[],
  records: readonly DreamMemoryRecord[]
) {
  const groups = new Map<string, Set<string>>();
  const ownerBySource = new Map<string, string>();
  for (const lineage of lineages) {
    const group = groups.get(lineage.targetId) ?? new Set<string>();
    for (const sourceId of lineage.sourceIds) {
      group.add(sourceId);
      ownerBySource.set(sourceId, lineage.targetId);
    }
    groups.set(lineage.targetId, group);
  }
  for (const lineage of dreamLegacyRecallLineages(records)) {
    const targetId = ownerBySource.get(lineage.targetId) ?? lineage.targetId;
    const group = groups.get(targetId) ?? new Set<string>();
    for (const sourceId of lineage.sourceIds) group.add(sourceId);
    groups.set(targetId, group);
  }
  return [...groups].map(([targetId, sourceIds]) => ({ targetId, sourceIds: [...sourceIds] }));
}

export function projectDreamRecallStats(input: {
  records: readonly DreamMemoryRecord[];
  stats: readonly DreamRecallStatsSnapshot[];
  trackingStartedAt: string;
}) {
  const statsById = new Map(input.stats.map((item) => [item.recordId, item]));
  return input.records.map((record): DreamRecallStatsSnapshot => {
    const recordId = canonicalMemoryId(record.id);
    if (recordId == null) throw new Error("Dream normalized long-term memory has an invalid canonical ID.");
    const aliases = uniqueStoredIds([recordId, storedMemoryId(record.legacyMemoryId)]
      .filter((value): value is string => value != null));
    const matches = aliases.flatMap((id) => {
      const item = statsById.get(id);
      return item == null ? [] : [item];
    });
    const latestReview = latestStats(matches, "lastReviewedAt");
    return {
      recordId,
      recallCount: matches.reduce((sum, item) => sum + item.recallCount, 0),
      distinctRecallDays: matches.reduce((maximum, item) => Math.max(maximum, item.distinctRecallDays), 0),
      lastRecalledAt: latestTimestamp(matches.map((item) => item.lastRecalledAt)),
      trackingStartedAt: earliestTimestamp(
        matches.map((item) => item.trackingStartedAt),
        input.trackingStartedAt
      ),
      lastReviewedAt: latestReview?.lastReviewedAt ?? null,
      importance: maximumScore(matches.map((item) => item.importance), latestReview?.importance),
      futureRelevance: maximumScore(matches.map((item) => item.futureRelevance), latestReview?.futureRelevance),
      emotionalSalience: maximumScore(
        matches.map((item) => item.emotionalSalience),
        latestReview?.emotionalSalience
      )
    };
  });
}

function normalizeRecords(
  records: readonly DreamMemoryRecord[],
  source: "working" | "long_term",
  usedIds: Set<string>
) {
  if (!Array.isArray(records)) throw new Error(`Dream ${source} memories must be an array.`);
  return records.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Dream ${source} memory ${index} must be an object.`);
    }
    const record = structuredClone(value);
    const originalId = normalizeText(record.id);
    const id = stableMemoryId(record, source, index, usedIds);
    const fact = legacyFact(record, id);
    const userIds = normalizeUserIds(record.userIds ?? record.userId);
    const eventType = normalizeText(record.eventType);
    const subjectKey = normalizeText(record.subjectKey);
    const eventKey = normalizeText(record.eventKey)
      || computeMemoryEventKey(eventType, subjectKey, userIds);
    const next: DreamMemoryRecord = {
      ...record,
      schemaVersion: 2,
      id,
      fact,
      userIds,
      addressNames: normalizeAddressNames(
        record.addressNames ?? record.addressName ?? record.address_name ?? record.salutation
      )
    };
    if (originalId && originalId !== id) next.legacyMemoryId = originalId;
    if (eventKey) next.eventKey = eventKey;
    const causalChainKey = readMemoryCausalChainKey(record.causalChainKey ?? record.causal_chain_key);
    if (causalChainKey) next.causalChainKey = causalChainKey;
    else delete next.causalChainKey;
    delete next.causal_chain_key;
    if (!normalizeText(next.eventFingerprint)) {
      next.eventFingerprint = computeMemoryEventFingerprint({
        fact,
        userIds,
        occurredAt: record.occurredAt ?? record.time,
        occurredEndAt: record.occurredEndAt
      });
    }
    delete next.addressName;
    delete next.address_name;
    delete next.salutation;
    return next;
  });
}

function stableMemoryId(
  record: DreamMemoryRecord,
  source: "working" | "long_term",
  index: number,
  usedIds: Set<string>
) {
  const current = normalizeText(record.id);
  if (MEMORY_ID_PATTERN.test(current) && !usedIds.has(current)) {
    usedIds.add(current);
    return current;
  }
  let attempt = 0;
  while (true) {
    const digest = sha256(JSON.stringify({ source, index, attempt, record }));
    const candidate = `legacy_${source}_${digest.slice(0, 32)}`;
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
    attempt += 1;
  }
}

function canonicalMemoryId(value: unknown) {
  const id = normalizeText(value);
  return MEMORY_ID_PATTERN.test(id) ? id : null;
}

function storedMemoryId(value: unknown) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  const length = [...id].length;
  return length >= 1 && length <= 128 ? id : null;
}

function uniqueStoredIds(values: readonly string[]) {
  return [...new Set(values)];
}

function latestStats(
  stats: readonly DreamRecallStatsSnapshot[],
  field: "lastRecalledAt" | "lastReviewedAt"
) {
  return [...stats]
    .filter((item) => item[field] != null)
    .sort((left, right) => String(right[field]).localeCompare(String(left[field])))[0];
}

function latestTimestamp(values: readonly (string | null)[]) {
  return values.filter((value): value is string => value != null).sort().at(-1) ?? null;
}

function earliestTimestamp(values: readonly string[], fallback: string) {
  return [...values, fallback].sort()[0]!;
}

function maximumScore(values: readonly (number | null)[], fallback?: number | null) {
  const scores = values.filter((value): value is number => value != null);
  if (fallback != null) scores.push(fallback);
  return scores.length ? Math.max(...scores) : null;
}

function legacyFact(record: DreamMemoryRecord, id: string) {
  for (const field of LEGACY_FACT_FIELDS) {
    const text = readableText(record[field]);
    if (text) return text;
  }
  const fields = Object.keys(record).filter((field) => field !== "id").sort().slice(0, 8);
  return fields.length
    ? `旧格式记忆（保留字段：${fields.join("、")}）`
    : `旧格式记忆 ${id}`;
}

function readableText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return normalizeText(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const nested = value as Record<string, unknown>;
  for (const field of ["fact", "text", "content", "summary", "description", "value"]) {
    const text = readableText(nested[field]);
    if (text) return text;
  }
  return "";
}
