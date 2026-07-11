import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import dotenv from "dotenv";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { ProviderConfig, ChatMessage, ImageResult, BotConfig, ImageQuality } from "../../src/types.js";
import { MAX_ATTACHMENT_VISUAL_PAGES } from "../../services/media/attachments/context.js";
import { normalizeAttachmentImage } from "../../services/media/attachments/image.js";
import { getRootDir, getWorkspacePath, resolveProjectPath } from "../../src/config.js";
import {
  ImageGenerationFailureContext,
  ImageGenerationHttpError,
  ImageGenerationTransportError,
  imageGenerationErrorCode,
  imageGenerationErrorStatus,
  isImageGenerationCancellation,
  runImageGenerationWithRetry
} from "./imageGenerationRetry.js";
import {
  WORKSPACE_BASH_TOOL_NAME,
  createWorkspaceBashTool,
  runWorkspaceBash,
  WorkspaceBashInput
} from "../../services/tools/bashTool.js";
import { CODEX_TOOL_NAME, MEMORY_RECALL_TOOL_NAME, WEBSEARCH_TOOL_NAME } from "../../services/tools/definitions.js";
import { GENERATE_IMG_TOOL_NAME, GenerateImageRunner, runGenerateImg, generateImgTool } from "../../services/tools/generateImgTool.js";
import { MemoryRecallInput } from "../../src/memory.js";
import { appendRequestLog } from "../../src/requestLog.js";
import { SELFIE_TOOL_NAME, SelfieRunner, selfieTool } from "../../services/tools/selfieTool.js";
import { runWebsearch, WebsearchInput } from "./webSearchTool.js";
import type { OpenAIToolDefinition, RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { providerToolExecutionMode, resolveProviderToolDefinitions } from "../../services/tools/toolRegistry.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
export type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const IMAGE_GENERATION_INSTRUCTIONS = "Generate the requested image with the hosted image_generation tool. Return the generated image only.";
const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_FETCH_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_CALL_ROUNDS = 4;
const inheritedProcessEnvironment = { ...process.env };

export interface ProviderCompleteOptions {
  signal?: AbortSignal;
  bash?: ProviderBashOptions;
  bot?: BotConfig;
  generateImage?: GenerateImageRunner;
  onAssistantText?: (text: string) => void | Promise<void>;
  onImageGenerated?: (image: ImageResult) => void;
  referenceImageUrls?: string[];
  memory?: ProviderMemoryOptions;
  selfie?: ProviderSelfieOptions;
  asyncCodex?: boolean;
  logContext?: ProviderLogContext;
}

export interface ProviderCompletedTurn {
  kind: "completed";
  text: string;
}

export interface ProviderDeferredTurn {
  kind: "deferred";
  acknowledgement: string;
  toolCall: {
    name: typeof CODEX_TOOL_NAME;
    callId: string;
    arguments: Record<string, unknown>;
  };
}

export type ProviderTurnResult = ProviderCompletedTurn | ProviderDeferredTurn;

export interface ProviderBashOptions {
  enabled: boolean;
  workspacePath: string;
  workspaceOnly: boolean;
  blockedKeywords: string[];
}

export interface ProviderMemoryOptions {
  enabled: boolean;
  recall: (input: MemoryRecallInput) => Promise<unknown>;
}

export interface ProviderSelfieOptions {
  enabled: boolean;
  referenceImageUrls?: string[];
  run: SelfieRunner;
}

export interface OpenAIProviderOptions {
  imageRetrySleep?: (delayMs: number) => Promise<void>;
}

export class OpenAIProvider {
  constructor(
    private readonly provider: ProviderConfig,
    private readonly options: OpenAIProviderOptions = {}
  ) {}

  getModelInfo() {
    return {
      model: this.provider.model,
      imageModel: this.provider.imageModel?.trim() || DEFAULT_IMAGE_MODEL
    };
  }

  hasApiKey() {
    return Boolean(this.getApiKey());
  }

  async test() {
    if (this.provider.kind === "openai-responses") {
      const client = this.createClient();
      await client.models.list();
    } else {
      await this.complete("只返回 OK。", [{ role: "user", content: "ping" }]);
    }
    return {
      ok: true,
      model: this.provider.model,
      imageModel: this.provider.imageModel
    };
  }

  async complete(systemPrompt: string, messages: ChatMessage[], options: ProviderCompleteOptions = {}) {
    return this.completeRequest(legacyPromptRequest(systemPrompt, messages), options);
  }

  async completeRequest(request: RenderedPromptRequest, options: ProviderCompleteOptions = {}) {
    const result = await this.completeRequestTurn(request, options);
    if (result.kind === "deferred") {
      throw new Error("异步 Codex Tool 只能由 Session Runtime 调度。");
    }
    return result.text;
  }

  async completeTurn(
    systemPrompt: string,
    messages: ChatMessage[],
    options: ProviderCompleteOptions = {}
  ): Promise<ProviderTurnResult> {
    return this.completeRequestTurn(legacyPromptRequest(systemPrompt, messages), options);
  }

  async completeRequestTurn(
    request: RenderedPromptRequest,
    options: ProviderCompleteOptions = {}
  ): Promise<ProviderTurnResult> {
    if (this.provider.kind === "codex-responses") {
      return this.completeWithCodex(request, options);
    }
    if (this.provider.kind === "gemini-openai" || this.provider.kind === "anthropic-openai") {
      return this.completeWithChatCompletions(request, options);
    }

    const client = this.createClient();
    const input: Array<Record<string, unknown>> = await Promise.all(request.messages.map(toResponsesInputMessage));
    const tools = resolveResponseTools(options, request.tools);
    const requestFields = promptRequestFields(request);

    for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
      const requestBody = {
        model: this.provider.model,
        temperature: this.provider.temperature,
        max_output_tokens: this.provider.maxOutputTokens,
        reasoning: this.provider.reasoningEffort ? { effort: this.provider.reasoningEffort } : undefined,
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
      await this.logModelRequest("responses.complete", requestBody, metadata);
      const response = await client.responses.create(requestBody as never, { signal: options.signal });
      await this.logModelResponse("responses.complete", {
        ok: true,
        summary: summarizeResponsesPayload(response, "")
      }, metadata);

      const toolCalls = extractFunctionCalls(response);
      const deferred = deferredCodexTurn(response, toolCalls, options);
      if (deferred) return deferred;
      if (!toolCalls.length) {
        const text = extractProviderText(response);
        if (!text) {
          throw new Error("模型没有返回可发送内容。");
        }
        return { kind: "completed", text };
      }

      await emitIntermediateAssistantText(response, options);
      input.push(...extractResponseOutput(response), ...(await executeFunctionCalls(toolCalls, options)));
    }

    throw new Error(`工具调用超过上限：${MAX_TOOL_CALL_ROUNDS + 1} 轮。`);
  }

  async generateImage(
    prompt: string,
    size: string,
    quality: ImageQuality,
    referenceImageUrls: string[] = [],
    logContext?: ProviderLogContext
  ): Promise<ImageResult> {
    if (this.provider.kind === "gemini-openai" || this.provider.kind === "anthropic-openai") {
      throw new Error("当前兼容 Provider 仅支持 Chat Completions；请为生图选择 OpenAI Responses 或 Codex Provider。");
    }
    const imageModel = this.provider.imageModel?.trim() || DEFAULT_IMAGE_MODEL;
    const imageSize = normalizeImageSize(size);
    const content = await buildImageGenerationContent(prompt, referenceImageUrls);

    if (this.provider.kind === "codex-responses") {
      return this.generateImageWithCodex(content, imageModel, imageSize, quality, referenceImageUrls, logContext);
    }

    const client = this.createClient({ maxRetries: 0 });
    const requestBody = {
      model: this.provider.model,
      instructions: IMAGE_GENERATION_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content
        }
      ],
      tools: [
        {
          type: "image_generation",
          model: imageModel,
          size: imageSize,
          quality
        }
      ],
      store: false,
      max_output_tokens: Math.min(Number(this.provider.maxOutputTokens || 1200), 1200),
      reasoning: this.provider.reasoningEffort ? { effort: this.provider.reasoningEffort } : undefined
    };
    const metadata = withLogContext({
      imageModel,
      size: imageSize,
      quality,
      referenceImageUrls: uniqueStrings(referenceImageUrls).slice(0, 4),
      resolvedReferenceImageCount: countInputImages(content)
    }, logContext);
    const result = await runImageGenerationWithRetry(async (attemptContext) => {
      await this.logModelRequest("image.generate", requestBody, { ...metadata, ...attemptContext });
      return client.responses.create(requestBody as never);
    }, {
      sleep: this.options.imageRetrySleep,
      onAttemptFailure: (error, failureContext) => this.logImageAttemptFailure(
        "image.generate",
        error,
        failureContext,
        metadata
      )
    });
    const finalMetadata = {
      ...metadata,
      attempt: result.attempt,
      maxAttempts: result.maxAttempts
    };
    try {
      const image = this.persistGeneratedImage(result.value, imageModel, imageSize);
      await this.logModelResponse("image.generate", {
        ok: true,
        summary: summarizeResponsesPayload(result.value, ""),
        image
      }, finalMetadata);
      return image;
    } catch (error) {
      await this.logModelResponse("image.generate", {
        ok: false,
        error: errorMessage(error),
        summary: summarizeResponsesPayload(result.value, ""),
        willRetry: false,
        retryDelayMs: 0
      }, finalMetadata);
      throw error;
    }
  }

  private createClient(options: { maxRetries?: number } = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(`Missing API key. Set ${this.provider.apiKeyEnv}.`);
    }

    return new OpenAI({
      apiKey,
      baseURL: this.normalizeOpenAiBaseUrl(this.provider.baseUrl),
      ...options
    });
  }

  private createChatClient() {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error(`Missing API key. Set ${this.provider.apiKeyEnv}.`);
    return new OpenAI({
      apiKey,
      baseURL: this.normalizeChatBaseUrl(),
      defaultHeaders: this.provider.kind === "gemini-openai"
        ? { "x-goog-api-client": "catrefuse-sunabot-oai/0.1.0" }
        : undefined
    });
  }

  private getApiKey() {
    const envToken = inheritedProcessEnvironment[this.provider.apiKeyEnv];
    if (envToken) return envToken;
    const providerToken = this.readEnvValue(resolveProjectPath(this.provider.envFile), this.provider.apiKeyEnv);
    if (providerToken) return providerToken;
    const projectToken = this.readEnvValue(getWorkspacePath(".env"), this.provider.apiKeyEnv);
    if (projectToken) return projectToken;
    const runtimeToken = process.env[this.provider.apiKeyEnv];
    if (runtimeToken) return runtimeToken;
    if (this.provider.kind === "codex-responses") return this.resolveCodexAccessToken();
    return "";
  }

  private readEnvValue(filePath: string | undefined, key: string) {
    if (!filePath || !fs.existsSync(filePath)) return "";
    try {
      return dotenv.parse(fs.readFileSync(filePath))[key]?.trim() ?? "";
    } catch {
      return "";
    }
  }

  private async completeWithCodex(
    request: RenderedPromptRequest,
    options: ProviderCompleteOptions
  ): Promise<ProviderTurnResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Codex 未登录。请先运行 codex login，或设置 CODEX_ACCESS_TOKEN。");
    }

    const tools = resolveResponseTools(options, request.tools);
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
        model: this.provider.model,
        store: false,
        stream: true,
        reasoning: this.provider.reasoningEffort ? { effort: this.provider.reasoningEffort, summary: "auto" } : undefined,
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
      await this.logModelRequest("codex.complete", requestBody, metadata);
      const response = await fetchWithSingleTransportRetry(this.normalizeCodexResponsesUrl(this.provider.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...this.codexBackendHeaders(apiKey)
        },
        body: JSON.stringify(requestBody),
        signal: options.signal
      }, options.signal);

      const text = await response.text();
      const payload = parseResponsesSsePayload(text) ?? parseJson(text);
      if (!response.ok) {
        const error = payload ?? parseJson(text);
        await this.logModelResponse("codex.complete", {
          ok: false,
          status: response.status,
          error: error?.error?.message ?? error?.detail ?? `Codex request failed: ${response.status}`,
          summary: summarizeResponsesPayload(payload, text)
        }, metadata);
        throw new Error(error?.error?.message ?? error?.detail ?? `Codex request failed: ${response.status}`);
      }
      await this.logModelResponse("codex.complete", {
        ok: true,
        status: response.status,
        summary: summarizeResponsesPayload(payload, text)
      }, metadata);

      const toolCalls = extractFunctionCalls(payload);
      if (!toolCalls.length) {
        const outputText = extractResponsesTextFromSse(text) || extractResponsesText(payload);
        if (!outputText) {
          throw new Error("模型没有返回可发送内容。");
        }
        return { kind: "completed", text: outputText };
      }

      const deferred = deferredCodexTurn(payload, toolCalls, options, extractResponsesTextFromSse(text));
      if (deferred) return deferred;
      await emitIntermediateAssistantText(payload, options, extractResponsesTextFromSse(text));
      input.push(...extractResponseOutput(payload), ...(await executeFunctionCalls(toolCalls, options)));
    }

    throw new Error(`工具调用超过上限：${MAX_TOOL_CALL_ROUNDS + 1} 轮。`);
  }

  private async completeWithChatCompletions(
    request: RenderedPromptRequest,
    options: ProviderCompleteOptions
  ): Promise<ProviderTurnResult> {
    const client = this.createChatClient();
    const messages: Array<Record<string, unknown>> = await Promise.all(request.messages.map(toChatCompletionMessage));
    const tools = resolveResponseTools(options, request.tools).map(toChatCompletionTool);

    for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
      const requestBody = {
        model: this.provider.model,
        messages,
        temperature: this.provider.kind === "anthropic-openai"
          ? Math.min(this.provider.temperature, 1)
          : this.provider.temperature,
        max_completion_tokens: this.provider.maxOutputTokens,
        reasoning_effort: this.provider.kind === "gemini-openai"
          ? normalizeGeminiReasoningEffort(this.provider.reasoningEffort)
          : undefined,
        tools: tools.length ? tools : undefined,
        parallel_tool_calls: tools.length ? false : undefined,
        response_format: request.response_format?.type === "text" ? undefined : request.response_format
      };
      const metadata = withLogContext({ round, toolNames: tools.map((tool) => tool.function.name) }, options.logContext);
      await this.logModelRequest("chat.completions.complete", requestBody, metadata);
      const response = await client.chat.completions.create(requestBody as never, { signal: options.signal });
      const choice = response.choices[0]?.message;
      await this.logModelResponse("chat.completions.complete", {
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

      const deferred = deferredCodexTurn({ output: calls, output_text: choice.content ?? "" }, calls, options, choice.content ?? "");
      if (deferred) return deferred;
      if (choice.content?.trim() && options.onAssistantText) await options.onAssistantText(choice.content.trim());
      messages.push({
        role: "assistant",
        content: choice.content ?? null,
        tool_calls: choice.tool_calls
      });
      const outputs = await executeFunctionCalls(calls, options);
      messages.push(...outputs.map((output) => ({
        role: "tool",
        tool_call_id: output.call_id,
        content: output.output
      })));
    }

    throw new Error(`工具调用超过上限：${MAX_TOOL_CALL_ROUNDS + 1} 轮。`);
  }

  private async generateImageWithCodex(
    content: Array<Record<string, unknown>>,
    imageModel: string,
    size: string,
    quality: ImageQuality,
    referenceImageUrls: string[],
    logContext?: ProviderLogContext
  ) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Codex 未登录。请先运行 codex login，或设置 CODEX_ACCESS_TOKEN。");
    }

    const requestBody = {
      model: this.provider.model,
      input: [
        {
          role: "user",
          content
        }
      ],
      instructions: IMAGE_GENERATION_INSTRUCTIONS,
      tools: [
        {
          type: "image_generation",
          model: imageModel,
          size,
          quality
        }
      ],
      store: false,
      stream: true,
      reasoning: this.provider.reasoningEffort ? { effort: this.provider.reasoningEffort, summary: "auto" } : undefined,
      include: ["reasoning.encrypted_content"]
    };
    const metadata = withLogContext({
      imageModel,
      size,
      quality,
      referenceImageUrls: uniqueStrings(referenceImageUrls).slice(0, 4),
      resolvedReferenceImageCount: countInputImages(content)
    }, logContext);
    const result = await runImageGenerationWithRetry(async (attemptContext) => {
      const attemptMetadata = { ...metadata, ...attemptContext };
      await this.logModelRequest("codex.image.generate", requestBody, attemptMetadata);
      let response: Response;
      try {
        response = await fetch(this.normalizeCodexResponsesUrl(this.provider.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...this.codexBackendHeaders(apiKey)
          },
          body: JSON.stringify(requestBody)
        });
      } catch (error) {
        if (isImageGenerationCancellation(error)) throw error;
        throw new ImageGenerationTransportError(error);
      }

      const text = await response.text();
      const payload = parseResponsesSsePayload(text) ?? parseJson(text);
      if (!response.ok) {
        throw new ImageGenerationHttpError(
          response.status,
          payload?.error?.message ?? payload?.detail ?? `Codex image request failed: ${response.status}`,
          summarizeResponsesPayload(payload, text)
        );
      }
      return { payload, text, status: response.status };
    }, {
      sleep: this.options.imageRetrySleep,
      onAttemptFailure: (error, failureContext) => this.logImageAttemptFailure(
        "codex.image.generate",
        error,
        failureContext,
        metadata
      )
    });
    const finalMetadata = {
      ...metadata,
      attempt: result.attempt,
      maxAttempts: result.maxAttempts
    };
    try {
      const image = this.persistGeneratedImage(result.value.payload, imageModel, size);
      await this.logModelResponse("codex.image.generate", {
        ok: true,
        status: result.value.status,
        summary: summarizeResponsesPayload(result.value.payload, result.value.text),
        image
      }, finalMetadata);
      return image;
    } catch (error) {
      await this.logModelResponse("codex.image.generate", {
        ok: false,
        status: result.value.status,
        error: errorMessage(error),
        summary: summarizeResponsesPayload(result.value.payload, result.value.text),
        willRetry: false,
        retryDelayMs: 0
      }, finalMetadata);
      throw error;
    }
  }

  private persistGeneratedImage(payload: unknown, imageModel: string, size: string): ImageResult {
    const image = extractGeneratedImage(payload);
    if (!image?.b64Json) {
      const text = extractResponsesText(payload);
      throw new Error(text || "没有收到生图结果。");
    }

    const imageDir = getWorkspacePath("artifacts/images");
    fs.mkdirSync(imageDir, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${nanoid(8)}.png`;
    const filePath = path.join(imageDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(stripDataUrlPrefix(image.b64Json), "base64"));
    return {
      url: `/generated-images/${fileName}`,
      filePath,
      revisedPrompt: `${imageModel} ${size}`
    };
  }

  private resolveCodexAccessToken() {
    const authFile = process.env.OPEN_ARONA_CODEX_AUTH_FILE || path.join(process.env.CODEX_HOME || homedir(), ".codex/auth.json");
    try {
      const payload = JSON.parse(fs.readFileSync(expandHome(authFile), "utf8")) as { tokens?: { access_token?: string } };
      const token = String(payload.tokens?.access_token ?? "").trim();
      if (!token || isJwtExpired(token)) return "";
      return token;
    } catch {
      return "";
    }
  }

  private codexBackendHeaders(accessToken: string) {
    const headers: Record<string, string> = {
      "User-Agent": "codex_cli_rs/0.0.0 (Sunabot)",
      originator: "codex_cli_rs"
    };
    const claims = decodeJwtClaims(accessToken);
    const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) {
      headers["ChatGPT-Account-ID"] = accountId.trim();
    }
    return headers;
  }

  private normalizeOpenAiBaseUrl(baseUrl?: string) {
    const value = String(baseUrl || "https://api.openai.com").replace(/\/+$/, "");
    return value.endsWith("/v1") ? value : `${value}/v1`;
  }

  private normalizeChatBaseUrl() {
    const fallback = this.provider.kind === "gemini-openai"
      ? "https://generativelanguage.googleapis.com/v1beta/openai"
      : "https://api.anthropic.com/v1";
    return String(this.provider.baseUrl || fallback).replace(/\/+$/, "");
  }

  private normalizeCodexResponsesUrl(baseUrl?: string) {
    const value = String(baseUrl || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
    return value.endsWith("/responses") ? value : `${value}/responses`;
  }

  private async logModelRequest(action: string, request: unknown, metadata: Record<string, unknown> = {}) {
    await appendRequestLog({
      category: "model.request",
      action,
      providerId: this.provider.id,
      providerKind: this.provider.kind,
      model: this.provider.model,
      request,
      metadata
    });
  }

  private async logModelResponse(action: string, response: unknown, metadata: Record<string, unknown> = {}) {
    await appendRequestLog({
      category: "model.response",
      action,
      providerId: this.provider.id,
      providerKind: this.provider.kind,
      model: this.provider.model,
      response,
      metadata
    });
  }

  private async logImageAttemptFailure(
    action: string,
    error: unknown,
    context: ImageGenerationFailureContext,
    metadata: Record<string, unknown>
  ) {
    const status = imageGenerationErrorStatus(error);
    const errorCode = imageGenerationErrorCode(error);
    const responseSummary = error instanceof ImageGenerationHttpError ? error.responseSummary : undefined;
    await this.logModelResponse(action, {
      ok: false,
      ...(status == null ? {} : { status }),
      error: errorMessage(error),
      ...(responseSummary == null ? {} : { summary: responseSummary }),
      willRetry: context.willRetry,
      retryDelayMs: context.retryDelayMs,
      ...(errorCode ? { errorCode } : {})
    }, {
      ...metadata,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts
    });
  }
}

function normalizeImageSize(value: string) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return "1024x1024";

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (
    width <= 3840 &&
    height <= 3840 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    ratio <= 3 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400
  ) {
    return `${width}x${height}`;
  }
  return "1024x1024";
}

async function buildImageGenerationContent(prompt: string, referenceImageUrls: string[]) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: prompt
    }
  ];

  for (const imageUrl of uniqueStrings(referenceImageUrls).slice(0, 4)) {
    const resolvedImageUrl = await resolveInputImageUrl(imageUrl, {
      source: "image_generation.reference",
      logFailures: true
    });
    if (!resolvedImageUrl) continue;
    content.push({
      type: "input_image",
      image_url: resolvedImageUrl
    });
  }

  return content;
}

function legacyPromptRequest(systemPrompt: string, messages: ChatMessage[]): RenderedPromptRequest {
  return {
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    response_format: { type: "text" }
  };
}

function promptRequestFields(request: RenderedPromptRequest) {
  const fields = { ...request } as Record<string, unknown>;
  delete fields.messages;
  delete fields.tools;
  delete fields.response_format;
  delete fields.input;
  delete fields.instructions;
  return fields;
}

function responseFormatFields(responseFormat: Record<string, unknown>, existingText: unknown) {
  const type = String(responseFormat.type ?? "text");
  if (type === "text") return {};
  const format = type === "json_schema" && isRecord(responseFormat.json_schema)
    ? { type, ...responseFormat.json_schema }
    : responseFormat;
  return {
    text: {
      ...(isRecord(existingText) ? existingText : {}),
      format
    }
  };
}

function resolveResponseTools(options: ProviderCompleteOptions, definitions?: OpenAIToolDefinition[]) {
  const available = getResponseTools(options);
  if (definitions == null) return available;
  const enabledNames = new Set(available.map(readToolName));
  return definitions
    .map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {})
    }))
    .filter((tool) => enabledNames.has(tool.name));
}

function getResponseTools(options: ProviderCompleteOptions) {
  return resolveProviderToolDefinitions(options);
}

function readToolName(tool: Record<string, unknown>) {
  return String(tool.name ?? tool.type ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function countInputImages(content: Array<Record<string, unknown>>) {
  return content.filter((item) => item.type === "input_image").length;
}

function extractProviderText(payload: unknown) {
  const outputText = (payload as { output_text?: string }).output_text;
  if (outputText?.trim()) return outputText.trim();
  return extractResponsesText(payload);
}

async function emitIntermediateAssistantText(payload: unknown, options: ProviderCompleteOptions, fallbackText = "") {
  if (!options.onAssistantText) return;
  const text = extractResponsesText(payload) || fallbackText.trim();
  if (!text) return;
  await options.onAssistantText(text);
}

function extractResponseOutput(payload: unknown) {
  const output = (payload as { output?: unknown[] })?.output;
  return Array.isArray(output) ? output.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
}

function extractFunctionCalls(payload: unknown) {
  return extractResponseOutput(payload).filter((item): item is ResponseFunctionCallItem => {
    return item.type === "function_call" &&
      typeof item.name === "string" &&
      typeof item.call_id === "string" &&
      typeof item.arguments === "string";
  });
}

function deferredCodexTurn(
  payload: unknown,
  calls: ResponseFunctionCallItem[],
  options: ProviderCompleteOptions,
  fallbackText = ""
): ProviderDeferredTurn | null {
  if (!options.asyncCodex) return null;
  const call = calls.find((item) => item.name === CODEX_TOOL_NAME);
  if (!call) return null;
  const args = parseJson(call.arguments);
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return {
    kind: "deferred",
    acknowledgement: extractResponsesText(payload) || fallbackText.trim(),
    toolCall: {
      name: CODEX_TOOL_NAME,
      callId: call.call_id,
      arguments: args as Record<string, unknown>
    }
  };
}

async function executeFunctionCalls(calls: ResponseFunctionCallItem[], options: ProviderCompleteOptions) {
  return Promise.all(calls.map(async (call) => {
    return {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(await executeFunctionCall(call, options))
    };
  }));
}

async function executeFunctionCall(call: ResponseFunctionCallItem, options: ProviderCompleteOptions) {
  try {
    const executionMode = providerToolExecutionMode(call.name);
    if (executionMode !== "inline") {
      return { ok: false, error: executionMode ? `Tool ${call.name} is ${executionMode}.` : `Unsupported tool: ${call.name}` };
    }
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object") {
      return { ok: false, error: `Invalid tool arguments for ${call.name}.` };
    }

    if (call.name === WORKSPACE_BASH_TOOL_NAME) {
      if (!options.bash?.enabled || !options.bash.workspacePath) {
        return { ok: false, error: "Bash is not enabled." };
      }
      const result = await runWorkspaceBash(args as WorkspaceBashInput, options.bash.workspacePath, {
        workspaceOnly: options.bash.workspaceOnly,
        blockedKeywords: options.bash.blockedKeywords
      });
      await appendRequestLog({
        category: "tool.call",
        action: WORKSPACE_BASH_TOOL_NAME,
        request: {
          callId: call.call_id,
          arguments: args
        },
        response: result,
        metadata: logContextMetadata(options.logContext)
      });
      return result;
    }

    if (call.name === WEBSEARCH_TOOL_NAME) {
      if (!options.bot) {
        return { ok: false, error: "Bot tool settings are not configured." };
      }
      await appendRequestLog({
        category: "tool.call",
        action: WEBSEARCH_TOOL_NAME,
        request: {
          callId: call.call_id,
          arguments: args
        },
        response: { status: "running" },
        metadata: logContextMetadata(options.logContext)
      });
      const result = await runWebsearch(args as WebsearchInput, options.bot, { signal: options.signal });
      await appendRequestLog({
        category: "tool.call",
        action: WEBSEARCH_TOOL_NAME,
        request: {
          callId: call.call_id,
          arguments: args
        },
        response: result,
        metadata: logContextMetadata(options.logContext)
      });
      return result;
    }

    if (call.name === GENERATE_IMG_TOOL_NAME) {
      if (!options.bot) {
        return { ok: false, error: "Bot tool settings are not configured." };
      }
      const result = await runGenerateImgSafely(args, call, options);
      if (isGeneratedImageResult(result)) {
        options.onImageGenerated?.(result.image);
      }
      return result;
    }

    if (call.name === SELFIE_TOOL_NAME) {
      if (!options.selfie?.enabled) {
        return { ok: false, error: "Selfie generation is not enabled." };
      }
      const result = await runSelfieSafely(args, call, options);
      if (isGeneratedImageResult(result)) {
        options.onImageGenerated?.(result.image);
      }
      return result;
    }

    if (call.name === MEMORY_RECALL_TOOL_NAME) {
      if (!options.memory?.enabled) {
        return { ok: false, error: "Memory recall is not enabled." };
      }
      const result = await options.memory.recall(args as MemoryRecallInput);
      await appendRequestLog({
        category: "tool.call",
        action: MEMORY_RECALL_TOOL_NAME,
        request: {
          callId: call.call_id,
          arguments: args
        },
        response: result,
        metadata: logContextMetadata(options.logContext)
      });
      return result;
    }

    return { ok: false, error: `Unsupported tool: ${call.name}` };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function runGenerateImgSafely(args: Record<string, unknown>, call: ResponseFunctionCallItem, options: ProviderCompleteOptions) {
  let result: unknown;
  try {
    result = await runGenerateImg(args, options.bot!, options.generateImage, {
      referenceImageUrls: options.referenceImageUrls,
      logContext: options.logContext
    });
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  await appendRequestLog({
    category: "tool.call",
    action: GENERATE_IMG_TOOL_NAME,
    request: {
      callId: call.call_id,
      arguments: args,
      defaultReferenceImageUrls: options.referenceImageUrls ?? []
    },
    response: pickToolLogResult(result),
    metadata: logContextMetadata(options.logContext)
  });
  return result;
}

async function runSelfieSafely(args: Record<string, unknown>, call: ResponseFunctionCallItem, options: ProviderCompleteOptions) {
  let result: unknown;
  try {
    result = await options.selfie!.run(args);
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  await appendRequestLog({
    category: "tool.call",
    action: SELFIE_TOOL_NAME,
    request: {
      callId: call.call_id,
      arguments: args,
      defaultReferenceImageUrls: options.selfie?.referenceImageUrls ?? []
    },
    response: pickToolLogResult(result),
    metadata: logContextMetadata(options.logContext)
  });
  return result;
}

function isGeneratedImageResult(value: unknown): value is { ok: true; image: ImageResult } {
  const result = value as { ok?: unknown; image?: unknown };
  const image = result?.image as ImageResult | undefined;
  return result?.ok === true && Boolean(image?.url || image?.filePath);
}

function pickToolLogResult(value: unknown) {
  const result = value as Record<string, unknown>;
  return {
    ok: result?.ok,
    provider: result?.provider,
    prompt: result?.prompt,
    size: result?.size,
    quality: result?.quality,
    referenceImageCount: result?.referenceImageCount,
    workspaceReferenceImageCount: result?.workspaceReferenceImageCount,
    chatReferenceImageCount: result?.chatReferenceImageCount,
    rewrittenPrompt: result?.rewrittenPrompt,
    resolution: result?.resolution,
    image: result?.image,
    error: result?.error
  };
}

interface ResponseFunctionCallItem extends Record<string, unknown> {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

export async function toResponsesInputMessage(message: ChatMessage) {
  const textType = message.role === "assistant" ? "output_text" : "input_text";
  const content = [
    {
      type: textType,
      text: message.content
    }
  ];

  if (message.role === "user") {
    for (const imageUrl of message.imageUrls ?? []) {
      const resolvedImageUrl = await resolveInputImageUrl(imageUrl);
      if (!resolvedImageUrl) continue;
      content.push({
        type: "input_image",
        image_url: resolvedImageUrl
      } as never);
    }
    for (const localImagePath of (message.localImagePaths ?? []).slice(0, MAX_ATTACHMENT_VISUAL_PAGES)) {
      const resolvedImageUrl = await resolveLocalInputImage(localImagePath);
      if (!resolvedImageUrl) continue;
      content.push({
        type: "input_image",
        image_url: resolvedImageUrl
      } as never);
    }
  }

  return {
    role: message.role,
    content
  };
}

async function toChatCompletionMessage(message: ChatMessage) {
  if (message.role !== "user" || (!(message.imageUrls?.length) && !(message.localImagePaths?.length))) {
    return { role: message.role, content: message.content };
  }
  const content: Array<Record<string, unknown>> = [{ type: "text", text: message.content }];
  for (const imageUrl of message.imageUrls ?? []) {
    const resolved = await resolveInputImageUrl(imageUrl);
    if (resolved) content.push({ type: "image_url", image_url: { url: resolved } });
  }
  for (const localPath of (message.localImagePaths ?? []).slice(0, MAX_ATTACHMENT_VISUAL_PAGES)) {
    const resolved = await resolveLocalInputImage(localPath);
    if (resolved) content.push({ type: "image_url", image_url: { url: resolved } });
  }
  return { role: message.role, content };
}

function toChatCompletionTool(tool: Record<string, unknown>) {
  return {
    type: "function" as const,
    function: {
      name: String(tool.name ?? ""),
      description: String(tool.description ?? ""),
      parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {})
    }
  };
}

function normalizeGeminiReasoningEffort(effort: ProviderConfig["reasoningEffort"]) {
  return effort && ["minimal", "low", "medium", "high"].includes(effort) ? effort : undefined;
}

export async function resolveLocalInputImage(filePath: string) {
  const cacheRoot = getWorkspacePath("artifacts/file-cache");
  try {
    const sourceStats = await fs.promises.lstat(filePath);
    if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) return null;
    const [realRoot, realFile] = await Promise.all([
      fs.promises.realpath(cacheRoot),
      fs.promises.realpath(filePath)
    ]);
    if (!isPathInside(realRoot, realFile)) return null;
    const normalized = await normalizeAttachmentImage(realFile, {
      maxBytes: MAX_INPUT_IMAGE_BYTES
    });
    return `data:${normalized.contentType};base64,${normalized.bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function isPathInside(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

interface ResolveInputImageOptions {
  source?: string;
  logFailures?: boolean;
}

async function resolveInputImageUrl(imageUrl: string, options: ResolveInputImageOptions = {}) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageUrl)) return imageUrl;
  if (!/^https?:\/\//i.test(imageUrl)) {
    await logInputImageResolveFailure(imageUrl, "unsupported_url", options);
    return null;
  }

  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      await logInputImageResolveFailure(imageUrl, "http_status", options, {
        status: response.status
      });
      return null;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    if (!contentType.startsWith("image/")) {
      await logInputImageResolveFailure(imageUrl, "non_image_content_type", options, {
        contentType
      });
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_FETCH_BYTES) {
      await logInputImageResolveFailure(imageUrl, "content_length_too_large", options, {
        contentLength,
        maxFetchBytes: MAX_IMAGE_FETCH_BYTES
      });
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_FETCH_BYTES) {
      await logInputImageResolveFailure(imageUrl, "image_too_large", options, {
        byteLength: bytes.length,
        maxFetchBytes: MAX_IMAGE_FETCH_BYTES
      });
      return null;
    }

    if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
      const compressed = await compressInputImage(bytes, contentType, MAX_INPUT_IMAGE_BYTES);
      if (!compressed) {
        await logInputImageResolveFailure(imageUrl, "compression_failed", options, {
          byteLength: bytes.length,
          maxBytes: MAX_INPUT_IMAGE_BYTES
        });
        return null;
      }
      await logInputImageResolveSuccess(imageUrl, options, {
        compressed: true,
        originalContentType: contentType,
        contentType: compressed.contentType,
        originalBytes: bytes.length,
        byteLength: compressed.bytes.length,
        maxBytes: MAX_INPUT_IMAGE_BYTES,
        ...compressed.details
      });
      return `data:${compressed.contentType};base64,${compressed.bytes.toString("base64")}`;
    }

    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch (error) {
    await logInputImageResolveFailure(imageUrl, "fetch_error", options, {
      error: errorMessage(error)
    });
    return null;
  }
}

interface CompressedInputImage {
  bytes: Buffer;
  contentType: string;
  details: Record<string, unknown>;
}

async function compressInputImage(bytes: Buffer, contentType: string, maxBytes: number): Promise<CompressedInputImage | null> {
  const metadata = await sharp(bytes, { animated: false }).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  const scaleSteps = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.3, 0.25];
  const qualitySteps = [88, 80, 72, 64, 56, 48, 40, 34, 28];
  let best: CompressedInputImage | null = null;

  for (const scale of scaleSteps) {
    const targetWidth = sourceWidth ? Math.max(1, Math.round(sourceWidth * scale)) : undefined;
    const targetHeight = sourceHeight ? Math.max(1, Math.round(sourceHeight * scale)) : undefined;
    for (const quality of qualitySteps) {
      const pipeline = sharp(bytes, { animated: false })
        .rotate()
        .flatten({ background: "#ffffff" });
      if (targetWidth && targetHeight && scale < 1) {
        pipeline.resize({
          width: targetWidth,
          height: targetHeight,
          fit: "inside",
          withoutEnlargement: true
        });
      }
      const output = await pipeline
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      const candidate: CompressedInputImage = {
        bytes: output,
        contentType: "image/jpeg",
        details: {
          sourceContentType: contentType,
          sourceWidth: sourceWidth || undefined,
          sourceHeight: sourceHeight || undefined,
          scale,
          quality,
          width: targetWidth,
          height: targetHeight
        }
      };
      if (!best || output.length < best.bytes.length) best = candidate;
      if (output.length <= maxBytes) return candidate;
    }
  }

  return best && best.bytes.length <= maxBytes ? best : null;
}

async function logInputImageResolveFailure(
  imageUrl: string,
  reason: string,
  options: ResolveInputImageOptions,
  details: Record<string, unknown> = {}
) {
  if (!options.logFailures) return;
  await appendRequestLog({
    category: "image.resolve",
    action: "input_image",
    request: {
      url: imageUrl
    },
    response: {
      ok: false,
      reason,
      ...details
    },
    metadata: {
      source: options.source
    }
  });
}

async function logInputImageResolveSuccess(
  imageUrl: string,
  options: ResolveInputImageOptions,
  details: Record<string, unknown>
) {
  if (!options.logFailures) return;
  await appendRequestLog({
    category: "image.resolve",
    action: "input_image",
    request: {
      url: imageUrl
    },
    response: {
      ok: true,
      ...details
    },
    metadata: {
      source: options.source
    }
  });
}

function summarizeResponsesPayload(payload: unknown, rawText: string) {
  const response = payload as {
    status?: unknown;
    error?: unknown;
    incomplete_details?: unknown;
    usage?: unknown;
    output?: Array<Record<string, unknown>>;
  } | null;
  const output = Array.isArray(response?.output) ? response.output : [];
  const imageItems = output.filter((item) => item?.type === "image_generation_call");
  return {
    hasPayload: Boolean(payload),
    rawChars: String(rawText ?? "").length,
    status: typeof response?.status === "string" ? response.status : undefined,
    error: response?.error,
    incompleteDetails: response?.incomplete_details,
    usage: response?.usage,
    outputCount: output.length,
    outputTypes: output.map((item) => String(item?.type ?? "")),
    imageGeneration: imageItems.map((item) => {
      const result = String(item.result ?? item.image ?? item.b64_json ?? item.partial_image_b64 ?? "");
      return {
        status: item.status,
        hasResult: Boolean(result.trim()),
        resultChars: result.length
      };
    }),
    textChars: extractResponsesText(payload).length
  };
}

function withLogContext(metadata: Record<string, unknown>, context?: ProviderLogContext) {
  return context ? { ...metadata, ...context } : metadata;
}

function logContextMetadata(context?: ProviderLogContext): Record<string, unknown> | undefined {
  return context ? { ...context } : undefined;
}

function extractResponsesTextFromSse(text: string) {
  let output = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const payload = parseJson(data);
    if (payload?.type === "response.output_text.delta" && typeof payload.delta === "string") {
      output += payload.delta;
    }
    if (!output && payload?.type === "response.completed") {
      output = extractResponsesText(payload.response);
    }
  }
  return output.trim();
}

function parseResponsesSsePayload(text: string) {
  const events = parseServerSentEventJson(text);
  if (!events.length) return null;
  const output: unknown[] = [];
  let responsePayload: Record<string, unknown> | null = null;
  let streamError: unknown = null;

  for (const event of events) {
    if (event?.error) streamError = event.error;
    if (event?.response && typeof event.response === "object") {
      responsePayload = event.response as Record<string, unknown>;
    }
    if ((event?.type === "response.output_item.added" || event?.type === "response.output_item.done") && event.item) {
      const index = Number(event.output_index);
      if (Number.isInteger(index) && index >= 0) {
        output[index] = { ...((output[index] as object) ?? {}), ...event.item };
      } else {
        output.push(event.item);
      }
    }
  }

  if (streamError) return { error: streamError };
  return {
    ...(responsePayload ?? {}),
    output: output.filter(Boolean)
  };
}

function parseServerSentEventJson(text: string) {
  return String(text ?? "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => parseJson(data))
    .filter(Boolean) as Array<Record<string, any>>;
}

function extractGeneratedImage(payload: unknown) {
  const response = payload as { output?: Array<Record<string, unknown>> };
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "image_generation_call") continue;
    const b64Json = String(item.result ?? item.image ?? item.b64_json ?? item.partial_image_b64 ?? "").trim();
    if (b64Json) {
      return {
        b64Json,
        mimeType: String(item.mime_type ?? item.mimeType ?? "image/png")
      };
    }
  }
  return null;
}

function stripDataUrlPrefix(value: string) {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractResponsesText(payload: unknown) {
  const response = payload as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ text?: string; type?: string }> }> };
  if (response?.output_text?.trim()) return response.output_text.trim();
  return (response?.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? "")
    .join("")
    .trim();
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWithSingleTransportRetry(
  input: string,
  init: RequestInit,
  signal?: AbortSignal
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (signal?.aborted || attempt === 1) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("aborted"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 150);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw new Error("transport retry exhausted");
}

function expandHome(inputPath: string) {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
  return inputPath;
}

function decodeJwtClaims(token: string): Record<string, any> {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function isJwtExpired(token: string) {
  const exp = decodeJwtClaims(token).exp;
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(Date.now() / 1000);
}
