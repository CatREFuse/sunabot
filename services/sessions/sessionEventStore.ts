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
  SqlRow,
  UpdateActiveSessionEventInput
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
    const now = this.now();
    return this.transaction(() => this.enqueueEventInTransaction(input, now));
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

  getPendingEvent(sessionId: string, kind: string) {
    const row = this.database.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND kind = ? AND status = 'pending'
      ORDER BY sequence DESC
      LIMIT 1
    `).get(
      requiredText(sessionId, "sessionId"),
      requiredText(kind, "kind")
    ) as SqlRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  getActiveEvent(sessionId: string, kind: string) {
    const row = this.database.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND kind = ? AND status IN ('pending', 'running')
      ORDER BY sequence DESC
      LIMIT 1
    `).get(
      requiredText(sessionId, "sessionId"),
      requiredText(kind, "kind")
    ) as SqlRow | undefined;
    return row ? mapEvent(row) : undefined;
  }

  listActiveEvents(kind: string) {
    const rows = this.database.prepare(`
      SELECT * FROM session_events
      WHERE kind = ? AND status IN ('pending', 'running')
      ORDER BY created_at, id
    `).all(requiredText(kind, "kind")) as SqlRow[];
    return rows.map(mapEvent);
  }

  reschedulePendingEvent(eventId: string, availableAt: number) {
    const id = requiredText(eventId, "eventId");
    const nextAvailableAt = integerTimestamp(availableAt, this.now(), "availableAt");
    return this.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE session_events SET available_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(nextAvailableAt, id);
      return Number(updated.changes) === 1 ? this.requireEvent(id) : undefined;
    });
  }

  bumpActiveEventAvailableAt(eventId: string, kind: string, availableAt: number) {
    const id = requiredText(eventId, "eventId");
    const expectedKind = requiredText(kind, "kind");
    const nextAvailableAt = integerTimestamp(availableAt, this.now(), "availableAt");
    return this.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE session_events SET available_at = ?
        WHERE id = ? AND kind = ? AND status IN ('pending', 'running')
      `).run(nextAvailableAt, id, expectedKind);
      return Number(updated.changes) === 1 ? this.requireEvent(id) : undefined;
    });
  }

  updateActiveEvent(input: UpdateActiveSessionEventInput) {
    const id = requiredText(input.eventId, "eventId");
    const expectedKind = requiredText(input.kind, "kind");
    const now = this.now();
    const nextAvailableAt = integerTimestamp(input.availableAt, now, "availableAt");
    const expectedAvailableAt = input.expectedAvailableAt === undefined
      ? undefined
      : integerTimestamp(input.expectedAvailableAt, now, "expectedAvailableAt");
    const hasExpectedPayload = Object.prototype.hasOwnProperty.call(input, "expectedPayload");
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM session_events
        WHERE id = ? AND kind = ? AND status IN ('pending', 'running')
          AND (? IS NULL OR available_at = ?)
      `).get(
        id,
        expectedKind,
        expectedAvailableAt ?? null,
        expectedAvailableAt ?? null
      ) as SqlRow | undefined;
      if (!row) return undefined;
      const codecContext = eventCodecContext(row);
      const encodedPayload = encodeSessionEventPayload(
        input.payload,
        expectedKind,
        codecContext
      );
      const expectedPayload = hasExpectedPayload
        ? encodeSessionEventPayload(input.expectedPayload, expectedKind, codecContext)
        : undefined;
      const updated = hasExpectedPayload
        ? this.database.prepare(`
          UPDATE session_events SET available_at = ?, payload_json = ?
          WHERE id = ? AND kind = ? AND status IN ('pending', 'running')
            AND (? IS NULL OR available_at = ?) AND payload_json = ?
        `).run(
          nextAvailableAt,
          encodedPayload,
          id,
          expectedKind,
          expectedAvailableAt ?? null,
          expectedAvailableAt ?? null,
          expectedPayload!
        )
        : this.database.prepare(`
          UPDATE session_events SET available_at = ?, payload_json = ?
          WHERE id = ? AND kind = ? AND status IN ('pending', 'running')
            AND (? IS NULL OR available_at = ?)
        `).run(
          nextAvailableAt,
          encodedPayload,
          id,
          expectedKind,
          expectedAvailableAt ?? null,
          expectedAvailableAt ?? null
        );
      return Number(updated.changes) === 1 ? this.requireEvent(id) : undefined;
    });
  }

  nextClaimableEventAvailableAt() {
    const row = this.database.prepare(`
      SELECT e.available_at
      FROM session_events e
      JOIN sessions s ON s.session_id = e.session_id
      WHERE e.status = 'pending'
        AND e.sequence = s.completed_event_sequence + 1
        AND NOT EXISTS (
          SELECT 1 FROM turns t
          WHERE t.session_id = e.session_id AND t.status = 'running'
        )
      ORDER BY e.available_at, e.created_at, e.session_id, e.sequence
      LIMIT 1
    `).get() as SqlRow | undefined;
    return row ? numberValue(row.available_at) : undefined;
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

  protected enqueueEventInTransaction(
    input: EnqueueSessionEventInput,
    now: number
  ): EnqueueSessionEventResult {
    const sessionId = requiredText(input.sessionId, "sessionId");
    const kind = requiredText(input.kind, "kind");
    const dedupeKey = optionalText(input.dedupeKey);
    const availableAt = integerTimestamp(input.availableAt, now, "availableAt");
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
  }

  protected enqueueHandoffTargetInTransaction(
    input: EnqueueSessionEventInput,
    now: number
  ): EnqueueSessionEventResult {
    const target = this.enqueueEventInTransaction(input, now);
    if (target.inserted) return target;
    const sessionId = requiredText(input.sessionId, "sessionId");
    const kind = requiredText(input.kind, "kind");
    const dedupeKey = requiredText(input.dedupeKey, "dedupeKey");
    const existing = target.event;
    const row = this.database.prepare(`
      SELECT payload_json FROM session_events WHERE id = ?
    `).get(existing.id) as SqlRow | undefined;
    const expectedPayload = encodeSessionEventPayload(input.payload, kind, {
      id: existing.id,
      sessionId,
      occurredAt: existing.createdAt,
      correlationId: existing.id,
      idempotencyKey: dedupeKey
    });
    if (
      existing.sessionId !== sessionId ||
      existing.kind !== kind ||
      existing.dedupeKey !== dedupeKey ||
      !row ||
      canonicalStoredJson(String(row.payload_json)) !== canonicalStoredJson(expectedPayload)
    ) {
      throw new Error(`Handoff target dedupe collision for ${dedupeKey}.`);
    }
    return target;
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

function eventCodecContext(row: SqlRow) {
  const eventId = String(row.id);
  const sessionId = String(row.session_id);
  const stored = parseStoredEventEnvelope(row.payload_json);
  if (!stored) {
    return {
      id: eventId,
      sessionId,
      occurredAt: numberValue(row.created_at),
      correlationId: eventId,
      ...(row.dedupe_key == null ? {} : { idempotencyKey: String(row.dedupe_key) })
    };
  }
  if (stored.id !== eventId) {
    throw new Error(`Session event ${eventId} envelope id is ${String(stored.id)}.`);
  }
  if (stored.conversationId !== sessionId) {
    throw new Error(`Session event ${eventId} envelope conversationId is inconsistent.`);
  }
  const payload = stored.payload as Record<string, unknown>;
  if (payload.kind !== String(row.kind)) {
    throw new Error(`Session event ${eventId} envelope kind is inconsistent.`);
  }
  return {
    id: eventId,
    sessionId,
    occurredAt: requiredEnvelopeText(stored.occurredAt, eventId, "occurredAt"),
    correlationId: requiredEnvelopeText(stored.correlationId, eventId, "correlationId"),
    ...optionalEnvelopeText(stored.causationId, "causationId"),
    ...optionalEnvelopeText(stored.idempotencyKey, "idempotencyKey")
  };
}

function parseStoredEventEnvelope(value: unknown): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Session event payload contains invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "session.turn_requested") return undefined;
  if (record.schemaVersion !== 1 || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw new Error("Session event envelope is invalid.");
  }
  return record;
}

function requiredEnvelopeText(value: unknown, eventId: string, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Session event ${eventId} envelope ${name} is invalid.`);
  }
  return value;
}

function optionalEnvelopeText(value: unknown, name: "causationId" | "idempotencyKey") {
  if (value == null) return {};
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Session event envelope ${name} is invalid.`);
  }
  return { [name]: value };
}

function canonicalStoredJson(value: string) {
  const encoded = JSON.stringify(canonicalJsonValue(JSON.parse(value)));
  if (encoded === undefined) throw new Error("Stored event envelope is not JSON serializable.");
  return encoded;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonicalJsonValue(child)]));
}
