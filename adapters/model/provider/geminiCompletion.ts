import type { RenderedPromptRequest } from "../../../services/agent/promptSystem.js";
import type { ChatMessage } from "../../../packages/contracts/model/modelGateway.js";
import type { ProviderAdapterContext, ProviderCompleteOptions, ProviderTurnResult, ResponseFunctionCallItem, TurnToolState } from "./contracts.js";
import { parseDataImage, toChatCompletionMessage } from "./imageInput.js";
import { withLogContext } from "./logger.js";
import { toGeminiFunctionDeclaration } from "./promptMapping.js";
import {
  claimBusinessToolCalls,
  resolveMaxToolCalls,
  resolveToolRoundLimit,
  toolCallLimitError
} from "./toolLoopLimits.js";
import { fetchTextWithTransportRetry, normalizeGeminiBaseUrl, resolveModelRequestMaxAttempts } from "./transport.js";
import { errorMessage, isRecord, parseJson } from "./valueUtils.js";
import { processProviderToolRound } from "./toolRound.js";
import { assertMappedProviderToolDefinitions } from "../../../services/tools/providerToolSchema.js";
import {
  assertMemoryToolDecisionsResolved,
  geminiMemoryToolConfig
} from "./memoryToolDecisions.js";

export async function completeGeminiGenerateContent(
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
  const contents = await Promise.all(request.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map(toGeminiContent));
  const resolvedDefinitions = context.toolExecutor.resolveDefinitions(
    options,
    request.tools,
    "gemini-generate-content"
  );
  const definitions = resolvedDefinitions.map(toGeminiFunctionDeclaration);
  assertMappedProviderToolDefinitions(definitions, "gemini-generate-content");
  const maxToolCalls = resolveMaxToolCalls(options);
  const toolRoundLimit = resolveToolRoundLimit(options, maxToolCalls);

  for (let round = 0; round <= toolRoundLimit; round += 1) {
    const requestBody = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: definitions.length ? [{ functionDeclarations: definitions }] : undefined,
      toolConfig: geminiMemoryToolConfig(options),
      generationConfig: {
        temperature: context.provider.temperature,
        maxOutputTokens: context.provider.maxOutputTokens,
        ...(request.response_format?.type !== "text" ? { responseMimeType: "application/json" } : {})
      }
    };
    const metadata = withLogContext({ round, toolCallCount: state.toolCallCount, maxToolCalls, toolNames: definitions.map((tool) => tool.name) }, options.logContext);
    const model = context.provider.model.replace(/^models\//, "");
    const url = `${normalizeGeminiBaseUrl(context.provider.baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
    let responseMetadata = metadata;
    const attempt = await fetchTextWithTransportRetry(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(requestBody),
      signal: options.signal
    }, options.signal, {
      maxAttempts: resolveModelRequestMaxAttempts(options.modelRequestMaxRetries, 1),
      attemptTimeoutMs: options.modelRequestAttemptTimeoutMs,
      beforeAttempt: async ({ attempt, maxAttempts }) => {
        responseMetadata = { ...metadata, transportAttempt: attempt, maxTransportAttempts: maxAttempts };
        await context.logger.request("gemini.generate-content.complete", requestBody, responseMetadata);
      },
      attemptFailed: async (error, { attempt, maxAttempts, willRetry, status, retryDelayMs }) => {
        await context.logger.response("gemini.generate-content.complete", {
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
    await context.logger.response("gemini.generate-content.complete", response.ok
      ? { ok: true, payload, usage: isRecord(payload) ? payload.usageMetadata : undefined }
      : { ok: false, status: response.status, error: geminiError(payload, response.status), payload, willRetry: false, retryDelayMs: 0 }, responseMetadata);
    if (!response.ok) throw new Error(geminiError(payload, response.status));
    const candidate = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates.find(isRecord) : undefined;
    const content = candidate && isRecord(candidate.content) ? candidate.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
    if (!parts.length) throw new Error("Gemini 没有返回消息。");
    const text = parts.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n").trim();
    const calls: ResponseFunctionCallItem[] = parts.flatMap((part, index) => {
      if (!isRecord(part.functionCall) || !part.functionCall.name) return [];
      const providerCallId = typeof part.functionCall.id === "string" && part.functionCall.id
        ? part.functionCall.id
        : undefined;
      return [{
        type: "function_call",
        call_id: providerCallId ?? `gemini-${round}-${index}`,
        ...(providerCallId ? { provider_call_id: providerCallId } : {}),
        name: String(part.functionCall.name),
        arguments: JSON.stringify(isRecord(part.functionCall.args) ? part.functionCall.args : {})
      }];
    });
    state.toolCallCount = claimBusinessToolCalls(state.toolCallCount, calls, maxToolCalls);
    if (!calls.length) {
      assertMemoryToolDecisionsResolved(options);
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    const toolRound = await processProviderToolRound({
      calls,
      siblingText: text,
      options,
      definitions: resolvedDefinitions,
      state,
      executor: context.toolExecutor,
      emitAssistantText: async () => {
        if (text && options.onAssistantText) await options.onAssistantText(text, "text");
      }
    });
    if (toolRound.terminal) return toolRound.terminal;
    contents.push({ role: "model", parts });
    contents.push({
      role: "user",
      parts: toolRound.outputs.map((output, index) => ({
        functionResponse: {
          ...(typeof calls[index]?.provider_call_id === "string"
            ? { id: calls[index].provider_call_id }
            : {}),
          name: calls[index]?.name ?? "tool",
          response: normalizeFunctionResponse(output.output)
        }
      }))
    });
  }
  throw toolCallLimitError(maxToolCalls);
}

async function toGeminiContent(message: ChatMessage) {
  const mapped = await toChatCompletionMessage(message) as { role: string; content: unknown };
  if (!Array.isArray(mapped.content)) return { role: mapped.role === "assistant" ? "model" : "user", parts: [{ text: String(mapped.content ?? "") }] };
  return {
    role: mapped.role === "assistant" ? "model" : "user",
    parts: mapped.content.flatMap<Record<string, unknown>>((part) => {
      if (!isRecord(part)) return [];
      if (part.type === "text") return [{ text: String(part.text ?? "") }];
      const imageUrl = isRecord(part.image_url) ? String(part.image_url.url ?? "") : "";
      const data = parseDataImage(imageUrl);
      return data ? [{ inlineData: { mimeType: data.mediaType, data: data.data } }] : [];
    })
  };
}

function normalizeFunctionResponse(value: unknown) {
  const parsed = parseJson(String(value ?? ""));
  return isRecord(parsed) ? parsed : { result: String(value ?? "") };
}

function geminiError(payload: unknown, status: number) {
  if (isRecord(payload) && isRecord(payload.error) && payload.error.message) return String(payload.error.message);
  return `Gemini request failed: ${status}`;
}
