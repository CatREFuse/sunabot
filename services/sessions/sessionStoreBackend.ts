import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SessionStateRecord,
  SessionStoreOptions,
  SqlRow
} from "./sessionTypes.js";

const DEFAULT_LEASE_MS = 30_000;

export abstract class SessionStoreBackend {
  protected readonly database: DatabaseSync;
  protected readonly clock: () => number;
  protected readonly idFactory: () => string;
  protected readonly defaultLeaseMs: number;

  protected constructor(options: SessionStoreOptions) {
    if (!options.databasePath.trim()) throw new Error("SessionStore databasePath is required.");
    if (options.databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(options.databasePath)), { recursive: true });
    }
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.defaultLeaseMs = positiveInteger(options.defaultLeaseMs, DEFAULT_LEASE_MS, "defaultLeaseMs");
    this.database = new DatabaseSync(options.databasePath, { timeout: 5_000 });
    this.configureDatabase();
  }

  close() {
    if (this.database.isOpen) this.database.close();
  }

  getJournalMode() {
    const row = this.database.prepare("PRAGMA journal_mode").get() as SqlRow | undefined;
    return String(row?.journal_mode ?? "");
  }

  getSessionState(sessionId: string) {
    const row = this.database.prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SqlRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  protected initializeMigrationTable() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
  }

  protected currentSchemaVersion() {
    const row = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as SqlRow;
    return numberValue(row.version);
  }

  protected recordSchemaMigration(version: number) {
    this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(version, this.now());
  }

  protected createSessionSchema() {
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
      ) STRICT
    `);
  }

  protected ensureSession(sessionId: string, now: number) {
    this.database.prepare(`
      INSERT INTO sessions(session_id, created_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, now, now);
  }

  protected allocateEventSequence(sessionId: string, now: number) {
    const session = this.requireSession(sessionId);
    const sequence = session.nextEventSequence + 1;
    this.database.prepare(`
      UPDATE sessions SET next_event_sequence = ?, updated_at = ? WHERE session_id = ?
    `).run(sequence, now, sessionId);
    return sequence;
  }

  protected allocateOutboxSequence(sessionId: string, now: number) {
    const session = this.requireSession(sessionId);
    const sequence = session.nextOutboxSequence + 1;
    this.database.prepare(`
      UPDATE sessions SET next_outbox_sequence = ?, updated_at = ? WHERE session_id = ?
    `).run(sequence, now, sessionId);
    return sequence;
  }

  protected requireSession(sessionId: string) {
    const value = this.getSessionState(sessionId);
    if (!value) throw new Error(`Session not found: ${sessionId}`);
    return value;
  }

  protected assertWorker(actual: string | undefined, expected: string, label: string) {
    if (!actual || actual !== expected) {
      throw new Error(`Worker ${expected} does not own ${label}.`);
    }
  }

  protected nextId() {
    return requiredText(this.idFactory(), "generated id");
  }

  protected now() {
    return integerTimestamp(this.clock(), Date.now(), "clock");
  }

  protected transaction<T>(operation: () => T): T {
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

  private configureDatabase() {
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA wal_autocheckpoint = 1000");
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

export function requiredText(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

export function optionalText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

export function positiveInteger(value: unknown, fallback: number, label: string) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}

export function integerTimestamp(value: unknown, fallback: number, label: string) {
  const number = value == null ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
  return number;
}

export function numberValue(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid integer value: ${String(value)}`);
  return number;
}

export function nullableNumber(value: unknown) {
  return value == null ? undefined : numberValue(value);
}

export function nullableString(value: unknown) {
  return value == null ? undefined : String(value);
}
