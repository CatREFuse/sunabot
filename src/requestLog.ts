import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkspacePath } from "./config.js";
import { applicationDatabasePath, applicationDataStore } from "../adapters/sqlite/applicationDataStore.js";
import { WORKSPACE_LAYOUT } from "../packages/platform/workspaceLayout.js";
import {
  normalizeTokenUsageRecord,
  publicTokenUsage,
  sumTokenCounts,
  type TokenUsageMeasurement
} from "./tokenUsage.js";

const MAX_STRING_LENGTH = 16_000;

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
}

export interface ReadRequestLogPageOptions {
  query?: string;
  page?: number;
  pageSize?: number;
}

export function requestLogPath() {
  return applicationDatabasePath();
}

export async function appendRequestLog(entry: RequestLogEntry) {
  const usage = normalizeTokenUsageRecord(entry as unknown as Record<string, unknown>);
  const record = sanitizeValue({
    id: randomUUID(),
    at: new Date().toISOString(),
    ...entry,
    ...(usage ? { tokenUsage: publicTokenUsage(usage) } : {})
  });

  try {
    const store = requestLogStore();
    store.appendRequestLog(record as Record<string, unknown>);
  } catch (error) {
    console.error("[request-log] append failed", error);
  }
}

export async function readRequestLogs(options: ReadRequestLogsOptions = {}) {
  const limit = normalizeLimit(options.limit);
  const query = String(options.query ?? "").trim().toLowerCase();

  return requestLogStore().readRequestLogs({ query, limit }).map(withTokenUsage);
}

export async function readRequestLogPage(options: ReadRequestLogPageOptions = {}) {
  const page = normalizePositiveInteger(options.page, 1, 100_000);
  const pageSize = normalizePositiveInteger(options.pageSize, 50, 100);
  const query = String(options.query ?? "").trim().toLowerCase();
  const result = requestLogStore().readRequestLogPage({ query, page, pageSize });
  return { ...result, logs: result.logs.map(withTokenUsage) };
}

export function readTokenUsageSummary(timezoneOffsetMinutes = 0) {
  const offset = normalizeTimezoneOffset(timezoneOffsetMinutes);
  const now = Date.now();
  const localNow = new Date(now - offset * 60_000);
  const today = localNow.toISOString().slice(0, 10);
  const since = new Date(now - 371 * 86_400_000).toISOString();
  const dayTotals = new Map<string, TokenUsageAccumulator>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyUsageAccumulator() }));

  for (const record of requestLogStore().readTokenUsageRecords(since)) {
    const usage = normalizeTokenUsageRecord(record);
    if (!usage) continue;
    const timestamp = Date.parse(String(record.at ?? ""));
    if (!Number.isFinite(timestamp)) continue;
    const local = new Date(timestamp - offset * 60_000);
    const date = local.toISOString().slice(0, 10);
    const day = dayTotals.get(date) ?? emptyUsageAccumulator();
    addUsage(day, usage);
    dayTotals.set(date, day);
    if (date === today) addUsage(hours[local.getUTCHours()]!, usage);
  }

  return {
    today: { date: today, ...usageBucket(dayTotals.get(today) ?? emptyUsageAccumulator()) },
    days: [...dayTotals].map(([date, usage]) => ({ date, ...usageBucket(usage) })),
    hours: hours.map(({ hour, ...usage }) => ({ hour, ...usageBucket(usage) }))
  };
}

function requestLogStore() {
  const store = applicationDataStore();
  store.ensureLegacyRequestLogsImported(getWorkspacePath(WORKSPACE_LAYOUT.legacyData, "request-bodies.jsonl"));
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
  target.requests = sumTokenCounts(target.requests, 1);
  if (usage.cacheReported) {
    target.measuredInput = sumTokenCounts(target.measuredInput, usage.input);
    target.measuredCachedInput = sumTokenCounts(target.measuredCachedInput, usage.cachedInput);
    target.cacheReports = sumTokenCounts(target.cacheReports, 1);
  }
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

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MaxDepth]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value !== "object" || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeValue(child, depth + 1);
  }
  return output;
}

function sanitizeString(value: string) {
  const dataImageMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i);
  if (dataImageMatch) {
    return `[image data url: ${dataImageMatch[1]}, base64Chars=${dataImageMatch[2]?.length ?? 0}]`;
  }

  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|access[_-]?token|authorization)=([^&\s]+)/gi, "$1=[REDACTED]");

  if (redacted.length <= MAX_STRING_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_STRING_LENGTH)}\n[truncated:${redacted.length - MAX_STRING_LENGTH}]`;
}

function isSecretKey(key: string) {
  return /^(authorization|apiKey|api_key|accessToken|access_token|token|password|secret)$/i.test(key);
}
