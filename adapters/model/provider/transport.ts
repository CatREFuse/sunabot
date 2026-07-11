import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import dotenv from "dotenv";
import type { ProviderConfig } from "../../../src/types.js";
import { getWorkspacePath, resolveProjectPath } from "../../../src/config.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";

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

export function createChatClient(provider: ProviderConfig, apiKey: string) {
  if (!apiKey) throw new Error(`Missing API key. Set ${provider.apiKeyEnv}.`);
  return new OpenAI({
    apiKey,
    baseURL: normalizeChatBaseUrl(provider),
    defaultHeaders: provider.kind === "gemini-openai"
      ? { "x-goog-api-client": "catrefuse-sunabot-oai/0.1.0" }
      : undefined
  });
}

export function resolveProviderApiKey(provider: ProviderConfig) {
  const envToken = inheritedProcessEnvironment[provider.apiKeyEnv];
  if (envToken) return envToken;
  const providerToken = readEnvValue(resolveProjectPath(provider.envFile), provider.apiKeyEnv);
  if (providerToken) return providerToken;
  const projectToken = readEnvValue(getWorkspacePath(WORKSPACE_LAYOUT.secretsEnv), provider.apiKeyEnv);
  if (projectToken) return projectToken;
  const runtimeToken = process.env[provider.apiKeyEnv];
  if (runtimeToken) return runtimeToken;
  if (provider.kind === "codex-responses") return resolveCodexAccessToken();
  return "";
}

export function normalizeOpenAiBaseUrl(baseUrl?: string) {
  const value = String(baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  return value.endsWith("/v1") ? value : `${value}/v1`;
}

export function normalizeChatBaseUrl(provider: ProviderConfig) {
  const fallback = provider.kind === "gemini-openai"
    ? "https://generativelanguage.googleapis.com/v1beta/openai"
    : "https://api.anthropic.com/v1";
  return String(provider.baseUrl || fallback).replace(/\/+$/, "");
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

export async function fetchWithSingleTransportRetry(
  input: string,
  init: RequestInit,
  signal?: AbortSignal
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (signal?.aborted || attempt === 1) throw error;
      await waitForTransportRetry(signal);
    }
  }
  throw new Error("transport retry exhausted");
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
  const authFile = process.env.OPEN_ARONA_CODEX_AUTH_FILE || path.join(process.env.CODEX_HOME || homedir(), ".codex/auth.json");
  try {
    const payload = JSON.parse(fs.readFileSync(expandHome(authFile), "utf8")) as { tokens?: { access_token?: string } };
    const token = String(payload.tokens?.access_token ?? "").trim();
    if (!token || isJwtExpired(token)) return "";
    return token;
  } catch {
    return "";
  }
}

function waitForTransportRetry(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 150);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
