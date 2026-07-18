import type { FastifyInstance } from "fastify";
import { AdminApiError } from "../../src/admin/errors.js";
import { EmojiLibraryRepository } from "../../src/admin/emojiLibrary.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { AppConfig } from "../../src/types.js";
import { registerEmojiRoutes } from "./plugins/emojiRoutes.js";

export function registerAgentEmojiApi(
  app: FastifyInstance,
  options: {
    getConfig(): AppConfig;
    runtime: SunaRuntime;
    getRuntime(agentId: string): SunaRuntime;
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
  registerEmojiRoutes(app, {
    repository: repositoryFor(options.runtime.config.persona.defaultAgentId),
    getRepository: repositoryFor,
    getConfig: options.getConfig,
    runtime: options.runtime,
    getAgentContext: (agentId) => {
      const runtime = runtimeFor(agentId);
      return { config: runtime.config, runtime };
    }
  });
}
