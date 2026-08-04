import type { DatabaseSync } from "node:sqlite";
import { modelCallMeasurement } from "../../packages/contracts/model/modelCallStats.js";
import type { ModelCallStore } from "./modelCallStore.js";
import { migrateScheduledTaskTables } from "./scheduledTaskStore.js";
import { migrateDirectorTables } from "./directorStore.js";
import { migrateDreamTables } from "./dreamStore.js";

type SqlRow = Record<string, unknown>;

export function migrateApplicationDataSchema(database: DatabaseSync, modelCalls: ModelCallStore) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_records (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('working', 'long_term', 'user_profile')),
      position INTEGER NOT NULL,
      record_id TEXT,
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_records_source_record_id
      ON memory_records(source, record_id) WHERE record_id IS NOT NULL AND record_id <> '';
    CREATE INDEX IF NOT EXISTS memory_records_source_position ON memory_records(source, position);
    CREATE TABLE IF NOT EXISTS memory_source_revisions (
      source TEXT PRIMARY KEY CHECK (source IN ('working', 'long_term', 'user_profile')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO memory_source_revisions (source, revision) VALUES
      ('working', 0), ('long_term', 0), ('user_profile', 0);
    CREATE TRIGGER IF NOT EXISTS memory_records_revision_insert
      AFTER INSERT ON memory_records BEGIN
        UPDATE memory_source_revisions SET revision = revision + 1 WHERE source = NEW.source;
      END;
    CREATE TRIGGER IF NOT EXISTS memory_records_revision_update
      AFTER UPDATE ON memory_records BEGIN
        UPDATE memory_source_revisions SET revision = revision + 1 WHERE source = OLD.source;
        UPDATE memory_source_revisions SET revision = revision + 1 WHERE source = NEW.source AND NEW.source <> OLD.source;
      END;
    CREATE TRIGGER IF NOT EXISTS memory_records_revision_delete
      AFTER DELETE ON memory_records BEGIN
        UPDATE memory_source_revisions SET revision = revision + 1 WHERE source = OLD.source;
      END;
    DROP TABLE IF EXISTS memory_batches;
    DROP TABLE IF EXISTS memory_scheduler;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      last_at TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
    CREATE INDEX IF NOT EXISTS conversations_last_at ON conversations(last_at DESC);
    CREATE TABLE IF NOT EXISTS image_history (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
    CREATE INDEX IF NOT EXISTS image_history_created_at ON image_history(created_at DESC);
    CREATE TABLE IF NOT EXISTS emojis (
      emoji_key TEXT PRIMARY KEY CHECK (
        length(trim(emoji_key)) BETWEEN 1 AND 24
        AND length(CAST(emoji_key AS BLOB)) <= 64
      ),
      file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 160),
      source TEXT NOT NULL CHECK (source IN ('upload', 'generated')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS emojis_updated_at ON emojis(updated_at DESC, emoji_key);
    CREATE TABLE IF NOT EXISTS emoji_versions (
      emoji_key TEXT NOT NULL REFERENCES emojis(emoji_key) ON UPDATE CASCADE ON DELETE CASCADE,
      file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 160),
      source TEXT NOT NULL CHECK (source IN ('upload', 'generated')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      PRIMARY KEY (emoji_key, file_name)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS emoji_versions_key_created_at
      ON emoji_versions(emoji_key, created_at DESC, file_name);
    CREATE TABLE IF NOT EXISTS request_logs (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL CHECK (json_valid(data_json))
    );
    CREATE INDEX IF NOT EXISTS request_logs_at ON request_logs(at DESC);
    CREATE INDEX IF NOT EXISTS request_logs_category_action ON request_logs(category, action, at DESC);
    CREATE TABLE IF NOT EXISTS outbox_local_effects (
      idempotency_key TEXT PRIMARY KEY,
      effect_kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_call_aggregates (
      conversation_id TEXT NOT NULL,
      behavior TEXT NOT NULL CHECK (behavior IN ('reply', 'orchestrator', 'memory', 'other')),
      memory_kind TEXT NOT NULL DEFAULT '' CHECK (memory_kind IN ('', 'working_long_term', 'user_profile')),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      measured_input_tokens INTEGER NOT NULL DEFAULT 0,
      measured_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_reports INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, behavior, memory_kind)
    );
    CREATE INDEX IF NOT EXISTS model_call_aggregates_behavior
      ON model_call_aggregates(behavior, memory_kind, conversation_id);
    CREATE TABLE IF NOT EXISTS model_call_model_aggregates (
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL,
      behavior TEXT NOT NULL CHECK (behavior IN ('reply', 'orchestrator', 'memory', 'other')),
      memory_kind TEXT NOT NULL DEFAULT '' CHECK (memory_kind IN ('', 'working_long_term', 'user_profile')),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      measured_input_tokens INTEGER NOT NULL DEFAULT 0,
      measured_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_reports INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, model, behavior, memory_kind)
    );
    CREATE INDEX IF NOT EXISTS model_call_model_aggregates_lookup
      ON model_call_model_aggregates(conversation_id, model, behavior, memory_kind);
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at, last_seen_at);
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      workspace TEXT NOT NULL UNIQUE,
      avatar_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_accounts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      label TEXT NOT NULL,
      qq_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      webui_port INTEGER NOT NULL DEFAULT 6099 CHECK (webui_port BETWEEN 1 AND 65535),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, label),
      UNIQUE (qq_id),
      UNIQUE (webui_port)
    );
    CREATE INDEX IF NOT EXISTS agent_accounts_agent ON agent_accounts(agent_id, created_at, id);
  `);

  migrateScheduledTaskTables(database);
  migrateDirectorTables(database);
  migrateDreamTables(database);

  const rawVersion = Number(metadata(database, "storage-schema-version") ?? 0);
  const schemaVersion = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
  if (schemaVersion < 2) {
    database.prepare("UPDATE request_logs SET search_text = '' WHERE search_text <> ''").run();
    setMetadata(database, "storage-schema-version", "2");
  }
  if (schemaVersion < 3) transaction(database, () => {
    database.prepare("DELETE FROM model_call_aggregates").run();
    const rows = database.prepare(`
      SELECT data_json FROM request_logs WHERE category = 'model.response' ORDER BY row_id
    `).all() as SqlRow[];
    for (const row of rows) {
      const measurement = modelCallMeasurement(parseObject(row.data_json));
      if (measurement) modelCalls.appendModelCallAggregateUnsafe(measurement);
    }
    setMetadata(database, "storage-schema-version", "3");
  });
  if (schemaVersion < 4) setMetadata(database, "storage-schema-version", "4");
  if (schemaVersion < 6) modelCalls.rebuildModelAggregates();
  if (schemaVersion < 7) setMetadata(database, "storage-schema-version", "7");
  if (schemaVersion < 8) {
    const columns = database.prepare("PRAGMA table_info(agent_accounts)").all() as SqlRow[];
    if (!columns.some((column) => String(column.name) === "webui_port")) {
      database.exec("ALTER TABLE agent_accounts ADD COLUMN webui_port INTEGER");
    }
    const accounts = database.prepare("SELECT id FROM agent_accounts ORDER BY created_at, id").all() as SqlRow[];
    accounts.forEach((account, index) => {
      database.prepare("UPDATE agent_accounts SET webui_port = ? WHERE id = ? AND webui_port IS NULL")
        .run(6099 + index, String(account.id));
    });
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_accounts_webui_port ON agent_accounts(webui_port)");
    setMetadata(database, "storage-schema-version", "8");
  }
  if (schemaVersion < 9) setMetadata(database, "storage-schema-version", "9");
  modelCalls.repairModelAggregatesIfStale();
  const repairedVersion = Number(metadata(database, "storage-schema-version") ?? 0);
  if (!Number.isSafeInteger(repairedVersion) || repairedVersion < 12) {
    transaction(database, () => {
      database.exec(`
        INSERT OR IGNORE INTO emoji_versions (
          emoji_key, file_name, source, size_bytes, width, height, created_at
        )
        SELECT emoji_key, file_name, source, size_bytes, width, height, updated_at
        FROM emojis
      `);
      setMetadata(database, "storage-schema-version", "12");
    });
  }
  if (!Number.isSafeInteger(repairedVersion) || repairedVersion < 13) {
    setMetadata(database, "storage-schema-version", "13");
  }
  if (!Number.isSafeInteger(repairedVersion) || repairedVersion < 14) {
    setMetadata(database, "storage-schema-version", "14");
  }
  if (!Number.isSafeInteger(repairedVersion) || repairedVersion < 15) {
    setMetadata(database, "storage-schema-version", "15");
  }
  if (!Number.isSafeInteger(repairedVersion) || repairedVersion < 16) {
    setMetadata(database, "storage-schema-version", "16");
  }
  if (!Number.isSafeInteger(repairedVersion) || repairedVersion < 17) {
    setMetadata(database, "storage-schema-version", "17");
  }
}

function transaction<T>(database: DatabaseSync, operation: () => T) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function metadata(database: DatabaseSync, key: string) {
  const row = database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as SqlRow | undefined;
  return row ? String(row.value) : undefined;
}

function setMetadata(database: DatabaseSync, key: string, value: string) {
  database.prepare(`
    INSERT INTO app_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function parseObject(value: unknown) {
  const parsed = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored JSON value is not an object.");
  return parsed as Record<string, unknown>;
}
