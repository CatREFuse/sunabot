import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkspacePath } from "./config.js";
import type { AppConfig } from "./types.js";
import {
  applicationDatabasePath,
  applicationDataStore,
  type ModelCallAggregateRow,
  type ModelCallModelAggregateRow
} from "../adapters/sqlite/applicationDataStore.js";
import { WORKSPACE_LAYOUT } from "../packages/platform/workspaceLayout.js";
import {
  memoryModelCallKindIds,
  modelCallMeasurement,
  modelCallBehaviorIds,
  type MemoryModelCallKindId,
  type ModelCallBehaviorId
} from "./modelCallStats.js";
import {
  normalizeTokenUsageRecord,
  publicTokenUsage,
  sumTokenCounts,
  type TokenUsageMeasurement
} from "./tokenUsage.js";

const MAX_STRING_LENGTH = 16_000;
const MAX_MODEL_PAYLOAD_STRING_LENGTH = 8 * 1024 * 1024;

export interface RequestLogEntry {
  category: string;
  action: string;
  providerId?: string;
  providerKind?: string;
  model?: string;
  request?: unknown;
  response?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ReadRequestLogsOptions {
  query?: string;
  limit?: number;
  config?: Pick<AppConfig, "persona">;
}

export interface ReadRequestLogPageOptions {
  query?: string;
  page?: number;
  pageSize?: number;
  config?: Pick<AppConfig, "persona">;
}

export { memoryModelCallKindIds, modelCallBehaviorIds } from "./modelCallStats.js";
export type { MemoryModelCallKindId, ModelCallBehaviorId } from "./modelCallStats.js";

export interface ReadModelCallStatsOptions {
  conversationId?: string;
  config?: Pick<AppConfig, "persona">;
  configs?: Array<Pick<AppConfig, "persona">>;
}

export interface ReadTokenUsageSummaryOptions {
  model?: string;
  behavior?: ModelCallBehaviorId | "";
  config?: Pick<AppConfig, "persona">;
  configs?: Array<Pick<AppConfig, "persona">>;
}

export const unlabeledTokenUsageModel = "__unlabeled__";

export function requestLogPath(config?: Pick<AppConfig, "persona">) {
  return applicationDatabasePath(config);
}

export async function appendRequestLog(entry: RequestLogEntry) {
  const record = requestLogRecord(entry, randomUUID());

  try {
    const store = requestLogStore();
    store.appendRequestLog(record as Record<string, unknown>);
  } catch (error) {
    console.error("[request-log] append failed", error);
  }
}

export async function appendRequestLogStrict(entry: RequestLogEntry, idempotencyKey: string) {
  const key = typeof idempotencyKey === "string" ? idempotencyKey.trim() : "";
  if (!key) throw new Error("idempotencyKey is required.");
  return requestLogStore().appendRequestLogIdempotent(requestLogRecord(entry, key) as Record<string, unknown>);
}

function requestLogRecord(entry: RequestLogEntry, id: string) {
  const usage = normalizeTokenUsageRecord(entry as unknown as Record<string, unknown>);
  const maxStringLength = entry.category === "model.request" || entry.category === "model.response"
    ? MAX_MODEL_PAYLOAD_STRING_LENGTH
    : MAX_STRING_LENGTH;
  return sanitizeValue({
    id,
    at: new Date().toISOString(),
    ...entry,
    ...(usage ? { tokenUsage: publicTokenUsage(usage) } : {})
  }, 0, maxStringLength);
}

export async function readRequestLogs(options: ReadRequestLogsOptions = {}) {
  const limit = normalizeLimit(options.limit);
  const query = String(options.query ?? "").trim().toLowerCase();

  return requestLogStore(options.config).readRequestLogs({ query, limit }).map(withTokenUsage);
}

export async function readRequestLogPage(options: ReadRequestLogPageOptions = {}) {
  const page = normalizePositiveInteger(options.page, 1, 100_000);
  const pageSize = normalizePositiveInteger(options.pageSize, 50, 100);
  const query = String(options.query ?? "").trim().toLowerCase();
  const result = requestLogStore(options.config).readRequestLogPage({ query, page, pageSize });
  return { ...result, logs: result.logs.map(withTokenUsage) };
}

export function readTokenUsageSummary(
  timezoneOffsetMinutes = 0,
  options: ReadTokenUsageSummaryOptions = {}
) {
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  const selectedModel = String(options.model ?? "").trim();
  const selectedBehavior = normalizeBehaviorFilter(options.behavior);
  const now = Date.now();
  const localNow = new Date(now - offset * 60_000);
  const today = localNow.toISOString().slice(0, 10);
  const since = new Date(now - 371 * 86_400_000).toISOString();
  const dayTotals = new Map<string, TokenUsageAccumulator>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyUsageAccumulator() }));
  const models = new Set<string>();

  const records = (options.configs?.length ? options.configs : [options.config])
    .flatMap((config) => requestLogStore(config).readTokenUsageRecords(since));
  for (const record of records) {
    const measurement = modelCallMeasurement(record);
    const model = measurement?.model || unlabeledTokenUsageModel;
    models.add(model);
    if (selectedModel && model !== selectedModel) continue;
    if (selectedBehavior && measurement?.behavior !== selectedBehavior) continue;
    const timestamp = Date.parse(String(record.at ?? ""));
    if (!Number.isFinite(timestamp)) continue;
    const local = new Date(timestamp - offset * 60_000);
    const date = local.toISOString().slice(0, 10);
    const day = dayTotals.get(date) ?? emptyUsageAccumulator();
    day.requests = sumTokenCounts(day.requests, 1);
    const usage = normalizeTokenUsageRecord(record);
    if (usage) addUsage(day, usage);
    dayTotals.set(date, day);
    if (date === today) {
      const hour = hours[local.getUTCHours()]!;
      hour.requests = sumTokenCounts(hour.requests, 1);
      if (usage) addUsage(hour, usage);
    }
  }

  return {
    today: { date: today, ...usageBucket(dayTotals.get(today) ?? emptyUsageAccumulator()) },
    days: [...dayTotals].map(([date, usage]) => ({ date, ...usageBucket(usage) })),
    hours: hours.map(({ hour, ...usage }) => ({ hour, ...usageBucket(usage) })),
    filters: {
      models: [...models].sort((left, right) => {
        if (left === unlabeledTokenUsageModel) return 1;
        if (right === unlabeledTokenUsageModel) return -1;
        return left.localeCompare(right);
      }),
      model: selectedModel,
      behavior: selectedBehavior
    }
  };
}

export function readModelCallStats(options: ReadModelCallStatsOptions = {}) {
  const conversationId = String(options.conversationId ?? "").trim();
  const stores = (options.configs?.length ? options.configs : [options.config]).map((config) => requestLogStore(config));
  const summary = aggregateModelCallRows(stores.flatMap((store) => store.readModelCallAggregateRows(conversationId)));
  const modelRows = stores.flatMap((store) => store.readModelCallModelAggregateRows(conversationId)).map((row) => ({
    ...row,
    model: row.model || unlabeledTokenUsageModel
  }));
  const models = [...new Set(modelRows.map((row) => row.model))]
    .map((model) => ({ model, ...aggregateModelCallRows(modelRows.filter((row) => row.model === model)) }))
    .sort((left, right) => right.total.total - left.total.total || left.model.localeCompare(right.model));

  return {
    conversationId: conversationId || null,
    ...summary,
    models
  };
}

function aggregateModelCallRows(rows: Array<ModelCallAggregateRow | ModelCallModelAggregateRow>) {
  const total = emptyUsageAccumulator();
  const behavior = Object.fromEntries(
    modelCallBehaviorIds.map((id) => [id, emptyUsageAccumulator()])
  ) as Record<ModelCallBehaviorId, TokenUsageAccumulator>;
  const memory = Object.fromEntries(
    memoryModelCallKindIds.map((id) => [id, emptyUsageAccumulator()])
  ) as Record<MemoryModelCallKindId, TokenUsageAccumulator>;

  for (const row of rows) {
    addAggregate(total, row);
    addAggregate(behavior[row.behavior], row);
    if (row.behavior === "memory" && row.memoryKind) addAggregate(memory[row.memoryKind], row);
  }

  return {
    total: usageBucket(total),
    behavior: Object.fromEntries(modelCallBehaviorIds.map((id) => [id, usageBucket(behavior[id])])),
    memory: {
      total: usageBucket(behavior.memory),
      kinds: Object.fromEntries(memoryModelCallKindIds.map((id) => [id, usageBucket(memory[id])]))
    }
  };
}

function requestLogStore(config?: Pick<AppConfig, "persona">) {
  const store = applicationDataStore(config);
  if (!config || config.persona.defaultAgentId === "plana") {
    store.ensureLegacyRequestLogsImported(getWorkspacePath(WORKSPACE_LAYOUT.legacyData, "request-bodies.jsonl"));
  }
  return store;
}

function normalizeLimit(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 100;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 500);
}

function normalizePositiveInteger(value: unknown, fallback: number, maximum: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), 1), maximum);
}

function normalizeTimezoneOffset(value: unknown) {
  const offset = Number(value);
  return Number.isFinite(offset) ? Math.min(Math.max(Math.trunc(offset), -840), 840) : 0;
}

function normalizeBehaviorFilter(value: unknown): ModelCallBehaviorId | "" {
  const behavior = String(value ?? "");
  return modelCallBehaviorIds.includes(behavior as ModelCallBehaviorId)
    ? behavior as ModelCallBehaviorId
    : "";
}

interface TokenUsageAccumulator {
  input: number;
  output: number;
  total: number;
  cachedInput: number;
  requests: number;
  measuredInput: number;
  measuredCachedInput: number;
  cacheReports: number;
}

function emptyUsageAccumulator(): TokenUsageAccumulator {
  return {
    input: 0,
    output: 0,
    total: 0,
    cachedInput: 0,
    requests: 0,
    measuredInput: 0,
    measuredCachedInput: 0,
    cacheReports: 0
  };
}

function addUsage(target: TokenUsageAccumulator, usage: TokenUsageMeasurement) {
  target.input = sumTokenCounts(target.input, usage.input);
  target.output = sumTokenCounts(target.output, usage.output);
  target.total = sumTokenCounts(target.total, usage.total);
  target.cachedInput = sumTokenCounts(target.cachedInput, usage.cachedInput);
  if (usage.cacheReported) {
    target.measuredInput = sumTokenCounts(target.measuredInput, usage.input);
    target.measuredCachedInput = sumTokenCounts(target.measuredCachedInput, usage.cachedInput);
    target.cacheReports = sumTokenCounts(target.cacheReports, 1);
  }
}

function addAggregate(target: TokenUsageAccumulator, row: ModelCallAggregateRow) {
  target.input = sumTokenCounts(target.input, row.input);
  target.output = sumTokenCounts(target.output, row.output);
  target.total = sumTokenCounts(target.total, row.total);
  target.cachedInput = sumTokenCounts(target.cachedInput, row.cachedInput);
  target.requests = sumTokenCounts(target.requests, row.requests);
  target.measuredInput = sumTokenCounts(target.measuredInput, row.measuredInput);
  target.measuredCachedInput = sumTokenCounts(target.measuredCachedInput, row.measuredCachedInput);
  target.cacheReports = sumTokenCounts(target.cacheReports, row.cacheReports);
}

function usageBucket(usage: TokenUsageAccumulator) {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cachedInput: usage.cachedInput,
    cacheRate: usage.cacheReports > 0
      ? usage.measuredInput > 0
        ? Math.min(Math.max(usage.measuredCachedInput / usage.measuredInput, 0), 1)
        : 0
      : null,
    requests: usage.requests
  };
}

function withTokenUsage(record: Record<string, unknown>) {
  const usage = normalizeTokenUsageRecord(record);
  return usage ? { ...record, tokenUsage: publicTokenUsage(usage) } : record;
}

function sanitizeValue(value: unknown, depth = 0, maxStringLength = MAX_STRING_LENGTH): unknown {
  if (depth > 12) return "[MaxDepth]";
  if (typeof value === "string") return sanitizeString(value, maxStringLength);
  if (typeof value !== "object" || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1, maxStringLength));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeValue(child, depth + 1, maxStringLength);
  }
  return output;
}

function sanitizeString(value: string, maxStringLength: number) {
  const dataImageMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
  if (dataImageMatch) {
    return `[image data url: ${dataImageMatch[1]}, base64Chars=${dataImageMatch[2]?.length ?? 0}]`;
  }

  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&]key)=([^&#\s]+)/gi, "$1=[REDACTED]")
    .replace(/(api[_-]?key|access[_-]?token|authorization)=([^&\s]+)/gi, "$1=[REDACTED]");

  if (redacted.length <= maxStringLength) return redacted;
  return `${redacted.slice(0, maxStringLength)}\n[truncated:${redacted.length - maxStringLength}]`;
}

function isSecretKey(key: string) {
  return /^(authorization|apiKey|api_key|accessToken|access_token|token|password|secret)$/i.test(key);
}
