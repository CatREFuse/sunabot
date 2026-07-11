import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexProcessIdentity } from "../../packages/contracts/tools/codex.js";
import { toolCompletionEnvelope, type AsyncToolCompletionPayload } from "../../packages/contracts/session/runtimeMessages.js";

export type SessionEventStatus = "pending" | "running" | "completed" | "dead";
export type TurnStatus =
  | "running"
  | "replied"
  | "no_reply"
  | "deferred"
  | "failed"
  | "timed_out"
  | "interrupted";
export type ToolJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "needs_input"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown";
export type OutboxStatus = "pending" | "sending" | "sent" | "dead" | "unknown";

export interface SessionStoreOptions {
  databasePath: string;
  clock?: () => number;
  idFactory?: () => string;
  defaultLeaseMs?: number;
  recoverOnOpen?: "expired" | "all";
}

export interface SessionStateRecord {
  sessionId: string;
  nextEventSequence: number;
  completedEventSequence: number;
  nextOutboxSequence: number;
  completedOutboxSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEventRecord {
  id: string;
  sessionId: string;
  sequence: number;
  kind: string;
  dedupeKey?: string;
  payload: unknown;
  status: SessionEventStatus;
  attempts: number;
  availableAt: number;
  createdAt: number;
  claimedAt?: number;
  finishedAt?: number;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  eventId: string;
  attempt: number;
  status: TurnStatus;
  workerId?: string;
  leaseUntil?: number;
  result?: unknown;
  error?: unknown;
  startedAt: number;
  finishedAt?: number;
}

export interface ToolJobRecord {
  id: string;
  sessionId: string;
  originEventId: string;
  originTurnId: string;
  providerCallId: string;
  toolName: string;
  taskKind?: string;
  originalRequest: unknown;
  arguments: unknown;
  status: ToolJobStatus;
  attempts: number;
  attemptToken?: string;
  processIdentity?: CodexProcessIdentity;
  availableAt: number;
  workerId?: string;
  leaseUntil?: number;
  result?: unknown;
  error?: unknown;
  ackOutboxId: string;
  completionEventId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface OutboxRecord {
  id: string;
  sessionId: string;
  sequence: number;
  originTurnId: string;
  kind: string;
  dedupeKey?: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  availableAt: number;
  workerId?: string;
  leaseUntil?: number;
  result?: unknown;
  error?: unknown;
  createdAt: number;
  sentAt?: number;
  finishedAt?: number;
}

export interface EnqueueSessionEventInput {
  sessionId: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string;
  availableAt?: number;
}

export interface EnqueueSessionEventResult {
  event: SessionEventRecord;
  inserted: boolean;
}

export interface ClaimOptions {
  workerId: string;
  leaseMs?: number;
  sessionId?: string;
}

export interface ClaimedTurn {
  event: SessionEventRecord;
  turn: TurnRecord;
}

export interface OutboxDraft {
  kind: string;
  payload: unknown;
  dedupeKey?: string;
  availableAt?: number;
}

export interface FinishTurnInput {
  turnId: string;
  workerId: string;
  outcome: Exclude<TurnStatus, "running" | "deferred" | "interrupted">;
  result?: unknown;
  error?: unknown;
  outbox?: OutboxDraft[];
}

export interface FinishTurnResult {
  turn: TurnRecord;
  outbox: OutboxRecord[];
  duplicate: boolean;
}

export interface DeferTurnInput {
  turnId: string;
  workerId: string;
  job: {
    id?: string;
    providerCallId: string;
    toolName: string;
    taskKind?: string;
    originalRequest: unknown;
    arguments: unknown;
    availableAt?: number;
  };
  acknowledgement: OutboxDraft;
  result?: unknown;
}

export interface DeferTurnResult {
  turn: TurnRecord;
  job: ToolJobRecord;
  acknowledgement: OutboxRecord;
  duplicate: boolean;
}

export interface CompleteToolJobInput {
  jobId: string;
  workerId?: string;
  attempt?: number;
  attemptToken?: string;
  status: Exclude<ToolJobStatus, "queued" | "running">;
  result?: unknown;
  error?: unknown;
}

export interface CompleteToolJobResult {
  job: ToolJobRecord;
  event: SessionEventRecord;
  inserted: boolean;
}

export interface FinishOutboxInput {
  outboxId: string;
  workerId: string;
  outcome: "sent" | "dead" | "unknown" | "retry";
  result?: unknown;
  error?: unknown;
  availableAt?: number;
}

export interface RecoveryResult {
  turns: number;
  toolJobs: number;
  outbox: number;
}

type SqlRow = Record<string, unknown>;

const SCHEMA_VERSION = 2;
const DEFAULT_LEASE_MS = 30_000;

export class SessionStore {
  private readonly database: DatabaseSync;
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly defaultLeaseMs: number;

  constructor(options: SessionStoreOptions) {
    if (!options.databasePath.trim()) throw new Error("SessionStore databasePath is required.");
    if (options.databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(options.databasePath)), { recursive: true });
    }
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.defaultLeaseMs = positiveInteger(options.defaultLeaseMs, DEFAULT_LEASE_MS, "defaultLeaseMs");
    this.database = new DatabaseSync(options.databasePath, { timeout: 5_000 });
    this.configureDatabase();
    this.migrate();
    if (options.recoverOnOpen === "expired") this.recoverExpiredLeases();
    if (options.recoverOnOpen === "all") this.recoverAllLeases();
  }

  close() {
    if (this.database.isOpen) this.database.close();
  }

  getJournalMode() {
    const row = this.database.prepare("PRAGMA journal_mode").get() as SqlRow | undefined;
    return String(row?.journal_mode ?? "");
  }

  enqueueEvent(input: EnqueueSessionEventInput): EnqueueSessionEventResult {
    const sessionId = requiredText(input.sessionId, "sessionId");
    const kind = requiredText(input.kind, "kind");
    const dedupeKey = optionalText(input.dedupeKey);
    const now = this.now();
    const availableAt = integerTimestamp(input.availableAt, now, "availableAt");

    return this.transaction(() => {
      this.ensureSession(sessionId, now);
      if (dedupeKey) {
        const existing = this.database.prepare(`
          SELECT * FROM session_events WHERE session_id = ? AND dedupe_key = ?
        `).get(sessionId, dedupeKey) as SqlRow | undefined;
        if (existing) return { event: mapEvent(existing), inserted: false };
      }

      const sequence = this.allocateEventSequence(sessionId, now);
      const id = this.nextId();
      this.database.prepare(`
        INSERT INTO session_events (
          id, session_id, sequence, kind, dedupe_key, payload_json,
          status, attempts, available_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(id, sessionId, sequence, kind, dedupeKey ?? null, json(input.payload), availableAt, now);
      return { event: this.requireEvent(id), inserted: true };
    });
  }

  claimNextTurn(options: ClaimOptions): ClaimedTurn | null {
    const workerId = requiredText(options.workerId, "workerId");
    const leaseMs = positiveInteger(options.leaseMs, this.defaultLeaseMs, "leaseMs");
    const sessionId = optionalText(options.sessionId);
    const now = this.now();

    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT e.*
        FROM session_events e
        JOIN sessions s ON s.session_id = e.session_id
        WHERE e.status = 'pending'
          AND e.available_at <= ?
          AND e.sequence = s.completed_event_sequence + 1
          AND (? IS NULL OR e.session_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM turns t
            WHERE t.session_id = e.session_id AND t.status = 'running'
          )
        ORDER BY e.available_at, e.created_at, e.session_id, e.sequence
        LIMIT 1
      `).get(now, sessionId ?? null, sessionId ?? null) as SqlRow | undefined;
      if (!row) return null;

      const event = mapEvent(row);
      const turnId = this.nextId();
      const attempt = event.attempts + 1;
      const leaseUntil = now + leaseMs;
      const updated = this.database.prepare(`
        UPDATE session_events
        SET status = 'running', attempts = ?, claimed_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(attempt, now, event.id);
      if (Number(updated.changes) !== 1) return null;
      this.database.prepare(`
        INSERT INTO turns (
          id, session_id, event_id, attempt, status, worker_id,
          lease_until, started_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      `).run(turnId, event.sessionId, event.id, attempt, workerId, leaseUntil, now);
      return {
        event: this.requireEvent(event.id),
        turn: this.requireTurn(turnId)
      };
    });
  }

  renewTurnLease(turnId: string, workerId: string, leaseMs = this.defaultLeaseMs) {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE turns SET lease_until = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(now + positiveInteger(leaseMs, this.defaultLeaseMs, "leaseMs"), turnId, workerId);
    return Number(result.changes) === 1;
  }

  finishTurn(input: FinishTurnInput): FinishTurnResult {
    const now = this.now();
    const outboxDrafts = input.outbox ?? [];
    return this.transaction(() => {
      const turn = this.requireTurn(input.turnId);
      if (turn.status !== "running") {
        if (turn.status === input.outcome) {
          return {
            turn,
            outbox: this.listOutboxForTurn(turn.id),
            duplicate: true
          };
        }
        throw new Error(`Turn ${turn.id} is ${turn.status}, not running.`);
      }
      this.assertWorker(turn.workerId, input.workerId, `turn ${turn.id}`);
      const event = this.requireEvent(turn.eventId);
      this.assertHeadEvent(event);

      const outbox = outboxDrafts.map((draft) => this.insertOutbox(turn, draft, now));
      this.database.prepare(`
        UPDATE turns
        SET status = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.outcome, nullableJson(input.result), nullableJson(input.error), now, turn.id);
      this.completeEvent(event, now);
      return {
        turn: this.requireTurn(turn.id),
        outbox,
        duplicate: false
      };
    });
  }

  deferTurn(input: DeferTurnInput): DeferTurnResult {
    const providerCallId = requiredText(input.job.providerCallId, "providerCallId");
    const toolName = requiredText(input.job.toolName, "toolName");
    const now = this.now();

    return this.transaction(() => {
      const turn = this.requireTurn(input.turnId);
      if (turn.status === "deferred") {
        const job = this.requireToolJobForTurn(turn.id, providerCallId);
        return {
          turn,
          job,
          acknowledgement: this.requireOutbox(job.ackOutboxId),
          duplicate: true
        };
      }
      if (turn.status !== "running") {
        throw new Error(`Turn ${turn.id} is ${turn.status}, not running.`);
      }
      this.assertWorker(turn.workerId, input.workerId, `turn ${turn.id}`);
      const event = this.requireEvent(turn.eventId);
      this.assertHeadEvent(event);

      const jobId = optionalText(input.job.id) ?? this.nextId();
      const acknowledgement = this.insertOutbox(turn, input.acknowledgement, now);
      this.database.prepare(`
        INSERT INTO tool_jobs (
          id, session_id, origin_event_id, origin_turn_id, provider_call_id,
          tool_name, task_kind, original_request_json, arguments_json,
          status, attempts, available_at, ack_outbox_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      `).run(
        jobId,
        turn.sessionId,
        event.id,
        turn.id,
        providerCallId,
        toolName,
        optionalText(input.job.taskKind) ?? null,
        json(input.job.originalRequest),
        json(input.job.arguments),
        integerTimestamp(input.job.availableAt, now, "job.availableAt"),
        acknowledgement.id,
        now
      );
      this.database.prepare(`
        UPDATE turns
        SET status = 'deferred', worker_id = NULL, lease_until = NULL,
            result_json = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(nullableJson(input.result), now, turn.id);
      this.completeEvent(event, now);
      return {
        turn: this.requireTurn(turn.id),
        job: this.requireToolJob(jobId),
        acknowledgement,
        duplicate: false
      };
    });
  }

  claimNextToolJob(options: ClaimOptions): ToolJobRecord | null {
    const workerId = requiredText(options.workerId, "workerId");
    const leaseMs = positiveInteger(options.leaseMs, this.defaultLeaseMs, "leaseMs");
    const sessionId = optionalText(options.sessionId);
    const now = this.now();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM tool_jobs
        WHERE status = 'queued' AND available_at <= ?
          AND (? IS NULL OR session_id = ?)
        ORDER BY available_at, created_at, id
        LIMIT 1
      `).get(now, sessionId ?? null, sessionId ?? null) as SqlRow | undefined;
      if (!row) return null;
      const job = mapToolJob(row);
      const attemptToken = this.nextId();
      const updated = this.database.prepare(`
        UPDATE tool_jobs
        SET status = 'running', attempts = attempts + 1, worker_id = ?,
            lease_until = ?, started_at = COALESCE(started_at, ?), attempt_token = ?
        WHERE id = ? AND status = 'queued'
      `).run(workerId, now + leaseMs, now, attemptToken, job.id);
      return Number(updated.changes) === 1 ? this.requireToolJob(job.id) : null;
    });
  }

  claimToolJob(jobId: string, options: Omit<ClaimOptions, "sessionId">): ToolJobRecord | null {
    const id = requiredText(jobId, "jobId");
    const workerId = requiredText(options.workerId, "workerId");
    const leaseMs = positiveInteger(options.leaseMs, this.defaultLeaseMs, "leaseMs");
    const now = this.now();
    return this.transaction(() => {
      const attemptToken = this.nextId();
      const updated = this.database.prepare(`
        UPDATE tool_jobs
        SET status = 'running', attempts = attempts + 1, worker_id = ?,
            lease_until = ?, started_at = COALESCE(started_at, ?), attempt_token = ?
        WHERE id = ? AND status = 'queued' AND available_at <= ?
      `).run(workerId, now + leaseMs, now, attemptToken, id, now);
      return Number(updated.changes) === 1 ? this.requireToolJob(id) : null;
    });
  }

  renewToolJobLease(
    jobId: string,
    workerId: string,
    leaseMs = this.defaultLeaseMs,
    attempt?: number,
    attemptToken?: string
  ) {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE tool_jobs SET lease_until = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
        AND (? IS NULL OR attempts = ?)
        AND (? IS NULL OR attempt_token = ?)
    `).run(
      now + positiveInteger(leaseMs, this.defaultLeaseMs, "leaseMs"),
      jobId,
      workerId,
      attempt ?? null,
      attempt ?? null,
      attemptToken ?? null,
      attemptToken ?? null
    );
    return Number(result.changes) === 1;
  }

  recordToolJobProcess(
    jobId: string,
    workerId: string,
    attempt: number,
    attemptToken: string,
    identity: CodexProcessIdentity
  ) {
    const validated = validateProcessIdentity(identity);
    if (validated.attempt !== attempt || validated.runToken !== attemptToken) {
      throw new Error(`Codex process identity does not match tool job ${jobId} attempt.`);
    }
    const result = this.database.prepare(`
      UPDATE tool_jobs SET process_identity_json = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
        AND attempts = ? AND attempt_token = ?
    `).run(json(validated), jobId, workerId, attempt, attemptToken);
    if (Number(result.changes) !== 1) {
      throw new Error(`Tool job ${jobId} attempt no longer owns its process claim.`);
    }
    return this.requireToolJob(jobId);
  }

  clearRecoveredToolJobProcess(
    jobId: string,
    workerId: string,
    attempt: number,
    attemptToken: string,
    recoveredRunToken: string
  ) {
    return this.transaction(() => {
      const job = this.requireToolJob(jobId);
      this.assertToolAttempt(job, workerId, attempt, attemptToken);
      if (!job.processIdentity) return job;
      if (job.processIdentity.runToken !== recoveredRunToken) {
        throw new Error(`Tool job ${jobId} recovered process identity changed.`);
      }
      this.database.prepare(`
        UPDATE tool_jobs SET process_identity_json = NULL
        WHERE id = ? AND status = 'running' AND worker_id = ?
          AND attempts = ? AND attempt_token = ?
      `).run(jobId, workerId, attempt, attemptToken);
      return this.requireToolJob(jobId);
    });
  }

  completeToolJob(input: CompleteToolJobInput): CompleteToolJobResult {
    const now = this.now();
    return this.transaction(() => {
      const job = this.requireToolJob(input.jobId);
      if (job.completionEventId) {
        return {
          job,
          event: this.requireEvent(job.completionEventId),
          inserted: false
        };
      }
      if (job.status === "running" && input.workerId) {
        this.assertWorker(job.workerId, input.workerId, `tool job ${job.id}`);
        if (input.attempt !== undefined || input.attemptToken !== undefined) {
          this.assertToolAttempt(
            job,
            input.workerId,
            positiveInteger(input.attempt, -1, "attempt"),
            requiredText(input.attemptToken, "attemptToken")
          );
        }
      } else if (input.workerId && job.status !== "running") {
        throw new Error(`Tool job ${job.id} is ${job.status}, not running.`);
      }
      if (isTerminalToolStatus(job.status)) {
        throw new Error(`Tool job ${job.id} is terminal without a completion event.`);
      }

      this.ensureSession(job.sessionId, now);
      const sequence = this.allocateEventSequence(job.sessionId, now);
      const completionEventId = this.nextId();
      const completionPayload = toolCompletionEnvelope({
        type: "tool_result",
        toolJobId: job.id,
        providerCallId: job.providerCallId,
        toolName: job.toolName,
        originalRequest: job.originalRequest as AsyncToolCompletionPayload["originalRequest"],
        arguments: job.arguments,
        outcome: {
          status: input.status,
          result: input.result ?? null,
          error: input.error ?? null
        }
      }, {
        conversationId: job.sessionId,
        correlationId: job.providerCallId,
        causationId: job.originEventId,
        idempotencyKey: `tool-completion:${job.id}`
      });
      this.database.prepare(`
        INSERT INTO session_events (
          id, session_id, sequence, kind, dedupe_key, payload_json,
          status, attempts, available_at, created_at
        ) VALUES (?, ?, ?, 'tool_completion', ?, ?, 'pending', 0, ?, ?)
      `).run(
        completionEventId,
        job.sessionId,
        sequence,
        `tool-completion:${job.id}`,
        json(completionPayload),
        now,
        now
      );
      const updated = this.database.prepare(`
        UPDATE tool_jobs
        SET status = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = ?, completion_event_id = ?, finished_at = ?,
            process_identity_json = NULL
        WHERE id = ? AND completion_event_id IS NULL
      `).run(
        input.status,
        nullableJson(input.result),
        nullableJson(input.error),
        completionEventId,
        now,
        job.id
      );
      if (Number(updated.changes) !== 1) {
        throw new Error(`Tool job ${job.id} completion lost its compare-and-set.`);
      }
      return {
        job: this.requireToolJob(job.id),
        event: this.requireEvent(completionEventId),
        inserted: true
      };
    });
  }

  claimNextOutbox(options: ClaimOptions): OutboxRecord | null {
    const workerId = requiredText(options.workerId, "workerId");
    const leaseMs = positiveInteger(options.leaseMs, this.defaultLeaseMs, "leaseMs");
    const sessionId = optionalText(options.sessionId);
    const now = this.now();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT o.*
        FROM outbox o
        JOIN sessions s ON s.session_id = o.session_id
        WHERE o.status = 'pending'
          AND o.available_at <= ?
          AND o.sequence = s.completed_outbox_sequence + 1
          AND (? IS NULL OR o.session_id = ?)
        ORDER BY o.available_at, o.created_at, o.session_id, o.sequence
        LIMIT 1
      `).get(now, sessionId ?? null, sessionId ?? null) as SqlRow | undefined;
      if (!row) return null;
      const outbox = mapOutbox(row);
      const updated = this.database.prepare(`
        UPDATE outbox
        SET status = 'sending', attempts = attempts + 1,
            worker_id = ?, lease_until = ?
        WHERE id = ? AND status = 'pending'
      `).run(workerId, now + leaseMs, outbox.id);
      return Number(updated.changes) === 1 ? this.requireOutbox(outbox.id) : null;
    });
  }

  renewOutboxLease(outboxId: string, workerId: string, leaseMs = this.defaultLeaseMs) {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE outbox SET lease_until = ?
      WHERE id = ? AND status = 'sending' AND worker_id = ?
    `).run(now + positiveInteger(leaseMs, this.defaultLeaseMs, "leaseMs"), outboxId, workerId);
    return Number(result.changes) === 1;
  }

  finishOutbox(input: FinishOutboxInput): OutboxRecord {
    const now = this.now();
    return this.transaction(() => {
      const outbox = this.requireOutbox(input.outboxId);
      if (isTerminalOutboxStatus(outbox.status)) return outbox;
      if (outbox.status !== "sending") {
        throw new Error(`Outbox ${outbox.id} is ${outbox.status}, not sending.`);
      }
      this.assertWorker(outbox.workerId, input.workerId, `outbox ${outbox.id}`);

      if (input.outcome === "retry") {
        this.database.prepare(`
          UPDATE outbox
          SET status = 'pending', worker_id = NULL, lease_until = NULL,
              error_json = ?, available_at = ?
          WHERE id = ? AND status = 'sending'
        `).run(
          nullableJson(input.error),
          integerTimestamp(input.availableAt, now, "availableAt"),
          outbox.id
        );
        return this.requireOutbox(outbox.id);
      }

      const session = this.requireSession(outbox.sessionId);
      if (outbox.sequence !== session.completedOutboxSequence + 1) {
        throw new Error(`Outbox ${outbox.id} is not the head of session ${outbox.sessionId}.`);
      }
      this.database.prepare(`
        UPDATE outbox
        SET status = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = ?, sent_at = ?, finished_at = ?
        WHERE id = ? AND status = 'sending'
      `).run(
        input.outcome,
        nullableJson(input.result),
        nullableJson(input.error),
        input.outcome === "sent" ? now : null,
        now,
        outbox.id
      );
      this.database.prepare(`
        UPDATE sessions
        SET completed_outbox_sequence = ?, updated_at = ?
        WHERE session_id = ? AND completed_outbox_sequence = ?
      `).run(outbox.sequence, now, outbox.sessionId, outbox.sequence - 1);
      return this.requireOutbox(outbox.id);
    });
  }

  recoverExpiredLeases(): RecoveryResult {
    return this.recoverLeases(false);
  }

  recoverAllLeases(): RecoveryResult {
    return this.recoverLeases(true);
  }

  getSessionState(sessionId: string) {
    const row = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SqlRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  getEvent(id: string) {
    const row = this.database.prepare("SELECT * FROM session_events WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  getTurn(id: string) {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapTurn(row) : undefined;
  }

  getToolJob(id: string) {
    const row = this.database.prepare("SELECT * FROM tool_jobs WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapToolJob(row) : undefined;
  }

  getOutbox(id: string) {
    const row = this.database.prepare("SELECT * FROM outbox WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  listEvents(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as SqlRow[]).map(mapEvent);
  }

  listTurns(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY started_at, attempt, id
    `).all(sessionId) as SqlRow[]).map(mapTurn);
  }

  listToolJobs(sessionId?: string) {
    const rows = sessionId
      ? this.database.prepare("SELECT * FROM tool_jobs WHERE session_id = ? ORDER BY created_at, id").all(sessionId)
      : this.database.prepare("SELECT * FROM tool_jobs ORDER BY created_at, id").all();
    return (rows as SqlRow[]).map(mapToolJob);
  }

  listOutbox(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM outbox WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as SqlRow[]).map(mapOutbox);
  }

  private configureDatabase() {
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  private migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
    const row = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as SqlRow;
    let currentVersion = numberValue(row.version);
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(`SessionStore schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}.`);
    }
    if (currentVersion === SCHEMA_VERSION) return;

    if (currentVersion < 1) this.transaction(() => {
      this.database.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          next_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_event_sequence >= 0),
          completed_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (completed_event_sequence >= 0),
          next_outbox_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_outbox_sequence >= 0),
          completed_outbox_sequence INTEGER NOT NULL DEFAULT 0 CHECK (completed_outbox_sequence >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (completed_event_sequence <= next_event_sequence),
          CHECK (completed_outbox_sequence <= next_outbox_sequence)
        ) STRICT;

        CREATE TABLE session_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          kind TEXT NOT NULL,
          dedupe_key TEXT,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          finished_at INTEGER,
          UNIQUE (session_id, sequence),
          UNIQUE (session_id, dedupe_key)
        ) STRICT;

        CREATE INDEX session_events_claim_idx
          ON session_events(status, available_at, session_id, sequence);

        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          event_id TEXT NOT NULL REFERENCES session_events(id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          status TEXT NOT NULL CHECK (status IN (
            'running', 'replied', 'no_reply', 'deferred', 'failed',
            'timed_out', 'interrupted'
          )),
          worker_id TEXT,
          lease_until INTEGER,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          UNIQUE (event_id, attempt)
        ) STRICT;

        CREATE UNIQUE INDEX turns_one_running_per_session
          ON turns(session_id) WHERE status = 'running';

        CREATE INDEX turns_lease_idx ON turns(status, lease_until);

        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          origin_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          dedupe_key TEXT,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead', 'unknown')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at INTEGER NOT NULL,
          worker_id TEXT,
          lease_until INTEGER,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          finished_at INTEGER,
          UNIQUE (session_id, sequence),
          UNIQUE (session_id, dedupe_key)
        ) STRICT;

        CREATE INDEX outbox_claim_idx ON outbox(status, available_at, session_id, sequence);
        CREATE INDEX outbox_lease_idx ON outbox(status, lease_until);

        CREATE TABLE tool_jobs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          origin_event_id TEXT NOT NULL REFERENCES session_events(id) ON DELETE CASCADE,
          origin_turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          provider_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          task_kind TEXT,
          original_request_json TEXT NOT NULL CHECK (json_valid(original_request_json)),
          arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'succeeded', 'needs_input', 'failed', 'timed_out',
            'cancelled', 'unknown'
          )),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          available_at INTEGER NOT NULL,
          worker_id TEXT,
          lease_until INTEGER,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
          ack_outbox_id TEXT NOT NULL REFERENCES outbox(id),
          completion_event_id TEXT UNIQUE REFERENCES session_events(id),
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          UNIQUE (origin_turn_id, provider_call_id)
        ) STRICT;

        CREATE INDEX tool_jobs_claim_idx ON tool_jobs(status, available_at, created_at);
        CREATE INDEX tool_jobs_lease_idx ON tool_jobs(status, lease_until);
      `);
      this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, this.now());
    });
    currentVersion = Math.max(currentVersion, 1);

    if (currentVersion < 2) this.transaction(() => {
      this.database.exec(`
        ALTER TABLE tool_jobs ADD COLUMN attempt_token TEXT;
        ALTER TABLE tool_jobs ADD COLUMN process_identity_json TEXT
          CHECK (process_identity_json IS NULL OR json_valid(process_identity_json));
      `);
      this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(2, this.now());
    });
  }

  private recoverLeases(all: boolean): RecoveryResult {
    const now = this.now();
    return this.transaction(() => {
      const turnRows = this.database.prepare(`
        SELECT * FROM turns
        WHERE status = 'running' AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
        ORDER BY started_at, id
      `).all(all ? 1 : 0, now) as SqlRow[];
      for (const row of turnRows) {
        const turn = mapTurn(row);
        this.database.prepare(`
          UPDATE turns
          SET status = 'interrupted', worker_id = NULL, lease_until = NULL,
              error_json = ?, finished_at = ?
          WHERE id = ? AND status = 'running'
        `).run(json({ code: "lease_recovered", message: "Turn lease was abandoned." }), now, turn.id);
        this.database.prepare(`
          UPDATE session_events
          SET status = 'pending', available_at = ?, claimed_at = NULL
          WHERE id = ? AND status = 'running'
        `).run(now, turn.eventId);
      }

      const jobResult = this.database.prepare(`
        UPDATE tool_jobs
        SET status = 'queued', worker_id = NULL, lease_until = NULL,
            available_at = ?
        WHERE status = 'running' AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
      `).run(now, all ? 1 : 0, now);
      const outboxResult = this.database.prepare(`
        UPDATE outbox
        SET status = 'pending', worker_id = NULL, lease_until = NULL,
            available_at = ?
        WHERE status = 'sending' AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
      `).run(now, all ? 1 : 0, now);
      return {
        turns: turnRows.length,
        toolJobs: Number(jobResult.changes),
        outbox: Number(outboxResult.changes)
      };
    });
  }

  private ensureSession(sessionId: string, now: number) {
    this.database.prepare(`
      INSERT INTO sessions(session_id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, now, now);
  }

  private allocateEventSequence(sessionId: string, now: number) {
    const session = this.requireSession(sessionId);
    const sequence = session.nextEventSequence + 1;
    this.database.prepare(`
      UPDATE sessions SET next_event_sequence = ?, updated_at = ? WHERE session_id = ?
    `).run(sequence, now, sessionId);
    return sequence;
  }

  private allocateOutboxSequence(sessionId: string, now: number) {
    const session = this.requireSession(sessionId);
    const sequence = session.nextOutboxSequence + 1;
    this.database.prepare(`
      UPDATE sessions SET next_outbox_sequence = ?, updated_at = ? WHERE session_id = ?
    `).run(sequence, now, sessionId);
    return sequence;
  }

  private insertOutbox(turn: TurnRecord, draft: OutboxDraft, now: number) {
    const id = this.nextId();
    const sequence = this.allocateOutboxSequence(turn.sessionId, now);
    this.database.prepare(`
      INSERT INTO outbox (
        id, session_id, sequence, origin_turn_id, kind, dedupe_key,
        payload_json, status, attempts, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      id,
      turn.sessionId,
      sequence,
      turn.id,
      requiredText(draft.kind, "outbox.kind"),
      optionalText(draft.dedupeKey) ?? null,
      json(draft.payload),
      integerTimestamp(draft.availableAt, now, "outbox.availableAt"),
      now
    );
    return this.requireOutbox(id);
  }

  private completeEvent(event: SessionEventRecord, now: number) {
    const session = this.requireSession(event.sessionId);
    if (event.sequence !== session.completedEventSequence + 1) {
      throw new Error(`Event ${event.id} is not the head of session ${event.sessionId}.`);
    }
    const eventResult = this.database.prepare(`
      UPDATE session_events
      SET status = 'completed', finished_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, event.id);
    if (Number(eventResult.changes) !== 1) {
      throw new Error(`Event ${event.id} could not be completed.`);
    }
    const sessionResult = this.database.prepare(`
      UPDATE sessions
      SET completed_event_sequence = ?, updated_at = ?
      WHERE session_id = ? AND completed_event_sequence = ?
    `).run(event.sequence, now, event.sessionId, event.sequence - 1);
    if (Number(sessionResult.changes) !== 1) {
      throw new Error(`Session ${event.sessionId} event cursor could not advance.`);
    }
  }

  private assertHeadEvent(event: SessionEventRecord) {
    if (event.status !== "running") throw new Error(`Event ${event.id} is ${event.status}, not running.`);
    const session = this.requireSession(event.sessionId);
    if (event.sequence !== session.completedEventSequence + 1) {
      throw new Error(`Event ${event.id} is not the head of session ${event.sessionId}.`);
    }
  }

  private requireSession(sessionId: string) {
    const row = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SqlRow | undefined;
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return mapSession(row);
  }

  private requireEvent(id: string) {
    const value = this.getEvent(id);
    if (!value) throw new Error(`Session event not found: ${id}`);
    return value;
  }

  private requireTurn(id: string) {
    const value = this.getTurn(id);
    if (!value) throw new Error(`Turn not found: ${id}`);
    return value;
  }

  private requireToolJob(id: string) {
    const value = this.getToolJob(id);
    if (!value) throw new Error(`Tool job not found: ${id}`);
    return value;
  }

  private requireToolJobForTurn(turnId: string, providerCallId: string) {
    const row = this.database.prepare(`
      SELECT * FROM tool_jobs WHERE origin_turn_id = ? AND provider_call_id = ?
    `).get(turnId, providerCallId) as SqlRow | undefined;
    if (!row) throw new Error(`Tool job not found for turn ${turnId} and call ${providerCallId}.`);
    return mapToolJob(row);
  }

  private requireOutbox(id: string) {
    const value = this.getOutbox(id);
    if (!value) throw new Error(`Outbox item not found: ${id}`);
    return value;
  }

  private listOutboxForTurn(turnId: string) {
    return (this.database.prepare(`
      SELECT * FROM outbox WHERE origin_turn_id = ? ORDER BY sequence
    `).all(turnId) as SqlRow[]).map(mapOutbox);
  }

  private assertWorker(actual: string | undefined, expected: string, label: string) {
    if (!actual || actual !== expected) {
      throw new Error(`Worker ${expected} does not own ${label}.`);
    }
  }

  private assertToolAttempt(
    job: ToolJobRecord,
    workerId: string,
    attempt: number,
    attemptToken: string
  ) {
    this.assertWorker(job.workerId, workerId, `tool job ${job.id}`);
    if (job.attempts !== attempt || job.attemptToken !== attemptToken) {
      throw new Error(`Tool job ${job.id} attempt ownership was lost.`);
    }
  }

  private nextId() {
    return requiredText(this.idFactory(), "generated id");
  }

  private now() {
    return integerTimestamp(this.clock(), Date.now(), "clock");
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapSession(row: SqlRow): SessionStateRecord {
  return {
    sessionId: String(row.session_id),
    nextEventSequence: numberValue(row.next_event_sequence),
    completedEventSequence: numberValue(row.completed_event_sequence),
    nextOutboxSequence: numberValue(row.next_outbox_sequence),
    completedOutboxSequence: numberValue(row.completed_outbox_sequence),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at)
  };
}

function mapEvent(row: SqlRow): SessionEventRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    kind: String(row.kind),
    dedupeKey: nullableString(row.dedupe_key),
    payload: parseJson(row.payload_json),
    status: String(row.status) as SessionEventStatus,
    attempts: numberValue(row.attempts),
    availableAt: numberValue(row.available_at),
    createdAt: numberValue(row.created_at),
    claimedAt: nullableNumber(row.claimed_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function mapTurn(row: SqlRow): TurnRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    eventId: String(row.event_id),
    attempt: numberValue(row.attempt),
    status: String(row.status) as TurnStatus,
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: parseNullableJson(row.result_json),
    error: parseNullableJson(row.error_json),
    startedAt: numberValue(row.started_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function mapToolJob(row: SqlRow): ToolJobRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    originEventId: String(row.origin_event_id),
    originTurnId: String(row.origin_turn_id),
    providerCallId: String(row.provider_call_id),
    toolName: String(row.tool_name),
    taskKind: nullableString(row.task_kind),
    originalRequest: parseJson(row.original_request_json),
    arguments: parseJson(row.arguments_json),
    status: String(row.status) as ToolJobStatus,
    attempts: numberValue(row.attempts),
    attemptToken: nullableString(row.attempt_token),
    processIdentity: parseProcessIdentity(row.process_identity_json),
    availableAt: numberValue(row.available_at),
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: parseNullableJson(row.result_json),
    error: parseNullableJson(row.error_json),
    ackOutboxId: String(row.ack_outbox_id),
    completionEventId: nullableString(row.completion_event_id),
    createdAt: numberValue(row.created_at),
    startedAt: nullableNumber(row.started_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function parseProcessIdentity(value: unknown) {
  const parsed = parseNullableJson(value);
  return parsed == null ? undefined : validateProcessIdentity(parsed);
}

function validateProcessIdentity(value: unknown): CodexProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex process identity must be an object.");
  }
  const record = value as Record<string, unknown>;
  const pid = positiveInteger(record.pid, -1, "processIdentity.pid");
  const processGroupId = positiveInteger(record.processGroupId, -1, "processIdentity.processGroupId");
  const attempt = positiveInteger(record.attempt, -1, "processIdentity.attempt");
  const runToken = requiredText(record.runToken, "processIdentity.runToken");
  const commandMarker = requiredText(record.commandMarker, "processIdentity.commandMarker");
  const startedAt = integerTimestamp(record.startedAt, -1, "processIdentity.startedAt");
  return { pid, processGroupId, attempt, runToken, commandMarker, startedAt };
}

function mapOutbox(row: SqlRow): OutboxRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    originTurnId: String(row.origin_turn_id),
    kind: String(row.kind),
    dedupeKey: nullableString(row.dedupe_key),
    payload: parseJson(row.payload_json),
    status: String(row.status) as OutboxStatus,
    attempts: numberValue(row.attempts),
    availableAt: numberValue(row.available_at),
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: parseNullableJson(row.result_json),
    error: parseNullableJson(row.error_json),
    createdAt: numberValue(row.created_at),
    sentAt: nullableNumber(row.sent_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function requiredText(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optionalText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function positiveInteger(value: unknown, fallback: number, label: string) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function integerTimestamp(value: unknown, fallback: number, label: string) {
  const number = value == null ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
  return number;
}

function numberValue(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid integer value: ${String(value)}`);
  return number;
}

function nullableNumber(value: unknown) {
  return value == null ? undefined : numberValue(value);
}

function nullableString(value: unknown) {
  return value == null ? undefined : String(value);
}

function json(value: unknown) {
  const encoded = JSON.stringify(value ?? null);
  if (encoded == null) throw new Error("Value is not JSON serializable.");
  return encoded;
}

function nullableJson(value: unknown) {
  return value === undefined ? null : json(value);
}

function parseJson(value: unknown) {
  return JSON.parse(String(value));
}

function parseNullableJson(value: unknown) {
  return value == null ? undefined : parseJson(value);
}

function isTerminalToolStatus(status: ToolJobStatus) {
  return status !== "queued" && status !== "running";
}

function isTerminalOutboxStatus(status: OutboxStatus) {
  return status === "sent" || status === "dead" || status === "unknown";
}
