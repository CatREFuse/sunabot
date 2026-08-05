import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getWorkspacePath, resolveProjectPath } from "../../packages/platform/projectPaths.js";
import type { AppConfig, ImageHistoryRecord } from "../../packages/contracts/admin/public.js";
import type { ConversationRecord } from "../../packages/contracts/messaging/messages.js";
import type {
  RequestLogBusinessNode,
  RequestLogMemoryTool
} from "../../packages/contracts/observability/requestLogPresentation.js";
import type { MemoryPersistenceProvider } from "../../services/memory/persistence.js";
import type { ScheduledTaskStore } from "../../services/scheduling/public.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { currentAgentRuntimeConfig } from "../../packages/platform/runtimeAgentContext.js";
import { readMemorySourceSnapshot } from "./memoryRevisionStore.js";
import { migrateApplicationDataSchema } from "./applicationDataSchema.js";
import { EmojiStore, type EmojiRecord, type EmojiVersionRecord } from "./emojiStore.js";
import { SqliteScheduledTaskStore } from "./scheduledTaskStore.js";
import { SqliteDirectorStore } from "./directorStore.js";
import { SqliteDreamStore } from "./dreamStore.js";
import { ImageHistoryStore } from "./imageHistoryStore.js";
import {
  ModelCallStore,
  type ModelCallAggregateRow,
  type ModelCallModelAggregateRow
} from "./modelCallStore.js";

export type { ModelCallAggregateRow, ModelCallModelAggregateRow } from "./modelCallStore.js";
export type { EmojiRecord, EmojiVersionRecord } from "./emojiStore.js";
export { generatedImageHistoryRecords } from "./imageHistoryStore.js";

export type MemoryDataSource = "working" | "long_term" | "user_profile";

type JsonObject = Record<string, unknown>;
type SqlRow = Record<string, unknown>;
export interface AgentRegistryRow {
  id: string;
  name: string;
  enabled: boolean;
  workspace: string;
  avatarPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAccountRegistryRow {
  id: string;
  agentId: string;
  label: string;
  qqId?: string;
  enabled: boolean;
  webuiPort: number;
  createdAt: string;
  updatedAt: string;
}

const stores = new Map<string, ApplicationDataStore>();

export function applicationDatabasePath(config?: Pick<AppConfig, "persona">) {
  const activeConfig = config ?? currentAgentRuntimeConfig();
  const agentId = activeConfig?.persona.defaultAgentId.trim() || "plana";
  if (activeConfig && agentId !== "plana") {
    const agentWorkspace = resolveProjectPath(activeConfig.persona.agentWorkspace);
    if (!agentWorkspace) throw new Error(`Agent workspace is invalid: ${activeConfig.persona.agentWorkspace}`);
    return path.join(agentWorkspace, "data", "sunabot.sqlite");
  }
  const configured = process.env.SUNABOT_DATABASE_PATH?.trim();
  if (configured) {
    throw new Error("SUNABOT_DATABASE_PATH 已停止支持；主库固定为 workspace/business/data/sunabot.sqlite。");
  }
  if (process.env.VITEST && activeConfig && path.isAbsolute(activeConfig.persona.agentWorkspace)) {
    const agentWorkspace = resolveProjectPath(activeConfig.persona.agentWorkspace);
    if (!agentWorkspace) return ":memory:";
    const parent = path.dirname(path.resolve(agentWorkspace));
    return path.join(path.basename(parent) === "agents" ? path.dirname(parent) : parent, "data", "sunabot.sqlite");
  }
  if (process.env.VITEST) return ":memory:";
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
  private readonly modelCalls: ModelCallStore;
  private readonly emojis: EmojiStore;
  private readonly imageHistory: ImageHistoryStore;
  readonly scheduledTasks: ScheduledTaskStore;
  readonly director: SqliteDirectorStore;
  readonly dreams: SqliteDreamStore;

  constructor(readonly databasePath: string) {
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.modelCalls = new ModelCallStore(this.database);
    migrateApplicationDataSchema(this.database, this.modelCalls);
    this.emojis = new EmojiStore(this.database);
    this.imageHistory = new ImageHistoryStore(this.database);
    this.scheduledTasks = new SqliteScheduledTaskStore(this.database);
    this.director = new SqliteDirectorStore(this.database);
    this.dreams = new SqliteDreamStore(this.database);
    initializeLongTermRecallTracking(this);
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

  readAgents(): AgentRegistryRow[] {
    return (this.database.prepare(`
      SELECT id, name, enabled, workspace, avatar_path, created_at, updated_at
      FROM agents ORDER BY created_at, id
    `).all() as SqlRow[]).map(mapAgentRegistryRow);
  }

  readAgent(id: string): AgentRegistryRow | undefined {
    const row = this.database.prepare(`
      SELECT id, name, enabled, workspace, avatar_path, created_at, updated_at
      FROM agents WHERE id = ?
    `).get(id) as SqlRow | undefined;
    return row ? mapAgentRegistryRow(row) : undefined;
  }

  createAgent(record: AgentRegistryRow) {
    this.database.prepare(`
      INSERT INTO agents (id, name, enabled, workspace, avatar_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.name,
      record.enabled ? 1 : 0,
      record.workspace,
      record.avatarPath ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  updateAgent(record: Pick<AgentRegistryRow, "id" | "name" | "enabled" | "avatarPath" | "updatedAt">) {
    const result = this.database.prepare(`
      UPDATE agents SET name = ?, enabled = ?, avatar_path = ?, updated_at = ? WHERE id = ?
    `).run(record.name, record.enabled ? 1 : 0, record.avatarPath ?? null, record.updatedAt, record.id);
    return Number(result.changes) > 0;
  }

  deleteAgent(id: string) {
    return Number(this.database.prepare("DELETE FROM agents WHERE id = ?").run(id).changes) > 0;
  }

  readAgentAccounts(agentId?: string): AgentAccountRegistryRow[] {
    const rows = agentId
      ? this.database.prepare(`
          SELECT id, agent_id, label, qq_id, enabled, webui_port, created_at, updated_at
          FROM agent_accounts WHERE agent_id = ? ORDER BY created_at, id
        `).all(agentId)
      : this.database.prepare(`
          SELECT id, agent_id, label, qq_id, enabled, webui_port, created_at, updated_at
          FROM agent_accounts ORDER BY agent_id, created_at, id
        `).all();
    return (rows as SqlRow[]).map(mapAgentAccountRegistryRow);
  }

  readAgentAccount(id: string): AgentAccountRegistryRow | undefined {
    const row = this.database.prepare(`
      SELECT id, agent_id, label, qq_id, enabled, webui_port, created_at, updated_at
      FROM agent_accounts WHERE id = ?
    `).get(id) as SqlRow | undefined;
    return row ? mapAgentAccountRegistryRow(row) : undefined;
  }

  createAgentAccount(record: AgentAccountRegistryRow) {
    this.database.prepare(`
      INSERT INTO agent_accounts (id, agent_id, label, qq_id, enabled, webui_port, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.agentId,
      record.label,
      record.qqId ?? null,
      record.enabled ? 1 : 0,
      record.webuiPort,
      record.createdAt,
      record.updatedAt
    );
  }

  updateAgentAccount(record: Pick<AgentAccountRegistryRow, "id" | "label" | "qqId" | "enabled" | "updatedAt">) {
    const result = this.database.prepare(`
      UPDATE agent_accounts SET label = ?, qq_id = ?, enabled = ?, updated_at = ? WHERE id = ?
    `).run(record.label, record.qqId ?? null, record.enabled ? 1 : 0, record.updatedAt, record.id);
    return Number(result.changes) > 0;
  }

  transferAgentAccountIdentity(accountId: string, qqId: string, updatedAt: string) {
    return this.transaction(() => {
      const target = this.database.prepare("SELECT id FROM agent_accounts WHERE id = ?").get(accountId) as SqlRow | undefined;
      if (!target) return { updated: false };
      const previous = this.database.prepare("SELECT id FROM agent_accounts WHERE qq_id = ?").get(qqId) as SqlRow | undefined;
      const previousAccountId = previous ? String(previous.id) : undefined;
      if (previousAccountId && previousAccountId !== accountId) {
        this.database.prepare("UPDATE agent_accounts SET qq_id = NULL, updated_at = ? WHERE id = ? AND qq_id = ?")
          .run(updatedAt, previousAccountId, qqId);
      }
      const result = this.database.prepare("UPDATE agent_accounts SET qq_id = ?, updated_at = ? WHERE id = ?")
        .run(qqId, updatedAt, accountId);
      return {
        updated: Number(result.changes) > 0,
        ...(previousAccountId && previousAccountId !== accountId ? { previousAccountId } : {})
      };
    });
  }

  deleteAgentAccount(id: string) {
    return Number(this.database.prepare("DELETE FROM agent_accounts WHERE id = ?").run(id).changes) > 0;
  }

  nextAgentAccountWebuiPort() {
    const row = this.database.prepare("SELECT COALESCE(MAX(webui_port), 6098) AS port FROM agent_accounts").get() as SqlRow;
    const port = Math.max(6098, Number(row.port ?? 6098)) + 1;
    if (port > 65_535) throw new Error("NapCat WebUI port range is exhausted.");
    return port;
  }

  readMemory(source: MemoryDataSource) {
    return this.database.prepare(`
      SELECT data_json FROM memory_records WHERE source = ? ORDER BY position, row_id
    `).all(source).map((row) => parseObject((row as SqlRow).data_json));
  }

  readMemorySnapshot() { return this.transaction(() => readMemorySourceSnapshot(this.database, (source) => this.readMemory(source))); }

  replaceMemory(source: MemoryDataSource, records: readonly JsonObject[]) {
    this.transaction(() => this.replaceMemoryUnsafe(source, records));
    if (source === "long_term") initializeLongTermRecallTracking(this);
  }

  initializeRecallTracking(recordIds: readonly string[], at?: Date) { return this.dreams.initializeRecallTracking(recordIds, at); }

  reserveActualRecall(input: Parameters<SqliteDreamStore["reserveActualRecall"]>[0]) { return this.dreams.reserveActualRecall(input); }

  recordActualRecall(input: Parameters<SqliteDreamStore["recordActualRecall"]>[0]) { return this.dreams.recordActualRecall(input); }

  listRecallStats(recordIds?: readonly string[]) { return this.dreams.listRecallStats(recordIds); }

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

  readConversations<T extends ConversationRecord = ConversationRecord>() {
    return this.database.prepare(`
      SELECT data_json FROM conversations ORDER BY last_at DESC, id
    `).all().map((row) => JSON.parse(String((row as SqlRow).data_json)) as T);
  }

  replaceConversations(records: readonly ConversationRecord[]) {
    this.transaction(() => this.replaceConversationsUnsafe(records));
  }

  upsertConversation(record: ConversationRecord) {
    this.transaction(() => this.upsertConversationUnsafe(record));
  }

  replaceConversationsIdempotent(idempotencyKey: string, records: readonly ConversationRecord[]) {
    const key = requiredIdempotencyKey(idempotencyKey);
    return this.transaction(() => {
      const inserted = this.database.prepare(`
        INSERT INTO outbox_local_effects (idempotency_key, effect_kind, created_at)
        VALUES (?, 'conversation_projection', ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).run(key, new Date().toISOString());
      if (Number(inserted.changes) !== 1) return false;
      this.replaceConversationsUnsafe(records);
      return true;
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
    return this.imageHistory.read();
  }

  replaceImageHistory(records: readonly ImageHistoryRecord[]) {
    this.imageHistory.replace(records);
  }

  appendImageHistory(record: ImageHistoryRecord) {
    this.imageHistory.append(record);
  }

  ensureLegacyImageHistoryImported(filePath: string) {
    return this.imageHistory.ensureLegacyImported(filePath);
  }

  ensureGeneratedImageHistoryIndexed(config?: Pick<AppConfig, "persona">) {
    return this.imageHistory.ensureGeneratedIndexed(config);
  }

  readEmojis(): EmojiRecord[] {
    return this.emojis.readAll();
  }

  readEmoji(key: string): EmojiRecord | undefined {
    return this.emojis.read(key);
  }

  readEmojiVersions(key: string): EmojiVersionRecord[] {
    return this.emojis.readVersions(key);
  }

  readEmojiVersion(key: string, fileName: string): EmojiVersionRecord | undefined {
    return this.emojis.readVersion(key, fileName);
  }

  upsertEmoji(record: EmojiRecord) {
    this.emojis.upsert(record);
  }

  renameEmoji(currentKey: string, nextKey: string, updatedAt: string): "renamed" | "missing" | "conflict" {
    return this.emojis.rename(currentKey, nextKey, updatedAt);
  }

  deleteEmojiVersion(key: string, fileName: string): "deleted" | "missing" | "current" {
    return this.emojis.deleteVersion(key, fileName);
  }

  deleteEmoji(key: string) {
    return this.emojis.delete(key);
  }

  clearLegacyEmojis() {
    this.emojis.clear();
  }

  appendRequestLog(record: JsonObject) {
    this.modelCalls.appendRequestLog(record);
  }

  appendMemoryOperationLog(record: JsonObject) {
    this.modelCalls.appendRequestLog(record);
  }

  readMemoryOperationLogPage(options: { page: number; pageSize: number }) {
    return this.modelCalls.readRequestLogCategoryPage({
      category: "memory.operation",
      ...options
    });
  }

  appendRequestLogIdempotent(record: JsonObject) {
    return this.modelCalls.appendRequestLogIdempotent(record);
  }

  readModelCallAggregateRows(conversationId = ""): ModelCallAggregateRow[] {
    return this.modelCalls.readAggregateRows(conversationId);
  }

  readModelCallModelAggregateRows(conversationId = ""): ModelCallModelAggregateRow[] {
    return this.modelCalls.readModelAggregateRows(conversationId);
  }

  readRequestLogs(options: {
    query?: string;
    limit: number;
    node?: RequestLogBusinessNode;
    memoryTool?: RequestLogMemoryTool;
  }) {
    return this.modelCalls.readRequestLogs(options);
  }

  readRequestLogPage(options: {
    query?: string;
    page: number;
    pageSize: number;
    node?: RequestLogBusinessNode;
    memoryTool?: RequestLogMemoryTool;
  }) {
    return this.modelCalls.readRequestLogPage(options);
  }

  readRequestLogTrace(id: string) {
    return this.modelCalls.readRequestLogTrace(id);
  }

  readTokenUsageRecords(since: string) {
    return this.modelCalls.readTokenUsageRecords(since);
  }

  ensureLegacyRequestLogsImported(filePath: string) {
    const marker = "legacy-request-logs";
    if (this.metadata(marker) === "done") return { imported: false, count: this.requestLogCount() };
    const records = readJsonlObjects(filePath);
    this.transaction(() => {
      if (this.requestLogCount() === 0) {
        for (const record of records) this.modelCalls.appendRequestLogUnsafe(record);
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
      imageHistory: this.imageHistory.count()
    };
  }

  private replaceConversationsUnsafe(records: readonly ConversationRecord[]) {
    const ids = new Set(records.map((record) => record.id));
    for (const record of records) this.upsertConversationUnsafe(record);
    for (const row of this.database.prepare("SELECT id FROM conversations").all() as SqlRow[]) {
      const id = String(row.id);
      if (!ids.has(id)) this.database.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    }
  }

  private upsertConversationUnsafe(record: ConversationRecord) {
    this.database.prepare(`
      INSERT INTO conversations (id, last_at, data_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_at = excluded.last_at,
        data_json = excluded.data_json
      WHERE conversations.data_json <> excluded.data_json
    `).run(record.id, record.lastAt, JSON.stringify(record));
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

  private requestLogCount() {
    return count(this.database.prepare("SELECT COUNT(*) AS count FROM request_logs").get());
  }
}

function initializeLongTermRecallTracking(store: Pick<ApplicationDataStore, "dreams" | "readMemory">) {
  const ids = store.readMemory("long_term")
    .flatMap((record) => {
      if (typeof record.id !== "string") return [];
      const id = record.id.trim();
      return id && [...id].length <= 128 ? [id] : [];
    });
  if (ids.length) store.dreams.initializeRecallTracking(ids);
}

function count(row: unknown) {
  return Number((row as SqlRow | undefined)?.count ?? 0);
}

function requiredIdempotencyKey(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error("idempotencyKey is required.");
  return value.trim();
}

function mapAgentRegistryRow(row: SqlRow): AgentRegistryRow {
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    workspace: String(row.workspace),
    ...(row.avatar_path == null || String(row.avatar_path).trim() === "" ? {} : { avatarPath: String(row.avatar_path) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapAgentAccountRegistryRow(row: SqlRow): AgentAccountRegistryRow {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    label: String(row.label),
    ...(row.qq_id == null || String(row.qq_id).trim() === "" ? {} : { qqId: String(row.qq_id) }),
    enabled: Number(row.enabled) === 1,
    webuiPort: Number(row.webui_port),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
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
