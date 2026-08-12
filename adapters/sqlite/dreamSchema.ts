import type { DatabaseSync } from "node:sqlite";

export function migrateDreamTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_recall_stats (
      record_id TEXT PRIMARY KEY CHECK (length(trim(record_id)) BETWEEN 1 AND 128),
      recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
      distinct_recall_days INTEGER NOT NULL DEFAULT 0 CHECK (distinct_recall_days >= 0),
      last_recalled_at TEXT,
      last_recall_local_date TEXT CHECK (
        last_recall_local_date IS NULL
        OR last_recall_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      ),
      tracking_started_at TEXT NOT NULL CHECK (length(trim(tracking_started_at)) > 0),
      last_reviewed_at TEXT,
      importance REAL CHECK (importance IS NULL OR importance BETWEEN 0.0 AND 1.0),
      future_relevance REAL CHECK (future_relevance IS NULL OR future_relevance BETWEEN 0.0 AND 1.0),
      emotional_salience REAL CHECK (emotional_salience IS NULL OR emotional_salience BETWEEN 0.0 AND 1.0),
      pending_recall_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(pending_recall_json)
        AND json_type(pending_recall_json) = 'array'
        AND length(pending_recall_json) <= 65536
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memory_recall_stats_review
      ON memory_recall_stats(last_reviewed_at, recall_count, record_id);

    CREATE TABLE IF NOT EXISTS memory_recall_receipts (
      recall_key TEXT NOT NULL CHECK (length(trim(recall_key)) BETWEEN 1 AND 256),
      record_id TEXT NOT NULL REFERENCES memory_recall_stats(record_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
      recall_local_date TEXT NOT NULL CHECK (
        recall_local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      ),
      recalled_at TEXT NOT NULL CHECK (length(trim(recalled_at)) > 0),
      PRIMARY KEY (recall_key, record_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memory_recall_receipts_record_day
      ON memory_recall_receipts(record_id, recall_local_date, recalled_at DESC);

    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
      local_date TEXT NOT NULL UNIQUE CHECK (
        local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      ),
      scheduled_for TEXT NOT NULL CHECK (length(trim(scheduled_for)) > 0),
      time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) BETWEEN 1 AND 80),
      window_start TEXT NOT NULL CHECK (length(trim(window_start)) > 0),
      window_end TEXT NOT NULL CHECK (length(trim(window_end)) > 0),
      status TEXT NOT NULL CHECK (status IN ('running', 'generated', 'consolidated', 'completed', 'failed')),
      worker_id TEXT,
      lease_until TEXT,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
      seed TEXT NOT NULL CHECK (length(trim(seed)) BETWEEN 1 AND 128),
      input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
      input_json TEXT NOT NULL CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
      output_json TEXT CHECK (
        output_json IS NULL OR (json_valid(output_json) AND json_type(output_json) = 'object')
      ),
      dream_text TEXT CHECK (dream_text IS NULL OR length(trim(dream_text)) BETWEEN 1 AND 4096),
      working_memory_id TEXT CHECK (
        working_memory_id IS NULL OR length(trim(working_memory_id)) BETWEEN 1 AND 128
      ),
      persona_json TEXT CHECK (
        persona_json IS NULL OR (json_valid(persona_json) AND json_type(persona_json) = 'object')
      ),
      persona_status TEXT NOT NULL CHECK (
        persona_status IN ('pending', 'none', 'proposed', 'applied', 'skipped', 'failed')
      ),
      result_json TEXT CHECK (
        result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')
      ),
      error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) BETWEEN 1 AND 80),
      error_text TEXT CHECK (error_text IS NULL OR length(trim(error_text)) BETWEEN 1 AND 65536),
      next_retry_at TEXT,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      generated_at TEXT,
      consolidated_at TEXT,
      persona_updated_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      CHECK (
        (status IN ('running', 'generated', 'consolidated') AND worker_id IS NOT NULL AND lease_until IS NOT NULL)
        OR (status IN ('completed', 'failed') AND worker_id IS NULL AND lease_until IS NULL)
      )
    ) STRICT;
    CREATE INDEX IF NOT EXISTS dream_runs_status_retry
      ON dream_runs(status, next_retry_at, lease_until, local_date);
    CREATE INDEX IF NOT EXISTS dream_runs_local_date
      ON dream_runs(local_date DESC, id);

    CREATE TABLE IF NOT EXISTS dream_memory_archive (
      record_id TEXT PRIMARY KEY CHECK (length(trim(record_id)) BETWEEN 1 AND 128),
      run_id TEXT NOT NULL REFERENCES dream_runs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2048),
      archived_at TEXT NOT NULL CHECK (length(trim(archived_at)) > 0),
      purge_after TEXT NOT NULL CHECK (length(trim(purge_after)) > 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS dream_memory_archive_purge
      ON dream_memory_archive(purge_after, record_id);
    CREATE INDEX IF NOT EXISTS dream_memory_archive_run
      ON dream_memory_archive(run_id, archived_at, record_id);
  `);
  const recallColumns = database.prepare("PRAGMA table_info(memory_recall_stats)").all() as Array<{
    name: string;
  }>;
  if (!recallColumns.some((column) => column.name === "pending_recall_json")) {
    database.exec(`
      ALTER TABLE memory_recall_stats ADD COLUMN pending_recall_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(pending_recall_json)
        AND json_type(pending_recall_json) = 'array'
        AND length(pending_recall_json) <= 65536
      )
    `);
  }
}
