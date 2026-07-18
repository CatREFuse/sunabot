import type { FastifyInstance } from "fastify";
import { MossTtsNanoClient } from "../../adapters/voice/public.js";
import { AdminApiError } from "../../src/admin/errors.js";
import { resolveProjectPath } from "../../src/config.js";
import type { SunaRuntime } from "../../src/runtime.js";
import {
  VOICE_LANGUAGES,
  VoiceProfileRepository,
  type VoiceLanguage,
  type VoiceSynthesisClient,
} from "../../services/voice/public.js";
import { registerVoiceProfileRoutes } from "./plugins/voiceProfileRoutes.js";

export interface VoiceApiCompositionOptions {
  defaultAgentId(): string;
  getRuntime(agentId: string): Pick<SunaRuntime, "config">;
  client?: VoiceSynthesisClient;
}

export type AgentVoiceCapability = {
  enabled: boolean;
  languages: readonly VoiceLanguage[];
  defaultLanguage: VoiceLanguage;
};

export function buildVoiceApiComposition(options: VoiceApiCompositionOptions) {
  const repositories = new Map<string, VoiceProfileRepository>();
  const client =
    options.client ??
    new MossTtsNanoClient({
      baseUrl: process.env.SUNABOT_MOSS_TTS_NANO_URL,
    });
  const repository = (agentId: string) => {
    const existing = repositories.get(agentId);
    if (existing) return existing;
    let runtime: Pick<SunaRuntime, "config">;
    try {
      runtime = options.getRuntime(agentId);
    } catch {
      throw new AdminApiError(
        409,
        "VOICE_AGENT_UNAVAILABLE",
        "Agent 尚未就绪。",
      );
    }
    const workspace = resolveProjectPath(runtime.config.persona.agentWorkspace);
    if (!workspace) {
      throw new AdminApiError(
        500,
        "VOICE_WORKSPACE_UNAVAILABLE",
        "Agent 语音目录不可用。",
      );
    }
    let created: VoiceProfileRepository;
    try {
      created = new VoiceProfileRepository(workspace);
    } catch {
      throw new AdminApiError(
        500,
        "VOICE_WORKSPACE_UNAVAILABLE",
        "Agent 语音目录不可用。",
      );
    }
    repositories.set(agentId, created);
    return created;
  };
  const resolveCapability = async (
    agentId: string,
  ): Promise<AgentVoiceCapability> => {
    try {
      const profile = await repository(agentId).readProfile();
      const languages = VOICE_LANGUAGES.filter(
        (language) => profile.languages[language] !== null,
      );
      return {
        enabled: profile.enabled && languages.length > 0,
        languages,
        defaultLanguage: profile.defaultLanguage,
      };
    } catch {
      return { enabled: false, languages: [], defaultLanguage: "ja" };
    }
  };
  return {
    client,
    repository,
    resolveCapability,
    defaultAgentId: options.defaultAgentId,
  };
}

export function registerVoiceApi(
  app: FastifyInstance,
  composition: ReturnType<typeof buildVoiceApiComposition>,
) {
  registerVoiceProfileRoutes(app, {
    repository: composition.repository,
    client: composition.client,
    defaultAgentId: composition.defaultAgentId,
  });
}
