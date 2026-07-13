import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StoredAdminSession {
  tokenHash: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

type SqlRow = Record<string, unknown>;

export class SqliteAdminSessionStore {
  private readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry
        ON admin_sessions(expires_at, last_seen_at);
    `);
  }

  close() {
    if (this.database.isOpen) this.database.close();
  }

  readAdminSession(tokenHash: string): StoredAdminSession | undefined {
    const row = this.database.prepare(`
      SELECT token_hash, csrf_token, created_at, last_seen_at, expires_at
      FROM admin_sessions WHERE token_hash = ?
    `).get(tokenHash) as SqlRow | undefined;
    return row ? {
      tokenHash: String(row.token_hash),
      csrfToken: String(row.csrf_token),
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at),
      expiresAt: Number(row.expires_at)
    } : undefined;
  }

  saveAdminSession(session: StoredAdminSession) {
    this.database.prepare(`
      INSERT INTO admin_sessions (token_hash, csrf_token, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        csrf_token = excluded.csrf_token,
        created_at = excluded.created_at,
        last_seen_at = excluded.last_seen_at,
        expires_at = excluded.expires_at
    `).run(session.tokenHash, session.csrfToken, session.createdAt, session.lastSeenAt, session.expiresAt);
  }

  deleteAdminSession(tokenHash: string) {
    this.database.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
  }

  clearAdminSessions() {
    this.database.prepare("DELETE FROM admin_sessions").run();
  }

  pruneAdminSessions(now: number, idleCutoff: number, maxSessions: number) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen_at < ?").run(now, idleCutoff);
      this.database.prepare(`
        DELETE FROM admin_sessions WHERE token_hash IN (
          SELECT token_hash FROM admin_sessions
          ORDER BY last_seen_at DESC, created_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(Math.max(0, Math.trunc(maxSessions)));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
