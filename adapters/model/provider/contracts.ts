import type OpenAI from "openai";
import type { BotConfig, ImageResult, ProviderConfig } from "../../../src/types.js";
import type { OpenAIToolDefinition } from "../../../services/agent/promptSystem.js";
import type { MemoryRecallInput } from "../../../services/memory/memoryService.js";
import type { GenerateImageRunner } from "../../../services/tools/generateImgTool.js";
import type { SelfieRunner } from "../../../services/tools/selfieTool.js";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import type { CODEX_TOOL_NAME } from "../../../services/tools/definitions.js";
import type { ImageGenerationFailureContext } from "../imageGenerationRetry.js";

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

export interface ResponseFunctionCallItem extends Record<string, unknown> {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

export interface ProviderLoggerPort {
  request(action: string, request: unknown, metadata?: Record<string, unknown>): Promise<void>;
  response(action: string, response: unknown, metadata?: Record<string, unknown>): Promise<void>;
  imageAttemptFailure(
    action: string,
    error: unknown,
    context: ImageGenerationFailureContext,
    metadata: Record<string, unknown>
  ): Promise<void>;
}

export interface ProviderToolExecutorPort {
  resolveDefinitions(options: ProviderCompleteOptions, definitions?: OpenAIToolDefinition[]): Record<string, unknown>[];
  deferredTurn(
    payload: unknown,
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    fallbackText?: string
  ): ProviderDeferredTurn | null;
  execute(calls: ResponseFunctionCallItem[], options: ProviderCompleteOptions): Promise<Array<Record<string, unknown>>>;
}

export interface GeneratedImageWriterPort {
  write(payload: unknown, imageModel: string, size: string): ImageResult;
}

export interface ProviderTransportFactories {
  createResponsesClient(options?: { maxRetries?: number }): OpenAI;
  createChatClient(): OpenAI;
  getApiKey(): string;
}

export interface ProviderAdapterContext extends ProviderTransportFactories {
  provider: ProviderConfig;
  logger: ProviderLoggerPort;
  toolExecutor: ProviderToolExecutorPort;
  imageWriter: GeneratedImageWriterPort;
  options: OpenAIProviderOptions;
}
