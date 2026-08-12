import { OpenAiSpeechClient } from "../../adapters/voice/public.js";
import type { ProviderVoiceCompanion } from "../../adapters/model/openaiProvider.js";
import {
  VoiceOutputStore,
  VoiceProfileError,
  VoiceProfileRepository,
  defaultVoiceProfile,
  voicePromptVariables,
  type VoiceProfileV1,
  type VoiceProviderSettings,
  type VoiceSynthesisClient,
} from "../../services/voice/public.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import { resolveProjectPath } from "../config.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import type { ParsedIncomingMessage } from "../types.js";
import type { QueueConversationAssetOptions } from "./conversationAssets.js";
import type { ReplyDelivery, RuntimeConfigPort } from "./runtimeContracts.js";

export interface RuntimeVoiceOptions {
  repository?: VoiceProfileRepository;
  client?: VoiceSynthesisClient;
}

export interface RuntimeVoiceSnapshot {
  profile: VoiceProfileV1;
  variables: ReturnType<typeof voicePromptVariables>;
}

interface RuntimeVoiceHost extends RuntimeConfigPort {
  queueConversationAsset(options: QueueConversationAssetOptions): Promise<unknown>;
}

export class RuntimeVoice {
  private repositoryValue?: VoiceProfileRepository;
  private repositoryWorkspace = "";
  private outputStoreValue?: VoiceOutputStore;

  constructor(
    private readonly host: RuntimeVoiceHost,
    private readonly options: RuntimeVoiceOptions = {},
  ) {}

  async snapshot(): Promise<RuntimeVoiceSnapshot> {
    let profile: VoiceProfileV1;
    try {
      profile = await this.repository().readProfile();
    } catch {
      profile = defaultVoiceProfile();
    }
    return { profile, variables: voicePromptVariables(profile) };
  }

  providerCapability(
    profile: VoiceProfileV1,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    delivery: ReplyDelivery | undefined,
  ) {
    const languages = (["zh", "en", "ja"] as const).filter(
      (language) => profile.provider.voices[language] !== null,
    );
    return {
      enabled:
        incoming.transport !== "web" &&
        profile.enabled &&
        languages.length > 0 &&
        typeof gateway.sendConversationAsset === "function" &&
        typeof delivery?.emitOutbox === "function",
      languages,
      defaultLanguage: profile.defaultLanguage,
    };
  }

  async synthesizeAndQueue(
    companion: ProviderVoiceCompanion,
    context: {
      incoming: ParsedIncomingMessage;
      gateway: MessagingPort;
      logRunId: string;
      isCurrent?: () => boolean;
      delivery: ReplyDelivery;
      signal?: AbortSignal;
    },
  ) {
    const startedAt = performance.now();
    try {
      const target = await this.repository().readRuntimeProfile(
        companion.language,
      );
      const result = await this.client(target.provider).generate({
        text: companion.text,
        voiceId: target.voiceId,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const stored = await this.outputStore().put(result.bytes, result.sha256);
      const queued = await this.host.queueConversationAsset({
        incoming: context.incoming,
        gateway: context.gateway,
        input: { path: stored.path, kind: "voice", name: stored.name },
        callId: companion.callId,
        logRunId: context.logRunId,
        isCurrent: context.isCurrent,
        delivery: context.delivery,
        toolName: "send_voice_message",
      });
      await this.log(companion, context, {
        status: "queued",
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        byteLength: stored.byteLength,
        sha256: stored.sha256,
      });
      return { ok: true as const, queued };
    } catch (error) {
      await this.log(companion, context, {
        status: "failed",
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        code: voiceErrorCode(error),
      }).catch(() => undefined);
      return { ok: false as const, code: voiceErrorCode(error) };
    }
  }

  private repository() {
    if (this.options.repository) return this.options.repository;
    const workspace = this.agentWorkspace();
    if (!this.repositoryValue || this.repositoryWorkspace !== workspace) {
      this.repositoryValue = new VoiceProfileRepository(workspace);
      this.repositoryWorkspace = workspace;
      this.outputStoreValue = undefined;
    }
    return this.repositoryValue;
  }

  private outputStore() {
    if (this.options.repository && this.outputStoreValue)
      return this.outputStoreValue;
    const workspace = this.agentWorkspace();
    if (!this.outputStoreValue || this.repositoryWorkspace !== workspace) {
      this.outputStoreValue = new VoiceOutputStore(workspace);
    }
    return this.outputStoreValue;
  }

  private client(provider: VoiceProviderSettings) {
    return (
      this.options.client ??
      new OpenAiSpeechClient({
        baseUrl: provider.baseUrl,
        model: provider.model,
        apiKey: process.env[provider.apiKeyEnv] ?? "",
      })
    );
  }

  private agentWorkspace() {
    const workspace = resolveProjectPath(
      this.host.config.persona.agentWorkspace,
    );
    if (!workspace) throw new Error("当前 Agent 工作区未配置。");
    return workspace;
  }

  private log(
    companion: ProviderVoiceCompanion,
    context: { incoming: ParsedIncomingMessage; logRunId: string },
    response: Record<string, unknown>,
  ) {
    return appendRequestLog({
      category: "runtime.action",
      action: "reply.voice.synthesis",
      request: {
        callId: companion.callId,
        language: companion.language,
        textLength: [...companion.text].length,
      },
      response,
      metadata: {
        conversationId:
          context.incoming.scope === "private"
            ? `private:${context.incoming.userId}`
            : `${context.incoming.scope}:${context.incoming.groupId}`,
        incomingMessageId:
          context.incoming.messageId == null
            ? undefined
            : String(context.incoming.messageId),
        runId: context.logRunId,
        stage: "reply",
      },
    });
  }
}

function voiceErrorCode(error: unknown) {
  if (error instanceof VoiceProfileError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return String((error as { code: string }).code).slice(0, 80);
  }
  return "VOICE_SYNTHESIS_FAILED";
}
