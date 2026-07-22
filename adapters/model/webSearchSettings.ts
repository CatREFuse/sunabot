import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { BotToolSettings } from "../../packages/contracts/admin/public.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";

export const DEFAULT_TAVILY_API_KEY_ENV = "TAVILY_API_KEY";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIRECT_API_KEY = /^[A-Za-z0-9._-]{16,512}$/;
type WebsearchSettings = BotToolSettings["websearch"];

export function isEnvironmentName(value: unknown) {
  return typeof value === "string" && ENVIRONMENT_NAME.test(value.trim());
}

export function looksLikeDirectApiKey(value: unknown) {
  return typeof value === "string" && DIRECT_API_KEY.test(value.trim()) && !isEnvironmentName(value);
}

export function normalizeTavilySettings(
  input: { tavilyApiKey?: unknown; tavilyApiKeys?: unknown; tavilyApiKeyEnv?: unknown },
  fallback: Pick<WebsearchSettings, "tavilyApiKey" | "tavilyApiKeys" | "tavilyApiKeyEnv">
) {
  const legacyKey = typeof input.tavilyApiKey === "string"
    ? input.tavilyApiKey.trim()
    : fallback.tavilyApiKey.trim();
  const inputKeys = Array.isArray(input.tavilyApiKeys)
    ? input.tavilyApiKeys.filter((value): value is string => typeof value === "string").map((value) => value.trim())
    : fallback.tavilyApiKeys ?? [];
  const rawEnv = typeof input.tavilyApiKeyEnv === "string"
    ? input.tavilyApiKeyEnv.trim()
    : fallback.tavilyApiKeyEnv;
  const tavilyApiKeys = uniqueKeys([...inputKeys, legacyKey]);

  if (isEnvironmentName(rawEnv)) {
    return { tavilyApiKey: "", tavilyApiKeys, tavilyApiKeyEnv: rawEnv };
  }
  if (looksLikeDirectApiKey(rawEnv)) tavilyApiKeys.push(rawEnv);
  return {
    tavilyApiKey: "",
    tavilyApiKeys: uniqueKeys(tavilyApiKeys),
    tavilyApiKeyEnv: isEnvironmentName(fallback.tavilyApiKeyEnv)
      ? fallback.tavilyApiKeyEnv
      : DEFAULT_TAVILY_API_KEY_ENV
  };
}

export function resolveTavilyApiKey(
  settings: Pick<WebsearchSettings, "tavilyApiKey" | "tavilyApiKeys" | "tavilyApiKeyEnv">,
  rootDir: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  return resolveTavilyApiKeys(settings, rootDir, environment)[0]
    ?? { value: "", source: "missing" as const };
}

export function resolveTavilyApiKeys(
  settings: Pick<WebsearchSettings, "tavilyApiKey" | "tavilyApiKeys" | "tavilyApiKeyEnv">,
  rootDir: string,
  environment: NodeJS.ProcessEnv = process.env
) {
  const credentials: Array<{ value: string; source: "direct" | "environment" | "project-env" }> = uniqueKeys([
    ...(settings.tavilyApiKeys ?? []),
    settings.tavilyApiKey
  ]).map((value) => ({ value, source: "direct" }));

  const inherited = String(environment[settings.tavilyApiKeyEnv] ?? "").trim();
  if (inherited) credentials.push({ value: inherited, source: "environment" });

  try {
    const parsed = dotenv.parse(fs.readFileSync(path.join(rootDir, WORKSPACE_LAYOUT.secretsEnv)));
    const projectValue = String(parsed[settings.tavilyApiKeyEnv] ?? "").trim();
    if (projectValue) credentials.push({ value: projectValue, source: "project-env" });
  } catch {
    // A missing or unreadable project env file is equivalent to an unset value.
  }
  const seen = new Set<string>();
  return credentials.filter((credential) => {
    if (!credential.value || seen.has(credential.value)) return false;
    seen.add(credential.value);
    return true;
  });
}

function uniqueKeys(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
