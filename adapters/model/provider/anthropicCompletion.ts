import type { RenderedPromptRequest } from "../../../services/agent/promptSystem.js";
import type { ChatMessage } from "../../../packages/contracts/model/modelGateway.js";
import type { ProviderAdapterContext, ProviderCompleteOptions, ProviderTurnResult, ResponseFunctionCallItem, TurnToolState } from "./contracts.js";
import { parseDataImage, toChatCompletionMessage } from "./imageInput.js";
import { withLogContext } from "./logger.js";
import { readToolName, toAnthropicTool } from "./promptMapping.js";
import {
  claimBusinessToolCalls,
  resolveMaxToolCalls,
  resolveToolRoundLimit,
  toolCallLimitError
} from "./toolLoopLimits.js";
import { fetchTextWithTransportRetry, normalizeAnthropicBaseUrl, resolveModelRequestMaxAttempts } from "./transport.js";
import { errorMessage, isRecord, parseJson } from "./valueUtils.js";
import { processProviderToolRound } from "./toolRound.js";
import { assertMappedProviderToolDefinitions } from "../../../services/tools/providerToolSchema.js";
import {
  anthropicWorkingMemoryToolChoice,
  assertWorkingMemoryDecisionResolved
} from "./workingMemoryDecision.js";

export async function completeAnthropicMessages(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions,
  state: TurnToolState
): Promise<ProviderTurnResult> {
  const apiKey = context.getApiKey();
  if (!apiKey) throw new Error(`Missing API key. Set ${context.provider.apiKeyEnv}.`);
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)
    .join("\n\n");
  const messages = await Promise.all(request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map(toAnthropicMessage));
  const definitions = context.toolExecutor.resolveDefinitions(
    options,
    request.tools,
    "anthropic-messages"
  );
  const tools = definitions.map(toAnthropicTool);
  assertMappedProviderToolDefinitions(tools, "anthropic-messages");
  const maxToolCalls = resolveMaxToolCalls(options);
  const toolRoundLimit = resolveToolRoundLimit(options, maxToolCalls);

  for (let round = 0; round <= toolRoundLimit; round += 1) {
    const requestBody = {
      model: context.provider.model,
      system: system || undefined,
      messages,
      temperature: Math.min(context.provider.temperature, 1),
      max_tokens: context.provider.maxOutputTokens,
      tools: tools.length ? tools : undefined,
      tool_choice: anthropicWorkingMemoryToolChoice(options)
    };
    const metadata = withLogContext({ round, toolCallCount: state.toolCallCount, maxToolCalls, toolNames: tools.map(readToolName) }, options.logContext);
    let responseMetadata = metadata;
    const attempt = await fetchTextWithTransportRetry(`${normalizeAnthropicBaseUrl(context.provider.baseUrl)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody),
      signal: options.signal
    }, options.signal, {
      maxAttempts: resolveModelRequestMaxAttempts(options.modelRequestMaxRetries, 1),
      attemptTimeoutMs: options.modelRequestAttemptTimeoutMs,
      beforeAttempt: async ({ attempt, maxAttempts }) => {
        responseMetadata = { ...metadata, transportAttempt: attempt, maxTransportAttempts: maxAttempts };
        await context.logger.request("anthropic.messages.complete", requestBody, responseMetadata);
      },
      attemptFailed: async (error, { attempt, maxAttempts, willRetry, status, retryDelayMs }) => {
        await context.logger.response("anthropic.messages.complete", {
          ok: false,
          ...(status == null ? {} : { status }),
          error: errorMessage(error),
          willRetry,
          retryDelayMs
        }, { ...metadata, transportAttempt: attempt, maxTransportAttempts: maxAttempts });
      }
    });
    const { response, text: raw } = attempt;
    const payload = parseJson(raw);
    await context.logger.response("anthropic.messages.complete", response.ok
      ? { ok: true, payload, stopReason: isRecord(payload) ? payload.stop_reason : undefined, usage: isRecord(payload) ? payload.usage : undefined }
      : { ok: false, status: response.status, error: anthropicError(payload, response.status), payload, willRetry: false, retryDelayMs: 0 }, responseMetadata);
    if (!response.ok) throw new Error(anthropicError(payload, response.status));
    if (!isRecord(payload) || !Array.isArray(payload.content)) throw new Error("Anthropic 没有返回消息。");

    const blocks = payload.content.filter(isRecord);
    const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n").trim();
    const calls: ResponseFunctionCallItem[] = blocks.flatMap((block) => block.type === "tool_use" && block.id && block.name
      ? [{ type: "function_call", call_id: String(block.id), name: String(block.name), arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) }]
      : []);
    state.toolCallCount = claimBusinessToolCalls(state.toolCallCount, calls, maxToolCalls);
    if (!calls.length) {
      assertWorkingMemoryDecisionResolved(options);
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    const toolRound = await processProviderToolRound({
      calls,
      siblingText: text,
      options,
      definitions,
      state,
      executor: context.toolExecutor,
      emitAssistantText: async () => {
        if (text && options.onAssistantText) await options.onAssistantText(text, "text");
      }
    });
    if (toolRound.terminal) return toolRound.terminal;
    messages.push({ role: "assistant", content: blocks });
    messages.push({
      role: "user",
      content: toolRound.outputs.map((output) => ({ type: "tool_result", tool_use_id: output.call_id, content: String(output.output ?? "") }))
    });
  }
  throw toolCallLimitError(maxToolCalls);
}

async function toAnthropicMessage(message: ChatMessage) {
  const mapped = await toChatCompletionMessage(message) as { role: string; content: unknown };
  if (!Array.isArray(mapped.content)) return { role: mapped.role === "assistant" ? "assistant" : "user", content: mapped.content };
  return {
    role: mapped.role === "assistant" ? "assistant" : "user",
    content: mapped.content.flatMap<Record<string, unknown>>((part) => {
      if (!isRecord(part)) return [];
      if (part.type === "text") return [{ type: "text", text: String(part.text ?? "") }];
      const imageUrl = isRecord(part.image_url) ? String(part.image_url.url ?? "") : "";
      const data = parseDataImage(imageUrl);
      return data ? [{ type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } }] : [];
    })
  };
}

function anthropicError(payload: unknown, status: number) {
  if (isRecord(payload) && isRecord(payload.error) && payload.error.message) return String(payload.error.message);
  return `Anthropic request failed: ${status}`;
}
