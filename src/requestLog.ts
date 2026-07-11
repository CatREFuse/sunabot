import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkspacePath } from "./config.js";
import { applicationDatabasePath, applicationDataStore } from "../adapters/sqlite/applicationDataStore.js";

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

export function requestLogPath() {
  return applicationDatabasePath();
}

export async function appendRequestLog(entry: RequestLogEntry) {
  const record = sanitizeValue({
    id: randomUUID(),
    at: new Date().toISOString(),
    ...entry
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

  return requestLogStore().readRequestLogs({ query, limit });
}

function requestLogStore() {
  const store = applicationDataStore();
  store.ensureLegacyRequestLogsImported(getWorkspacePath("artifacts/request-bodies.jsonl"));
  return store;
}

function normalizeLimit(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 100;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 500);
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
