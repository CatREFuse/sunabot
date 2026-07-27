import type { BotConfig } from "../../packages/contracts/admin/public.js";

export function mergeManifestBotConfig(
  shared: BotConfig,
  manifest: BotConfig,
  defaultAgent: boolean
) {
  const bot = structuredClone(manifest);
  bot.replyModel = bot.replyModel?.trim() || shared.replyModel;
  bot.replyReasoningEffort = bot.replyReasoningEffort ?? shared.replyReasoningEffort;
  bot.imageReader = {
    ...structuredClone(shared.imageReader),
    ...structuredClone(bot.imageReader ?? {})
  };
  bot.tone = { ...structuredClone(shared.tone), ...structuredClone(bot.tone ?? {}) };
  bot.director = { ...structuredClone(shared.director), ...structuredClone(bot.director ?? {}) };
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
