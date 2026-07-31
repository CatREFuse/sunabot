import type OpenAI from "openai";
import type { ImageQuality, ProviderConfig } from "../../packages/contracts/admin/public.js";
import type { ImageResult } from "../../packages/contracts/media/media.js";
import {
  AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS,
  type ChatMessage,
  type ProviderLogContext
} from "../../packages/contracts/model/modelGateway.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { completeProviderTurn } from "./provider/completion.js";
import type {
  GeneratedImageWriterPort,
  OpenAIProviderOptions,
  ProviderAdapterContext,
  ProviderCompleteOptions,
  ProviderLoggerPort,
  ProviderToolExecutorPort,
  ProviderTurnResult
} from "./provider/contracts.js";
import { DEFAULT_IMAGE_MODEL, generateProviderImage } from "./provider/imageGeneration.js";
import { FileGeneratedImageWriter } from "./provider/imageWriter.js";
import { createProviderLogger } from "./provider/logger.js";
import { legacyPromptRequest } from "./provider/promptMapping.js";
import { RegistryProviderToolExecutor } from "./provider/toolExecutor.js";
import {
  createChatClient as createOpenAIChatClient,
  createResponsesClient,
  resolveProviderApiKey,
  resolveProviderApiKeyAsync
} from "./provider/transport.js";

export type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
export type {
  OpenAIProviderOptions,
  ProviderBashOptions, ProviderCompletedTurn, ProviderCompleteOptions, ProviderDeferredTurn, ProviderMemoryOptions, ProviderNoReplyTurn, ProviderSelfieOptions,
  ProviderTurnResult,
  ProviderVoiceCapability,
  ProviderVoiceCompanion
} from "./provider/contracts.js";
export { resolveLocalInputImage, toResponsesInputMessage } from "./provider/imageInput.js";

export class OpenAIProvider {
  private readonly logger: ProviderLoggerPort;
  private readonly toolExecutor: ProviderToolExecutorPort;
  private readonly imageWriter: GeneratedImageWriterPort;

  constructor(
    private readonly provider: ProviderConfig,
    private readonly options: OpenAIProviderOptions = {}
  ) {
    this.logger = createProviderLogger(provider);
    this.toolExecutor = new RegistryProviderToolExecutor();
    this.imageWriter = new FileGeneratedImageWriter();
  }

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
    if (this.provider.kind === "openai-official") {
      const client = this.createClient();
      await client.models.list();
    } else {
      await this.complete("只返回 OK。", [{ role: "user", content: "ping" }], {
        signal: AbortSignal.timeout(AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS),
        modelRequestAttemptTimeoutMs: AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS
      });
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
      throw new Error("异步工具只能由 Session Runtime 调度。");
    }
    if (result.kind === "no_reply") {
      throw new Error("no_reply 只能由 Session Runtime 处理。");
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
    return completeProviderTurn(this.adapterContext(), request, options);
  }

  async generateImage(
    prompt: string,
    size: string,
    quality: ImageQuality,
    referenceImageUrls: string[] = [],
    logContext?: ProviderLogContext,
    signal?: AbortSignal
  ): Promise<ImageResult> {
    return generateProviderImage(
      this.adapterContext(),
      prompt,
      size,
      quality,
      referenceImageUrls,
      logContext,
      signal
    );
  }

  private adapterContext(): ProviderAdapterContext {
    return {
      provider: this.provider,
      options: this.options,
      logger: this.logger,
      toolExecutor: this.toolExecutor,
      imageWriter: this.imageWriter,
      createResponsesClient: (options) => this.createClient(options),
      createChatClient: (options) => this.createChatClient(options),
      getApiKey: () => this.getApiKey(),
      getApiKeyAsync: () => this.getApiKeyAsync()
    };
  }

  private createClient(options: { maxRetries?: number } = {}): OpenAI {
    return createResponsesClient(this.provider, this.getApiKey(), options);
  }

  private createChatClient(options: { maxRetries?: number } = {}): OpenAI {
    return createOpenAIChatClient(this.provider, this.getApiKey(), options);
  }

  private getApiKey() {
    return resolveProviderApiKey(this.provider);
  }

  private async getApiKeyAsync() {
    return this.getApiKey() || resolveProviderApiKeyAsync(this.provider);
  }

  configuration() {
    return { ...this.provider };
  }

}
