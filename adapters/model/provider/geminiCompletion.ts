import type { RenderedPromptRequest } from "../../../services/agent/promptSystem.js";
import type { ChatMessage } from "../../../src/types.js";
import type { ProviderAdapterContext, ProviderCompleteOptions, ProviderTurnResult, ResponseFunctionCallItem, TurnToolState } from "./contracts.js";
import { toChatCompletionMessage } from "./imageInput.js";
import { withLogContext } from "./logger.js";
import { claimToolCalls, resolveMaxToolCalls, toolCallLimitError } from "./toolLoopLimits.js";
import { fetchTextWithTransportRetry, normalizeGeminiBaseUrl, resolveModelRequestMaxAttempts } from "./transport.js";
import { errorMessage, isRecord, parseJson } from "./valueUtils.js";
import { preflightProviderToolResponse } from "./toolResponsePreflight.js";

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
  const resolvedDefinitions = context.toolExecutor.resolveDefinitions(options, request.tools);
  const definitions = resolvedDefinitions.map((tool) => ({
    name: String(tool.name ?? ""),
    description: String(tool.description ?? ""),
    parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} }
  }));
  const maxToolCalls = resolveMaxToolCalls(options);

  for (let round = 0; round <= maxToolCalls; round += 1) {
    const requestBody = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: definitions.length ? [{ functionDeclarations: definitions }] : undefined,
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
      ? { ok: true, usage: isRecord(payload) ? payload.usageMetadata : undefined }
      : { ok: false, status: response.status, error: geminiError(payload, response.status), willRetry: false, retryDelayMs: 0 }, responseMetadata);
    if (!response.ok) throw new Error(geminiError(payload, response.status));
    const candidate = isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates.find(isRecord) : undefined;
    const content = candidate && isRecord(candidate.content) ? candidate.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
    if (!parts.length) throw new Error("Gemini 没有返回消息。");
    const text = parts.map((part) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n").trim();
    const calls: ResponseFunctionCallItem[] = parts.flatMap((part, index) => isRecord(part.functionCall) && part.functionCall.name
      ? [{
          type: "function_call",
          call_id: `gemini-${round}-${index}`,
          name: String(part.functionCall.name),
          arguments: JSON.stringify(isRecord(part.functionCall.args) ? part.functionCall.args : {})
        }]
      : []);
    state.toolCallCount = claimToolCalls(state.toolCallCount, calls.length, maxToolCalls);
    if (!calls.length) {
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    const preflight = preflightProviderToolResponse(calls, text, options, state);
    if (!preflight.rejected) {
      const deferred = context.toolExecutor.deferredTurn(calls, options, resolvedDefinitions, state);
      if (deferred) return deferred;
      const noReply = context.toolExecutor.noReplyTurn(calls, options, resolvedDefinitions, state);
      if (noReply) return noReply;
      if (text && options.onAssistantText && preflight.emitAssistantText) {
        await options.onAssistantText(text, "text");
      }
    }
    contents.push({ role: "model", parts });
    const outputs = preflight.rejected ?? await context.toolExecutor.execute(calls, options, resolvedDefinitions, state);
    contents.push({
      role: "user",
      parts: outputs.map((output, index) => ({
        functionResponse: {
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

function parseDataImage(value: string) {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined;
}

function normalizeFunctionResponse(value: unknown) {
  const parsed = parseJson(String(value ?? ""));
  return isRecord(parsed) ? parsed : { result: String(value ?? "") };
}

function geminiError(payload: unknown, status: number) {
  if (isRecord(payload) && isRecord(payload.error) && payload.error.message) return String(payload.error.message);
  return `Gemini request failed: ${status}`;
}
