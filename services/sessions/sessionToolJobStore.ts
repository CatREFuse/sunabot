import type { CodexProcessIdentity } from "../../packages/contracts/tools/codex.js";
import { toolCompletionEnvelope, type AsyncToolCompletionPayload } from "../../packages/contracts/session/runtimeMessages.js";
import {
  decodeToolJobCompletion,
  decodeToolJobProcess,
  decodeToolJobRequest,
  encodeToolJobCompletion,
  encodeToolJobProcess,
  encodeToolJobRequest
} from "../../packages/contracts/session/durableQueue.js";
import { SessionEventStore } from "./sessionEventStore.js";
import {
  integerTimestamp,
  nullableNumber,
  nullableString,
  numberValue,
  optionalText,
  positiveInteger,
  requiredText
} from "./sessionStoreBackend.js";
import type {
  ClaimOptions,
  CompleteToolJobInput,
  CompleteToolJobResult,
  SqlRow,
  ToolJobRecord,
  ToolJobStatus
} from "./sessionTypes.js";

interface InsertToolJobInput {
  id: string;
  sessionId: string;
  originEventId: string;
  originTurnId: string;
  providerCallId: string;
  toolName: string;
  taskKind?: string;
  originalRequest: unknown;
  arguments: unknown;
  availableAt: number;
  ackOutboxId: string;
  createdAt: number;
}

export abstract class SessionToolJobStore extends SessionEventStore {
  claimNextToolJob(options: ClaimOptions): ToolJobRecord | null {
    const workerId = requiredText(options.workerId, "workerId");
    const leaseMs = positiveInteger(options.leaseMs, this.defaultLeaseMs, "leaseMs");
    const sessionId = optionalText(options.sessionId);
    const now = this.now();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT jobs.* FROM tool_jobs jobs
        WHERE jobs.status = 'queued' AND jobs.available_at <= ?
          AND (? IS NULL OR jobs.session_id = ?)
        ORDER BY jobs.available_at, jobs.created_at, jobs.id
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
    const job = this.requireToolJob(jobId);
    const encodedIdentity = encodeToolJobProcess(validated, {
      id: `${job.id}:process:${attempt}`,
      sessionId: job.sessionId,
      occurredAt: validated.startedAt,
      correlationId: job.providerCallId,
      causationId: job.originEventId,
      idempotencyKey: `${job.id}:${attemptToken}`
    });
    const result = this.database.prepare(`
      UPDATE tool_jobs SET process_identity_json = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
        AND attempts = ? AND attempt_token = ?
    `).run(encodedIdentity, jobId, workerId, attempt, attemptToken);
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
      const completionEvent = this.insertPendingEvent({
        id: completionEventId,
        sessionId: job.sessionId,
        kind: "tool_completion",
        payload: completionPayload,
        dedupeKey: `tool-completion:${job.id}`,
        availableAt: now,
        createdAt: now,
        correlationId: job.providerCallId,
        causationId: job.originEventId
      });
      const encodedCompletion = encodeToolJobCompletion({
        status: input.status,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      }, {
        id: job.id,
        sessionId: job.sessionId,
        occurredAt: now,
        correlationId: job.providerCallId,
        causationId: job.originEventId,
        idempotencyKey: `tool-completion:${job.id}`
      });
      const updated = this.database.prepare(`
        UPDATE tool_jobs
        SET status = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = NULL, completion_event_id = ?, finished_at = ?,
            process_identity_json = NULL
        WHERE id = ? AND completion_event_id IS NULL
      `).run(input.status, encodedCompletion, completionEventId, now, job.id);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Tool job ${job.id} completion lost its compare-and-set.`);
      }
      return {
        job: this.requireToolJob(job.id),
        event: completionEvent,
        inserted: true
      };
    });
  }

  getToolJob(id: string) {
    const row = this.database.prepare("SELECT * FROM tool_jobs WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapToolJob(row) : undefined;
  }

  listToolJobs(sessionId?: string) {
    const rows = sessionId
      ? this.database.prepare("SELECT * FROM tool_jobs WHERE session_id = ? ORDER BY created_at, id").all(sessionId)
      : this.database.prepare("SELECT * FROM tool_jobs ORDER BY created_at, id").all();
    return (rows as SqlRow[]).map(mapToolJob);
  }

  protected createToolJobSchema() {
    this.database.exec(`
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
  }

  protected migrateToolJobSchemaV2() {
    this.database.exec(`
      ALTER TABLE tool_jobs ADD COLUMN attempt_token TEXT;
      ALTER TABLE tool_jobs ADD COLUMN process_identity_json TEXT
        CHECK (process_identity_json IS NULL OR json_valid(process_identity_json));
    `);
  }

  protected insertToolJob(input: InsertToolJobInput) {
    const encodedRequest = encodeToolJobRequest({
      providerCallId: input.providerCallId,
      toolName: input.toolName,
      ...(input.taskKind ? { taskKind: input.taskKind } : {}),
      originTurnId: input.originTurnId,
      originalRequest: input.originalRequest,
      arguments: input.arguments
    }, {
      id: input.id,
      sessionId: input.sessionId,
      occurredAt: input.createdAt,
      correlationId: input.providerCallId,
      causationId: input.originEventId,
      idempotencyKey: `tool-job:${input.id}`
    });
    this.database.prepare(`
      INSERT INTO tool_jobs (
        id, session_id, origin_event_id, origin_turn_id, provider_call_id,
        tool_name, task_kind, original_request_json, arguments_json,
        status, attempts, available_at, ack_outbox_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(
      input.id,
      input.sessionId,
      input.originEventId,
      input.originTurnId,
      input.providerCallId,
      input.toolName,
      input.taskKind ?? null,
      encodedRequest,
      "null",
      input.availableAt,
      input.ackOutboxId,
      input.createdAt
    );
    return this.requireToolJob(input.id);
  }

  protected requireToolJob(id: string) {
    const value = this.getToolJob(id);
    if (!value) throw new Error(`Tool job not found: ${id}`);
    return value;
  }

  protected requireToolJobForTurn(turnId: string, providerCallId: string) {
    const row = this.database.prepare(`
      SELECT * FROM tool_jobs WHERE origin_turn_id = ? AND provider_call_id = ?
    `).get(turnId, providerCallId) as SqlRow | undefined;
    if (!row) throw new Error(`Tool job not found for turn ${turnId} and call ${providerCallId}.`);
    return mapToolJob(row);
  }

  protected recoverToolJobLeases(all: boolean, now: number) {
    const result = this.database.prepare(`
      UPDATE tool_jobs
      SET status = 'queued', worker_id = NULL, lease_until = NULL,
          available_at = ?
      WHERE status = 'running' AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
    `).run(now, all ? 1 : 0, now);
    return Number(result.changes);
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
}

function mapToolJob(row: SqlRow): ToolJobRecord {
  const request = decodeToolJobRequest(row.original_request_json, row.arguments_json);
  const completion = decodeToolJobCompletion(row.result_json, row.error_json);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    originEventId: String(row.origin_event_id),
    originTurnId: String(row.origin_turn_id),
    providerCallId: String(row.provider_call_id),
    toolName: String(row.tool_name),
    taskKind: nullableString(row.task_kind),
    originalRequest: request.originalRequest,
    arguments: request.arguments,
    status: String(row.status) as ToolJobStatus,
    attempts: numberValue(row.attempts),
    attemptToken: nullableString(row.attempt_token),
    processIdentity: parseProcessIdentity(row.process_identity_json),
    availableAt: numberValue(row.available_at),
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: completion.result,
    error: completion.error,
    ackOutboxId: String(row.ack_outbox_id),
    completionEventId: nullableString(row.completion_event_id),
    createdAt: numberValue(row.created_at),
    startedAt: nullableNumber(row.started_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function parseProcessIdentity(value: unknown) {
  const parsed = decodeToolJobProcess(value);
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

function isTerminalToolStatus(status: ToolJobStatus) {
  return status !== "queued" && status !== "running";
}
