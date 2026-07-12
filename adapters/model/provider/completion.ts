import type { RenderedPromptRequest } from "../../../services/agent/promptSystem.js";
import type {
  ProviderAdapterContext,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "./contracts.js";
import { toChatCompletionMessage, toResponsesInputMessage } from "./imageInput.js";
import { withLogContext } from "./logger.js";
import {
  promptRequestFields,
  readToolName,
  responseFormatFields,
  toChatCompletionTool
} from "./promptMapping.js";
import { promptCacheKey } from "./promptCaching.js";
import {
  emitIntermediateAssistantText,
  extractFunctionCalls,
  extractProviderText,
  extractResponseOutput,
  extractResponsesText,
  extractResponsesTextFromSse,
  parseResponsesSsePayload,
  summarizeResponsesPayload
} from "./streamDecoder.js";
import {
  assertRequestNotAborted,
  codexBackendHeaders,
  fetchTextWithTransportRetry,
  normalizeCodexResponsesUrl,
  resolveRetryDelayMs,
  waitForRetry
} from "./transport.js";
import { errorMessage, parseJson } from "./valueUtils.js";
import { completeAnthropicMessages } from "./anthropicCompletion.js";
import { completeGeminiGenerateContent } from "./geminiCompletion.js";
import { claimToolCalls, resolveMaxToolCalls, toolCallLimitError } from "./toolLoopLimits.js";

export async function completeProviderTurn(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  if (context.provider.kind === "codex-responses") {
    return completeCodexResponses(context, request, options);
  }
  if (context.provider.kind === "anthropic-official" || context.provider.kind === "anthropic-compatible") return completeAnthropicMessages(context, request, options);
  if (context.provider.kind === "gemini-official" || context.provider.kind === "gemini-compatible") return completeGeminiGenerateContent(context, request, options);
  if (context.provider.kind === "openai-compatible") return completeChatCompletions(context, request, options);
  return completeOpenAIResponses(context, request, options);
}

async function completeOpenAIResponses(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  const client = context.createResponsesClient({ maxRetries: 0 });
  const input: Array<Record<string, unknown>> = await Promise.all(request.messages.map(toResponsesInputMessage));
  const tools = context.toolExecutor.resolveDefinitions(options, request.tools);
  const toolNames = tools.map(readToolName);
  const cacheKey = promptCacheKey(context.provider, options.logContext, toolNames);
  const requestFields = promptRequestFields(request);
  const maxToolCalls = resolveMaxToolCalls(options);
  let toolCallCount = 0;

  for (let round = 0; round <= maxToolCalls; round += 1) {
    const requestBody = {
      model: context.provider.model,
      temperature: context.provider.temperature,
      max_output_tokens: context.provider.maxOutputTokens,
      reasoning: context.provider.reasoningEffort ? { effort: context.provider.reasoningEffort } : undefined,
      ...requestFields,
      ...responseFormatFields(request.response_format, requestFields.text),
      prompt_cache_key: cacheKey,
      input: input as never,
      tools: tools.length ? tools as never : undefined,
      parallel_tool_calls: tools.length ? requestFields.parallel_tool_calls ?? false : undefined
    };
    const metadata = withLogContext({
      round,
      toolCallCount,
      maxToolCalls,
      toolNames
    }, options.logContext);
    const attempt = await executeSdkModelRequest(
      context,
      "responses.complete",
      requestBody,
      metadata,
      options.signal,
      () => client.responses.create(requestBody as never, { signal: options.signal })
    );
    const response = attempt.value;
    await context.logger.response("responses.complete", {
      ok: true,
      summary: summarizeResponsesPayload(response, "")
    }, attempt.metadata);

    const toolCalls = extractFunctionCalls(response);
    toolCallCount = claimToolCalls(toolCallCount, toolCalls.length, maxToolCalls);
    const deferred = context.toolExecutor.deferredTurn(toolCalls, options, tools);
    if (deferred) return deferred;
    if (!toolCalls.length) {
      const text = extractProviderText(response);
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    await emitIntermediateAssistantText(response, options);
    input.push(...extractResponseOutput(response), ...(await context.toolExecutor.execute(toolCalls, options, tools)));
  }

  throw toolCallLimitError(maxToolCalls);
}

async function completeCodexResponses(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  const apiKey = context.getApiKey();
  if (!apiKey) throw new Error("Codex 未登录。请先运行 codex login，或设置 CODEX_ACCESS_TOKEN。");

  const tools = context.toolExecutor.resolveDefinitions(options, request.tools);
  const systemPrompt = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input: Array<Record<string, unknown>> = await Promise.all(
    request.messages.filter((message) => message.role !== "system").map(toResponsesInputMessage)
  );
  const toolNames = tools.map(readToolName);
  const cacheKey = promptCacheKey(context.provider, options.logContext, toolNames);
  const requestFields = promptRequestFields(request);
  const maxToolCalls = resolveMaxToolCalls(options);
  let toolCallCount = 0;

  for (let round = 0; round <= maxToolCalls; round += 1) {
    const requestBody = {
      model: context.provider.model,
      store: false,
      stream: true,
      reasoning: context.provider.reasoningEffort
        ? { effort: context.provider.reasoningEffort, summary: "auto" }
        : undefined,
      include: ["reasoning.encrypted_content"],
      ...requestFields,
      ...responseFormatFields(request.response_format, requestFields.text),
      prompt_cache_key: cacheKey,
      input,
      instructions: systemPrompt,
      tools: tools.length ? tools : undefined,
      parallel_tool_calls: tools.length ? requestFields.parallel_tool_calls ?? false : undefined
    };
    const metadata = withLogContext({
      round,
      toolCallCount,
      maxToolCalls,
      toolNames
    }, options.logContext);
    let responseMetadata = metadata;
    const attempt = await fetchTextWithTransportRetry(normalizeCodexResponsesUrl(context.provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...codexBackendHeaders(apiKey)
      },
      body: JSON.stringify(requestBody),
      signal: options.signal
    }, options.signal, {
      beforeAttempt: async ({ attempt, maxAttempts }) => {
        responseMetadata = { ...metadata, transportAttempt: attempt, maxTransportAttempts: maxAttempts };
        await context.logger.request("codex.complete", requestBody, responseMetadata);
      },
      attemptFailed: async (error, { attempt, maxAttempts, willRetry, status, retryDelayMs }) => {
        await context.logger.response("codex.complete", {
          ok: false,
          ...(status == null ? {} : { status }),
          error: errorMessage(error),
          willRetry,
          retryDelayMs
        }, { ...metadata, transportAttempt: attempt, maxTransportAttempts: maxAttempts });
      }
    });
    const { response, text } = attempt;
    const payload = parseResponsesSsePayload(text) ?? parseJson(text);
    if (!response.ok) {
      const error = payload ?? parseJson(text);
      await context.logger.response("codex.complete", {
        ok: false,
        status: response.status,
        error: error?.error?.message ?? error?.detail ?? `Codex request failed: ${response.status}`,
        summary: summarizeResponsesPayload(payload, text),
        willRetry: false,
        retryDelayMs: 0
      }, responseMetadata);
      throw new Error(error?.error?.message ?? error?.detail ?? `Codex request failed: ${response.status}`);
    }
    await context.logger.response("codex.complete", {
      ok: true,
      status: response.status,
      summary: summarizeResponsesPayload(payload, text)
    }, responseMetadata);

    const toolCalls = extractFunctionCalls(payload);
    toolCallCount = claimToolCalls(toolCallCount, toolCalls.length, maxToolCalls);
    if (!toolCalls.length) {
      const outputText = extractResponsesTextFromSse(text) || extractResponsesText(payload);
      if (!outputText) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text: outputText };
    }

    const streamText = extractResponsesTextFromSse(text);
    const deferred = context.toolExecutor.deferredTurn(toolCalls, options, tools);
    if (deferred) return deferred;
    await emitIntermediateAssistantText(payload, options, streamText);
    input.push(...extractResponseOutput(payload), ...(await context.toolExecutor.execute(toolCalls, options, tools)));
  }

  throw toolCallLimitError(maxToolCalls);
}

async function completeChatCompletions(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  const client = context.createChatClient({ maxRetries: 0 });
  const messages: Array<Record<string, unknown>> = await Promise.all(request.messages.map(toChatCompletionMessage));
  const definitions = context.toolExecutor.resolveDefinitions(options, request.tools);
  const tools = definitions.map(toChatCompletionTool);
  const maxToolCalls = resolveMaxToolCalls(options);
  let toolCallCount = 0;

  for (let round = 0; round <= maxToolCalls; round += 1) {
    const requestBody = {
      model: context.provider.model,
      messages,
      temperature: context.provider.temperature,
      max_completion_tokens: context.provider.maxOutputTokens,
      reasoning_effort: undefined,
      tools: tools.length ? tools : undefined,
      parallel_tool_calls: tools.length ? false : undefined,
      response_format: request.response_format?.type === "text" ? undefined : request.response_format
    };
    const metadata = withLogContext({
      round,
      toolCallCount,
      maxToolCalls,
      toolNames: tools.map((tool) => tool.function.name)
    }, options.logContext);
    const attempt = await executeSdkModelRequest(
      context,
      "chat.completions.complete",
      requestBody,
      metadata,
      options.signal,
      () => client.chat.completions.create(requestBody as never, { signal: options.signal })
    );
    const response = attempt.value;
    const choice = response.choices[0]?.message;
    await context.logger.response("chat.completions.complete", {
      ok: true,
      finishReason: response.choices[0]?.finish_reason,
      toolCallCount: choice?.tool_calls?.length ?? 0,
      textLength: choice?.content?.length ?? 0,
      usage: response.usage
    }, attempt.metadata);
    if (!choice) throw new Error("模型没有返回消息。");

    const calls = (choice.tool_calls ?? []).flatMap((call) => {
      if (call.type !== "function") return [];
      return [{
        type: "function_call" as const,
        name: call.function.name,
        call_id: call.id,
        arguments: call.function.arguments
      }];
    });
    toolCallCount = claimToolCalls(toolCallCount, calls.length, maxToolCalls);
    if (!calls.length) {
      const text = choice.content?.trim();
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    const deferred = context.toolExecutor.deferredTurn(calls, options, definitions);
    if (deferred) return deferred;
    if (choice.content?.trim() && options.onAssistantText) await options.onAssistantText(choice.content.trim());
    messages.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: choice.tool_calls
    });
    const outputs = await context.toolExecutor.execute(calls, options, definitions);
    messages.push(...outputs.map((output) => ({
      role: "tool",
      tool_call_id: output.call_id,
      content: output.output
    })));
  }

  throw toolCallLimitError(maxToolCalls);
}

async function executeSdkModelRequest<T>(
  context: ProviderAdapterContext,
  action: string,
  request: unknown,
  metadata: Record<string, unknown>,
  signal: AbortSignal | undefined,
  execute: () => Promise<T>
) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertRequestNotAborted(signal);
    const attemptMetadata = { ...metadata, transportAttempt: attempt, maxTransportAttempts: maxAttempts };
    await context.logger.request(action, request, attemptMetadata);
    try {
      return { value: await execute(), metadata: attemptMetadata };
    } catch (error) {
      const status = modelErrorStatus(error);
      const willRetry = !signal?.aborted && attempt < maxAttempts && retryableModelError(error, status);
      const retryDelayMs = willRetry ? resolveRetryDelayMs(error, attempt) : 0;
      await context.logger.response(action, {
        ok: false,
        ...(status == null ? {} : { status }),
        error: errorMessage(error),
        willRetry,
        retryDelayMs
      }, attemptMetadata);
      if (!willRetry) throw error;
      await waitForRetry(retryDelayMs, signal);
    }
  }
  throw new Error("model request retry exhausted");
}

function modelErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = Number((error as { status?: unknown }).status);
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function retryableModelError(error: unknown, status: number | undefined) {
  if (error && typeof error === "object") {
    const headers = (error as { headers?: unknown }).headers;
    const retryHeader = headers instanceof Headers
      ? headers.get("x-should-retry")
      : headers && typeof headers === "object"
        ? String((headers as Record<string, unknown>)["x-should-retry"] ?? "")
        : "";
    if (retryHeader === "true") return true;
    if (retryHeader === "false") return false;
  }
  return status == null || status === 408 || status === 409 || status === 429 || status >= 500;
}
