import type { DatabaseSync } from "node:sqlite";
import {
  modelCallMeasurement,
  type MemoryModelCallKindId,
  type ModelCallBehaviorId,
  type ModelCallMeasurement
} from "../../packages/contracts/model/modelCallStats.js";
import type {
  RequestLogBusinessNode,
  RequestLogMemoryTool
} from "../../packages/contracts/observability/requestLogPresentation.js";

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

export interface ModelCallModelAggregateRow extends ModelCallAggregateRow {
  model: string;
}

export class ModelCallStore {
  constructor(private readonly database: DatabaseSync) {}

  appendRequestLog(record: JsonObject) {
    this.transaction(() => this.appendRequestLogUnsafe(record));
  }

  appendRequestLogIdempotent(record: JsonObject) {
    return this.transaction(() => {
      const result = this.database.prepare(`
        INSERT INTO request_logs (id, at, category, action, search_text, data_json)
        VALUES (?, ?, ?, ?, '', ?)
        ON CONFLICT(id) DO NOTHING
      `).run(
        String(record.id ?? ""),
        String(record.at ?? new Date().toISOString()),
        String(record.category ?? ""),
        String(record.action ?? ""),
        JSON.stringify(record)
      );
      if (Number(result.changes) !== 1) return false;
      const measurement = modelCallMeasurement(record);
      if (measurement) this.appendModelCallAggregateUnsafe(measurement);
      return true;
    });
  }

  appendRequestLogUnsafe(record: JsonObject) {
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

  readAggregateRows(conversationId = ""): ModelCallAggregateRow[] {
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

  readModelAggregateRows(conversationId = ""): ModelCallModelAggregateRow[] {
    return (this.database.prepare(`
      SELECT model, behavior, memory_kind, input_tokens, output_tokens, total_tokens,
        cached_input_tokens, requests, measured_input_tokens,
        measured_cached_input_tokens, cache_reports
      FROM model_call_model_aggregates
      WHERE conversation_id = ?
      ORDER BY model, behavior, memory_kind
    `).all(conversationId) as SqlRow[]).map((row) => ({
      model: String(row.model),
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

  readRequestLogs(options: {
    query?: string;
    limit: number;
    node?: RequestLogBusinessNode;
    memoryTool?: RequestLogMemoryTool;
  }) {
    return this.readRequestLogPage({
      query: options.query,
      page: 1,
      pageSize: options.limit,
      node: options.node,
      memoryTool: options.memoryTool
    }).logs;
  }

  readRequestLogPage(options: {
    query?: string;
    page: number;
    pageSize: number;
    node?: RequestLogBusinessNode;
    memoryTool?: RequestLogMemoryTool;
  }) {
    const query = String(options.query ?? "").trim().toLowerCase();
    const offset = (options.page - 1) * options.pageSize;
    const filter = requestLogSqlFilter(options.node, options.memoryTool, query);
    const where = filter.conditions.length ? `WHERE ${filter.conditions.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT data_json FROM request_logs
      ${where}
      ORDER BY at DESC, row_id DESC LIMIT ? OFFSET ?
    `).all(...filter.parameters, options.pageSize, offset);
    const countRow = this.database.prepare(`
      SELECT COUNT(*) AS count FROM request_logs
      ${where}
    `).get(...filter.parameters) as SqlRow;
    const total = Number(countRow.count ?? 0);
    return {
      logs: rows.map((row) => JSON.parse(String((row as SqlRow).data_json))),
      page: options.page,
      pageSize: options.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / options.pageSize))
    };
  }

  readRequestLogCategoryPage(options: { category: string; page: number; pageSize: number }) {
    const offset = (options.page - 1) * options.pageSize;
    const rows = this.database.prepare(`
      SELECT data_json FROM request_logs
      WHERE category = ?
      ORDER BY at DESC, row_id DESC LIMIT ? OFFSET ?
    `).all(options.category, options.pageSize, offset);
    const countRow = this.database.prepare(`
      SELECT COUNT(*) AS count FROM request_logs WHERE category = ?
    `).get(options.category) as SqlRow;
    const total = Number(countRow.count ?? 0);
    return {
      logs: rows.map((row) => JSON.parse(String((row as SqlRow).data_json))),
      page: options.page,
      pageSize: options.pageSize,
      total,
      pageCount: Math.max(1, Math.ceil(total / options.pageSize))
    };
  }

  readRequestLogTrace(id: string) {
    const selected = this.database.prepare(`
      SELECT data_json FROM request_logs WHERE id = ? LIMIT 1
    `).get(id) as SqlRow | undefined;
    if (!selected) return [];
    const selectedRecord = parseObject(selected.data_json);
    const metadata = selectedRecord.metadata && typeof selectedRecord.metadata === "object" && !Array.isArray(selectedRecord.metadata)
      ? selectedRecord.metadata as JsonObject
      : {};
    const runId = typeof metadata.runId === "string" ? metadata.runId.trim() : "";
    if (!runId) return [selectedRecord];
    return (this.database.prepare(`
      SELECT data_json FROM request_logs
      WHERE json_extract(data_json, '$.metadata.runId') = ?
      ORDER BY at ASC, row_id ASC
      LIMIT 200
    `).all(runId) as SqlRow[]).map((row) => parseObject(row.data_json));
  }

  readTokenUsageRecords(since: string) {
    return this.database.prepare(`
      SELECT data_json FROM request_logs
      WHERE category = 'model.response' AND at >= ?
      ORDER BY at ASC, row_id ASC
    `).all(since).map((row) => JSON.parse(String((row as SqlRow).data_json)) as JsonObject);
  }

  repairModelAggregatesIfStale() {
    const sourceRequests = count(this.database.prepare(`
      SELECT COUNT(*) AS count FROM request_logs WHERE category = 'model.response'
    `).get());
    const aggregateRequests = count(this.database.prepare(`
      SELECT COALESCE(SUM(requests), 0) AS count
      FROM model_call_model_aggregates WHERE conversation_id = ''
    `).get());
    if (sourceRequests !== aggregateRequests) this.rebuildModelAggregates();
  }

  rebuildModelAggregates() {
    this.transaction(() => {
      this.database.prepare("DELETE FROM model_call_model_aggregates").run();
      const rows = this.database.prepare(`
        SELECT data_json FROM request_logs WHERE category = 'model.response' ORDER BY row_id
      `).all() as SqlRow[];
      for (const row of rows) {
        const measurement = modelCallMeasurement(parseObject(row.data_json));
        if (measurement) this.appendModelCallModelAggregateUnsafe(measurement);
      }
      setMetadata(this.database, "storage-schema-version", "6");
    });
  }

  appendModelCallAggregateUnsafe(measurement: ModelCallMeasurement) {
    this.appendModelCallModelAggregateUnsafe(measurement);
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

  private appendModelCallModelAggregateUnsafe(measurement: ModelCallMeasurement) {
    const upsert = this.database.prepare(`
      INSERT INTO model_call_model_aggregates (
        conversation_id, model, behavior, memory_kind, input_tokens, output_tokens,
        total_tokens, cached_input_tokens, requests, measured_input_tokens,
        measured_cached_input_tokens, cache_reports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(conversation_id, model, behavior,memory_kind) DO UPDATE SET
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
        measurement.model,
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
}

function count(row: unknown) {
  return Number((row as SqlRow | undefined)?.count ?? 0);
}

function parseObject(value: unknown) {
  const parsed = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored JSON value is not an object.");
  return parsed as JsonObject;
}

function setMetadata(database: DatabaseSync, key: string, value: string) {
  database.prepare(`
    INSERT INTO app_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function requestLogSqlFilter(
  node: RequestLogBusinessNode | undefined,
  memoryTool: RequestLogMemoryTool | undefined,
  query: string
) {
  const conditions: string[] = [];
  const parameters: string[] = [];
  if (query) {
    conditions.push("LOWER(data_json) LIKE ? ESCAPE '\\'");
    parameters.push(`%${escapeLike(query)}%`);
  }
  const nodeCondition = requestLogNodeCondition(node);
  if (nodeCondition) conditions.push(nodeCondition);
  const memoryAction = node === "memory_recording" && memoryTool === "working_memory"
    ? "add_workmemory"
    : node === "memory_recording" && memoryTool === "air"
      ? "read_air"
      : node === "memory_recording" && memoryTool === "user_profile"
        ? "add_user_profile"
        : "";
  if (memoryAction) {
    conditions.push("category = 'tool.call' AND action = ?");
    parameters.push(memoryAction);
  }
  return { conditions, parameters };
}

function requestLogNodeCondition(node: RequestLogBusinessNode | undefined) {
  const conversationId = "COALESCE(json_extract(data_json, '$.metadata.conversationId'), '')";
  const promptFamily = "COALESCE(json_extract(data_json, '$.metadata.promptFamily'), '')";
  const stage = "COALESCE(json_extract(data_json, '$.metadata.stage'), '')";
  const memoryKind = "COALESCE(json_extract(data_json, '$.metadata.memoryKind'), '')";
  const scope = "COALESCE(json_extract(data_json, '$.request.scope'), '')";
  const dream = `(action LIKE 'dream.%'
    OR ${promptFamily} = 'memory.dream'
    OR ${conversationId} LIKE 'dream:%')`;
  const memoryRecording = "(category = 'tool.call' AND action IN ('add_workmemory', 'read_air', 'add_user_profile'))";
  switch (node) {
    case "onebot_heartbeat":
      return "0";
    case "private_conversation":
      return `(${conversationId} LIKE '%:private:%'
        OR ${conversationId} LIKE 'private:%'
        OR ${conversationId} LIKE 'web:%'
        OR ${scope} = 'private'
        OR ${promptFamily} LIKE '%private%')`;
    case "group_conversation":
      return `(${conversationId} LIKE '%:group:%'
        OR ${conversationId} LIKE 'group:%'
        OR ${scope} = 'group'
        OR ${promptFamily} LIKE '%group%'
        OR ${stage} = 'orchestrator')`;
    case "memory_compression":
      return `(NOT ${dream}
        AND NOT ${memoryRecording}
        AND (${stage} = 'memory'
          OR ${memoryKind} <> ''
          OR (${promptFamily} LIKE 'memory.%' AND ${promptFamily} <> 'memory.dream')))`;
    case "memory_recording":
      return memoryRecording;
    case "dream":
      return dream;
    default:
      return "";
  }
}
