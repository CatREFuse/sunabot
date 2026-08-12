import type { BotConfig } from "../../packages/contracts/admin/public.js";

export function mergeManifestBotConfig(
  shared: BotConfig,
  manifest: BotConfig,
  _defaultAgent: boolean
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
  const orchestrator = {
    ...structuredClone(shared.orchestrator),
    ...structuredClone(bot.orchestrator)
  };
  bot.orchestrator = {
    enabled: orchestrator.enabled,
    userGroupchatOrchestratorModel: orchestrator.userGroupchatOrchestratorModel,
    reasoningEffort: orchestrator.reasoningEffort,
    promptFile: orchestrator.promptFile,
    messageThreshold: orchestrator.messageThreshold,
    recentMessageWindowMs: orchestrator.recentMessageWindowMs
  };
  bot.bash = { ...structuredClone(shared.bash), ...structuredClone(bot.bash) };
  return bot;
}
