import type OpenAI from "openai";
import type { AgentToolName, BotConfig, ProviderConfig } from "../../../packages/contracts/admin/public.js";
import type { ImageResult } from "../../../packages/contracts/media/media.js";
import type { OpenAIToolDefinition } from "../../../services/agent/promptSystem.js";
import type { MemoryRecallInput } from "../../../services/memory/memoryService.js";
import type { KnowledgeSearchToolPort } from "../../../services/tools/knowledgeSearchTool.js";
import type {
  GenerateImageRunner,
  GenerateImgReferenceContext
} from "../../../services/tools/generateImgTool.js";
import type { SelfieRunner } from "../../../services/tools/selfieTool.js";
import type { SystemConfigToolPort } from "../../../services/tools/systemConfigTool.js";
import type { CronToolPort } from "../../../services/tools/cronTool.js";
import type { CallDirectorToolPort } from "../../../services/tools/callDirectorTool.js";
import type { AddWorkMemoryToolPort, ReadAirToolPort } from "../../../services/tools/public.js";
import type { PrepareOutboundConversationAssetInput } from "../../../services/delivery/public.js";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import type { ImageGenerationFailureContext } from "../imageGenerationRetry.js";
import type { WorkspaceBashProviderOptions } from "../../../services/tools/bashTool.js";
import type { SkillRuntimeToolPort } from "../../../services/tools/skillRuntimeTool.js";
import type { VoiceLanguage } from "../../../services/voice/public.js";

export interface ProviderCompleteOptions {
  signal?: AbortSignal;
  modelRequestMaxRetries?: number;
  modelRequestAttemptTimeoutMs?: number;
  allowNoReply?: boolean;
  workbenchFiles?: ProviderWorkbenchFileOptions;
  bash?: {
    native?: ProviderBashOptions;
    docker?: ProviderBashOptions;
  };
  bot?: BotConfig;
  generateImage?: GenerateImageRunner;
  onAssistantText?: (text: string, source?: ProviderAssistantTextSource) => void | Promise<void>;
  onToolCall?: (name: string) => void;
  onImageGenerated?: (image: ImageResult, metadata?: GeneratedImageMetadata) => void;
  referenceImageUrls?: string[];
  imageReferences?: GenerateImgReferenceContext;
  memory?: ProviderMemoryOptions;
  knowledge?: KnowledgeSearchToolPort;
  selfie?: ProviderSelfieOptions;
  conversationAssets?: ProviderConversationAssetOptions;
  voice?: ProviderVoiceCapability;
  asyncCodex?: boolean;
  asyncImage?: boolean;
  imageTools?: boolean;
  systemConfig?: SystemConfigToolPort;
  cron?: CronToolPort;
  director?: CallDirectorToolPort;
  air?: ReadAirToolPort;
  workingMemory?: AddWorkMemoryToolPort;
  skills?: SkillRuntimeToolPort;
  disabledTools?: readonly AgentToolName[];
  mcp?: ProviderMcpOptions;
  logContext?: ProviderLogContext;
}

export interface GeneratedImageMetadata {
  prompt?: string;
  size?: string;
  resolution?: string;
}

export type ProviderAssistantTextSource = "text" | "assistant_text";

export interface TurnToolState {
  toolCallCount: number;
  assistantTextSent: boolean;
  assistantTextDeliveryCount: number;
  deliveredAssistantText?: {
    text: string;
    source: ProviderAssistantTextSource;
  };
  acceptedToolNames: string[];
  terminal?: "deferred" | "no_reply" | "voice";
}

export interface ProviderCompletedTurn {
  kind: "completed";
  text: string;
  messageOrigin?: ProviderAssistantTextSource;
  textAlreadyDelivered?: boolean;
  voice?: ProviderVoiceCompanion;
}

export interface ProviderDeferredTurn {
  kind: "deferred";
  acknowledgement: string;
  toolCall: {
    name: string;
    callId: string;
    arguments: Record<string, unknown>;
  };
  voice?: ProviderVoiceCompanion;
}

export interface ProviderVoiceCompanion {
  text: string;
  language: VoiceLanguage;
  callId: string;
  toolName: "send_voice_message";
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

export interface ProviderVoiceCapability {
  enabled: boolean;
  languages: readonly VoiceLanguage[];
  defaultLanguage: VoiceLanguage;
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
  companionTurn(
    calls: ResponseFunctionCallItem[],
    siblingText: string,
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state?: TurnToolState
  ): ProviderCompletedTurn | ProviderDeferredTurn | null;
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
  getApiKeyAsync(): Promise<string>;
}

export interface ProviderAdapterContext extends ProviderTransportFactories {
  provider: ProviderConfig;
  logger: ProviderLoggerPort;
  toolExecutor: ProviderToolExecutorPort;
  imageWriter: GeneratedImageWriterPort;
  options: OpenAIProviderOptions;
}
