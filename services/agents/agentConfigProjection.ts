import type { BotConfig } from "../../packages/contracts/admin/public.js";

export function mergeManifestBotConfig(
  shared: BotConfig,
  manifest: BotConfig,
  defaultAgent: boolean
) {
  const bot = structuredClone(manifest);
  bot.tone = { ...structuredClone(shared.tone), ...structuredClone(bot.tone ?? {}) };
  bot.orchestrator = {
    ...structuredClone(shared.orchestrator),
    ...structuredClone(bot.orchestrator),
    groupThreadModel: defaultAgent
      ? shared.orchestrator.groupThreadModel
      : bot.orchestrator?.groupThreadModel?.trim() || shared.orchestrator.groupThreadModel
  };
  bot.bash = { ...structuredClone(shared.bash), ...structuredClone(bot.bash) };
  return bot;
}
