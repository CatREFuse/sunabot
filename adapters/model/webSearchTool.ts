import crypto from "node:crypto";
import { getWorkspaceDir } from "../../src/config.js";
import { appendRequestLog } from "../../src/requestLog.js";
import { BotConfig } from "../../src/types.js";
import { resolveTavilyApiKeys } from "./webSearchSettings.js";

export const WEBSEARCH_TOOL_NAME = "websearch";
export const WEBSEARCH_TIMEOUT_MS = 30_000;

const MAX_QUERY_LENGTH = 1_000;
const MAX_OUTPUT_CHARS = 16_000;
let activePoolSignature = "";
let activeCredentialIndex = 0;

export interface WebsearchInput {
  query?: unknown;
  maxResults?: unknown;
}

export interface WebsearchRunOptions {
  signal?: AbortSignal;
}

export const websearchTool = {
  type: "function",
  name: WEBSEARCH_TOOL_NAME,
  description: "Search the live web for current information. Returns titles, URLs, and concise result snippets.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "The web search query."
      },
      maxResults: {
        type: ["integer", "null"],
        description: "Maximum result count from 1 to 10. Use null for the configured default."
      }
    },
    required: ["query", "maxResults"]
  },
  strict: true
};

export async function runWebsearch(
  input: WebsearchInput,
  botConfig: BotConfig,
  options: WebsearchRunOptions = {}
) {
  const query = normalizeQuery(input.query);
  if (!query) {
    return { ok: false, error: "Search query is empty." };
  }

  const settings = botConfig.tools.websearch;
  const maxResults = normalizeMaxResults(input.maxResults, settings.maxResults);
  const result = await runTavilySearch(query, maxResults, settings, options.signal);

  await appendRequestLog({
    category: "tool.call",
    action: WEBSEARCH_TOOL_NAME,
    request: buildWebsearchRequestLog(query, maxResults),
    response: pickWebsearchLogResult(result)
  });
  return result;
}

async function runTavilySearch(
  query: string,
  maxResults: number,
  settings: BotConfig["tools"]["websearch"],
  signal?: AbortSignal
) {
  const credentials = resolveTavilyApiKeys(settings, getWorkspaceDir());
  if (!credentials.length) {
    return {
      ok: false,
      provider: "tavily",
      error: `Tavily API Key 未配置。请在管理台填写 API Key，或设置环境变量 ${settings.tavilyApiKeyEnv}。`
    };
  }

  const signature = credentialPoolSignature(credentials.map((credential) => credential.value));
  if (signature !== activePoolSignature) {
    activePoolSignature = signature;
    activeCredentialIndex = 0;
  }

  let lastError = "";
  const startIndex = activeCredentialIndex;
  for (let offset = 0; offset < credentials.length; offset += 1) {
    const index = (startIndex + offset) % credentials.length;
    const credential = credentials[index]!;
    let response: Response;
    try {
      response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.value}`
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: maxResults,
          include_raw_content: false
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS)])
          : AbortSignal.timeout(WEBSEARCH_TIMEOUT_MS)
      });
    } catch (error) {
      return { ok: false, provider: "tavily", error: `Tavily 请求失败：${errorMessage(error)}` };
    }
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      activeCredentialIndex = index;
      const results = Array.isArray(payload?.results) ? payload.results : [];
      return {
        ok: true,
        provider: "tavily",
        query,
        maxResults,
        credentialAttempts: offset + 1,
        answer: typeof payload?.answer === "string" ? payload.answer : "",
        results: results.slice(0, maxResults).map(toSearchResult)
      };
    }

    lastError = readTavilyError(payload) || tavilyStatusError(response.status);
    if (!isCredentialFailure(response.status)) {
      return { ok: false, provider: "tavily", error: lastError };
    }
    activeCredentialIndex = (index + 1) % credentials.length;
  }

  return {
    ok: false,
    provider: "tavily",
    credentialAttempts: credentials.length,
    error: credentials.length === 1 ? lastError : `全部 ${credentials.length} 个 Tavily Key 均不可用。${lastError}`
  };
}

function buildWebsearchRequestLog(query: string, maxResults: number) {
  return {
    provider: "tavily",
    method: "POST",
    url: "https://api.tavily.com/search",
    body: {
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_raw_content: false
    }
  };
}

function pickWebsearchLogResult(value: unknown) {
  const result = value as Record<string, unknown>;
  return {
    ok: result?.ok,
    provider: result?.provider,
    query: result?.query,
    maxResults: result?.maxResults,
    resultCount: Array.isArray(result?.results) ? result.results.length : undefined,
    contentLength: typeof result?.content === "string" ? result.content.length : undefined,
    error: result?.error
  };
}

function toSearchResult(value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    title: String(record.title ?? "").trim(),
    url: String(record.url ?? "").trim(),
    content: truncateOutput(String(record.content ?? "").trim(), 2_000),
    score: typeof record.score === "number" ? record.score : undefined,
    publishedDate: typeof record.published_date === "string" ? record.published_date : undefined
  };
}

function normalizeQuery(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

function normalizeMaxResults(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 10);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

function readTavilyError(payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const detail = record.detail ?? record.error ?? record.message;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const nested = detail as Record<string, unknown>;
    const message = nested.error ?? nested.message ?? nested.detail;
    if (typeof message === "string") return message;
  }
  return "";
}

function tavilyStatusError(status: number) {
  if (status === 401 || status === 403) return `Tavily API Key 无效或无权限（HTTP ${status}）。`;
  if (status === 429) return "Tavily 请求频率或额度已达上限（HTTP 429）。";
  return `Tavily 请求失败（HTTP ${status}）。`;
}

function isCredentialFailure(status: number) {
  return status === 401 || status === 403 || status === 429;
}

function credentialPoolSignature(values: readonly string[]) {
  return crypto.createHash("sha256").update(values.join("\0"), "utf8").digest("hex");
}

function truncateOutput(value: string, maxChars = MAX_OUTPUT_CHARS) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}
