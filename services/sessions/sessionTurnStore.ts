import {
  decodeTurnOutcome,
  encodeTurnOutcome
} from "../../packages/contracts/session/durableQueue.js";
import { SessionOutboxStore } from "./sessionOutboxStore.js";
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
  ClaimedTurn,
  ClaimOptions,
  DeferTurnInput,
  DeferTurnResult,
  FinishTurnInput,
  FinishTurnResult,
  ReplayUnknownOutboxInput,
  SqlRow,
  TurnRecord,
  TurnStatus
} from "./sessionTypes.js";

export abstract class SessionTurnStore extends SessionOutboxStore {
  replayUnknownOutbox(input: ReplayUnknownOutboxInput) {
    if (input.confirmedNotSent !== true) {
      throw new Error("confirmedNotSent must be true before replaying delivery_unknown.");
    }
    const now = this.now();
    return this.transaction(() => {
      const outbox = this.requireOutbox(requiredText(input.outboxId, "outboxId"));
      if (outbox.status !== "delivery_unknown") {
        throw new Error(`Outbox ${outbox.id} is ${outbox.status}, not delivery_unknown.`);
      }
      if (outbox.uncertainSettleStep) {
        throw new Error(`Outbox ${outbox.id} has an unknown settle effect and cannot be replayed.`);
      }
      return this.insertOutbox(this.requireTurn(outbox.originTurnId), {
        kind: outbox.kind,
        payload: outbox.payload,
        deliveryPartition: outbox.deliveryPartition
      }, now);
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

      const event = this.requireEvent(String(row.id));
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
      const encodedOutcome = encodeTurnOutcome(input.outcome, input.result, input.error, {
        id: turn.id,
        sessionId: turn.sessionId,
        occurredAt: now,
        correlationId: turn.id,
        causationId: event.id
      });
      this.database.prepare(`
        UPDATE turns
        SET status = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = NULL, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(input.outcome, encodedOutcome, now, turn.id);
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
      const taskKind = optionalText(input.job.taskKind);
      const job = this.insertToolJob({
        id: jobId,
        sessionId: turn.sessionId,
        originEventId: event.id,
        originTurnId: turn.id,
        providerCallId,
        toolName,
        ...(taskKind ? { taskKind } : {}),
        originalRequest: input.job.originalRequest,
        arguments: input.job.arguments,
        availableAt: integerTimestamp(input.job.availableAt, now, "job.availableAt"),
        ackOutboxId: acknowledgement.id,
        createdAt: now
      });
      this.database.prepare(`
        UPDATE turns
        SET status = 'deferred', worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = NULL, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(encodeTurnOutcome("deferred", input.result, undefined, {
        id: turn.id,
        sessionId: turn.sessionId,
        occurredAt: now,
        correlationId: turn.id,
        causationId: event.id
      }), now, turn.id);
      this.completeEvent(event, now);
      return {
        turn: this.requireTurn(turn.id),
        job,
        acknowledgement,
        duplicate: false
      };
    });
  }

  getTurn(id: string) {
    const row = this.database.prepare("SELECT * FROM turns WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapTurn(row) : undefined;
  }

  listTurns(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM turns WHERE session_id = ? ORDER BY started_at, attempt, id
    `).all(sessionId) as SqlRow[]).map(mapTurn);
  }

  protected createTurnSchema() {
    this.database.exec(`
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
    `);
  }

  protected requireTurn(id: string) {
    const value = this.getTurn(id);
    if (!value) throw new Error(`Turn not found: ${id}`);
    return value;
  }

  protected recoverTurnLeases(all: boolean, now: number) {
    const rows = this.database.prepare(`
      SELECT * FROM turns
      WHERE status = 'running' AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
      ORDER BY started_at, id
    `).all(all ? 1 : 0, now) as SqlRow[];
    for (const row of rows) {
      const turn = mapTurn(row);
      const encodedOutcome = encodeTurnOutcome(
        "interrupted",
        undefined,
        { code: "lease_recovered", message: "Turn lease was abandoned." },
        {
          id: turn.id,
          sessionId: turn.sessionId,
          occurredAt: now,
          correlationId: turn.id,
          causationId: turn.eventId
        }
      );
      this.database.prepare(`
        UPDATE turns
        SET status = 'interrupted', worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = NULL, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(encodedOutcome, now, turn.id);
      this.database.prepare(`
        UPDATE session_events
        SET status = 'pending', available_at = ?, claimed_at = NULL
        WHERE id = ? AND status = 'running'
      `).run(now, turn.eventId);
    }
    return rows.length;
  }
}

function mapTurn(row: SqlRow): TurnRecord {
  const outcome = decodeTurnOutcome(row.result_json, row.error_json);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    eventId: String(row.event_id),
    attempt: numberValue(row.attempt),
    status: String(row.status) as TurnStatus,
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: outcome.result,
    error: outcome.error,
    startedAt: numberValue(row.started_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}
