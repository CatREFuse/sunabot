import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import dotenv from "dotenv";
import type { ProviderConfig } from "../../../packages/contracts/admin/public.js";
import { getWorkspacePath, resolveProjectPath } from "../../../packages/platform/projectPaths.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { ensureCodexAccessToken } from "../../../packages/platform/codexTokenRefresh.mjs";

const inheritedProcessEnvironment = { ...process.env };

export function createResponsesClient(
  provider: ProviderConfig,
  apiKey: string,
  options: { maxRetries?: number } = {}
) {
  if (!apiKey) throw new Error(`Missing API key. Set ${provider.apiKeyEnv}.`);
  return new OpenAI({
    apiKey,
    baseURL: normalizeOpenAiBaseUrl(provider.baseUrl),
    ...options
  });
}

export function createChatClient(
  provider: ProviderConfig,
  apiKey: string,
  options: { maxRetries?: number } = {}
) {
  if (!apiKey) throw new Error(`Missing API key. Set ${provider.apiKeyEnv}.`);
  return new OpenAI({
    apiKey,
    baseURL: normalizeChatBaseUrl(provider),
    defaultHeaders: undefined,
    ...options
  });
}

export function resolveProviderApiKey(provider: ProviderConfig) {
  const configuredToken = resolveConfiguredProviderApiKey(provider);
  if (configuredToken) return configuredToken;
  if (provider.kind === "codex-responses") return resolveCodexAccessToken();
  return "";
}

function resolveConfiguredProviderApiKey(provider: ProviderConfig) {
  const envToken = inheritedProcessEnvironment[provider.apiKeyEnv];
  if (envToken) return envToken;
  const providerToken = readEnvValue(resolveProjectPath(provider.envFile), provider.apiKeyEnv);
  if (providerToken) return providerToken;
  const projectToken = readEnvValue(getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv), provider.apiKeyEnv);
  if (projectToken) return projectToken;
  const runtimeToken = process.env[provider.apiKeyEnv];
  if (runtimeToken) return runtimeToken;
  return "";
}

export async function resolveProviderApiKeyAsync(provider: ProviderConfig) {
  const configuredToken = resolveConfiguredProviderApiKey(provider);
  if (configuredToken || provider.kind !== "codex-responses") return configuredToken;
  const authFile = resolveCodexAuthFile();
  try {
    return await ensureCodexAccessToken({
      authFile,
      codexHome: path.dirname(authFile)
    });
  } catch {
    return "";
  }
}

export function normalizeOpenAiBaseUrl(baseUrl?: string) {
  const value = String(baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

export function normalizeChatBaseUrl(provider: ProviderConfig) {
  return String(provider.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function normalizeAnthropicBaseUrl(baseUrl?: string) {
  const value = String(baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

export function normalizeGeminiBaseUrl(baseUrl?: string) {
  const value = String(baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  return /\/v\d+(?:beta\d*)?$/.test(value) ? value : `${value}/v1beta`;
}

export function normalizeCodexResponsesUrl(baseUrl?: string) {
  const value = String(baseUrl || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
  return value.endsWith("/responses") ? value : `${value}/responses`;
}

export function codexBackendHeaders(accessToken: string) {
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0 (Sunabot)",
    originator: "codex_cli_rs"
  };
  const claims = decodeJwtClaims(accessToken);
  const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId === "string" && accountId.trim()) {
    headers["ChatGPT-Account-ID"] = accountId.trim();
  }
  return headers;
}

interface TransportRetryContext {
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
  status?: number;
  retryDelayMs: number;
}

interface TransportResponseFailure {
  error: unknown;
  retryable: boolean;
}

interface TransportRetryObserver {
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  beforeAttempt?(context: { attempt: number; maxAttempts: number }): unknown | Promise<unknown>;
  attemptFailed?(error: unknown, context: TransportRetryContext): unknown | Promise<unknown>;
  classifyResponseFailure?(response: Response, text: string): TransportResponseFailure | undefined;
}

export const PROVIDER_TRANSPORT_ATTEMPT_TIMEOUT_MS = 60_000;

export async function fetchTextWithTransportRetry(
  input: string,
  init: RequestInit,
  signal?: AbortSignal,
  observer: TransportRetryObserver = {}
) {
  const maxAttempts = normalizeMaxAttempts(observer.maxAttempts, 2);
  const attemptTimeoutMs = normalizeAttemptTimeout(observer.attemptTimeoutMs);
  const callerSignal = signal ?? init.signal ?? undefined;
  for (let index = 0; index < maxAttempts; index += 1) {
    const attempt = index + 1;
    assertRequestNotAborted(callerSignal);
    await observer.beforeAttempt?.({ attempt, maxAttempts });
    let response: Response | undefined;
    let text: string;
    const attemptController = new AbortController();
    const attemptSignal = callerSignal
      ? AbortSignal.any([callerSignal, attemptController.signal])
      : attemptController.signal;
    const attemptTimer = setTimeout(() => {
      const error = new Error(`Provider transport attempt timed out after ${attemptTimeoutMs}ms`);
      error.name = "TimeoutError";
      attemptController.abort(error);
    }, attemptTimeoutMs);
    try {
      response = await abortable(fetch(input, { ...init, signal: attemptSignal }), attemptSignal);
      text = await abortable(response.text(), attemptSignal);
    } catch (error) {
      clearTimeout(attemptTimer);
      const willRetry = !callerSignal?.aborted && attempt < maxAttempts;
      const retryDelayMs = willRetry ? resolveRetryDelayMs(response?.headers, attempt) : 0;
      await observer.attemptFailed?.(error, {
        attempt,
        maxAttempts,
        willRetry,
        ...(response ? { status: response.status } : {}),
        retryDelayMs
      });
      if (!willRetry) throw error;
      await waitForRetry(retryDelayMs, callerSignal);
      continue;
    } finally {
      clearTimeout(attemptTimer);
    }

    const responseFailure = observer.classifyResponseFailure?.(response, text);
    if (responseFailure) {
      const willRetry = !callerSignal?.aborted && attempt < maxAttempts && responseFailure.retryable;
      const retryDelayMs = willRetry ? resolveRetryDelayMs(response.headers, attempt) : 0;
      await observer.attemptFailed?.(responseFailure.error, {
        attempt,
        maxAttempts,
        willRetry,
        status: response.status,
        retryDelayMs
      });
      if (!willRetry) throw responseFailure.error;
      await waitForRetry(retryDelayMs, callerSignal);
      continue;
    }

    const willRetry = !callerSignal?.aborted
      && attempt < maxAttempts
      && retryableTransportStatus(response.status);
    if (willRetry) {
      const retryDelayMs = resolveRetryDelayMs(response.headers, attempt);
      await observer.attemptFailed?.(new Error(`Provider request failed: ${response.status}`), {
        attempt,
        maxAttempts,
        willRetry: true,
        status: response.status,
        retryDelayMs
      });
      await waitForRetry(retryDelayMs, callerSignal);
      continue;
    }

    return { response, text, attempt, maxAttempts };
  }
  throw new Error("transport retry exhausted");
}

export function resolveModelRequestMaxAttempts(maxRetries: unknown, defaultRetries: number) {
  const retries = Number.isSafeInteger(maxRetries) && Number(maxRetries) >= 0 && Number(maxRetries) <= 10
    ? Number(maxRetries)
    : defaultRetries;
  return retries + 1;
}

function normalizeMaxAttempts(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 11
    ? Number(value)
    : fallback;
}

function normalizeAttemptTimeout(value: unknown) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0
    ? Math.trunc(timeout)
    : PROVIDER_TRANSPORT_ATTEMPT_TIMEOUT_MS;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function readEnvValue(filePath: string | undefined, key: string) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    return dotenv.parse(fs.readFileSync(filePath))[key]?.trim() ?? "";
  } catch {
    return "";
  }
}

function resolveCodexAccessToken() {
  const authFile = resolveCodexAuthFile();
  try {
    const payload = JSON.parse(fs.readFileSync(authFile, "utf8")) as { tokens?: { access_token?: string } };
    const token = String(payload.tokens?.access_token ?? "").trim();
    if (!token || isJwtExpired(token)) return "";
    return token;
  } catch {
    return "";
  }
}

function resolveCodexAuthFile() {
  const configured = process.env.OPEN_ARONA_CODEX_AUTH_FILE?.trim();
  if (!configured) return getWorkspacePath(WORKSPACE_LAYOUT.codexHome, "auth.json");
  const expanded = expandHome(configured);
  if (path.isAbsolute(expanded)) return expanded;
  return resolveProjectPath(expanded) ?? path.resolve(expanded);
}

export function assertRequestNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
}

export function resolveRetryDelayMs(source: unknown, attempt: number) {
  const retryAfterMs = readHeader(source, "retry-after-ms");
  if (retryAfterMs != null) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return boundedRetryDelay(parsed);
  }

  const retryAfter = readHeader(source, "retry-after");
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return boundedRetryDelay(seconds * 1_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return boundedRetryDelay(Math.max(0, at - Date.now()));
  }

  return 150 * Math.max(1, attempt);
}

export async function waitForRetry(delayMs: number, signal?: AbortSignal) {
  assertRequestNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryableTransportStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function readHeader(source: unknown, name: string) {
  const headers = source instanceof Headers
    ? source
    : source && typeof source === "object" && "headers" in source
      ? (source as { headers?: unknown }).headers
      : source;
  if (headers instanceof Headers) return headers.get(name);
  if (!headers || typeof headers !== "object") return undefined;
  const entry = Object.entries(headers as Record<string, unknown>)
    .find(([key]) => key.toLowerCase() === name);
  return entry?.[1] == null ? undefined : String(entry[1]);
}

function boundedRetryDelay(value: number) {
  return Math.min(Math.max(Math.ceil(value), 0), 60_000);
}

function expandHome(inputPath: string) {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
  return inputPath;
}

function decodeJwtClaims(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function isJwtExpired(token: string) {
  const exp = decodeJwtClaims(token).exp;
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(Date.now() / 1000);
}
