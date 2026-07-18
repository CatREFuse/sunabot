import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import type { AppConfig } from "../../src/types.js";
import { PROMPT_FILE_DEFINITIONS } from "../agent/public.js";
import type { AgentManifest } from "./agentRegistry.js";
import type { AgentConfigImportPlan, AgentConfigImportRules } from "./agentConfigImport.js";
import { sharedSystemPromptConfig } from "./agentPromptFiles.js";

export function agentConfigImportRules(shared: AppConfig): AgentConfigImportRules {
  const sharedSystemConfig = sharedSystemPromptConfig(shared);
  return {
    finalPromptFiles: PROMPT_FILE_DEFINITIONS
      .filter((definition) => definition.scope === "persona" && definition.kind === "final")
      .map((definition) => definition.fileName(shared)),
    systemPromptFiles: PROMPT_FILE_DEFINITIONS
      .filter((definition) => definition.scope === "system")
      .map((definition) => definition.fileName(sharedSystemConfig))
  };
}

export function applyAgentConfigImportManifest(
  base: AgentManifest,
  value: unknown,
  plan: AgentConfigImportPlan
): AgentManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new ServiceError(400, "AGENT_IMPORT_MANIFEST_INVALID", "Agent 配置文件无效。");
  }
  const prompts = isRecord(value.prompts) ? value.prompts : {};
  const hasSystemPrompts = plan.included.some((fileName) => fileName.startsWith("system-prompts/"));
  const bot = mergeKnownConfig(base.bot, isRecord(value.bot) ? value.bot : {});
  bot.adminQq = base.bot.adminQq;
  bot.adminName = base.bot.adminName;
  bot.tools.websearch.tavilyApiKey = base.bot.tools.websearch.tavilyApiKey;
  bot.tools.websearch.tavilyApiKeys = structuredClone(base.bot.tools.websearch.tavilyApiKeys);
  bot.tools.websearch.tavilyApiKeyEnv = base.bot.tools.websearch.tavilyApiKeyEnv;
  return {
    ...base,
    prompts: { overrideSystem: prompts.overrideSystem === true && hasSystemPrompts },
    bot,
    onebot: mergeKnownConfig(base.onebot, isRecord(value.onebot) ? value.onebot : {})
  };
}

export function importedAgentAvatarPath(plan: AgentConfigImportPlan) {
  return plan.included.find((fileName) => /^assets\/avatar\.(?:png|jpg|webp)$/.test(fileName));
}

function mergeKnownConfig<T>(base: T, imported: unknown): T {
  if (Array.isArray(base)) {
    if (!Array.isArray(imported)) return structuredClone(base);
    return [...new Set(imported
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item && item.length <= 512)
      .slice(0, 100))] as T;
  }
  if (isRecord(base)) {
    if (!isRecord(imported)) return structuredClone(base);
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) {
      merged[key] = mergeKnownConfig(value, imported[key]);
    }
    return merged as T;
  }
  if (typeof base === "string") {
    return (typeof imported === "string" && imported.length <= 4_096 ? imported : base) as T;
  }
  if (typeof base === "number") {
    return (typeof imported === "number" && Number.isFinite(imported) ? imported : base) as T;
  }
  if (typeof base === "boolean") return (typeof imported === "boolean" ? imported : base) as T;
  return structuredClone(base);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
