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
  MEMORY_RECALL_TOOL_NAME,
  WEBSEARCH_TOOL_NAME
} from "../../../services/tools/definitions.js";
import {
  GENERATE_IMG_TOOL_NAME,
  runGenerateImg
} from "../../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../../services/tools/selfieTool.js";
import {
  ASSISTANT_TEXT_TOOL_NAME,
  readAssistantText
} from "../../../services/tools/assistantTextTool.js";
import { NO_REPLY_TOOL_NAME } from "../../../services/tools/noReplyTool.js";
import {
  isProviderToolAvailable,
  isProviderDeferredTool,
  providerToolExecutionMode,
  resolveProviderToolDefinitions
} from "../../../services/tools/toolRegistry.js";
import {
  readDeferredDispatchMessage,
  withRequiredDispatchMessage,
  withoutDispatchMessage
} from "../../../services/tools/deferredDispatch.js";
import { runWebsearch, type WebsearchInput } from "../webSearchTool.js";
import type {
  ProviderCompleteOptions,
  ProviderDeferredTurn,
  ProviderToolExecutorPort,
  ResponseFunctionCallItem
} from "./contracts.js";
import { logContextMetadata } from "./logger.js";
import { readToolName } from "./promptMapping.js";
import { errorMessage, parseJson } from "./valueUtils.js";

type InlineExecutor = (
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) => Promise<unknown>;

const inlineExecutors: ReadonlyMap<string, InlineExecutor> = new Map([
  [ASSISTANT_TEXT_TOOL_NAME, runAssistantText],
  [WORKSPACE_BASH_TOOL_NAME, runBash],
  [WEBSEARCH_TOOL_NAME, runWebSearch],
  [GENERATE_IMG_TOOL_NAME, runImageGeneration],
  [SELFIE_TOOL_NAME, runSelfie],
  [MEMORY_RECALL_TOOL_NAME, runMemoryRecall]
]);

async function runAssistantText(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  const text = readAssistantText(args);
  if (!text) return { ok: false, error: "Assistant text is empty." };
  if (!options.onAssistantText) return { ok: false, error: "Assistant text delivery is not configured." };
  await options.onAssistantText(text, "assistant_text");
  const result = { ok: true, delivered: true, textLength: text.length };
  await appendToolLog(ASSISTANT_TEXT_TOOL_NAME, call, { text }, result, options);
  return result;
}

export class RegistryProviderToolExecutor implements ProviderToolExecutorPort {
  resolveDefinitions(options: ProviderCompleteOptions, definitions?: OpenAIToolDefinition[]) {
    const configured = resolveProviderToolDefinitions(options, definitions) as Record<string, unknown>[];
    return configured.map((tool) => isProviderDeferredTool(readToolName(tool), options)
      ? withRequiredDispatchMessage(tool)
      : withoutDispatchMessage(tool));
  }

  deferredTurn(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[]
  ): ProviderDeferredTurn | null {
    if (calls.length !== 1) return null;
    const call = calls[0]!;
    if (!isProviderToolAvailable(call.name, options)) return null;
    if (!isToolEnabledForTurn(call.name, definitions)) return null;
    if (!isProviderDeferredTool(call.name, options)) return null;
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const dispatch = readDeferredDispatchMessage(args as Record<string, unknown>, call.name);
    if (!dispatch.ok) return null;
    options.onToolCall?.(call.name);
    return {
      kind: "deferred",
      acknowledgement: dispatch.message,
      toolCall: {
        name: call.name,
        callId: call.call_id,
        arguments: dispatch.workerArguments
      }
    };
  }

  noReplyTurn(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[]
  ) {
    if (calls.length !== 1) return null;
    const call = calls[0]!;
    if (call.name !== NO_REPLY_TOOL_NAME) return null;
    if (!isProviderToolAvailable(call.name, options)) return null;
    if (!isToolEnabledForTurn(call.name, definitions)) return null;
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) return null;
    options.onToolCall?.(call.name);
    return { kind: "no_reply" as const };
  }

  async execute(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[]
  ) {
    if (calls.length > 1 && calls.some((call) => call.name === NO_REPLY_TOOL_NAME)) {
      return calls.map((call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({ ok: false, error: "no_reply must be called alone before any other tool." })
      }));
    }
    return Promise.all(calls.map(async (call) => ({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(await executeFunctionCall(call, options, definitions))
    })));
  }
}

async function executeFunctionCall(
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions,
  definitions: readonly Record<string, unknown>[]
) {
  try {
    const executionMode = providerToolExecutionMode(call.name, options);
    if (!executionMode) return { ok: false, error: `Unsupported tool: ${call.name}` };
    if (!isProviderToolAvailable(call.name, options)) {
      return { ok: false, error: `Tool ${call.name} is unavailable.` };
    }
    if (!isToolEnabledForTurn(call.name, definitions)) {
      return { ok: false, error: `Tool ${call.name} is not enabled for this prompt.` };
    }
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object") {
      return { ok: false, error: `Invalid tool arguments for ${call.name}.` };
    }
    if (executionMode === "deferred") {
      const dispatch = readDeferredDispatchMessage(args as Record<string, unknown>, call.name);
      return {
        ok: false,
        error: dispatch.ok
          ? `Deferred tool ${call.name} must be called alone in a separate model response.`
          : dispatch.error
      };
    }
    if (executionMode !== "inline") return { ok: false, error: `Tool ${call.name} is ${executionMode}.` };
    if (call.name === NO_REPLY_TOOL_NAME) {
      return { ok: false, error: "no_reply must be called alone with an empty object." };
    }
    const executor = inlineExecutors.get(call.name);
    if (!executor) return { ok: false, error: `Unsupported tool: ${call.name}` };
    options.onToolCall?.(call.name);
    return await executor(args as Record<string, unknown>, call, options);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function isToolEnabledForTurn(name: string, definitions: readonly Record<string, unknown>[]) {
  return definitions.some((definition) => readToolName(definition) === name);
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
      imageReferences: options.imageReferences,
      logContext: options.logContext
    });
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  await appendToolLog(GENERATE_IMG_TOOL_NAME, call, {
    ...args,
    defaultReferenceImageUrls: options.referenceImageUrls ?? [],
    availableHistoricalReferenceImageCount: options.imageReferences?.historyImageUrls?.length ?? 0
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
