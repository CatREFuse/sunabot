import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  commitDreamConsolidationUnsafe,
  initializeRecallTrackingUnsafe,
  listRecallStatsUnsafe,
  readRecallStatsUnsafe,
  recordActualRecallUnsafe,
  reserveActualRecallUnsafe
} from "./dreamConsolidationStore.js";
import {
  assertSameOccurrence,
  boundedText,
  encodeJsonObject,
  jsonEquals,
  listLimit,
  mapArchive,
  mapRun,
  normalizeCanonicalMemoryId,
  normalizeClaim,
  normalizeId,
  normalizeLocalDate,
  normalizePersonaStatus,
  normalizeWorkerId,
  normalizedScore,
  validDate
} from "./dreamCodec.js";
import { migrateDreamTables } from "./dreamSchema.js";
import type {
  ClaimDailyDreamRunInput,
  CommitDreamConsolidationInput,
  DreamPersonaStatus,
  DreamRunClaimResult,
  JsonObject,
  RecordActualRecallInput,
  RecordMemoryReviewInput,
  ReserveActualRecallInput,
  SqliteDreamStoreOptions
} from "./dreamTypes.js";

export { migrateDreamTables } from "./dreamSchema.js";
export { digestDreamMemorySnapshot } from "./dreamConsolidationStore.js";
export type * from "./dreamTypes.js";

type SqlRow = Record<string, unknown>;
const DREAM_MAX_CLAIMS = 3;
const MAX_LEGAL_MODEL_CONTEXT_MS = 86_400_000;
const PENDING_RECALL_TTL_MS = MAX_LEGAL_MODEL_CONTEXT_MS + 60 * 60_000;

const RUN_COLUMNS = `
  id, local_date, scheduled_for, time_zone, window_start, window_end, status,
  worker_id, lease_until, attempt_count, seed, input_digest, input_json, output_json,
  dream_text, working_memory_id, persona_json, persona_status, result_json,
  error_code, error_text, next_retry_at, created_at, updated_at, generated_at,
  consolidated_at, persona_updated_at, completed_at, failed_at
`;

const ARCHIVE_COLUMNS = "record_id, run_id, data_json, reason, archived_at, purge_after";
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class SqliteDreamStore {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: DatabaseSync,
    options: SqliteDreamStoreOptions = {}
  ) {
    migrateDreamTables(database);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  initializeRecallTracking(recordIds: readonly string[], at?: Date) {
    const timestamp = this.inputDate(at).toISOString();
    return this.transaction(() => initializeRecallTrackingUnsafe(this.database, recordIds, timestamp));
  }

  reserveActualRecall(input: ReserveActualRecallInput) {
    const recallKey = boundedText(input.recallKey, "recallKey", 1, 256);
    const exposedAt = this.inputDate(input.at);
    return this.transaction(() => reserveActualRecallUnsafe(this.database, {
      recordId: input.recordId,
      recallKey,
      exposedAt: exposedAt.toISOString(),
      expiresAt: new Date(exposedAt.getTime() + PENDING_RECALL_TTL_MS).toISOString()
    }));
  }

  recordActualRecall(input: RecordActualRecallInput) {
    const recallKey = boundedText(input.recallKey, "recallKey", 1, 256);
    const localDate = normalizeLocalDate(input.localDate, "localDate");
    const recalledAt = this.inputDate(input.at).toISOString();
    return this.transaction(() => recordActualRecallUnsafe(this.database, {
      recordId: input.recordId,
      recallKey,
      localDate,
      recalledAt
    }));
  }

  recordMemoryReview(input: RecordMemoryReviewInput) {
    const recordId = normalizeCanonicalMemoryId(input.recordId, "recordId");
    const timestamp = this.inputDate(input.at).toISOString();
    const importance = normalizedScore(input.importance, "importance");
    const futureRelevance = normalizedScore(input.futureRelevance, "futureRelevance");
    const emotionalSalience = normalizedScore(input.emotionalSalience, "emotionalSalience");
    this.database.prepare(`
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
      recordId,
      timestamp,
      timestamp,
      importance,
      futureRelevance,
      emotionalSalience
    );
    return this.requireRecallStats(recordId);
  }

  readRecallStats(recordId: string) {
    return readRecallStatsUnsafe(this.database, recordId);
  }

  listRecallStats(recordIds?: readonly string[]) {
    return listRecallStatsUnsafe(this.database, recordIds);
  }

  claimDailyRun(input: ClaimDailyDreamRunInput): DreamRunClaimResult {
    const normalized = normalizeClaim(input, this.idFactory, this.clock);
    return this.transaction(() => {
      const existing = this.readRunByLocalDate(normalized.localDate);
      if (!existing) {
        this.database.prepare(`
          INSERT INTO dream_runs (
            id, local_date, scheduled_for, time_zone, window_start, window_end, status,
            worker_id, lease_until, attempt_count, seed, input_digest, input_json, output_json,
            dream_text, working_memory_id, persona_json, persona_status, result_json,
            error_code, error_text, next_retry_at, created_at, updated_at, generated_at,
            consolidated_at, persona_updated_at, completed_at, failed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'running', ?, ?, 1, ?, ?, ?, NULL,
            NULL, NULL, NULL, 'pending', NULL, NULL, NULL, NULL, ?, ?, NULL,
            NULL, NULL, NULL, NULL
          )
        `).run(
          normalized.id,
          normalized.localDate,
          normalized.scheduledFor,
          normalized.timeZone,
          normalized.window.start,
          normalized.window.end,
          normalized.workerId,
          normalized.leaseUntil,
          normalized.seed,
          normalized.inputDigest,
          normalized.inputJson,
          normalized.nowIso,
          normalized.nowIso
        );
        return { status: "created", run: this.requireRun(normalized.id) };
      }
      assertSameOccurrence(existing, normalized);
      if (existing.status === "completed") return { status: "existing", run: existing };
      if (existing.status === "failed" && normalized.force) {
        const recoveredStatus = existing.result != null
          ? "consolidated"
          : existing.output != null
            ? "generated"
            : "running";
        const forced = this.database.prepare(`
          UPDATE dream_runs SET
            status = ?, worker_id = ?, lease_until = ?, attempt_count = attempt_count + 1,
            error_code = NULL, error_text = NULL, next_retry_at = NULL, failed_at = NULL,
            updated_at = ?
          WHERE id = ? AND status = 'failed'
        `).run(
          recoveredStatus,
          normalized.workerId,
          normalized.leaseUntil,
          normalized.nowIso,
          existing.id
        );
        const current = this.requireRun(existing.id);
        return {
          status: Number(forced.changes) === 1 ? "recovered" : "existing",
          run: current
        };
      }
      if (
        (existing.status === "running" || existing.status === "generated" || existing.status === "consolidated"
          || (existing.status === "failed" && existing.nextRetryAt != null && existing.nextRetryAt <= normalized.nowIso))
        && existing.attemptCount >= DREAM_MAX_CLAIMS
        && (existing.leaseUntil == null || existing.leaseUntil <= normalized.nowIso)
      ) {
        const terminal = this.database.prepare(`
          UPDATE dream_runs SET
            status = 'failed', worker_id = NULL, lease_until = NULL,
            error_code = 'DREAM_ATTEMPT_LIMIT',
            error_text = 'Dream processing stopped after three interrupted attempts.',
            next_retry_at = NULL, failed_at = ?, updated_at = ?
          WHERE id = ? AND attempt_count >= ? AND (
            (status IN ('running', 'generated', 'consolidated') AND (lease_until IS NULL OR lease_until <= ?))
            OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
          )
        `).run(
          normalized.nowIso,
          normalized.nowIso,
          existing.id,
          DREAM_MAX_CLAIMS,
          normalized.nowIso,
          normalized.nowIso
        );
        const current = this.requireRun(existing.id);
        return { status: Number(terminal.changes) === 1 || current.status === "failed" ? "existing" : "busy", run: current };
      }
      if (existing.status === "failed") {
        if (existing.nextRetryAt == null || existing.nextRetryAt > normalized.nowIso) {
          return { status: "existing", run: existing };
        }
      } else if (existing.leaseUntil != null && existing.leaseUntil > normalized.nowIso) {
        return { status: "busy", run: existing };
      }
      const recoveredStatus = existing.result != null
        ? "consolidated"
        : existing.output != null
          ? "generated"
          : "running";
      const recovered = this.database.prepare(`
        UPDATE dream_runs SET
          status = ?, worker_id = ?, lease_until = ?, attempt_count = attempt_count + 1,
          error_code = NULL, error_text = NULL, next_retry_at = NULL, failed_at = NULL,
          updated_at = ?
        WHERE id = ? AND (
          (status IN ('running', 'generated', 'consolidated') AND lease_until <= ? AND attempt_count < ?)
          OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ? AND attempt_count < ?)
        )
      `).run(
        recoveredStatus,
        normalized.workerId,
        normalized.leaseUntil,
        normalized.nowIso,
        existing.id,
        normalized.nowIso,
        DREAM_MAX_CLAIMS,
        normalized.nowIso,
        DREAM_MAX_CLAIMS
      );
      if (Number(recovered.changes) !== 1) {
        const current = this.requireRun(existing.id);
        return { status: current.status === "completed" || current.status === "failed" ? "existing" : "busy", run: current };
      }
      return { status: "recovered", run: this.requireRun(existing.id) };
    });
  }

  getRun(id: string) {
    return this.readRun(normalizeId(id, "runId"));
  }

  getRunByLocalDate(localDate: string) {
    return this.readRunByLocalDate(normalizeLocalDate(localDate, "localDate"));
  }

  listRuns(input: { beforeLocalDate?: string; limit?: number } = {}) {
    const before = input.beforeLocalDate == null
      ? null
      : normalizeLocalDate(input.beforeLocalDate, "beforeLocalDate");
    const limit = listLimit(input.limit);
    return (this.database.prepare(`
      SELECT ${RUN_COLUMNS} FROM dream_runs
      WHERE (? IS NULL OR local_date < ?)
      ORDER BY local_date DESC, id DESC
      LIMIT ?
    `).all(before, before, limit) as SqlRow[]).map(mapRun);
  }

  markGenerated(input: {
    runId: string;
    workerId: string;
    output: JsonObject;
    dreamText: string;
    now?: Date;
  }) {
    const runId = normalizeId(input.runId, "runId");
    const workerId = normalizeWorkerId(input.workerId);
    const outputJson = encodeJsonObject(input.output, "output");
    const dreamText = boundedText(input.dreamText, "dreamText", 1, 4096);
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE dream_runs SET
        status = 'generated', output_json = ?, dream_text = ?, generated_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running' AND lease_until > ?
    `).run(outputJson, dreamText, nowIso, nowIso, runId, workerId, nowIso);
    if (Number(updated.changes) === 1) return this.requireRun(runId);
    const current = this.readRun(runId);
    return current && current.status === "generated" && current.workerId === workerId &&
      current.leaseUntil != null && current.leaseUntil > nowIso && current.dreamText === dreamText &&
      jsonEquals(current.output, input.output)
      ? current
      : undefined;
  }

  markConsolidated(input: {
    runId: string;
    workerId: string;
    workingMemoryId: string;
    result: JsonObject;
    now?: Date;
  }) {
    const runId = normalizeId(input.runId, "runId");
    const workerId = normalizeWorkerId(input.workerId);
    const workingMemoryId = normalizeCanonicalMemoryId(input.workingMemoryId, "workingMemoryId");
    const resultJson = encodeJsonObject(input.result, "result");
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE dream_runs SET
        status = 'consolidated', working_memory_id = ?, result_json = ?,
        consolidated_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'generated' AND lease_until > ?
    `).run(workingMemoryId, resultJson, nowIso, nowIso, runId, workerId, nowIso);
    if (Number(updated.changes) === 1) return this.requireRun(runId);
    const current = this.readRun(runId);
    return current && current.status === "consolidated" && current.workerId === workerId &&
      current.leaseUntil != null && current.leaseUntil > nowIso &&
      current.workingMemoryId === workingMemoryId && jsonEquals(current.result, input.result)
      ? current
      : undefined;
  }

  commitConsolidation(input: CommitDreamConsolidationInput) {
    const now = this.inputDate(input.now);
    return this.transaction(() => commitDreamConsolidationUnsafe(this.database, input, now));
  }

  markPersona(input: {
    runId: string;
    workerId: string;
    status: Exclude<DreamPersonaStatus, "pending">;
    persona?: JsonObject | null;
    now?: Date;
  }) {
    const runId = normalizeId(input.runId, "runId");
    const workerId = normalizeWorkerId(input.workerId);
    const personaStatus = normalizePersonaStatus(input.status, false);
    const persona = input.persona ?? null;
    if ((personaStatus === "proposed" || personaStatus === "applied") && persona == null) {
      throw new Error(`persona is required when persona status is ${personaStatus}.`);
    }
    if (personaStatus === "none" && persona != null) {
      throw new Error("persona must be null when persona status is none.");
    }
    const personaJson = persona == null ? null : encodeJsonObject(persona, "persona");
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE dream_runs SET
        persona_json = ?, persona_status = ?, persona_updated_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'consolidated' AND lease_until > ?
    `).run(personaJson, personaStatus, nowIso, nowIso, runId, workerId, nowIso);
    if (Number(updated.changes) === 1) return this.requireRun(runId);
    const current = this.readRun(runId);
    return current && current.status === "consolidated" && current.workerId === workerId &&
      current.leaseUntil != null && current.leaseUntil > nowIso &&
      current.personaStatus === personaStatus && jsonEquals(current.persona, persona)
      ? current
      : undefined;
  }

  markFailed(input: {
    runId: string;
    workerId: string;
    errorCode: string;
    errorText: string;
    retryAt?: Date | null;
    now?: Date;
  }) {
    const runId = normalizeId(input.runId, "runId");
    const workerId = normalizeWorkerId(input.workerId);
    const errorCode = boundedText(input.errorCode, "errorCode", 1, 80);
    const errorText = boundedText(input.errorText, "errorText", 1, 65_536);
    const now = this.inputDate(input.now);
    const nowIso = now.toISOString();
    const nextRetryAt = input.retryAt == null ? null : validDate(input.retryAt, "retryAt").toISOString();
    if (nextRetryAt != null && nextRetryAt <= nowIso) {
      throw new Error("retryAt must be later than now.");
    }
    const updated = this.database.prepare(`
      UPDATE dream_runs SET
        status = 'failed', worker_id = NULL, lease_until = NULL,
        error_code = ?, error_text = ?, next_retry_at = ?, failed_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ?
        AND status IN ('running', 'generated', 'consolidated') AND lease_until > ?
    `).run(errorCode, errorText, nextRetryAt, nowIso, nowIso, runId, workerId, nowIso);
    if (Number(updated.changes) === 1) return this.requireRun(runId);
    const current = this.readRun(runId);
    return current && current.status === "failed" && current.errorCode === errorCode &&
      current.errorText === errorText && current.nextRetryAt === nextRetryAt
      ? current
      : undefined;
  }

  complete(input: { runId: string; workerId: string; now?: Date }) {
    const runId = normalizeId(input.runId, "runId");
    const workerId = normalizeWorkerId(input.workerId);
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE dream_runs SET
        status = 'completed', worker_id = NULL, lease_until = NULL,
        error_code = NULL, error_text = NULL, next_retry_at = NULL, failed_at = NULL,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'consolidated'
        AND persona_status <> 'pending' AND lease_until > ?
    `).run(nowIso, nowIso, runId, workerId, nowIso);
    if (Number(updated.changes) === 1) return this.requireRun(runId);
    const current = this.readRun(runId);
    return current?.status === "completed" ? current : undefined;
  }

  archiveMemory(input: {
    recordId: string;
    runId: string;
    data: JsonObject;
    reason: string;
    archivedAt?: Date;
    purgeAfter?: Date;
  }) {
    const recordId = normalizeCanonicalMemoryId(input.recordId, "recordId");
    const runId = normalizeId(input.runId, "runId");
    const dataJson = encodeJsonObject(input.data, "archive data");
    const reason = boundedText(input.reason, "reason", 1, 2048);
    const archivedAtDate = this.inputDate(input.archivedAt);
    const purgeAfterDate = input.purgeAfter == null
      ? new Date(archivedAtDate.getTime() + ARCHIVE_RETENTION_MS)
      : validDate(input.purgeAfter, "purgeAfter");
    if (purgeAfterDate.getTime() < archivedAtDate.getTime() + ARCHIVE_RETENTION_MS) {
      throw new Error("purgeAfter must retain archived memory for at least 30 days.");
    }
    const archivedAt = archivedAtDate.toISOString();
    const purgeAfter = purgeAfterDate.toISOString();
    const inserted = this.database.prepare(`
      INSERT INTO dream_memory_archive (
        record_id, run_id, data_json, reason, archived_at, purge_after
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO NOTHING
    `).run(recordId, runId, dataJson, reason, archivedAt, purgeAfter);
    const archive = this.requireArchive(recordId);
    if (Number(inserted.changes) === 0 && (
      archive.runId !== runId || archive.reason !== reason || archive.archivedAt !== archivedAt ||
      archive.purgeAfter !== purgeAfter || !jsonEquals(archive.data, input.data)
    )) {
      throw new Error(`Dream memory archive collision for ${recordId}.`);
    }
    return { status: Number(inserted.changes) === 1 ? "created" as const : "existing" as const, archive };
  }

  listArchives(input: { runId?: string; limit?: number } = {}) {
    const runId = input.runId == null ? null : normalizeId(input.runId, "runId");
    const limit = listLimit(input.limit);
    return (this.database.prepare(`
      SELECT ${ARCHIVE_COLUMNS} FROM dream_memory_archive
      WHERE (? IS NULL OR run_id = ?)
      ORDER BY archived_at, record_id
      LIMIT ?
    `).all(runId, runId, limit) as SqlRow[]).map(mapArchive);
  }

  purgeArchivedMemories(input: { now?: Date; limit?: number } = {}) {
    const nowIso = this.inputDate(input.now).toISOString();
    const limit = listLimit(input.limit);
    return this.transaction(() => {
      const due = (this.database.prepare(`
        SELECT ${ARCHIVE_COLUMNS} FROM dream_memory_archive
        WHERE purge_after <= ? ORDER BY purge_after, record_id LIMIT ?
      `).all(nowIso, limit) as SqlRow[]).map(mapArchive);
      const remove = this.database.prepare("DELETE FROM dream_memory_archive WHERE record_id = ?");
      for (const archive of due) remove.run(archive.recordId);
      return due;
    });
  }

  private readRun(id: string) {
    const row = this.database.prepare(`SELECT ${RUN_COLUMNS} FROM dream_runs WHERE id = ?`)
      .get(id) as SqlRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  private readRunByLocalDate(localDate: string) {
    const row = this.database.prepare(`SELECT ${RUN_COLUMNS} FROM dream_runs WHERE local_date = ?`)
      .get(localDate) as SqlRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  private requireRun(id: string) {
    const run = this.readRun(id);
    if (!run) throw new Error(`Dream run not found: ${id}`);
    return run;
  }

  private requireRecallStats(recordId: string) {
    const stats = this.readRecallStats(recordId);
    if (!stats) throw new Error(`Memory recall stats not found: ${recordId}`);
    return stats;
  }

  private requireArchive(recordId: string) {
    const row = this.database.prepare(`
      SELECT ${ARCHIVE_COLUMNS} FROM dream_memory_archive WHERE record_id = ?
    `).get(recordId) as SqlRow | undefined;
    if (!row) throw new Error(`Dream memory archive not found: ${recordId}`);
    return mapArchive(row);
  }

  private inputDate(value?: Date) {
    return validDate(value ?? this.clock(), value ? "date" : "clock");
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
