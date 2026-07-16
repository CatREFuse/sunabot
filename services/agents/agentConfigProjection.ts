import type { BotConfig } from "../../src/types.js";

export function mergeManifestBotConfig(
  shared: BotConfig,
  manifest: BotConfig,
  defaultAgent: boolean
) {
  const bot = structuredClone(manifest);
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
