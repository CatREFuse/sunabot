import type { ImageResult } from "../../../src/types.js";
import { appendRequestLog } from "../../../src/requestLog.js";
import type { OpenAIToolDefinition } from "../../../services/agent/promptSystem.js";
import type { MemoryRecallInput } from "../../../services/memory/memoryService.js";
import {
  WORKSPACE_BASH_TOOL_NAME,
  runWorkspaceBash,
  type WorkspaceBashInput
} from "../../../services/tools/bashTool.js";
import {
  CODEX_TOOL_NAME,
  MEMORY_RECALL_TOOL_NAME,
  WEBSEARCH_TOOL_NAME
} from "../../../services/tools/definitions.js";
import {
  GENERATE_IMG_TOOL_NAME,
  runGenerateImg
} from "../../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../../services/tools/selfieTool.js";
import {
  providerToolExecutionMode,
  resolveProviderToolDefinitions
} from "../../../services/tools/toolRegistry.js";
import { runWebsearch, type WebsearchInput } from "../webSearchTool.js";
import type {
  ProviderCompleteOptions,
  ProviderDeferredTurn,
  ProviderToolExecutorPort,
  ResponseFunctionCallItem
} from "./contracts.js";
import { logContextMetadata } from "./logger.js";
import { readToolName } from "./promptMapping.js";
import { extractResponsesText } from "./streamDecoder.js";
import { errorMessage, parseJson } from "./valueUtils.js";

type InlineExecutor = (
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) => Promise<unknown>;

const inlineExecutors: ReadonlyMap<string, InlineExecutor> = new Map([
  [WORKSPACE_BASH_TOOL_NAME, runBash],
  [WEBSEARCH_TOOL_NAME, runWebSearch],
  [GENERATE_IMG_TOOL_NAME, runImageGeneration],
  [SELFIE_TOOL_NAME, runSelfie],
  [MEMORY_RECALL_TOOL_NAME, runMemoryRecall]
]);

export class RegistryProviderToolExecutor implements ProviderToolExecutorPort {
  resolveDefinitions(options: ProviderCompleteOptions, definitions?: OpenAIToolDefinition[]) {
    const available = resolveProviderToolDefinitions(options) as Record<string, unknown>[];
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

  deferredTurn(
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

  async execute(calls: ResponseFunctionCallItem[], options: ProviderCompleteOptions) {
    return Promise.all(calls.map(async (call) => ({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(await executeFunctionCall(call, options))
    })));
  }
}

async function executeFunctionCall(call: ResponseFunctionCallItem, options: ProviderCompleteOptions) {
  try {
    const executionMode = providerToolExecutionMode(call.name);
    if (executionMode !== "inline") {
      return {
        ok: false,
        error: executionMode ? `Tool ${call.name} is ${executionMode}.` : `Unsupported tool: ${call.name}`
      };
    }
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object") {
      return { ok: false, error: `Invalid tool arguments for ${call.name}.` };
    }
    const executor = inlineExecutors.get(call.name);
    if (!executor) return { ok: false, error: `Unsupported tool: ${call.name}` };
    return await executor(args as Record<string, unknown>, call, options);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function runBash(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.bash?.enabled || !options.bash.workspacePath) {
    return { ok: false, error: "Bash is not enabled." };
  }
  const result = await runWorkspaceBash(args as unknown as WorkspaceBashInput, options.bash.workspacePath, {
    workspaceOnly: options.bash.workspaceOnly,
    blockedKeywords: options.bash.blockedKeywords
  });
  await appendToolLog(WORKSPACE_BASH_TOOL_NAME, call, args, result, options);
  return result;
}

async function runWebSearch(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.bot) return { ok: false, error: "Bot tool settings are not configured." };
  await appendToolLog(WEBSEARCH_TOOL_NAME, call, args, { status: "running" }, options);
  const result = await runWebsearch(args as unknown as WebsearchInput, options.bot, { signal: options.signal });
  await appendToolLog(WEBSEARCH_TOOL_NAME, call, args, result, options);
  return result;
}

async function runImageGeneration(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.bot) return { ok: false, error: "Bot tool settings are not configured." };
  let result: unknown;
  try {
    result = await runGenerateImg(args, options.bot, options.generateImage, {
      referenceImageUrls: options.referenceImageUrls,
      logContext: options.logContext
    });
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  await appendToolLog(GENERATE_IMG_TOOL_NAME, call, {
    ...args,
    defaultReferenceImageUrls: options.referenceImageUrls ?? []
  }, pickToolLogResult(result), options);
  if (isGeneratedImageResult(result)) options.onImageGenerated?.(result.image);
  return result;
}

async function runSelfie(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.selfie?.enabled) return { ok: false, error: "Selfie generation is not enabled." };
  let result: unknown;
  try {
    result = await options.selfie.run(args);
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  await appendToolLog(SELFIE_TOOL_NAME, call, {
    ...args,
    defaultReferenceImageUrls: options.selfie.referenceImageUrls ?? []
  }, pickToolLogResult(result), options);
  if (isGeneratedImageResult(result)) options.onImageGenerated?.(result.image);
  return result;
}

async function runMemoryRecall(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.memory?.enabled) return { ok: false, error: "Memory recall is not enabled." };
  const result = await options.memory.recall(args as unknown as MemoryRecallInput);
  await appendToolLog(MEMORY_RECALL_TOOL_NAME, call, args, result, options);
  return result;
}

async function appendToolLog(
  action: string,
  call: ResponseFunctionCallItem,
  args: Record<string, unknown>,
  response: unknown,
  options: ProviderCompleteOptions
) {
  const { defaultReferenceImageUrls, ...argumentsValue } = args;
  await appendRequestLog({
    category: "tool.call",
    action,
    request: {
      callId: call.call_id,
      arguments: argumentsValue,
      ...(defaultReferenceImageUrls === undefined ? {} : { defaultReferenceImageUrls })
    },
    response,
    metadata: logContextMetadata(options.logContext)
  });
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
