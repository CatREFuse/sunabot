import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getWorkspacePath, resolveProjectPath } from "../../src/config.js";
import type { AppConfig, ConversationRecord, ImageHistoryRecord } from "../../src/types.js";
import type { MemoryPersistenceProvider } from "../../services/memory/persistence.js";

export type MemoryDataSource = "working" | "long_term" | "user_profile";

type JsonObject = Record<string, unknown>;
type SqlRow = Record<string, unknown>;

const stores = new Map<string, ApplicationDataStore>();

export function applicationDatabasePath(config?: Pick<AppConfig, "persona">) {
  const configured = process.env.SUNABOT_DATABASE_PATH?.trim();
  if (configured) return path.resolve(configured);
  if (!config && process.env.VITEST) return ":memory:";
  if (!config) return getWorkspacePath("artifacts/sunabot.sqlite");

  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) throw new Error("Agent workspace is not configured.");
  const resolved = path.resolve(workspace);
  const parent = path.dirname(resolved);
  if (path.basename(parent) === "agents") {
    return path.join(path.dirname(parent), "artifacts", "sunabot.sqlite");
  }
  return path.join(parent, "artifacts", "sunabot.sqlite");
}

export function applicationDataStore(config?: Pick<AppConfig, "persona">) {
  const databasePath = applicationDatabasePath(config);
  let store = stores.get(databasePath);
  if (!store) {
    store = new ApplicationDataStore(databasePath);
    stores.set(databasePath, store);
  }
  return store;
}

export function closeApplicationDataStores() {
  for (const store of stores.values()) store.close();
  stores.clear();
}

export const sqliteMemoryPersistence: MemoryPersistenceProvider = {
  repository: (config) => applicationDataStore(config),
  databasePath: (config) => applicationDatabasePath(config)
};

export class ApplicationDataStore {
  private readonly database: DatabaseSync;

  constructor(readonly databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  close() {
    if (this.database.isOpen) this.database.close();
  }

  checkpoint() {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  compact() {
    this.database.exec("VACUUM");
  }

  readMemory(source: MemoryDataSource) {
    return this.database.prepare(`
      SELECT data_json FROM memory_records WHERE source = ? ORDER BY position, row_id
    `).all(source).map((row) => parseObject((row as SqlRow).data_json));
  }

  replaceMemory(source: MemoryDataSource, records: readonly JsonObject[]) {
    this.transaction(() => this.replaceMemoryUnsafe(source, records));
  }

  commitMemoryBatch(input: {
    batchId: string;
    baselineWorking: readonly JsonObject[];
    working: readonly JsonObject[];
    longTerm: readonly JsonObject[];
    userProfile: readonly JsonObject[];
    result: unknown;
  }) {
    return this.transaction(() => {
      const existing = this.readMemoryBatch(input.batchId);
      if (existing !== undefined) return { status: "existing" as const, result: existing };
      if (JSON.stringify(this.readMemory("working")) !== JSON.stringify(input.baselineWorking)) {
        return { status: "snapshot_conflict" as const };
      }
      this.replaceMemoryUnsafe("working", input.working);
      this.replaceMemoryUnsafe("long_term", input.longTerm);
      this.replaceMemoryUnsafe("user_profile", input.userProfile);
      this.database.prepare(`
        INSERT INTO memory_batches (batch_id, result_json, committed_at) VALUES (?, ?, ?)
      `).run(input.batchId, JSON.stringify(input.result), new Date().toISOString());
      return { status: "committed" as const, result: input.result };
    });
  }

  readMemoryBatch(batchId: string) {
    const row = this.database.prepare(`
      SELECT result_json FROM memory_batches WHERE batch_id = ?
    `).get(batchId) as SqlRow | undefined;
    return row ? JSON.parse(String(row.result_json)) : undefined;
  }

  hasMemoryBatch(batchId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM memory_batches WHERE batch_id = ?
    `).get(batchId));
  }

  readMemoryScheduler() {
    const conversations: Record<string, JsonObject> = {};
    for (const row of this.database.prepare(`
      SELECT conversation_id, data_json FROM memory_scheduler ORDER BY conversation_id
    `).all() as SqlRow[]) {
      conversations[String(row.conversation_id)] = parseObject(row.data_json);
    }
    return conversations;
  }

  replaceMemoryScheduler(conversations: Readonly<Record<string, object>>) {
    this.transaction(() => {
      const ids = new Set(Object.keys(conversations));
      const upsert = this.database.prepare(`
        INSERT INTO memory_scheduler (conversation_id, updated_at, data_json) VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          data_json = excluded.data_json
      `);
      for (const [id, value] of Object.entries(conversations)) {
        upsert.run(id, String((value as JsonObject).updatedAt ?? ""), JSON.stringify(value));
      }
      for (const row of this.database.prepare("SELECT conversation_id FROM memory_scheduler").all() as SqlRow[]) {
        const id = String(row.conversation_id);
        if (!ids.has(id)) this.database.prepare("DELETE FROM memory_scheduler WHERE conversation_id = ?").run(id);
      }
    });
  }

  ensureLegacyMemorySchedulerImported(filePath: string) {
    const marker = "legacy-memory-scheduler";
    if (this.metadata(marker) === "done") return { imported: false, count: this.memorySchedulerCount() };
    const conversations = readSchedulerJson(filePath);
    this.transaction(() => {
      if (this.memorySchedulerCount() === 0) {
        const insert = this.database.prepare(`
          INSERT INTO memory_scheduler (conversation_id, updated_at, data_json) VALUES (?, ?, ?)
        `);
        for (const [id, value] of Object.entries(conversations)) {
          insert.run(id, String(value.updatedAt ?? ""), JSON.stringify(value));
        }
      }
      this.setMetadata(marker, "done");
    });
    return { imported: Object.keys(conversations).length > 0, count: this.memorySchedulerCount() };
  }

  ensureLegacyMemoryImported(source: MemoryDataSource, filePath: string) {
    const marker = `legacy-memory:${source}`;
    if (this.metadata(marker) === "done") return { imported: false, count: this.memoryCount(source) };
    const records = readJsonlObjects(filePath);
    this.transaction(() => {
      if (this.memoryCount(source) === 0 && records.length) this.replaceMemoryUnsafe(source, records);
      this.setMetadata(marker, "done");
    });
    return { imported: records.length > 0, count: this.memoryCount(source) };
  }

  readConversations() {
    return this.database.prepare(`
      SELECT data_json FROM conversations ORDER BY last_at DESC, id
    `).all().map((row) => JSON.parse(String((row as SqlRow).data_json)) as ConversationRecord);
  }

  replaceConversations(records: readonly ConversationRecord[]) {
    this.transaction(() => {
      const ids = new Set(records.map((record) => record.id));
      const upsert = this.database.prepare(`
        INSERT INTO conversations (id, last_at, data_json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_at = excluded.last_at,
          data_json = excluded.data_json
        WHERE conversations.data_json <> excluded.data_json
      `);
      for (const record of records) upsert.run(record.id, record.lastAt, JSON.stringify(record));
      for (const row of this.database.prepare("SELECT id FROM conversations").all() as SqlRow[]) {
        const id = String(row.id);
        if (!ids.has(id)) this.database.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      }
    });
  }

  ensureLegacyConversationsImported(filePath: string) {
    const marker = "legacy-conversations";
    if (this.metadata(marker) === "done") return { imported: false, count: this.conversationCount() };
    const records = readConversationJson(filePath);
    this.transaction(() => {
      if (this.conversationCount() === 0 && records.length) {
        const insert = this.database.prepare(`
          INSERT INTO conversations (id, last_at, data_json) VALUES (?, ?, ?)
        `);
        for (const record of records) insert.run(record.id, record.lastAt, JSON.stringify(record));
      }
      this.setMetadata(marker, "done");
    });
    return { imported: records.length > 0, count: this.conversationCount() };
  }

  readImageHistory() {
    return this.database.prepare(`
      SELECT data_json FROM image_history ORDER BY created_at DESC, id LIMIT 80
    `).all().map((row) => JSON.parse(String((row as SqlRow).data_json)) as ImageHistoryRecord);
  }

  replaceImageHistory(records: readonly ImageHistoryRecord[]) {
    this.transaction(() => {
      this.database.prepare("DELETE FROM image_history").run();
      const insert = this.database.prepare(`
        INSERT INTO image_history (id, url, created_at, data_json) VALUES (?, ?, ?, ?)
      `);
      for (const record of records) insert.run(record.id, record.url, record.createdAt, JSON.stringify(record));
    });
  }

  ensureLegacyImageHistoryImported(filePath: string) {
    const marker = "legacy-image-history";
    if (this.metadata(marker) === "done") return { imported: false, count: this.imageHistoryCount() };
    const records = readImageHistoryJson(filePath);
    this.transaction(() => {
      if (this.imageHistoryCount() === 0) {
        const insert = this.database.prepare(`
          INSERT INTO image_history (id, url, created_at, data_json) VALUES (?, ?, ?, ?)
        `);
        for (const record of records) insert.run(record.id, record.url, record.createdAt, JSON.stringify(record));
      }
      this.setMetadata(marker, "done");
    });
    return { imported: records.length > 0, count: this.imageHistoryCount() };
  }

  appendRequestLog(record: JsonObject) {
    this.database.prepare(`
      INSERT INTO request_logs (id, at, category, action, search_text, data_json)
      VALUES (?, ?, ?, ?, '', ?)
    `).run(
      String(record.id ?? ""),
      String(record.at ?? new Date().toISOString()),
      String(record.category ?? ""),
      String(record.action ?? ""),
      JSON.stringify(record)
    );
  }

  readRequestLogs(options: { query?: string; limit: number }) {
    const query = String(options.query ?? "").trim().toLowerCase();
    const rows = query
      ? this.database.prepare(`
          SELECT data_json FROM request_logs
          WHERE LOWER(data_json) LIKE ? ESCAPE '\\'
          ORDER BY at DESC, row_id DESC LIMIT ?
        `).all(`%${escapeLike(query)}%`, options.limit)
      : this.database.prepare(`
          SELECT data_json FROM request_logs ORDER BY at DESC, row_id DESC LIMIT ?
        `).all(options.limit);
    return rows.map((row) => JSON.parse(String((row as SqlRow).data_json)));
  }

  ensureLegacyRequestLogsImported(filePath: string) {
    const marker = "legacy-request-logs";
    if (this.metadata(marker) === "done") return { imported: false, count: this.requestLogCount() };
    const records = readJsonlObjects(filePath);
    this.transaction(() => {
      if (this.requestLogCount() === 0) {
        for (const record of records) this.appendRequestLog(record);
      }
      this.setMetadata(marker, "done");
    });
    return { imported: records.length > 0, count: this.requestLogCount() };
  }

  counts() {
    return {
      conversations: this.conversationCount(),
      requestLogs: this.requestLogCount(),
      workingMemory: this.memoryCount("working"),
      longTermMemory: this.memoryCount("long_term"),
      userProfiles: this.memoryCount("user_profile"),
      memorySchedulerConversations: this.memorySchedulerCount(),
      imageHistory: this.imageHistoryCount()
    };
  }

  private migrate() {
    this.database.exec(`
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
      CREATE INDEX IF NOT EXISTS memory_records_source_position
        ON memory_records(source, position);
      CREATE TABLE IF NOT EXISTS memory_batches (
        batch_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        committed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_scheduler (
        conversation_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      );
      CREATE INDEX IF NOT EXISTS memory_scheduler_updated_at ON memory_scheduler(updated_at);
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
    `);
    if (this.metadata("storage-schema-version") !== "2") {
      this.database.prepare("UPDATE request_logs SET search_text = '' WHERE search_text <> ''").run();
      this.setMetadata("storage-schema-version", "2");
    }
  }

  private replaceMemoryUnsafe(source: MemoryDataSource, records: readonly JsonObject[]) {
    this.database.prepare("DELETE FROM memory_records WHERE source = ?").run(source);
    const insert = this.database.prepare(`
      INSERT INTO memory_records (source, position, record_id, data_json) VALUES (?, ?, ?, ?)
    `);
    records.forEach((record, position) => {
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
      insert.run(source, position, id, JSON.stringify(record));
    });
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private metadata(key: string) {
    const row = this.database.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key) as SqlRow | undefined;
    return row ? String(row.value) : undefined;
  }

  private setMetadata(key: string, value: string) {
    this.database.prepare(`
      INSERT INTO app_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private memoryCount(source: MemoryDataSource) {
    return count(this.database.prepare("SELECT COUNT(*) AS count FROM memory_records WHERE source = ?").get(source));
  }

  private conversationCount() {
    return count(this.database.prepare("SELECT COUNT(*) AS count FROM conversations").get());
  }

  private memorySchedulerCount() {
    return count(this.database.prepare("SELECT COUNT(*) AS count FROM memory_scheduler").get());
  }

  private imageHistoryCount() {
    return count(this.database.prepare("SELECT COUNT(*) AS count FROM image_history").get());
  }

  private requestLogCount() {
    return count(this.database.prepare("SELECT COUNT(*) AS count FROM request_logs").get());
  }
}

function count(row: unknown) {
  return Number((row as SqlRow | undefined)?.count ?? 0);
}

function parseObject(value: unknown) {
  const parsed = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored JSON value is not an object.");
  return parsed as JsonObject;
}

function readJsonlObjects(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const records: JsonObject[] = [];
  const ids = new Set<string>();
  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid JSONL object at ${filePath}:${index + 1}`);
    }
    const record = value as JsonObject;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id && ids.has(id)) throw new Error(`Duplicate JSONL id ${id} at ${filePath}:${index + 1}`);
    if (id) ids.add(id);
    records.push(record);
  });
  return records;
}

function readConversationJson(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { conversations?: unknown } | unknown[];
  const records = Array.isArray(parsed) ? parsed : parsed.conversations;
  if (!Array.isArray(records)) throw new Error(`Invalid conversation store at ${filePath}`);
  return records.filter((record): record is ConversationRecord => Boolean(
    record && typeof record === "object" && typeof (record as ConversationRecord).id === "string"
  ));
}

function readSchedulerJson(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { version?: unknown; conversations?: unknown };
  if (parsed.version !== 1 || !parsed.conversations || typeof parsed.conversations !== "object" || Array.isArray(parsed.conversations)) {
    throw new Error(`Invalid memory scheduler store at ${filePath}`);
  }
  return parsed.conversations as Record<string, JsonObject>;
}

function readImageHistoryJson(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`Invalid image history store at ${filePath}`);
  return parsed.filter((record): record is ImageHistoryRecord => Boolean(
    record && typeof record === "object" &&
    typeof (record as ImageHistoryRecord).id === "string" &&
    typeof (record as ImageHistoryRecord).url === "string" &&
    typeof (record as ImageHistoryRecord).createdAt === "string"
  ));
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
