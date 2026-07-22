import { OpenAIProvider } from "../../adapters/model/openaiProvider.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import type { MessageScopeV1 } from "../../packages/contracts/messaging/messages.js";
import { buildCommonPromptVariables } from "../../services/agent/persona.js";
import {
  PLAIN_TONE_OUTPUT_CONTRACT,
  TONE_AVAILABLE_ASSETS_VARIABLE,
  TONE_MODE_VARIABLE,
  TONE_OUTPUT_CONTRACT_VARIABLE,
  segmentedToneOutputContract,
  serializeToneAvailableAssets,
  type ToneAvailableAssetV1
} from "../../services/agent/toneReplyPrompt.js";
import { senderDisplayName } from "../../services/conversations/senderName.js";
import { parseSegmentedReplyXml } from "../../services/messaging/segmentedReply.js";
import { resolveModelReasoningEffort } from "../../packages/contracts/admin/models.js";
import { AGENT_TOOL_NAMES } from "../types.js";
import type { ParsedIncomingMessage } from "../types.js";
import type { RuntimePromptPort } from "./runtimeContracts.js";

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
  constructor(private readonly host: RuntimePromptPort) {}

  async rewrite(text: string, context: ToneRewriteContext = {}) {
    if (!this.host.config.bot.tone.enabled || !text.trim()) return text;
    const rewritten = await this.complete(text, context, PLAIN_TONE_OUTPUT_CONTRACT, [], false);
    return preserveFormattedError(text, rewritten);
  }

  async rewriteForDelivery(
    text: string,
    assets: readonly ToneAvailableAssetV1[],
    context: ToneRewriteContext = {},
    emojiMarkers: readonly string[] = []
  ) {
    const segmented = this.host.config.bot.tone.enabled
      && this.host.config.bot.tone.segmentedReply;
    if (!segmented) {
      return { segmented: false as const, content: await this.rewrite(text, context) };
    }
    serializeToneAvailableAssets(assets);
    if (!text.trim()) return { segmented: true as const, content: "" };
    const rewritten = await this.complete(
      text,
      context,
      segmentedToneOutputContract(emojiMarkers),
      assets,
      true
    );
    return {
      segmented: true as const,
      content: preserveSegmentedFormattedError(text, rewritten)
    };
  }

  private async complete(
    text: string,
    context: ToneRewriteContext,
    outputContract: string,
    assets: readonly ToneAvailableAssetV1[],
    toneMode: boolean
  ) {

    const settings = this.host.config.bot.tone;
    const followMainModel = settings.followMainModel;
    const baseProvider = this.host.getProvider(
      followMainModel ? undefined : settings.providerId || undefined
    ).configuration();
    const reasoning = resolveModelReasoningEffort(
      followMainModel ? baseProvider.model : settings.model,
      followMainModel ? baseProvider.reasoningEffort : settings.reasoningEffort,
      baseProvider.reasoningEffort ?? "low"
    );
    const provider = new OpenAIProvider({
      ...baseProvider,
      model: followMainModel ? baseProvider.model : settings.model,
      reasoningEffort: reasoning.effort,
      temperature: followMainModel ? baseProvider.temperature : settings.temperature,
      maxOutputTokens: followMainModel ? baseProvider.maxOutputTokens : settings.maxOutputTokens
    });
    const incoming = context.incoming;
    const request = await this.host.renderPromptRequest(TONE_PROMPT_ID, {
      ...buildCommonPromptVariables(this.host.config, {
        scope: incoming?.scope ?? context.scope,
        userName: incoming ? senderDisplayName(incoming.sender) : context.userName
      }),
      "tone.input": text,
      [TONE_MODE_VARIABLE]: toneMode,
      [TONE_OUTPUT_CONTRACT_VARIABLE]: outputContract,
      [TONE_AVAILABLE_ASSETS_VARIABLE]: serializeToneAvailableAssets(assets)
    });
    const signal = toneSignal(context.signal);
    const output = await this.host.completePrompt(provider, {
      messages: request.messages,
      tools: [],
      response_format: { type: "text" }
    }, {
      signal,
      modelRequestMaxRetries: followMainModel
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

function preserveFormattedError(source: string, rewritten: string) {
  const original = source.trim();
  if (!original.startsWith("异常：") || rewritten.includes(original)) return rewritten;
  return `${rewritten}\n${original}`;
}

function preserveSegmentedFormattedError(source: string, rewritten: string) {
  const original = source.trim();
  if (!original.startsWith("异常：")) return rewritten;
  let nodes;
  try {
    nodes = parseSegmentedReplyXml(rewritten).nodes;
  } catch {
    return rewritten;
  }
  if (nodes.some((node) => node.type === "dialog" && node.text.includes(original))) return rewritten;
  return `${rewritten}<dialog>${escapeXmlText(original)}</dialog>`;
}

function escapeXmlText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
