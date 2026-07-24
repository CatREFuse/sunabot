import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  boundedText,
  encodeJsonObject,
  jsonEquals,
  mapRecallStats,
  mapRun,
  normalizeCanonicalMemoryId,
  normalizeId,
  normalizeStoredMemoryId,
  normalizeWorkerId,
  normalizedScore,
  tryStoredMemoryId
} from "./dreamCodec.js";
import type {
  CommitDreamConsolidationInput,
  DreamConsolidationCommitResult,
  DreamMemoryReviewInput,
  DreamRecallLineageInput,
  DreamRun,
  JsonObject,
  MemoryRecallStats,
  RecordActualRecallResult,
  ReserveActualRecallResult
} from "./dreamTypes.js";

type SqlRow = Record<string, unknown>;
type MemorySource = "working" | "long_term";

const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface NormalizedMemoryRecord {
  id: string | null;
  data: JsonObject;
  encoded: string;
}

interface NormalizedConsolidationInput {
  runId: string;
  workerId: string;
  expectedWorkingDigest: string;
  expectedLongTermDigest: string;
  externalWorkingMemory: boolean;
  workingMemoryId: string;
  working: NormalizedMemoryRecord[];
  longTerm: NormalizedMemoryRecord[];
  archives: Array<{
    recordId: string;
    data: JsonObject;
    encoded: string;
    reason: string;
    recallSnapshot: { recallCount: number; trackingStartedAt: string };
  }>;
  recallLineages: Array<{ targetId: string; sourceIds: string[] }>;
  reviews: Array<{
    recordId: string;
    sourceIds: string[];
    importance: number;
    futureRelevance: number;
    emotionalSalience: number;
  }>;
  result: JsonObject;
  resultJson: string;
}

interface PendingRecallExposure {
  recallKey: string;
  expiresAt: string;
}

const MAX_PENDING_RECALL_EXPOSURES = 128;

export function initializeRecallTrackingUnsafe(
  database: DatabaseSync,
  recordIds: readonly string[],
  trackingStartedAt: string
) {
  const ids = uniqueStorableIds(recordIds);
  const insert = database.prepare(`
    INSERT INTO memory_recall_stats (
      record_id, recall_count, distinct_recall_days, last_recalled_at,
      last_recall_local_date, tracking_started_at, last_reviewed_at,
      importance, future_relevance, emotional_salience
    ) SELECT ?, 0, 0, NULL, NULL, ?, NULL, NULL, NULL, NULL
    WHERE EXISTS (
      SELECT 1 FROM memory_records WHERE source = 'long_term' AND record_id = ?
    )
    ON CONFLICT(record_id) DO NOTHING
  `);
  for (const id of ids) insert.run(id, trackingStartedAt, id);
  return listRecallStatsUnsafe(database, ids);
}

export function recordActualRecallUnsafe(database: DatabaseSync, input: {
  recordId: unknown;
  recallKey: string;
  localDate: string;
  recalledAt: string;
}): RecordActualRecallResult {
  const recordId = tryStoredMemoryId(input.recordId);
  if (recordId == null) return missingRecallResult(input.recordId, input.recalledAt);
  const present = database.prepare(`
    SELECT 1 FROM memory_records WHERE source = 'long_term' AND record_id = ? LIMIT 1
  `).get(recordId);
  if (!present) {
    database.prepare("DELETE FROM memory_recall_stats WHERE record_id = ?").run(recordId);
    return missingRecallResult(recordId, input.recalledAt);
  }
  database.prepare(`
    INSERT INTO memory_recall_stats (
      record_id, recall_count, distinct_recall_days, last_recalled_at,
      last_recall_local_date, tracking_started_at, last_reviewed_at,
      importance, future_relevance, emotional_salience
    ) VALUES (?, 0, 0, NULL, NULL, ?, NULL, NULL, NULL, NULL)
    ON CONFLICT(record_id) DO NOTHING
  `).run(recordId, input.recalledAt);
  updatePendingRecallExposures(database, recordId, (entries) => entries.filter(
    (entry) => entry.recallKey !== input.recallKey && entry.expiresAt > input.recalledAt
  ));
  const inserted = database.prepare(`
    INSERT INTO memory_recall_receipts (recall_key, record_id, recall_local_date, recalled_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(recall_key, record_id) DO NOTHING
  `).run(input.recallKey, recordId, input.localDate, input.recalledAt);
  recomputeRecallStats(database, recordId);
  return {
    recorded: Number(inserted.changes) === 1,
    recordPresent: true,
    stats: readRecallStatsUnsafe(database, recordId)!
  };
}

export function reserveActualRecallUnsafe(database: DatabaseSync, input: {
  recordId: unknown;
  recallKey: string;
  exposedAt: string;
  expiresAt: string;
}): ReserveActualRecallResult {
  const recordId = tryStoredMemoryId(input.recordId);
  if (recordId == null) return { reserved: false, recordPresent: false };
  const present = database.prepare(`
    SELECT 1 FROM memory_records WHERE source = 'long_term' AND record_id = ? LIMIT 1
  `).get(recordId);
  if (!present) {
    database.prepare("DELETE FROM memory_recall_stats WHERE record_id = ?").run(recordId);
    return { reserved: false, recordPresent: false };
  }
  initializeRecallTrackingUnsafe(database, [recordId], input.exposedAt);
  let reserved = false;
  updatePendingRecallExposures(database, recordId, (entries) => {
    const active = entries.filter((entry) => entry.expiresAt > input.exposedAt);
    const existing = active.find((entry) => entry.recallKey === input.recallKey);
    if (existing) {
      existing.expiresAt = existing.expiresAt >= input.expiresAt ? existing.expiresAt : input.expiresAt;
      return active;
    }
    if (active.length >= MAX_PENDING_RECALL_EXPOSURES) {
      throw new Error(`Memory ${recordId} has too many pending model-context exposures.`);
    }
    reserved = true;
    active.push({ recallKey: input.recallKey, expiresAt: input.expiresAt });
    return active;
  });
  return { reserved, recordPresent: true };
}

export function readRecallStatsUnsafe(database: DatabaseSync, recordId: unknown): MemoryRecallStats | undefined {
  const normalized = tryStoredMemoryId(recordId);
  if (normalized == null) return undefined;
  const row = database.prepare("SELECT * FROM memory_recall_stats WHERE record_id = ?")
    .get(normalized) as SqlRow | undefined;
  return row ? mapRecallStats(row) : undefined;
}

export function listRecallStatsUnsafe(database: DatabaseSync, recordIds?: readonly string[]) {
  if (recordIds == null) {
    return (database.prepare("SELECT * FROM memory_recall_stats ORDER BY record_id").all() as SqlRow[])
      .map(mapRecallStats);
  }
  const ids = uniqueStorableIds(recordIds);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return (database.prepare(`
    SELECT * FROM memory_recall_stats WHERE record_id IN (${placeholders}) ORDER BY record_id
  `).all(...ids) as SqlRow[]).map(mapRecallStats);
}

export function digestDreamMemorySnapshot(records: readonly JsonObject[]) {
  const hash = createHash("sha256");
  hash.update("[");
  records.forEach((record, index) => {
    if (index > 0) hash.update(",");
    hash.update(encodeJsonObject(record, `memory snapshot record ${index}`));
  });
  hash.update("]");
  return hash.digest("hex");
}

export function commitDreamConsolidationUnsafe(
  database: DatabaseSync,
  input: CommitDreamConsolidationInput,
  now: Date
): DreamConsolidationCommitResult {
  const normalized = normalizeInput(input);
  const nowIso = now.toISOString();
  const run = requireRun(database, normalized.runId);
  if (run.status === "consolidated" || run.status === "completed") {
    return run.workingMemoryId === normalized.workingMemoryId && jsonEquals(run.result, normalized.result)
      ? { status: "existing", run }
      : { status: "result_conflict", run };
  }
  if (run.status !== "generated" || run.workerId !== normalized.workerId ||
    run.leaseUntil == null || run.leaseUntil <= nowIso) {
    return { status: "lease_lost", run };
  }

  const currentWorking = normalized.externalWorkingMemory ? [] : readMemory(database, "working");
  const currentLongTerm = readMemory(database, "long_term");
  const actualWorkingDigest = normalized.externalWorkingMemory
    ? normalized.expectedWorkingDigest
    : digestDreamMemorySnapshot(currentWorking);
  const actualLongTermDigest = digestDreamMemorySnapshot(currentLongTerm);
  const sources: MemorySource[] = [];
  if (actualWorkingDigest !== normalized.expectedWorkingDigest) sources.push("working");
  if (actualLongTermDigest !== normalized.expectedLongTermDigest) sources.push("long_term");
  if (!archiveRecallSnapshotsCurrent(database, normalized.archives) && !sources.includes("long_term")) {
    sources.push("long_term");
  }
  if (pendingRecallBlocksRemoval(database, normalized.longTerm, nowIso) && !sources.includes("long_term")) {
    sources.push("long_term");
  }
  if (sources.length > 0) {
    return { status: "snapshot_conflict", sources, actualWorkingDigest, actualLongTermDigest };
  }

  if (!normalized.externalWorkingMemory) replaceMemory(database, "working", normalized.working);
  replaceMemory(database, "long_term", normalized.longTerm);
  archiveMemories(database, normalized, now);
  for (const lineage of normalized.recallLineages) mergeRecallLineage(database, lineage);
  for (const archive of normalized.archives) {
    database.prepare("DELETE FROM memory_recall_stats WHERE record_id = ?").run(archive.recordId);
  }
  initializeFinalTracking(database, normalized.longTerm, nowIso);
  for (const review of normalized.reviews) writeReview(database, review, nowIso);

  const updated = database.prepare(`
    UPDATE dream_runs SET
      status = 'consolidated', working_memory_id = ?, result_json = ?,
      consolidated_at = ?, updated_at = ?
    WHERE id = ? AND worker_id = ? AND status = 'generated' AND lease_until > ?
  `).run(
    normalized.workingMemoryId,
    normalized.resultJson,
    nowIso,
    nowIso,
    normalized.runId,
    normalized.workerId,
    nowIso
  );
  if (Number(updated.changes) !== 1) throw new Error("Dream consolidation lease changed during commit.");
  return { status: "committed", run: requireRun(database, normalized.runId) };
}

function normalizeInput(input: CommitDreamConsolidationInput): NormalizedConsolidationInput {
  const working = normalizeRecords(input.working, "working", false);
  const longTerm = normalizeRecords(input.longTerm, "longTerm", true);
  const finalWorkingIds = new Set(working.flatMap((record) => record.id == null ? [] : [record.id]));
  const finalLongTermIds = new Set(longTerm.map((record) => record.id!));
  const workingMemoryId = normalizeCanonicalMemoryId(input.workingMemoryId, "workingMemoryId");
  if (!finalWorkingIds.has(workingMemoryId)) {
    throw new Error("workingMemoryId must exist in the final working memory snapshot.");
  }

  const archives = input.archives.map((archive, index) => {
    const recordId = normalizeCanonicalMemoryId(archive.recordId, `archives[${index}].recordId`);
    if (finalLongTermIds.has(recordId)) throw new Error(`Archived memory remains in long-term memory: ${recordId}`);
    return {
      recordId,
      data: archive.data,
      encoded: encodeJsonObject(archive.data, `archives[${index}].data`),
      reason: boundedText(archive.reason, `archives[${index}].reason`, 1, 2048),
      recallSnapshot: normalizeArchiveRecallSnapshot(archive.recallSnapshot, index)
    };
  });
  assertUnique(archives.map((archive) => archive.recordId), "archive record IDs");
  const archivedIds = new Set(archives.map((archive) => archive.recordId));
  const recallLineages = normalizeLineages(input.recallLineages, finalLongTermIds, archivedIds);
  const reviews = normalizeReviews(input.reviews, finalLongTermIds);
  const resultJson = encodeJsonObject(input.result, "result");
  return {
    runId: normalizeId(input.runId, "runId"),
    workerId: normalizeWorkerId(input.workerId),
    expectedWorkingDigest: normalizeDigest(input.expectedWorkingDigest, "expectedWorkingDigest"),
    expectedLongTermDigest: normalizeDigest(input.expectedLongTermDigest, "expectedLongTermDigest"),
    externalWorkingMemory: input.externalWorkingMemory === true,
    workingMemoryId,
    working,
    longTerm,
    archives,
    recallLineages,
    reviews,
    result: input.result,
    resultJson
  };
}

function normalizeArchiveRecallSnapshot(
  snapshot: { recallCount: number; trackingStartedAt: string },
  index: number
) {
  if (!Number.isSafeInteger(snapshot.recallCount) || snapshot.recallCount !== 0) {
    throw new Error(`archives[${index}].recallSnapshot.recallCount must be 0.`);
  }
  const field = `archives[${index}].recallSnapshot.trackingStartedAt`;
  const trackingStartedAt = boundedText(snapshot.trackingStartedAt, field, 1, 80);
  const timestamp = Date.parse(trackingStartedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== trackingStartedAt) {
    throw new Error(`${field} must be a canonical ISO timestamp.`);
  }
  return { recallCount: 0, trackingStartedAt };
}

function archiveRecallSnapshotsCurrent(
  database: DatabaseSync,
  archives: NormalizedConsolidationInput["archives"]
) {
  const read = database.prepare(`
    SELECT recall_count, tracking_started_at,
      (SELECT COUNT(*) FROM memory_recall_receipts WHERE record_id = ?) AS receipt_count
    FROM memory_recall_stats WHERE record_id = ?
  `);
  return archives.every((archive) => {
    const row = read.get(archive.recordId, archive.recordId) as SqlRow | undefined;
    return row != null && archive.recallSnapshot.recallCount === 0 &&
      Number(row.recall_count) === 0 && Number(row.receipt_count) === 0 &&
      String(row.tracking_started_at) === archive.recallSnapshot.trackingStartedAt;
  });
}

function pendingRecallBlocksRemoval(
  database: DatabaseSync,
  finalRecords: readonly NormalizedMemoryRecord[],
  nowIso: string
) {
  const finalIds = new Set(finalRecords.map((record) => record.id!));
  const rows = database.prepare(`
    SELECT stats.record_id, stats.pending_recall_json
    FROM memory_recall_stats AS stats
    INNER JOIN memory_records AS memory
      ON memory.source = 'long_term' AND memory.record_id = stats.record_id
  `).all() as SqlRow[];
  let blocksRemoval = false;
  for (const row of rows) {
    const recordId = String(row.record_id);
    const entries = readPendingRecallExposures(row.pending_recall_json);
    const active = entries.filter((entry) => entry.expiresAt > nowIso);
    if (active.length !== entries.length) {
      updatePendingRecallExposures(database, recordId, () => active);
    }
    if (!finalIds.has(recordId) && active.length > 0) blocksRemoval = true;
  }
  return blocksRemoval;
}

function normalizeRecords(records: readonly JsonObject[], field: string, requireIds: boolean) {
  const normalized = records.map((data, index): NormalizedMemoryRecord => {
    const encoded = encodeJsonObject(data, `${field}[${index}]`);
    const rawId = typeof data.id === "string" && data.id.trim() ? data.id : null;
    const id = rawId == null ? null : normalizeCanonicalMemoryId(rawId, `${field}[${index}].id`);
    if (requireIds && id == null) throw new Error(`${field}[${index}].id is required.`);
    return { id, data, encoded };
  });
  assertUnique(normalized.flatMap((record) => record.id == null ? [] : [record.id]), `${field} record IDs`);
  return normalized;
}

function normalizeLineages(
  lineages: readonly DreamRecallLineageInput[],
  finalIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>
) {
  const sourceOwners = new Map<string, string>();
  return lineages.map((lineage, index) => {
    const targetId = normalizeCanonicalMemoryId(lineage.targetId, `recallLineages[${index}].targetId`);
    if (!finalIds.has(targetId)) throw new Error(`Recall lineage target is not in long-term memory: ${targetId}`);
    const sourceIds = uniqueStoredIds(lineage.sourceIds, `recallLineages[${index}].sourceIds`);
    if (sourceIds.length === 0) throw new Error(`recallLineages[${index}].sourceIds must not be empty.`);
    for (const sourceId of sourceIds) {
      if (archivedIds.has(sourceId)) throw new Error(`Archived memory cannot enter recall lineage: ${sourceId}`);
      if (sourceId !== targetId && finalIds.has(sourceId)) {
        throw new Error(`Non-target recall lineage source remains in long-term memory: ${sourceId}`);
      }
      const owner = sourceOwners.get(sourceId);
      if (owner != null && owner !== targetId) throw new Error(`Recall lineage source has multiple targets: ${sourceId}`);
      sourceOwners.set(sourceId, targetId);
    }
    return { targetId, sourceIds };
  });
}

function normalizeReviews(reviews: readonly DreamMemoryReviewInput[], finalIds: ReadonlySet<string>) {
  const normalized = reviews.map((review, index) => {
    const recordId = normalizeCanonicalMemoryId(review.recordId, `reviews[${index}].recordId`);
    if (!finalIds.has(recordId)) throw new Error(`Reviewed memory is not in long-term memory: ${recordId}`);
    return {
      recordId,
      sourceIds: uniqueCanonicalIds(review.sourceIds, `reviews[${index}].sourceIds`),
      importance: normalizedScore(review.importance, `reviews[${index}].importance`),
      futureRelevance: normalizedScore(review.futureRelevance, `reviews[${index}].futureRelevance`),
      emotionalSalience: normalizedScore(review.emotionalSalience, `reviews[${index}].emotionalSalience`)
    };
  });
  assertUnique(normalized.map((review) => review.recordId), "review record IDs");
  return normalized;
}

function readMemory(database: DatabaseSync, source: MemorySource) {
  return (database.prepare(`
    SELECT data_json FROM memory_records WHERE source = ? ORDER BY position, row_id
  `).all(source) as SqlRow[]).map((row, index) => parseStoredObject(row.data_json, `${source}[${index}]`));
}

function replaceMemory(database: DatabaseSync, source: MemorySource, records: readonly NormalizedMemoryRecord[]) {
  database.prepare("DELETE FROM memory_records WHERE source = ?").run(source);
  const insert = database.prepare(`
    INSERT INTO memory_records (source, position, record_id, data_json) VALUES (?, ?, ?, ?)
  `);
  records.forEach((record, position) => insert.run(source, position, record.id, record.encoded));
}

function archiveMemories(database: DatabaseSync, input: NormalizedConsolidationInput, now: Date) {
  const archivedAt = now.toISOString();
  const purgeAfter = new Date(now.getTime() + ARCHIVE_RETENTION_MS).toISOString();
  const insert = database.prepare(`
    INSERT INTO dream_memory_archive (
      record_id, run_id, data_json, reason, archived_at, purge_after
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO NOTHING
  `);
  const read = database.prepare(`
    SELECT run_id, data_json, reason, archived_at, purge_after
    FROM dream_memory_archive WHERE record_id = ?
  `);
  for (const archive of input.archives) {
    const inserted = insert.run(
      archive.recordId,
      input.runId,
      archive.encoded,
      archive.reason,
      archivedAt,
      purgeAfter
    );
    if (Number(inserted.changes) === 1) continue;
    const row = read.get(archive.recordId) as SqlRow | undefined;
    const same = row != null && String(row.run_id) === input.runId &&
      String(row.reason) === archive.reason && String(row.archived_at) === archivedAt &&
      String(row.purge_after) === purgeAfter &&
      jsonEquals(parseStoredObject(row.data_json, "archive data"), archive.data);
    if (!same) throw new Error(`Dream memory archive collision for ${archive.recordId}.`);
  }
}

function mergeRecallLineage(database: DatabaseSync, lineage: { targetId: string; sourceIds: string[] }) {
  const placeholders = lineage.sourceIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT * FROM memory_recall_stats WHERE record_id IN (${placeholders})
  `).all(...lineage.sourceIds) as SqlRow[];
  if (rows.length > 0) upsertLineageStats(database, lineage.targetId, rows);
  database.prepare(`
    INSERT OR IGNORE INTO memory_recall_receipts (
      recall_key, record_id, recall_local_date, recalled_at
    )
    SELECT recall_key, ?, MIN(recall_local_date), MIN(recalled_at)
    FROM memory_recall_receipts
    WHERE record_id IN (${placeholders})
    GROUP BY recall_key
  `).run(lineage.targetId, ...lineage.sourceIds);
  for (const sourceId of lineage.sourceIds) {
    if (sourceId !== lineage.targetId) {
      database.prepare("DELETE FROM memory_recall_stats WHERE record_id = ?").run(sourceId);
    }
  }
  recomputeRecallStats(database, lineage.targetId);
}

function upsertLineageStats(database: DatabaseSync, targetId: string, rows: SqlRow[]) {
  const earliestTracking = rows.map((row) => String(row.tracking_started_at)).sort()[0]!;
  const latestReview = [...rows]
    .filter((row) => row.last_reviewed_at != null)
    .sort((left, right) => String(right.last_reviewed_at).localeCompare(String(left.last_reviewed_at)))[0];
  const latestReviewedAt = latestReview == null ? null : String(latestReview.last_reviewed_at);
  const latestImportance = latestReview?.importance == null ? null : Number(latestReview.importance);
  const latestFutureRelevance = latestReview?.future_relevance == null
    ? null
    : Number(latestReview.future_relevance);
  const latestEmotionalSalience = latestReview?.emotional_salience == null
    ? null
    : Number(latestReview.emotional_salience);
  database.prepare(`
    INSERT INTO memory_recall_stats (
      record_id, recall_count, distinct_recall_days, last_recalled_at,
      last_recall_local_date, tracking_started_at, last_reviewed_at,
      importance, future_relevance, emotional_salience
    ) VALUES (?, 0, 0, NULL, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      tracking_started_at = MIN(memory_recall_stats.tracking_started_at, excluded.tracking_started_at),
      last_reviewed_at = CASE
        WHEN excluded.last_reviewed_at IS NOT NULL AND (
          memory_recall_stats.last_reviewed_at IS NULL OR excluded.last_reviewed_at > memory_recall_stats.last_reviewed_at
        ) THEN excluded.last_reviewed_at ELSE memory_recall_stats.last_reviewed_at END,
      importance = CASE
        WHEN excluded.last_reviewed_at IS NOT NULL AND (
          memory_recall_stats.last_reviewed_at IS NULL OR excluded.last_reviewed_at >= memory_recall_stats.last_reviewed_at
        ) THEN excluded.importance ELSE memory_recall_stats.importance END,
      future_relevance = CASE
        WHEN excluded.last_reviewed_at IS NOT NULL AND (
          memory_recall_stats.last_reviewed_at IS NULL OR excluded.last_reviewed_at >= memory_recall_stats.last_reviewed_at
        ) THEN excluded.future_relevance ELSE memory_recall_stats.future_relevance END,
      emotional_salience = CASE
        WHEN excluded.last_reviewed_at IS NOT NULL AND (
          memory_recall_stats.last_reviewed_at IS NULL OR excluded.last_reviewed_at >= memory_recall_stats.last_reviewed_at
        ) THEN excluded.emotional_salience ELSE memory_recall_stats.emotional_salience END
  `).run(
    targetId,
    earliestTracking,
    latestReviewedAt,
    latestImportance,
    latestFutureRelevance,
    latestEmotionalSalience
  );
}

function recomputeRecallStats(database: DatabaseSync, recordId: string) {
  database.prepare(`
    UPDATE memory_recall_stats SET
      recall_count = (SELECT COUNT(*) FROM memory_recall_receipts WHERE record_id = ?),
      distinct_recall_days = (
        SELECT COUNT(DISTINCT recall_local_date) FROM memory_recall_receipts WHERE record_id = ?
      ),
      last_recalled_at = (
        SELECT recalled_at FROM memory_recall_receipts
        WHERE record_id = ? ORDER BY recalled_at DESC, recall_key DESC LIMIT 1
      ),
      last_recall_local_date = (
        SELECT recall_local_date FROM memory_recall_receipts
        WHERE record_id = ? ORDER BY recalled_at DESC, recall_key DESC LIMIT 1
      )
    WHERE record_id = ?
  `).run(recordId, recordId, recordId, recordId, recordId);
}

function updatePendingRecallExposures(
  database: DatabaseSync,
  recordId: string,
  update: (entries: PendingRecallExposure[]) => PendingRecallExposure[]
) {
  const row = database.prepare(`
    SELECT pending_recall_json FROM memory_recall_stats WHERE record_id = ?
  `).get(recordId) as SqlRow | undefined;
  if (!row) return;
  const entries = update(readPendingRecallExposures(row.pending_recall_json));
  entries.sort((left, right) => left.recallKey.localeCompare(right.recallKey));
  database.prepare(`
    UPDATE memory_recall_stats SET pending_recall_json = ? WHERE record_id = ?
  `).run(JSON.stringify(entries), recordId);
}

function readPendingRecallExposures(value: unknown): PendingRecallExposure[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("Stored pending recall exposures are invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PENDING_RECALL_EXPOSURES) {
    throw new Error("Stored pending recall exposures are invalid.");
  }
  const keys = new Set<string>();
  return parsed.map((entry, index) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "expiresAt,recallKey") {
      throw new Error(`Stored pending recall exposure ${index} is invalid.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.recallKey !== "string" || typeof record.expiresAt !== "string") {
      throw new Error(`Stored pending recall exposure ${index} is invalid.`);
    }
    const recallKey = boundedText(record.recallKey, `pending recall ${index} key`, 1, 256);
    if (keys.has(recallKey)) throw new Error("Stored pending recall exposure keys are duplicated.");
    keys.add(recallKey);
    const expiresAt = record.expiresAt;
    const timestamp = Date.parse(expiresAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== expiresAt) {
      throw new Error(`Stored pending recall exposure ${index} expiry is invalid.`);
    }
    return { recallKey, expiresAt };
  });
}

function initializeFinalTracking(
  database: DatabaseSync,
  records: readonly NormalizedMemoryRecord[],
  nowIso: string
) {
  const insert = database.prepare(`
    INSERT INTO memory_recall_stats (
      record_id, recall_count, distinct_recall_days, last_recalled_at,
      last_recall_local_date, tracking_started_at, last_reviewed_at,
      importance, future_relevance, emotional_salience
    ) VALUES (?, 0, 0, NULL, NULL, ?, NULL, NULL, NULL, NULL)
    ON CONFLICT(record_id) DO NOTHING
  `);
  for (const record of records) insert.run(record.id, nowIso);
}

function writeReview(database: DatabaseSync, review: NormalizedConsolidationInput["reviews"][number], nowIso: string) {
  database.prepare(`
    INSERT INTO memory_recall_stats (
      record_id, recall_count, distinct_recall_days, last_recalled_at,
      last_recall_local_date, tracking_started_at, last_reviewed_at,
      importance, future_relevance, emotional_salience
    ) VALUES (?, 0, 0, NULL, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(record_id) DO UPDATE SET
      last_reviewed_at = excluded.last_reviewed_at,
      importance = excluded.importance,
      future_relevance = excluded.future_relevance,
      emotional_salience = excluded.emotional_salience
  `).run(
    review.recordId,
    nowIso,
    nowIso,
    review.importance,
    review.futureRelevance,
    review.emotionalSalience
  );
}

function requireRun(database: DatabaseSync, id: string): DreamRun {
  const row = database.prepare("SELECT * FROM dream_runs WHERE id = ?").get(id) as SqlRow | undefined;
  if (!row) throw new Error(`Dream run not found: ${id}`);
  return mapRun(row);
}

function parseStoredObject(value: unknown, field: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`Stored ${field} is invalid JSON.`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Stored ${field} must be a JSON object.`);
  }
  encodeJsonObject(parsed as JsonObject, `stored ${field}`);
  return parsed as JsonObject;
}

function uniqueCanonicalIds(values: readonly string[], field: string) {
  const ids = values.map((value, index) => normalizeCanonicalMemoryId(value, `${field}[${index}]`));
  assertUnique(ids, field);
  return ids;
}

function uniqueStoredIds(values: readonly string[], field: string) {
  const ids = values.map((value, index) => normalizeStoredMemoryId(value, `${field}[${index}]`));
  assertUnique(ids, field);
  return ids;
}

function uniqueStorableIds(values: readonly unknown[]) {
  return [...new Set(values.flatMap((value) => {
    const id = tryStoredMemoryId(value);
    return id == null ? [] : [id];
  }))];
}

function missingRecallResult(recordId: unknown, trackingStartedAt: string): RecordActualRecallResult {
  return {
    recorded: false,
    recordPresent: false,
    stats: {
      recordId: tryStoredMemoryId(recordId) ?? "missing_memory_record",
      recallCount: 0,
      distinctRecallDays: 0,
      lastRecalledAt: null,
      lastRecallLocalDate: null,
      trackingStartedAt,
      lastReviewedAt: null,
      importance: null,
      futureRelevance: null,
      emotionalSalience: null
    }
  };
}

function assertUnique(values: readonly string[], field: string) {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique.`);
}

function normalizeDigest(value: string, field: string) {
  const digest = boundedText(value, field, 64, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error(`${field} must be a SHA-256 hex digest.`);
  return digest;
}
