import type { ReasoningEffort } from "../../packages/contracts/admin/public.js";
import type { OpenAIProvider } from "../../adapters/model/openaiProvider.js";

interface ReplyProviderRuntime {
  config: {
    bot: {
      replyModel: string;
      replyReasoningEffort?: ReasoningEffort;
    };
  };
  getProviderForModel(model: string, effort?: ReasoningEffort): OpenAIProvider;
}

export function replyProvider(runtime: ReplyProviderRuntime) {
  return runtime.getProviderForModel(
    runtime.config.bot.replyModel,
    runtime.config.bot.replyReasoningEffort
  );
}
