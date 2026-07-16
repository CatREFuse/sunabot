import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import { resolveTavilyApiKeys } from "../../adapters/model/webSearchSettings.js";
import { getWorkspaceDir } from "../config.js";
import type { AppConfig } from "../types.js";
import { uniqueStrings } from "./configValidation.js";

export type ConfigApplyMode = "hot" | "reconnect" | "restart";

export type ConfigFieldStates = Record<string, {
  applyMode: ConfigApplyMode;
  secretConfigured?: boolean;
  secretCount?: number;
  storedSecretCount?: number;
}>;

export function configFieldStates(config: AppConfig): ConfigFieldStates {
  const states: ConfigFieldStates = { schemaVersion: { applyMode: "hot" } };
  addFieldStates(states, config.server, "server", "restart");
  addFieldStates(states, config.persona, "persona", "hot");
  addFieldStates(states, config.providers, "providers", "hot");
  addFieldStates(states, config.broadcastStorm, "broadcastStorm", "hot");
  addFieldStates(states, config.normalReply, "normalReply", "hot");
  addFieldStates(states, config.bot, "bot", "hot");
  addFieldStates(states, config.onebot, "onebot", "hot");

  states["onebot.reverseWsPath"] = { applyMode: "restart" };
  states["onebot.accessTokenEnv"] = {
    applyMode: "reconnect",
    secretConfigured: Boolean(process.env[config.onebot.accessTokenEnv])
  };
  const tavilyCredentials = resolveTavilyApiKeys(config.bot.tools.websearch, getWorkspaceDir());
  const storedTavilyKeys = uniqueStrings([
    ...(config.bot.tools.websearch.tavilyApiKeys ?? []),
    config.bot.tools.websearch.tavilyApiKey
  ]);
  states["bot.tools.websearch.tavilyApiKeyEnv"] = {
    applyMode: "hot",
    secretConfigured: tavilyCredentials.length > 0,
    secretCount: tavilyCredentials.length,
    storedSecretCount: storedTavilyKeys.length
  };
  states["bot.tools.websearch.tavilyApiKey"] = states["bot.tools.websearch.tavilyApiKeyEnv"]!;
  states["bot.tools.websearch.tavilyApiKeys"] = states["bot.tools.websearch.tavilyApiKeyEnv"]!;
  states["bot.tools.codex.maxConcurrency"] = { applyMode: "restart" };
  for (const [index, provider] of config.providers.items.entries()) {
    states[`providers.items.${provider.id}`] = { applyMode: "hot" };
    states[`providers.items.${provider.id}.apiKeyEnv`] = {
      applyMode: "hot",
      secretConfigured: new OpenAIProvider(provider).hasApiKey()
    };
    states[`providers.items.${index}.apiKeyEnv`] = states[`providers.items.${provider.id}.apiKeyEnv`]!;
  }
  return states;
}

function addFieldStates(
  states: ConfigFieldStates,
  value: unknown,
  prefix: string,
  applyMode: ConfigApplyMode
) {
  states[prefix] = { applyMode };
  if (Array.isArray(value)) {
    value.forEach((item, index) => addFieldStates(states, item, `${prefix}.${index}`, applyMode));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    addFieldStates(states, child, `${prefix}.${key}`, applyMode);
  }
}
