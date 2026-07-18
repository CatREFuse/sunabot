import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  decodeScheduledTaskSnapshot,
  firstScheduledAt,
  nextScheduledAt,
  nonNegativeInteger,
  normalizeIsoTimestamp,
  normalizeScheduledTaskDraft,
  normalizeScheduledTaskError,
  normalizeScheduledTaskId,
  normalizeScheduledTaskResult,
  normalizeScheduledTaskSchedule,
  normalizeScheduledTaskTargets,
  normalizeScheduledTaskWorkerId,
  normalizeStoredTimestamp,
  positiveInteger,
  scheduledTaskSnapshot,
  type ClaimDueOccurrenceInput,
  type ClaimDueOccurrenceResult,
  type ClaimPendingRunInput,
  type CompleteScheduledTaskRunInput,
  type CreateScheduledTaskInput,
  type DeleteScheduledTaskResult,
  type FailScheduledTaskRunInput,
  type ListScheduledTasksInput,
  type MarkScheduledTaskRunGeneratedInput,
  type RenewScheduledTaskRunInput,
  type ScheduledTask,
  type ScheduledTaskPage,
  type ScheduledTaskRun,
  type ScheduledTaskRunStatus,
  type ScheduledTaskSchedule,
  type ScheduledTaskStore,
  type UpdateScheduledTaskInput,
  type UpdateScheduledTaskResult
} from "../../services/scheduling/public.js";

type SqlRow = Record<string, unknown>;

export interface SqliteScheduledTaskStoreOptions {
  clock?: () => Date;
  idFactory?: () => string;
  allowedConversationIds?: (conversationId: string) => boolean;
}

const TASK_COLUMNS = `
  id, revision, name, enabled, schedule_kind, cron_expression, timezone, run_at,
  context_text, targets_json, next_run_at, last_scheduled_at, created_at, updated_at
`;

const RUN_COLUMNS = `
  id, task_id, task_revision, scheduled_for, status, snapshot_json, result_text,
  error_text, attempts, worker_id, lease_until, created_at, updated_at,
  generated_at, completed_at
`;

export function migrateScheduledTaskTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('cron', 'once')),
      cron_expression TEXT,
      timezone TEXT,
      run_at TEXT,
      context_text TEXT NOT NULL CHECK (length(context_text) <= 32768),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      next_run_at TEXT,
      last_scheduled_at TEXT,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      CHECK (
        (schedule_kind = 'cron' AND cron_expression IS NOT NULL AND timezone IS NOT NULL AND run_at IS NULL)
        OR
        (schedule_kind = 'once' AND cron_expression IS NULL AND timezone IS NULL AND run_at IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS scheduled_tasks_due
      ON scheduled_tasks(next_run_at, id)
      WHERE enabled = 1 AND next_run_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) BETWEEN 1 AND 128),
      task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
      scheduled_for TEXT NOT NULL CHECK (length(trim(scheduled_for)) > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'generated', 'completed', 'failed')),
      snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      result_text TEXT CHECK (result_text IS NULL OR length(result_text) BETWEEN 1 AND 65536),
      error_text TEXT CHECK (error_text IS NULL OR length(error_text) BETWEEN 1 AND 65536),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      worker_id TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      generated_at TEXT,
      completed_at TEXT,
      UNIQUE (task_id, scheduled_for),
      CHECK (
        (status = 'pending' AND attempts = 0 AND worker_id IS NULL AND lease_until IS NULL
          AND result_text IS NULL AND error_text IS NULL AND generated_at IS NULL AND completed_at IS NULL)
        OR
        (status = 'running' AND attempts >= 1 AND worker_id IS NOT NULL AND lease_until IS NOT NULL
          AND result_text IS NULL AND error_text IS NULL AND generated_at IS NULL AND completed_at IS NULL)
        OR
        (status = 'generated' AND attempts >= 1 AND worker_id IS NOT NULL AND lease_until IS NOT NULL
          AND result_text IS NOT NULL AND error_text IS NULL AND generated_at IS NOT NULL AND completed_at IS NULL)
        OR
        (status = 'completed' AND attempts >= 1 AND worker_id IS NULL AND lease_until IS NULL
          AND result_text IS NOT NULL AND error_text IS NULL AND generated_at IS NOT NULL AND completed_at IS NOT NULL)
        OR
        (status = 'failed' AND attempts >= 1 AND worker_id IS NULL AND lease_until IS NULL
          AND error_text IS NOT NULL AND completed_at IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS scheduled_task_runs_status
      ON scheduled_task_runs(status, lease_until, scheduled_for, id);
    CREATE INDEX IF NOT EXISTS scheduled_task_runs_task
      ON scheduled_task_runs(task_id, scheduled_for DESC, id);
  `);
}

export class SqliteScheduledTaskStore implements ScheduledTaskStore {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly allowedConversationIds: (conversationId: string) => boolean;

  constructor(
    private readonly database: DatabaseSync,
    options: SqliteScheduledTaskStoreOptions = {}
  ) {
    migrateScheduledTaskTables(database);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.allowedConversationIds = options.allowedConversationIds ?? ((conversationId) => Boolean(
      this.database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId)
    ));
  }

  create(input: CreateScheduledTaskInput): ScheduledTask {
    const now = this.now();
    const draft = normalizeScheduledTaskDraft({
      name: input.name,
      enabled: input.enabled ?? true,
      schedule: input.schedule,
      context: input.context,
      targets: input.targets
    }, { isAllowedConversationId: this.allowedConversationIds });
    const id = normalizeScheduledTaskId(this.idFactory());
    const timestamp = now.toISOString();
    const nextRunAt = draft.enabled ? firstScheduledAt(draft.schedule, now) : null;
    const schedule = scheduleColumns(draft.schedule);
    this.database.prepare(`
      INSERT INTO scheduled_tasks (
        id, revision, name, enabled, schedule_kind, cron_expression, timezone, run_at,
        context_text, targets_json, next_run_at, last_scheduled_at, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      draft.name,
      draft.enabled ? 1 : 0,
      schedule.kind,
      schedule.expression,
      schedule.timezone,
      schedule.runAt,
      draft.context,
      JSON.stringify(draft.targets),
      nextRunAt,
      timestamp,
      timestamp
    );
    return this.requireTask(id);
  }

  get(id: string) {
    return this.readTask(normalizeScheduledTaskId(id));
  }

  list(input: ListScheduledTasksInput = {}): ScheduledTaskPage {
    const cursor = input.cursor == null ? null : normalizeScheduledTaskId(input.cursor, "cursor");
    const limit = listLimit(input.limit);
    const enabled = input.enabled == null ? null : input.enabled ? 1 : 0;
    const rows = this.database.prepare(`
      SELECT ${TASK_COLUMNS} FROM scheduled_tasks
      WHERE (? IS NULL OR enabled = ?) AND (? IS NULL OR id > ?)
      ORDER BY id
      LIMIT ?
    `).all(enabled, enabled, cursor, cursor, limit + 1) as SqlRow[];
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(mapTask),
      nextCursor: rows.length > limit ? String(pageRows.at(-1)!.id) : null
    };
  }

  update(input: UpdateScheduledTaskInput): UpdateScheduledTaskResult {
    const id = normalizeScheduledTaskId(input.id);
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const changed = ["name", "enabled", "schedule", "context", "targets"]
      .some((field) => Object.prototype.hasOwnProperty.call(input, field));
    if (!changed) throw new Error("Scheduled task update requires at least one changed field.");

    return this.transaction(() => {
      const current = this.readTask(id);
      if (!current) return { status: "not_found" };
      if (current.revision !== expectedRevision) return { status: "conflict", current };
      const draft = normalizeScheduledTaskDraft({
        name: input.name ?? current.name,
        enabled: input.enabled ?? current.enabled,
        schedule: input.schedule ?? current.schedule,
        context: input.context ?? current.context,
        targets: input.targets ?? current.targets
      }, { isAllowedConversationId: this.allowedConversationIds });
      const scheduleChanged = JSON.stringify(draft.schedule) !== JSON.stringify(current.schedule);
      const becameEnabled = draft.enabled && !current.enabled;
      const nextRunAt = !draft.enabled
        ? null
        : scheduleChanged || becameEnabled
          ? firstScheduledAt(draft.schedule, this.now())
          : current.nextRunAt;
      const timestamp = this.now().toISOString();
      const schedule = scheduleColumns(draft.schedule);
      const updated = this.database.prepare(`
        UPDATE scheduled_tasks SET
          revision = revision + 1,
          name = ?, enabled = ?, schedule_kind = ?, cron_expression = ?, timezone = ?, run_at = ?,
          context_text = ?, targets_json = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        draft.name,
        draft.enabled ? 1 : 0,
        schedule.kind,
        schedule.expression,
        schedule.timezone,
        schedule.runAt,
        draft.context,
        JSON.stringify(draft.targets),
        nextRunAt,
        timestamp,
        id,
        expectedRevision
      );
      if (Number(updated.changes) !== 1) {
        const latest = this.readTask(id);
        return latest ? { status: "conflict", current: latest } : { status: "not_found" };
      }
      return { status: "updated", task: this.requireTask(id) };
    });
  }

  delete(id: string, expectedRevision: number): DeleteScheduledTaskResult {
    const taskId = normalizeScheduledTaskId(id);
    const revision = positiveInteger(expectedRevision, "expectedRevision");
    return this.transaction(() => {
      const removed = this.database.prepare("DELETE FROM scheduled_tasks WHERE id = ? AND revision = ?")
        .run(taskId, revision);
      if (Number(removed.changes) === 1) return { status: "deleted" };
      const current = this.readTask(taskId);
      return current ? { status: "conflict", current } : { status: "not_found" };
    });
  }

  getRun(id: string) {
    return this.readRun(normalizeScheduledTaskId(id, "runId"));
  }

  listRuns(taskId?: string) {
    const rows = taskId == null
      ? this.database.prepare(`SELECT ${RUN_COLUMNS} FROM scheduled_task_runs ORDER BY scheduled_for, id`).all()
      : this.database.prepare(`
          SELECT ${RUN_COLUMNS} FROM scheduled_task_runs
          WHERE task_id = ? ORDER BY scheduled_for, id
        `).all(normalizeScheduledTaskId(taskId));
    return (rows as SqlRow[]).map(mapRun);
  }

  claimDueOccurrence(input: ClaimDueOccurrenceInput = {}): ClaimDueOccurrenceResult | undefined {
    const now = this.inputDate(input.now);
    const nowIso = now.toISOString();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT ${TASK_COLUMNS} FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at, id LIMIT 1
      `).get(nowIso) as SqlRow | undefined;
      if (!row) return undefined;
      const task = mapTask(row);
      const scheduledFor = task.nextRunAt!;
      const nextRunAt = nextScheduledAt(task.schedule, now);
      const snapshot = scheduledTaskSnapshot(task);
      const runId = normalizeScheduledTaskId(this.idFactory(), "runId");
      const inserted = this.database.prepare(`
        INSERT INTO scheduled_task_runs (
          id, task_id, task_revision, scheduled_for, status, snapshot_json, result_text,
          error_text, attempts, worker_id, lease_until, created_at, updated_at, generated_at, completed_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, 0, NULL, NULL, ?, ?, NULL, NULL)
        ON CONFLICT(task_id, scheduled_for) DO NOTHING
      `).run(
        runId,
        task.id,
        task.revision,
        scheduledFor,
        JSON.stringify(snapshot),
        nowIso,
        nowIso
      );
      const status = Number(inserted.changes) === 1 ? "created" as const : "existing" as const;
      const run = status === "created"
        ? this.requireRun(runId)
        : this.requireRunByOccurrence(task.id, scheduledFor);
      if (run.taskRevision !== task.revision || JSON.stringify(run.snapshot) !== JSON.stringify(snapshot)) {
        throw new Error(`Scheduled task occurrence collision for ${task.id} at ${scheduledFor}.`);
      }
      const advanced = this.database.prepare(`
        UPDATE scheduled_tasks SET next_run_at = ?, last_scheduled_at = ?, updated_at = ?
        WHERE id = ? AND revision = ? AND next_run_at = ?
      `).run(nextRunAt, scheduledFor, nowIso, task.id, task.revision, scheduledFor);
      if (Number(advanced.changes) !== 1) throw new Error("Scheduled task due occurrence could not advance atomically.");
      return { status, run };
    });
  }

  claimPendingRun(input: ClaimPendingRunInput): ScheduledTaskRun | undefined {
    const workerId = normalizeScheduledTaskWorkerId(input.workerId);
    const leaseMs = normalizeLease(input.leaseMs);
    const now = this.inputDate(input.now);
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT ${RUN_COLUMNS} FROM scheduled_task_runs
        WHERE status = 'pending'
          OR (status IN ('running', 'generated') AND lease_until <= ?)
        ORDER BY CASE status WHEN 'generated' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
          scheduled_for, id
        LIMIT 1
      `).get(nowIso) as SqlRow | undefined;
      if (!row) return undefined;
      const run = mapRun(row);
      const claimed = this.database.prepare(`
        UPDATE scheduled_task_runs SET
          status = CASE WHEN status = 'generated' THEN 'generated' ELSE 'running' END,
          attempts = attempts + 1,
          worker_id = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND (
          status = 'pending'
          OR (status IN ('running', 'generated') AND lease_until <= ?)
        )
      `).run(workerId, leaseUntil, nowIso, run.id, nowIso);
      return Number(claimed.changes) === 1 ? this.requireRun(run.id) : undefined;
    });
  }

  renew(input: RenewScheduledTaskRunInput): ScheduledTaskRun | undefined {
    const runId = normalizeScheduledTaskId(input.runId, "runId");
    const workerId = normalizeScheduledTaskWorkerId(input.workerId);
    const now = this.inputDate(input.now);
    const nowIso = now.toISOString();
    const proposed = new Date(now.getTime() + normalizeLease(input.leaseMs)).toISOString();
    const updated = this.database.prepare(`
      UPDATE scheduled_task_runs SET
        lease_until = CASE WHEN lease_until > ? THEN lease_until ELSE ? END,
        updated_at = ?
      WHERE id = ? AND worker_id = ? AND status IN ('running', 'generated') AND lease_until > ?
    `).run(proposed, proposed, nowIso, runId, workerId, nowIso);
    return Number(updated.changes) === 1 ? this.requireRun(runId) : undefined;
  }

  markGenerated(input: MarkScheduledTaskRunGeneratedInput): ScheduledTaskRun | undefined {
    const runId = normalizeScheduledTaskId(input.runId, "runId");
    const workerId = normalizeScheduledTaskWorkerId(input.workerId);
    const resultText = normalizeScheduledTaskResult(input.resultText);
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE scheduled_task_runs SET
        status = 'generated', result_text = ?, generated_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running' AND lease_until > ?
    `).run(resultText, nowIso, nowIso, runId, workerId, nowIso);
    return Number(updated.changes) === 1 ? this.requireRun(runId) : undefined;
  }

  complete(input: CompleteScheduledTaskRunInput): ScheduledTaskRun | undefined {
    const runId = normalizeScheduledTaskId(input.runId, "runId");
    const workerId = normalizeScheduledTaskWorkerId(input.workerId);
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE scheduled_task_runs SET
        status = 'completed', worker_id = NULL, lease_until = NULL,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'generated' AND lease_until > ?
    `).run(nowIso, nowIso, runId, workerId, nowIso);
    return Number(updated.changes) === 1 ? this.requireRun(runId) : undefined;
  }

  fail(input: FailScheduledTaskRunInput): ScheduledTaskRun | undefined {
    const runId = normalizeScheduledTaskId(input.runId, "runId");
    const workerId = normalizeScheduledTaskWorkerId(input.workerId);
    const errorText = normalizeScheduledTaskError(input.errorText);
    const nowIso = this.inputDate(input.now).toISOString();
    const updated = this.database.prepare(`
      UPDATE scheduled_task_runs SET
        status = 'failed', error_text = ?, worker_id = NULL, lease_until = NULL,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status IN ('running', 'generated') AND lease_until > ?
    `).run(errorText, nowIso, nowIso, runId, workerId, nowIso);
    return Number(updated.changes) === 1 ? this.requireRun(runId) : undefined;
  }

  nextWakeAt() {
    const row = this.database.prepare(`
      SELECT MIN(wake_at) AS wake_at FROM (
        SELECT next_run_at AS wake_at FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL
        UNION ALL
        SELECT CASE WHEN status = 'pending' THEN created_at ELSE lease_until END AS wake_at
        FROM scheduled_task_runs
        WHERE status IN ('pending', 'running', 'generated')
      )
    `).get() as SqlRow | undefined;
    return row?.wake_at == null ? null : normalizeStoredTimestamp(row.wake_at, "wakeAt");
  }

  private readTask(id: string) {
    const row = this.database.prepare(`SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?`)
      .get(id) as SqlRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  private requireTask(id: string) {
    const task = this.readTask(id);
    if (!task) throw new Error(`Scheduled task not found: ${id}`);
    return task;
  }

  private readRun(id: string) {
    const row = this.database.prepare(`SELECT ${RUN_COLUMNS} FROM scheduled_task_runs WHERE id = ?`)
      .get(id) as SqlRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  private requireRun(id: string) {
    const run = this.readRun(id);
    if (!run) throw new Error(`Scheduled task run not found: ${id}`);
    return run;
  }

  private requireRunByOccurrence(taskId: string, scheduledFor: string) {
    const row = this.database.prepare(`
      SELECT ${RUN_COLUMNS} FROM scheduled_task_runs WHERE task_id = ? AND scheduled_for = ?
    `).get(taskId, scheduledFor) as SqlRow | undefined;
    if (!row) throw new Error(`Scheduled task occurrence not found: ${taskId} at ${scheduledFor}`);
    return mapRun(row);
  }

  private now() {
    return validDate(this.clock(), "clock");
  }

  private inputDate(value?: Date) {
    return validDate(value ?? this.clock(), value ? "now" : "clock");
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

function mapTask(row: SqlRow): ScheduledTask {
  const schedule = storedSchedule(row);
  const draft = normalizeScheduledTaskDraft({
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    schedule,
    context: String(row.context_text),
    targets: normalizeScheduledTaskTargets(parseJson(row.targets_json, "targets_json"))
  });
  return {
    id: normalizeScheduledTaskId(String(row.id)),
    revision: positiveInteger(Number(row.revision), "stored task revision"),
    ...draft,
    nextRunAt: nullableTimestamp(row.next_run_at, "next_run_at"),
    lastScheduledAt: nullableTimestamp(row.last_scheduled_at, "last_scheduled_at"),
    createdAt: normalizeStoredTimestamp(row.created_at, "created_at"),
    updatedAt: normalizeStoredTimestamp(row.updated_at, "updated_at")
  };
}

function mapRun(row: SqlRow): ScheduledTaskRun {
  const status = String(row.status);
  if (!isRunStatus(status)) throw new Error(`Stored scheduled task run status is invalid: ${status}`);
  const snapshot = decodeScheduledTaskSnapshot(parseJson(row.snapshot_json, "snapshot_json"));
  const taskId = normalizeScheduledTaskId(String(row.task_id));
  const taskRevision = positiveInteger(Number(row.task_revision), "stored run task revision");
  if (snapshot.taskId !== taskId || snapshot.taskRevision !== taskRevision) {
    throw new Error("Stored scheduled task run snapshot identity is inconsistent.");
  }
  return {
    id: normalizeScheduledTaskId(String(row.id), "runId"),
    taskId,
    taskRevision,
    scheduledFor: normalizeStoredTimestamp(row.scheduled_for, "scheduled_for"),
    status,
    snapshot,
    resultText: nullableText(row.result_text),
    errorText: nullableText(row.error_text),
    attempts: nonNegativeInteger(Number(row.attempts), "stored run attempts"),
    workerId: nullableText(row.worker_id),
    leaseUntil: nullableTimestamp(row.lease_until, "lease_until"),
    createdAt: normalizeStoredTimestamp(row.created_at, "created_at"),
    updatedAt: normalizeStoredTimestamp(row.updated_at, "updated_at"),
    generatedAt: nullableTimestamp(row.generated_at, "generated_at"),
    completedAt: nullableTimestamp(row.completed_at, "completed_at")
  };
}

function storedSchedule(row: SqlRow): ScheduledTaskSchedule {
  if (row.schedule_kind === "cron") {
    return normalizeScheduledTaskSchedule({
      kind: "cron",
      expression: String(row.cron_expression),
      timezone: String(row.timezone)
    });
  }
  if (row.schedule_kind === "once") {
    return normalizeScheduledTaskSchedule({ kind: "once", runAt: String(row.run_at) });
  }
  throw new Error(`Stored scheduled task schedule kind is invalid: ${String(row.schedule_kind)}`);
}

function scheduleColumns(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "cron") {
    return { kind: "cron", expression: schedule.expression, timezone: schedule.timezone, runAt: null };
  }
  return { kind: "once", expression: null, timezone: null, runAt: schedule.runAt };
}

function nullableTimestamp(value: unknown, field: string) {
  return value == null ? null : normalizeStoredTimestamp(value, field);
}

function nullableText(value: unknown) {
  return value == null ? null : String(value);
}

function parseJson(value: unknown, field: string): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    throw new Error(`Stored scheduled task ${field} is invalid JSON.`);
  }
}

function isRunStatus(value: string): value is ScheduledTaskRunStatus {
  return value === "pending" || value === "running" || value === "generated" ||
    value === "completed" || value === "failed";
}

function listLimit(value: number | undefined) {
  if (value == null) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("Scheduled task list limit must be between 1 and 100.");
  }
  return value;
}

function normalizeLease(value: number) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 86_400_000) {
    throw new Error("leaseMs must be between 100 and 86400000.");
  }
  return value;
}

function validDate(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${field} returned an invalid date.`);
  return new Date(value.getTime());
}
