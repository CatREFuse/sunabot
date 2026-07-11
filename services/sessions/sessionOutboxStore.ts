import {
  decodeOutboxDelivery,
  decodeOutboxPayload,
  encodeOutboxDelivery,
  encodeOutboxPayload
} from "../../packages/contracts/session/durableQueue.js";
import { SessionToolJobStore } from "./sessionToolJobStore.js";
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
  FinishOutboxInput,
  OutboxDraft,
  OutboxRecord,
  OutboxStatus,
  SqlRow,
  TurnRecord
} from "./sessionTypes.js";

export abstract class SessionOutboxStore extends SessionToolJobStore {
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
        const encodedDelivery = encodeOutboxDelivery({
          outcome: "retry",
          ...(input.error !== undefined ? { error: input.error } : {})
        }, {
          id: outbox.id,
          sessionId: outbox.sessionId,
          occurredAt: now,
          correlationId: outbox.originTurnId,
          causationId: outbox.originTurnId,
          ...(outbox.dedupeKey ? { idempotencyKey: outbox.dedupeKey } : {})
        });
        this.database.prepare(`
          UPDATE outbox
          SET status = 'pending', worker_id = NULL, lease_until = NULL,
              result_json = ?, error_json = NULL, available_at = ?
          WHERE id = ? AND status = 'sending'
        `).run(
          encodedDelivery,
          integerTimestamp(input.availableAt, now, "availableAt"),
          outbox.id
        );
        return this.requireOutbox(outbox.id);
      }

      const session = this.requireSession(outbox.sessionId);
      if (outbox.sequence !== session.completedOutboxSequence + 1) {
        throw new Error(`Outbox ${outbox.id} is not the head of session ${outbox.sessionId}.`);
      }
      const encodedDelivery = encodeOutboxDelivery({
        outcome: input.outcome,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {})
      }, {
        id: outbox.id,
        sessionId: outbox.sessionId,
        occurredAt: now,
        correlationId: outbox.originTurnId,
        causationId: outbox.originTurnId,
        ...(outbox.dedupeKey ? { idempotencyKey: outbox.dedupeKey } : {})
      });
      this.database.prepare(`
        UPDATE outbox
        SET status = ?, worker_id = NULL, lease_until = NULL,
            result_json = ?, error_json = NULL, sent_at = ?, finished_at = ?
        WHERE id = ? AND status = 'sending'
      `).run(
        input.outcome,
        encodedDelivery,
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

  getOutbox(id: string) {
    const row = this.database.prepare("SELECT * FROM outbox WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  listOutbox(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM outbox WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as SqlRow[]).map(mapOutbox);
  }

  protected createOutboxSchema() {
    this.database.exec(`
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
    `);
  }

  protected insertOutbox(turn: TurnRecord, draft: OutboxDraft, now: number) {
    const id = this.nextId();
    const sequence = this.allocateOutboxSequence(turn.sessionId, now);
    const kind = requiredText(draft.kind, "outbox.kind");
    const dedupeKey = optionalText(draft.dedupeKey);
    const encodedPayload = encodeOutboxPayload(draft.payload, kind, {
      id,
      sessionId: turn.sessionId,
      occurredAt: now,
      correlationId: turn.id,
      causationId: turn.eventId,
      ...(dedupeKey ? { idempotencyKey: dedupeKey } : {})
    });
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
      kind,
      dedupeKey ?? null,
      encodedPayload,
      integerTimestamp(draft.availableAt, now, "outbox.availableAt"),
      now
    );
    return this.requireOutbox(id);
  }

  protected requireOutbox(id: string) {
    const value = this.getOutbox(id);
    if (!value) throw new Error(`Outbox item not found: ${id}`);
    return value;
  }

  protected listOutboxForTurn(turnId: string) {
    return (this.database.prepare(`
      SELECT * FROM outbox WHERE origin_turn_id = ? ORDER BY sequence
    `).all(turnId) as SqlRow[]).map(mapOutbox);
  }

  protected recoverOutboxLeases(all: boolean, now: number) {
    const result = this.database.prepare(`
      UPDATE outbox
      SET status = 'pending', worker_id = NULL, lease_until = NULL,
          available_at = ?
      WHERE status = 'sending' AND (? = 1 OR lease_until IS NULL OR lease_until <= ?)
    `).run(now, all ? 1 : 0, now);
    return Number(result.changes);
  }
}

function mapOutbox(row: SqlRow): OutboxRecord {
  const delivery = decodeOutboxDelivery(row.result_json, row.error_json);
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    originTurnId: String(row.origin_turn_id),
    kind: String(row.kind),
    dedupeKey: nullableString(row.dedupe_key),
    payload: decodeOutboxPayload(row.payload_json),
    status: String(row.status) as OutboxStatus,
    attempts: numberValue(row.attempts),
    availableAt: numberValue(row.available_at),
    workerId: nullableString(row.worker_id),
    leaseUntil: nullableNumber(row.lease_until),
    result: delivery.result,
    error: delivery.error,
    createdAt: numberValue(row.created_at),
    sentAt: nullableNumber(row.sent_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}

function isTerminalOutboxStatus(status: OutboxStatus) {
  return status === "sent" || status === "dead" || status === "unknown";
}
