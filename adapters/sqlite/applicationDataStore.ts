import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getWorkspacePath, resolveProjectPath } from "../../src/config.js";
import type { AppConfig, ConversationRecord, ImageHistoryRecord } from "../../src/types.js";
import type { MemoryPersistenceProvider } from "../../services/memory/persistence.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import {
  modelCallMeasurement,
  type MemoryModelCallKindId,
  type ModelCallBehaviorId,
  type ModelCallMeasurement
} from "../../src/modelCallStats.js";

export type MemoryDataSource = "working" | "long_term" | "user_profile";

type JsonObject = Record<string, unknown>;
type SqlRow = Record<string, unknown>;

export interface ModelCallAggregateRow {
  behavior: ModelCallBehaviorId;
  memoryKind: MemoryModelCallKindId | "";
  input: number;
  output: number;
  total: number;
  cachedInput: number;
  requests: number;
  measuredInput: number;
  measuredCachedInput: number;
  cacheReports: number;
}

const stores = new Map<string, ApplicationDataStore>();

export function applicationDatabasePath(config?: Pick<AppConfig, "persona">) {
  const configured = process.env.SUNABOT_DATABASE_PATH?.trim();
  if (configured) return path.resolve(configured);
  if (process.env.VITEST) {
    if (!config || !path.isAbsolute(config.persona.agentWorkspace)) return ":memory:";
    const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
    if (!agentWorkspace) return ":memory:";
    const parent = path.dirname(path.resolve(agentWorkspace));
    return path.join(path.basename(parent) === "agents" ? path.dirname(parent) : parent, "data", "sunabot.sqlite");
  }
  return getWorkspacePath(WORKSPACE_LAYOUT.database);
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
    this.transaction(() => this.appendRequestLogUnsafe(record));
  }

  readModelCallAggregateRows(conversationId = ""): ModelCallAggregateRow[] {
    return (this.database.prepare(`
      SELECT behavior, memory_kind, input_tokens, output_tokens, total_tokens,
        cached_input_tokens, requests, measured_input_tokens,
        measured_cached_input_tokens, cache_reports
      FROM model_call_aggregates
      WHERE conversation_id = ?
      ORDER BY behavior, memory_kind
    `).all(conversationId) as SqlRow[]).map((row) => ({
      behavior: String(row.behavior) as ModelCallBehaviorId,
      memoryKind: String(row.memory_kind) as MemoryModelCallKindId | "",
      input: Number(row.input_tokens ?? 0),
      output: Number(row.output_tokens ?? 0),
      total: Number(row.total_tokens ?? 0),
      cachedInput: Number(row.cached_input_tokens ?? 0),
      requests: Number(row.requests ?? 0),
      measuredInput: Number(row.measured_input_tokens ?? 0),
      measuredCachedInput: Number(row.measured_cached_input_tokens ?? 0),
      cacheReports: Number(row.cache_reports ?? 0)
    }));
  }

  private appendRequestLogUnsafe(record: JsonObject) {
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
    const measurement = modelCallMeasurement(record);
    if (measurement) this.appendModelCallAggregateUnsafe(measurement);
  }

  readRequestLogs(options: { query?: string; limit: number }) {
    return this.readRequestLogPage({ query: options.query, page: 1, pageSize: options.limit }).logs;
  }

  readRequestLogPage(options: { query?: string; page: number; pageSize: number }) {
    const query = String(options.query ?? "").trim().toLowerCase();
    const offset = (options.page - 1) * options.pageSize;
    const rows = query
      ? this.database.prepare(`
          SELECT data_json FROM request_logs
          WHERE LOWER(data_json) LIKE ? ESCAPE '\\'
          ORDER BY at DESC, row_id DESC LIMIT ? OFFSET ?
        `).all(`%${escapeLike(query)}%`, options.pageSize, offset)
      : this.database.prepare(`
          SELECT data_json FROM request_logs ORDER BY at DESC, row_id DESC LIMIT ? OFFSET ?
        `).all(options.pageSize, offset);
    const countRow = query
      ? this.database.prepare(`
          SELECT COUNT(*) AS count FROM request_logs
          WHERE LOWER(data_json) LIKE ? ESCAPE '\\'
        `).get(`%${escapeLike(query)}%`) as SqlRow
      : this.database.prepare("SELECT COUNT(*) AS count FROM request_logs").get() as SqlRow;
    const total = Number(countRow.count ?? 0);
    return {
      logs: rows.map((row) => JSON.parse(String((row as SqlRow).data_json))),
      page: options.page,
      pageSize: options.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / options.pageSize))
    };
  }

  readTokenUsageRecords(since: string) {
    return this.database.prepare(`
      SELECT data_json FROM request_logs
      WHERE category = 'model.response' AND at >= ?
      ORDER BY at ASC, row_id ASC
    `).all(since).map((row) => JSON.parse(String((row as SqlRow).data_json)) as JsonObject);
  }

  ensureLegacyRequestLogsImported(filePath: string) {
    const marker = "legacy-request-logs";
    if (this.metadata(marker) === "done") return { imported: false, count: this.requestLogCount() };
    const records = readJsonlObjects(filePath);
    this.transaction(() => {
      if (this.requestLogCount() === 0) {
        for (const record of records) this.appendRequestLogUnsafe(record);
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
    `);
    const rawVersion = Number(this.metadata("storage-schema-version") ?? 0);
    const schemaVersion = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
    if (schemaVersion < 2) {
      this.database.prepare("UPDATE request_logs SET search_text = '' WHERE search_text <> ''").run();
      this.setMetadata("storage-schema-version", "2");
    }
    if (schemaVersion < 3) {
      this.transaction(() => {
        this.database.prepare("DELETE FROM model_call_aggregates").run();
        const rows = this.database.prepare(`
          SELECT data_json FROM request_logs WHERE category = 'model.response' ORDER BY row_id
        `).all() as SqlRow[];
        for (const row of rows) {
          const measurement = modelCallMeasurement(parseObject(row.data_json));
          if (measurement) this.appendModelCallAggregateUnsafe(measurement);
        }
        this.setMetadata("storage-schema-version", "3");
      });
    }
  }

  private appendModelCallAggregateUnsafe(measurement: ModelCallMeasurement) {
    const upsert = this.database.prepare(`
      INSERT INTO model_call_aggregates (
        conversation_id, behavior, memory_kind, input_tokens, output_tokens,
        total_tokens, cached_input_tokens, requests, measured_input_tokens,
        measured_cached_input_tokens, cache_reports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(conversation_id, behavior, memory_kind) DO UPDATE SET
        input_tokens = MIN(9007199254740991, input_tokens + excluded.input_tokens),
        output_tokens = MIN(9007199254740991, output_tokens + excluded.output_tokens),
        total_tokens = MIN(9007199254740991, total_tokens + excluded.total_tokens),
        cached_input_tokens = MIN(9007199254740991, cached_input_tokens + excluded.cached_input_tokens),
        requests = MIN(9007199254740991, requests + 1),
        measured_input_tokens = MIN(9007199254740991, measured_input_tokens + excluded.measured_input_tokens),
        measured_cached_input_tokens = MIN(9007199254740991, measured_cached_input_tokens + excluded.measured_cached_input_tokens),
        cache_reports = MIN(9007199254740991, cache_reports + excluded.cache_reports)
    `);
    const scopes = measurement.conversationId ? ["", measurement.conversationId] : [""];
    for (const conversationId of scopes) {
      upsert.run(
        conversationId,
        measurement.behavior,
        measurement.memoryKind,
        measurement.input,
        measurement.output,
        measurement.total,
        measurement.cachedInput,
        measurement.cacheReported ? measurement.input : 0,
        measurement.cacheReported ? measurement.cachedInput : 0,
        measurement.cacheReported ? 1 : 0
      );
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
