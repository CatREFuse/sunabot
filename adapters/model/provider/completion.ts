import type { RenderedPromptRequest } from "../../../services/agent/promptSystem.js";
import type {
  ProviderAdapterContext,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "./contracts.js";
import { toChatCompletionMessage, toResponsesInputMessage } from "./imageInput.js";
import { withLogContext } from "./logger.js";
import {
  normalizeGeminiReasoningEffort,
  promptRequestFields,
  readToolName,
  responseFormatFields,
  toChatCompletionTool
} from "./promptMapping.js";
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
  codexBackendHeaders,
  fetchWithSingleTransportRetry,
  normalizeCodexResponsesUrl
} from "./transport.js";
import { parseJson } from "./valueUtils.js";

const MAX_TOOL_CALL_ROUNDS = 4;

export async function completeProviderTurn(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  if (context.provider.kind === "codex-responses") {
    return completeCodexResponses(context, request, options);
  }
  if (context.provider.kind === "gemini-openai" || context.provider.kind === "anthropic-openai") {
    return completeChatCompletions(context, request, options);
  }
  return completeOpenAIResponses(context, request, options);
}

async function completeOpenAIResponses(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  const client = context.createResponsesClient();
  const input: Array<Record<string, unknown>> = await Promise.all(request.messages.map(toResponsesInputMessage));
  const tools = context.toolExecutor.resolveDefinitions(options, request.tools);
  const requestFields = promptRequestFields(request);

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const requestBody = {
      model: context.provider.model,
      temperature: context.provider.temperature,
      max_output_tokens: context.provider.maxOutputTokens,
      reasoning: context.provider.reasoningEffort ? { effort: context.provider.reasoningEffort } : undefined,
      ...requestFields,
      ...responseFormatFields(request.response_format, requestFields.text),
      input: input as never,
      tools: tools.length ? tools as never : undefined,
      parallel_tool_calls: tools.length ? requestFields.parallel_tool_calls ?? false : undefined
    };
    const metadata = withLogContext({
      round,
      toolNames: tools.map(readToolName)
    }, options.logContext);
    await context.logger.request("responses.complete", requestBody, metadata);
    const response = await client.responses.create(requestBody as never, { signal: options.signal });
    await context.logger.response("responses.complete", {
      ok: true,
      summary: summarizeResponsesPayload(response, "")
    }, metadata);

    const toolCalls = extractFunctionCalls(response);
    const deferred = context.toolExecutor.deferredTurn(response, toolCalls, options);
    if (deferred) return deferred;
    if (!toolCalls.length) {
      const text = extractProviderText(response);
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    await emitIntermediateAssistantText(response, options);
    input.push(...extractResponseOutput(response), ...(await context.toolExecutor.execute(toolCalls, options)));
  }

  throw new Error(`工具调用超过上限：${MAX_TOOL_CALL_ROUNDS + 1} 轮。`);
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
  const requestFields = promptRequestFields(request);

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
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
      input,
      instructions: systemPrompt,
      tools: tools.length ? tools : undefined,
      parallel_tool_calls: tools.length ? requestFields.parallel_tool_calls ?? false : undefined
    };
    const metadata = withLogContext({
      round,
      toolNames: tools.map(readToolName)
    }, options.logContext);
    await context.logger.request("codex.complete", requestBody, metadata);
    const response = await fetchWithSingleTransportRetry(normalizeCodexResponsesUrl(context.provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...codexBackendHeaders(apiKey)
      },
      body: JSON.stringify(requestBody),
      signal: options.signal
    }, options.signal);

    const text = await response.text();
    const payload = parseResponsesSsePayload(text) ?? parseJson(text);
    if (!response.ok) {
      const error = payload ?? parseJson(text);
      await context.logger.response("codex.complete", {
        ok: false,
        status: response.status,
        error: error?.error?.message ?? error?.detail ?? `Codex request failed: ${response.status}`,
        summary: summarizeResponsesPayload(payload, text)
      }, metadata);
      throw new Error(error?.error?.message ?? error?.detail ?? `Codex request failed: ${response.status}`);
    }
    await context.logger.response("codex.complete", {
      ok: true,
      status: response.status,
      summary: summarizeResponsesPayload(payload, text)
    }, metadata);

    const toolCalls = extractFunctionCalls(payload);
    if (!toolCalls.length) {
      const outputText = extractResponsesTextFromSse(text) || extractResponsesText(payload);
      if (!outputText) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text: outputText };
    }

    const streamText = extractResponsesTextFromSse(text);
    const deferred = context.toolExecutor.deferredTurn(payload, toolCalls, options, streamText);
    if (deferred) return deferred;
    await emitIntermediateAssistantText(payload, options, streamText);
    input.push(...extractResponseOutput(payload), ...(await context.toolExecutor.execute(toolCalls, options)));
  }

  throw new Error(`工具调用超过上限：${MAX_TOOL_CALL_ROUNDS + 1} 轮。`);
}

async function completeChatCompletions(
  context: ProviderAdapterContext,
  request: RenderedPromptRequest,
  options: ProviderCompleteOptions
): Promise<ProviderTurnResult> {
  const client = context.createChatClient();
  const messages: Array<Record<string, unknown>> = await Promise.all(request.messages.map(toChatCompletionMessage));
  const tools = context.toolExecutor.resolveDefinitions(options, request.tools).map(toChatCompletionTool);

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const requestBody = {
      model: context.provider.model,
      messages,
      temperature: context.provider.kind === "anthropic-openai"
        ? Math.min(context.provider.temperature, 1)
        : context.provider.temperature,
      max_completion_tokens: context.provider.maxOutputTokens,
      reasoning_effort: context.provider.kind === "gemini-openai"
        ? normalizeGeminiReasoningEffort(context.provider.reasoningEffort)
        : undefined,
      tools: tools.length ? tools : undefined,
      parallel_tool_calls: tools.length ? false : undefined,
      response_format: request.response_format?.type === "text" ? undefined : request.response_format
    };
    const metadata = withLogContext({
      round,
      toolNames: tools.map((tool) => tool.function.name)
    }, options.logContext);
    await context.logger.request("chat.completions.complete", requestBody, metadata);
    const response = await client.chat.completions.create(requestBody as never, { signal: options.signal });
    const choice = response.choices[0]?.message;
    await context.logger.response("chat.completions.complete", {
      ok: true,
      finishReason: response.choices[0]?.finish_reason,
      toolCallCount: choice?.tool_calls?.length ?? 0,
      textLength: choice?.content?.length ?? 0
    }, metadata);
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
    if (!calls.length) {
      const text = choice.content?.trim();
      if (!text) throw new Error("模型没有返回可发送内容。");
      return { kind: "completed", text };
    }

    const deferred = context.toolExecutor.deferredTurn(
      { output: calls, output_text: choice.content ?? "" },
      calls,
      options,
      choice.content ?? ""
    );
    if (deferred) return deferred;
    if (choice.content?.trim() && options.onAssistantText) await options.onAssistantText(choice.content.trim());
    messages.push({
      role: "assistant",
      content: choice.content ?? null,
      tool_calls: choice.tool_calls
    });
    const outputs = await context.toolExecutor.execute(calls, options);
    messages.push(...outputs.map((output) => ({
      role: "tool",
      tool_call_id: output.call_id,
      content: output.output
    })));
  }

  throw new Error(`工具调用超过上限：${MAX_TOOL_CALL_ROUNDS + 1} 轮。`);
}
