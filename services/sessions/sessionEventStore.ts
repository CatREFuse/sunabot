import {
  decodeSessionEventPayload,
  encodeSessionEventPayload
} from "../../packages/contracts/session/durableQueue.js";
import {
  integerTimestamp,
  nullableNumber,
  nullableString,
  optionalText,
  requiredText,
  numberValue,
  SessionStoreBackend
} from "./sessionStoreBackend.js";
import type {
  EnqueueSessionEventInput,
  EnqueueSessionEventResult,
  SessionEventRecord,
  SessionEventStatus,
  SqlRow
} from "./sessionTypes.js";

interface PendingEventInput {
  id: string;
  sessionId: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string;
  availableAt: number;
  createdAt: number;
  correlationId: string;
  causationId?: string;
}

export abstract class SessionEventStore extends SessionStoreBackend {
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
      const id = this.nextId();
      const event = this.insertPendingEvent({
        id,
        sessionId,
        kind,
        payload: input.payload,
        ...(dedupeKey ? { dedupeKey } : {}),
        availableAt,
        createdAt: now,
        correlationId: id
      });
      return { event, inserted: true };
    });
  }

  getEvent(id: string) {
    const row = this.database.prepare("SELECT * FROM session_events WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  listEvents(sessionId: string) {
    return (this.database.prepare(`
      SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence
    `).all(sessionId) as SqlRow[]).map(mapEvent);
  }

  protected createEventSchema() {
    this.database.exec(`
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
    `);
  }

  protected insertPendingEvent(input: PendingEventInput) {
    this.ensureSession(input.sessionId, input.createdAt);
    const sequence = this.allocateEventSequence(input.sessionId, input.createdAt);
    const encodedPayload = encodeSessionEventPayload(input.payload, input.kind, {
      id: input.id,
      sessionId: input.sessionId,
      occurredAt: input.createdAt,
      correlationId: input.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      ...(input.dedupeKey ? { idempotencyKey: input.dedupeKey } : {})
    });
    this.database.prepare(`
      INSERT INTO session_events (
        id, session_id, sequence, kind, dedupe_key, payload_json,
        status, attempts, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      input.id,
      input.sessionId,
      sequence,
      input.kind,
      input.dedupeKey ?? null,
      encodedPayload,
      input.availableAt,
      input.createdAt
    );
    return this.requireEvent(input.id);
  }

  protected requireEvent(id: string) {
    const value = this.getEvent(id);
    if (!value) throw new Error(`Session event not found: ${id}`);
    return value;
  }

  protected completeEvent(event: SessionEventRecord, now: number) {
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

  protected assertHeadEvent(event: SessionEventRecord) {
    if (event.status !== "running") throw new Error(`Event ${event.id} is ${event.status}, not running.`);
    const session = this.requireSession(event.sessionId);
    if (event.sequence !== session.completedEventSequence + 1) {
      throw new Error(`Event ${event.id} is not the head of session ${event.sessionId}.`);
    }
  }
}

function mapEvent(row: SqlRow): SessionEventRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    kind: String(row.kind),
    dedupeKey: nullableString(row.dedupe_key),
    payload: decodeSessionEventPayload(row.payload_json),
    status: String(row.status) as SessionEventStatus,
    attempts: numberValue(row.attempts),
    availableAt: numberValue(row.available_at),
    createdAt: numberValue(row.created_at),
    claimedAt: nullableNumber(row.claimed_at),
    finishedAt: nullableNumber(row.finished_at)
  };
}
