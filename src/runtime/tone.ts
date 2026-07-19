import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import type { MessageScopeV1 } from "../../packages/contracts/messaging/messages.js";
import { buildCommonPromptVariables } from "../../services/agent/persona.js";
import { senderDisplayName } from "../../services/conversations/senderName.js";
import { resolveModelReasoningEffort } from "../admin/models.js";
import { AGENT_TOOL_NAMES } from "../types.js";
import type { SunaRuntime } from "../runtime.js";
import type { ParsedIncomingMessage } from "../types.js";

const TONE_PROMPT_ID = "conversation.tone-rewrite";
const TONE_REQUEST_TIMEOUT_MS = 60_000;

export interface ToneRewriteContext {
  incoming?: ParsedIncomingMessage;
  scope?: MessageScopeV1;
  userName?: string;
  signal?: AbortSignal;
  logContext?: ProviderLogContext;
}

export class RuntimeTone {
  constructor(private readonly host: SunaRuntime) {}

  async rewrite(text: string, context: ToneRewriteContext = {}) {
    if (!this.host.config.bot.tone.enabled || !text.trim()) return text;

    const settings = this.host.config.bot.tone;
    const baseProvider = this.host.getProvider(
      settings.followMainModel ? undefined : settings.providerId || undefined
    ).configuration();
    const reasoning = resolveModelReasoningEffort(
      settings.followMainModel ? baseProvider.model : settings.model,
      settings.followMainModel ? baseProvider.reasoningEffort : settings.reasoningEffort,
      baseProvider.reasoningEffort ?? "low"
    );
    const provider = new OpenAIProvider({
      ...baseProvider,
      model: settings.followMainModel ? baseProvider.model : settings.model,
      reasoningEffort: reasoning.effort,
      temperature: settings.followMainModel ? baseProvider.temperature : settings.temperature,
      maxOutputTokens: settings.followMainModel ? baseProvider.maxOutputTokens : settings.maxOutputTokens
    });
    const incoming = context.incoming;
    const request = await this.host.renderPromptRequest(TONE_PROMPT_ID, {
      ...buildCommonPromptVariables(this.host.config, {
        scope: incoming?.scope ?? context.scope,
        userName: incoming ? senderDisplayName(incoming.sender) : context.userName
      }),
      "tone.input": text
    });
    const signal = toneSignal(context.signal);
    const output = await this.host.completePrompt(provider, {
      messages: request.messages,
      tools: [],
      response_format: { type: "text" }
    }, {
      signal,
      modelRequestMaxRetries: settings.followMainModel
        ? this.host.config.normalReply.maxRetries
        : settings.maxRetries,
      disabledTools: AGENT_TOOL_NAMES,
      logContext: {
        ...context.logContext,
        stage: "tone",
        promptFamily: TONE_PROMPT_ID
      }
    });
    const rewritten = output.trim();
    if (!rewritten) throw new Error("Tone 节点没有返回可发送内容。");
    return rewritten;
  }
}

function toneSignal(parent: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(TONE_REQUEST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
