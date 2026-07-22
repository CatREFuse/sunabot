import type { FastifyInstance } from "fastify";
import { AdminApiError } from "../../src/admin/errors.js";
import type { AgentConfigService } from "../../src/admin/agentConfigService.js";
import type { ConfigService } from "../../src/admin/configService.js";
import { EmojiLibraryRepository } from "../../src/admin/emojiLibrary.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { AppConfig, BotConfig, EmojiSendSize } from "../../packages/contracts/admin/public.js";
import { registerEmojiRoutes } from "./plugins/emojiRoutes.js";

export function registerAgentEmojiApi(
  app: FastifyInstance,
  options: {
    getConfig(): AppConfig;
    runtime: SunaRuntime;
    getRuntime(agentId: string): SunaRuntime;
    configService: Pick<ConfigService, "readEnvelope" | "patch">;
    agentConfigService: Pick<AgentConfigService, "readEnvelope" | "patch">;
  }
) {
  const repositories = new Map<string, EmojiLibraryRepository>();
  const runtimeFor = (agentId: string) => {
    try {
      return options.getRuntime(agentId);
    } catch {
      throw new AdminApiError(409, "EMOJI_AGENT_UNAVAILABLE", "Agent 尚未就绪。");
    }
  };
  const repositoryFor = (agentId: string) => {
    const existing = repositories.get(agentId);
    if (existing) return existing;
    const repository = new EmojiLibraryRepository({
      getConfig: () => agentId === options.getConfig().persona.defaultAgentId
        ? options.getConfig()
        : runtimeFor(agentId).config
    });
    repositories.set(agentId, repository);
    return repository;
  };
  const configEnvelopeFor = (agentId: string) => (
    agentId === options.runtime.config.persona.defaultAgentId
      ? options.configService.readEnvelope()
      : options.agentConfigService.readEnvelope(agentId)
  );
  registerEmojiRoutes(app, {
    repository: repositoryFor(options.runtime.config.persona.defaultAgentId),
    getRepository: repositoryFor,
    getConfig: options.getConfig,
    runtime: options.runtime,
    getAgentContext: (agentId) => {
      const runtime = runtimeFor(agentId);
      return { config: runtime.config, runtime };
    },
    settings: {
      read: async (agentId) => {
        const envelope = await configEnvelopeFor(agentId);
        return emojiSettings(envelope.config.bot, envelope.revision);
      },
      update: async (agentId, input) => {
        const envelope = await configEnvelopeFor(agentId);
        const value = botSectionValue(envelope.config.bot, input.sendSize, input.sendSeparately);
        const updated = agentId === options.runtime.config.persona.defaultAgentId
          ? await options.configService.patch("bot", { revision: input.revision, value })
          : await options.agentConfigService.patch(agentId, "bot", { revision: input.revision, value });
        return emojiSettings(updated.config.bot, updated.revision);
      }
    }
  });
}

function emojiSettings(bot: BotConfig, revision: string) {
  return {
    sendSize: bot.emojiSendSize,
    sendSeparately: bot.emojiSendSeparately,
    revision
  };
}

function botSectionValue(bot: BotConfig, emojiSendSize: EmojiSendSize, emojiSendSeparately: boolean) {
  return {
    adminQq: bot.adminQq,
    adminName: bot.adminName,
    replyDebounceMs: bot.replyDebounceMs,
    pokeOnNoReply: bot.pokeOnNoReply,
    quoteGroupReplies: bot.quoteGroupReplies,
    quoteGroupReplyExcludedUserIds: [...bot.quoteGroupReplyExcludedUserIds],
    contextMessageLimit: bot.contextMessageLimit,
    emojiSendSize,
    emojiSendSeparately
  };
}
