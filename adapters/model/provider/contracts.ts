import type OpenAI from "openai";
import type { BotConfig, ImageResult, ProviderConfig } from "../../../src/types.js";
import type { OpenAIToolDefinition } from "../../../services/agent/promptSystem.js";
import type { MemoryRecallInput } from "../../../services/memory/memoryService.js";
import type {
  GenerateImageRunner,
  GenerateImgReferenceContext
} from "../../../services/tools/generateImgTool.js";
import type { SelfieRunner } from "../../../services/tools/selfieTool.js";
import type { SystemConfigToolPort } from "../../../services/tools/systemConfigTool.js";
import type { PrepareOutboundConversationAssetInput } from "../../../services/delivery/public.js";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import type { ImageGenerationFailureContext } from "../imageGenerationRetry.js";
import type { WorkspaceBashProviderOptions } from "../../../services/tools/bashTool.js";
import type { SkillRuntimeToolPort } from "../../../services/tools/skillRuntimeTool.js";

export interface ProviderCompleteOptions {
  signal?: AbortSignal;
  modelRequestMaxRetries?: number;
  allowNoReply?: boolean;
  workbenchFiles?: ProviderWorkbenchFileOptions;
  bash?: ProviderBashOptions;
  bot?: BotConfig;
  generateImage?: GenerateImageRunner;
  onAssistantText?: (text: string, source?: ProviderAssistantTextSource) => void | Promise<void>;
  onToolCall?: (name: string) => void;
  onImageGenerated?: (image: ImageResult) => void;
  referenceImageUrls?: string[];
  imageReferences?: GenerateImgReferenceContext;
  memory?: ProviderMemoryOptions;
  selfie?: ProviderSelfieOptions;
  conversationAssets?: ProviderConversationAssetOptions;
  asyncCodex?: boolean;
  asyncImage?: boolean;
  imageTools?: boolean;
  systemConfig?: SystemConfigToolPort;
  skills?: SkillRuntimeToolPort;
  mcp?: ProviderMcpOptions;
  logContext?: ProviderLogContext;
}

export type ProviderAssistantTextSource = "text" | "assistant_text";

export interface TurnToolState {
  toolCallCount: number;
  assistantTextSent: boolean;
  acceptedToolNames: string[];
  terminal?: "deferred" | "no_reply";
}

export interface ProviderCompletedTurn {
  kind: "completed";
  text: string;
}

export interface ProviderDeferredTurn {
  kind: "deferred";
  acknowledgement: string;
  toolCall: {
    name: string;
    callId: string;
    arguments: Record<string, unknown>;
  };
}

export interface ProviderNoReplyTurn {
  kind: "no_reply";
}

export type ProviderTurnResult = ProviderCompletedTurn | ProviderDeferredTurn | ProviderNoReplyTurn;

export type ProviderBashOptions = WorkspaceBashProviderOptions;

export interface ProviderWorkbenchFileOptions {
  read(input: unknown): Promise<unknown>;
  write(input: unknown): Promise<unknown>;
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

export interface ProviderConversationAssetOptions {
  enabled: boolean;
  send: (
    input: PrepareOutboundConversationAssetInput,
    context: { callId: string; toolName: "send_file" }
  ) => Promise<unknown>;
}

export interface ProviderMcpOptions {
  definitions(): Record<string, unknown>[];
  describe(name: string): {
    serverId: string;
    transport: "stdio" | "streamable_http";
  };
  call(input: {
    name: string;
    arguments: Record<string, unknown>;
    callId: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
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
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state?: TurnToolState
  ): ProviderDeferredTurn | null;
  noReplyTurn(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state?: TurnToolState
  ): ProviderNoReplyTurn | null;
  execute(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state?: TurnToolState
  ): Promise<Array<Record<string, unknown>>>;
}

export interface GeneratedImageWriterPort {
  write(payload: unknown, imageModel: string, size: string): ImageResult;
}

export interface ProviderTransportFactories {
  createResponsesClient(options?: { maxRetries?: number }): OpenAI;
  createChatClient(options?: { maxRetries?: number }): OpenAI;
  getApiKey(): string;
}

export interface ProviderAdapterContext extends ProviderTransportFactories {
  provider: ProviderConfig;
  logger: ProviderLoggerPort;
  toolExecutor: ProviderToolExecutorPort;
  imageWriter: GeneratedImageWriterPort;
  options: OpenAIProviderOptions;
}
