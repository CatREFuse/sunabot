import type { ImageResult } from "../../../packages/contracts/media/media.js";
import { appendRequestLog } from "../../observability/requestLog.js";
import type { OpenAIToolDefinition } from "../../../services/agent/promptSystem.js";
import type { MemoryRecallInput } from "../../../services/memory/memoryService.js";
import type { KnowledgeSearchInput } from "../../../services/knowledge/public.js";
import { DOCKER_BASH_TOOL_NAME, NATIVE_BASH_TOOL_NAME } from "../../../services/tools/bashTool.js";
import { MEMORY_RECALL_TOOL_NAME, WEBSEARCH_TOOL_NAME } from "../../../services/tools/definitions.js";
import { GENERATE_IMG_TOOL_NAME, runGenerateImg } from "../../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../../services/tools/selfieTool.js";
import { ASSISTANT_TEXT_TOOL_NAME, readAssistantText } from "../../../services/tools/assistantTextTool.js";
import { NO_REPLY_TOOL_NAME } from "../../../services/tools/noReplyTool.js";
import { SYSTEM_CONFIG_TOOL_NAME, runSystemConfig } from "../../../services/tools/systemConfigTool.js";
import {
  CRON_TOOL_NAME,
  runCronTool
} from "../../../services/tools/cronTool.js";
import {
  CALL_DIRECTOR_TOOL_NAME,
  runCallDirector
} from "../../../services/tools/callDirectorTool.js";
import {
  ADD_WORKMEMORY_TOOL_NAME,
  EXPORT_CHAT_MEDIA_TOOL_NAME,
  IMPORT_CHAT_EMOJI_TOOL_NAME,
  IMPORT_CHAT_SELFIE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WEBFETCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WORKBENCH_FILE_MAX_BYTES,
  isWorkbenchFileRelativePath,
  validateReadFileInput,
  validateWorkbenchFileText,
  validateWriteFileInput,
  workbenchFilePublicMessage,
  type WorkbenchFileErrorCode
} from "../../../services/tools/public.js";
import {
  SEND_FILE_TOOL_NAME,
  readSendFileInput
} from "../../../services/tools/sendConversationAssetTool.js";
import {
  isProviderToolAvailable,
  isProviderDeferredTool,
  providerToolExecutionMode,
  resolveProviderToolDefinitions
} from "../../../services/tools/toolRegistry.js";
import { executeProviderBash } from "./bashToolExecutor.js";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  readActivateSkillInput
} from "../../../services/tools/activateSkillTool.js";
import {
  READ_SKILL_RESOURCE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
  readSkillResourceInput,
  readSkillScriptInput
} from "../../../services/tools/skillRuntimeTool.js";
import { isMcpToolAlias } from "../../../services/extensions/public.js";
import {
  readDeferredDispatchMessage,
  withRequiredDispatchMessage,
  withoutDispatchMessage
} from "../../../services/tools/deferredDispatch.js";
import { runWebsearch, type WebsearchInput } from "../webSearchTool.js";
import { KNOWLEDGE_SEARCH_TOOL_NAME } from "../../../services/tools/knowledgeSearchTool.js";
import type {
  ProviderCompleteOptions,
  ProviderDeferredTurn,
  ProviderToolExecutorPort,
  ResponseFunctionCallItem,
  TurnToolState
} from "./contracts.js";
import { providerVoiceCompanionTurn } from "./voiceCompanionTurn.js";
import { logContextMetadata } from "./logger.js";
import { mcpToolLogSummary } from "./mcpToolLog.js";
import { readToolName } from "./promptMapping.js";
import { validProviderToolDefinitions } from "./toolDefinitionIsolation.js";
import type { ProviderToolSchemaProtocol } from "../../../services/tools/providerToolSchema.js";
import { errorMessage, isRecord, parseJson } from "./valueUtils.js";
import {
  createTurnToolState,
  markAcceptedTool
} from "./turnToolState.js";
import { runWebFetch } from "./webFetchExecutor.js";
import { READ_AIR_TOOL_NAME, executeReadAirTool } from "./readAirExecutor.js";
import { executeAddWorkMemoryTool } from "./addWorkMemoryExecutor.js";
import { runExportChatMedia, runImportChatEmoji, runImportChatSelfie } from "./chatMediaExecutor.js";

export { mcpToolLogSummary } from "./mcpToolLog.js";

type InlineExecutor = (
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) => Promise<unknown>;

const inlineExecutors: ReadonlyMap<string, InlineExecutor> = new Map([
  [ASSISTANT_TEXT_TOOL_NAME, runAssistantText],
  [READ_FILE_TOOL_NAME, runReadFile],
  [WRITE_FILE_TOOL_NAME, runWriteFile],
  [EXPORT_CHAT_MEDIA_TOOL_NAME, runExportChatMedia],
  [IMPORT_CHAT_EMOJI_TOOL_NAME, runImportChatEmoji],
  [IMPORT_CHAT_SELFIE_TOOL_NAME, runImportChatSelfie],
  [NATIVE_BASH_TOOL_NAME, runNativeBash],
  [DOCKER_BASH_TOOL_NAME, runDockerBash],
  [WEBSEARCH_TOOL_NAME, runWebSearch],
  [WEBFETCH_TOOL_NAME, runWebFetch],
  [GENERATE_IMG_TOOL_NAME, runImageGeneration],
  [SELFIE_TOOL_NAME, runSelfie],
  [SEND_FILE_TOOL_NAME, runSendFile],
  [MEMORY_RECALL_TOOL_NAME, runMemoryRecall],
  [ADD_WORKMEMORY_TOOL_NAME, executeAddWorkMemoryTool],
  [READ_AIR_TOOL_NAME, executeReadAirTool],
  [KNOWLEDGE_SEARCH_TOOL_NAME, runKnowledgeSearch],
  [SYSTEM_CONFIG_TOOL_NAME, runSystemConfigTool],
  [CRON_TOOL_NAME, executeCronTool],
  [CALL_DIRECTOR_TOOL_NAME, executeCallDirectorTool],
  [ACTIVATE_SKILL_TOOL_NAME, runActivateSkill],
  [READ_SKILL_RESOURCE_TOOL_NAME, runReadSkillResource],
  [RUN_SKILL_SCRIPT_TOOL_NAME, runSkillScript]
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
  resolveDefinitions(
    options: ProviderCompleteOptions,
    definitions?: OpenAIToolDefinition[],
    protocol: ProviderToolSchemaProtocol = "openai-responses"
  ) {
    const configured = resolveProviderToolDefinitions(options, definitions) as Record<string, unknown>[];
    const dynamicMcp = options.mcp?.definitions().filter((tool) => isMcpToolAlias(readToolName(tool))) ?? [];
    const seen = new Set(configured.map(readToolName));
    const resolved = [...configured, ...dynamicMcp.filter((tool) => {
      const name = readToolName(tool);
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    })].map((tool) => isProviderDeferredTool(readToolName(tool), options)
      ? withRequiredDispatchMessage(tool)
      : withoutDispatchMessage(tool));
    return validProviderToolDefinitions(resolved, protocol);
  }

  companionTurn(
    calls: ResponseFunctionCallItem[],
    siblingText: string,
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state: TurnToolState = createTurnToolState()
  ) { return providerVoiceCompanionTurn(calls, siblingText, options, definitions, state); }

  deferredTurn(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state: TurnToolState = createTurnToolState()
  ): ProviderDeferredTurn | null {
    const deferredCalls = calls.filter((call) => isProviderDeferredTool(call.name, options));
    if (deferredCalls.length !== 1) return null;
    const call = deferredCalls[0]!;
    if (!isProviderToolAvailable(call.name, options)) return null;
    if (!isToolEnabledForTurn(call.name, definitions)) return null;
    if (!isProviderDeferredTool(call.name, options)) return null;
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const dispatch = readDeferredDispatchMessage(args as Record<string, unknown>, call.name);
    if (!dispatch.ok) return null;
    options.onToolCall?.(call.name);
    markAcceptedTool(state, call.name);
    state.terminal = "deferred";
    return {
      kind: "deferred",
      acknowledgement: dispatch.message,
      toolCall: {
        name: call.name,
        callId: call.call_id,
        arguments: call.name === "codex"
          ? {
              ...dispatch.workerArguments,
              __sunabot_admin_authorized: true,
              ...(options.codexControl === true ? { __sunabot_control_authorized: true } : {})
            }
          : dispatch.workerArguments
      }
    };
  }

  async noReplyTurn(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state: TurnToolState = createTurnToolState()
  ) {
    const noReplyCalls = calls.filter((call) => call.name === NO_REPLY_TOOL_NAME);
    if (!noReplyCalls.length) return null;
    for (const call of noReplyCalls) {
      if (!isProviderToolAvailable(call.name, options)) return null;
      if (!isToolEnabledForTurn(call.name, definitions)) return null;
      const args = parseJson(call.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) return null;
      options.onToolCall?.(call.name);
      markAcceptedTool(state, call.name);
      await appendToolLog(NO_REPLY_TOOL_NAME, call, {}, { ok: true }, options);
    }
    state.terminal = "no_reply";
    return { kind: "no_reply" as const };
  }

  async execute(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state: TurnToolState = createTurnToolState()
  ) {
    return Promise.all(calls.map(async (call) => ({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(await executeFunctionCall(call, options, definitions, state))
    })));
  }
}

async function executeFunctionCall(
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions,
  definitions: readonly Record<string, unknown>[],
  state: TurnToolState
) {
  try {
    if (isMcpToolAlias(call.name)) {
      if (!options.mcp || !isToolEnabledForTurn(call.name, definitions)) {
        return { ok: false, error: `Tool ${call.name} is unavailable.` };
      }
      const args = parseJson(call.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: `Invalid tool arguments for ${call.name}.` };
      }
      options.onToolCall?.(call.name);
      const result = await options.mcp.call({
        name: call.name,
        arguments: args as Record<string, unknown>,
        callId: call.call_id,
        signal: options.signal
      });
      await appendToolLog(call.name, call, {
        argumentKeys: Object.keys(args as Record<string, unknown>).sort()
      }, mcpToolLogSummary(result), options).catch(() => undefined);
      if (toolCallSucceeded(result)) markAcceptedTool(state, call.name);
      return result;
    }
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
          ? `Deferred tool ${call.name} could not be dispatched from this response.`
          : dispatch.error
      };
    }
    if (executionMode !== "inline") return { ok: false, error: `Tool ${call.name} is ${executionMode}.` };
    if (call.name === NO_REPLY_TOOL_NAME) {
      options.onToolCall?.(call.name);
      markAcceptedTool(state, call.name);
      return { ok: true };
    }
    const executor = inlineExecutors.get(call.name);
    if (!executor) return { ok: false, error: `Unsupported tool: ${call.name}` };
    options.onToolCall?.(call.name);
    const result = await executor(args as Record<string, unknown>, call, options);
    if (toolCallSucceeded(result)) markAcceptedTool(state, call.name);
    return result;
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function toolCallSucceeded(result: unknown) {
  return !isRecord(result) || result.ok !== false;
}

async function runActivateSkill(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.skills?.skillIds.length) return { ok: false, error: "Skill activation is not enabled." };
  const input = readActivateSkillInput(args, options.skills.skillIds);
  const result = await options.skills.activate(input);
  await appendToolLog(ACTIVATE_SKILL_TOOL_NAME, call, input, pickToolLogResult(result), options)
    .catch(() => undefined);
  return result;
}

async function runReadSkillResource(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.skills?.skillIds.length) return { ok: false, error: "Skill resources are not enabled." };
  const input = readSkillResourceInput(args, options.skills.skillIds);
  const result = await options.skills.readResource(input);
  await appendToolLog(READ_SKILL_RESOURCE_TOOL_NAME, call, input, skillResourceLogResult(result), options)
    .catch(() => undefined);
  return result;
}

async function runSkillScript(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.skills?.runScript || !options.skills.skillIds.length) {
    return { ok: false, error: "Skill script execution is not enabled." };
  }
  const input = readSkillScriptInput(args, options.skills.skillIds);
  const result = await options.skills.runScript(input);
  await appendToolLog(RUN_SKILL_SCRIPT_TOOL_NAME, call, {
    skillId: input.skillId,
    path: input.path,
    argumentCount: input.args.length
  }, skillScriptLogResult(result), options).catch(() => undefined);
  return result;
}

function skillResourceLogResult(value: unknown) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ok: result.ok,
    skillId: result.skillId,
    path: result.path,
    sha256: result.sha256,
    byteLength: result.byteLength,
    encoding: result.encoding
  };
}

function skillScriptLogResult(value: unknown) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutLength: typeof result.stdout === "string" ? result.stdout.length : undefined,
    stderrLength: typeof result.stderr === "string" ? result.stderr.length : undefined,
    code: result.code
  };
}

async function runReadFile(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.workbenchFiles) return { ok: false, error: "File tools are not enabled." };
  const validated = validateReadFileInput(args);
  if (!validated.ok) return await rejectFileToolArguments(READ_FILE_TOOL_NAME, call, args, false, options);
  const result = await safeFileToolCall(
    "read",
    validated.input.path,
    undefined,
    () => options.workbenchFiles!.read(validated.input)
  );
  await appendToolLog(READ_FILE_TOOL_NAME, call, safeFileArguments(args, false), fileToolLogResult(result), options)
    .catch(() => undefined);
  return result;
}

async function runWriteFile(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.workbenchFiles) return { ok: false, error: "File tools are not enabled." };
  const validated = validateWriteFileInput(args);
  if (!validated.ok) return await rejectFileToolArguments(WRITE_FILE_TOOL_NAME, call, args, true, options);
  const result = await safeFileToolCall(
    "write",
    validated.input.path,
    validated.byteLength,
    () => options.workbenchFiles!.write(validated.input)
  );
  await appendToolLog(WRITE_FILE_TOOL_NAME, call, safeFileArguments(args, true), fileToolLogResult(result), options)
    .catch(() => undefined);
  return result;
}

async function rejectFileToolArguments(
  toolName: typeof READ_FILE_TOOL_NAME | typeof WRITE_FILE_TOOL_NAME,
  call: ResponseFunctionCallItem,
  args: Record<string, unknown>,
  write: boolean,
  options: ProviderCompleteOptions
) {
  const result = fileToolArgumentsInvalid();
  await appendToolLog(toolName, call, safeFileArguments(args, write), fileToolLogResult(result), options)
    .catch(() => undefined);
  return result;
}

async function safeFileToolCall(
  kind: "read" | "write",
  requestPath: string,
  requestByteLength: number | undefined,
  operation: () => Promise<unknown>
) {
  try {
    return normalizedFileToolResult(kind, requestPath, requestByteLength, await operation());
  } catch {
    return fileToolUnavailable();
  }
}

function safeFileArguments(args: Record<string, unknown>, write: boolean) {
  return {
    path: safeFileLogPath(args.path),
    ...(write ? {
      overwrite: args.overwrite === true,
      contentByteLength: typeof args.content === "string" ? Buffer.byteLength(args.content, "utf8") : 0
    } : {})
  };
}

function fileToolLogResult(value: unknown) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ok: result.ok,
    path: safeFileLogPath(result.path),
    byteLength: result.byteLength,
    created: result.created,
    overwritten: result.overwritten,
    code: result.code
  };
}

function normalizedFileToolResult(
  kind: "read" | "write",
  requestPath: string,
  requestByteLength: number | undefined,
  value: unknown
) {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (result.ok === false && isWorkbenchFileErrorCode(result.code)) {
    return {
      ok: false,
      code: result.code,
      error: workbenchFilePublicMessage(result.code)
    };
  }
  const successKeys = kind === "read"
    ? ["byteLength", "content", "ok", "path"]
    : ["byteLength", "created", "ok", "overwritten", "path"];
  if (!hasExactKeys(result, successKeys)) return fileToolUnavailable();
  const byteLength = result.byteLength;
  if (
    result.ok !== true
    || !isWorkbenchFileRelativePath(result.path)
    || result.path !== requestPath
    || !Number.isSafeInteger(byteLength)
    || Number(byteLength) < 0
    || Number(byteLength) > WORKBENCH_FILE_MAX_BYTES
  ) return fileToolUnavailable();
  if (kind === "read") {
    const content = validateWorkbenchFileText(result.content);
    if (!content.ok || content.byteLength !== byteLength) return fileToolUnavailable();
    return { ok: true, path: requestPath, byteLength, content: content.content };
  }
  if (
    requestByteLength === undefined
    || byteLength !== requestByteLength
    || typeof result.created !== "boolean"
    || typeof result.overwritten !== "boolean"
    || result.created === result.overwritten
  ) {
    return fileToolUnavailable();
  }
  return {
    ok: true,
    path: requestPath,
    byteLength,
    created: result.created,
    overwritten: result.overwritten
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeFileLogPath(value: unknown) {
  return isWorkbenchFileRelativePath(value) ? value : "[invalid]";
}

function isWorkbenchFileErrorCode(value: unknown): value is WorkbenchFileErrorCode {
  return typeof value === "string" && [
    "WORKBENCH_FILE_PATH_INVALID",
    "WORKBENCH_FILE_ARGUMENTS_INVALID",
    "WORKBENCH_FILE_NOT_FOUND",
    "WORKBENCH_FILE_EXISTS",
    "WORKBENCH_FILE_CONFLICT",
    "WORKBENCH_FILE_TOO_LARGE",
    "WORKBENCH_FILE_TEXT_INVALID",
    "WORKBENCH_FILE_FORBIDDEN",
    "WORKBENCH_FILE_UNSAFE",
    "WORKBENCH_FILE_UNAVAILABLE"
  ].includes(value);
}

function fileToolUnavailable() {
  const code = "WORKBENCH_FILE_UNAVAILABLE" as const;
  return { ok: false, code, error: workbenchFilePublicMessage(code) };
}

function fileToolArgumentsInvalid() {
  const code = "WORKBENCH_FILE_ARGUMENTS_INVALID" as const;
  return { ok: false, code, error: workbenchFilePublicMessage(code) };
}

function isToolEnabledForTurn(name: string, definitions: readonly Record<string, unknown>[]) {
  return definitions.some((definition) => readToolName(definition) === name);
}

async function runNativeBash(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  return runBash(NATIVE_BASH_TOOL_NAME, args, call, options);
}

async function runDockerBash(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  return runBash(DOCKER_BASH_TOOL_NAME, args, call, options);
}

async function runBash(
  toolName: typeof NATIVE_BASH_TOOL_NAME | typeof DOCKER_BASH_TOOL_NAME,
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  const result = await executeProviderBash(toolName, args, options);
  await appendToolLog(toolName, call, args, result, options);
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
      resolveWorkbenchImagePaths: options.resolveWorkbenchImagePaths,
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
  if (isGeneratedImageResult(result)) options.onImageGenerated?.(result.image, generatedImageMetadata(result));
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
  if (isGeneratedImageResult(result)) options.onImageGenerated?.(result.image, generatedImageMetadata(result));
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

async function runKnowledgeSearch(args: Record<string, unknown>, call: ResponseFunctionCallItem, options: ProviderCompleteOptions) {
  if (!options.knowledge?.enabled) return { ok: false, error: "Knowledge search is not enabled." };
  const result = await options.knowledge.search(args as KnowledgeSearchInput);
  await appendToolLog(KNOWLEDGE_SEARCH_TOOL_NAME, call, args, result, options);
  return result;
}

async function runSystemConfigTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.systemConfig) {
    return { ok: false, error: "System configuration is unavailable." };
  }
  const result = await runSystemConfig(args, options.systemConfig);
  await appendToolLog(SYSTEM_CONFIG_TOOL_NAME, call, args, result, options);
  return result;
}

async function executeCronTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.cron) return { ok: false, error: "Scheduled task management is unavailable." };
  const result = await runCronTool(args, options.cron);
  await appendToolLog(CRON_TOOL_NAME, call, args, result, options);
  return result;
}

async function executeCallDirectorTool(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.director) return { ok: false, error: "Daily director is unavailable." };
  const result = await runCallDirector(args, options.director);
  await appendToolLog(CALL_DIRECTOR_TOOL_NAME, call, args, result, options);
  return result;
}

async function runSendFile(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!options.conversationAssets?.enabled) {
    return { ok: false, error: "Conversation asset delivery is not enabled." };
  }
  const input = readSendFileInput(args);
  let result: unknown;
  try {
    result = await options.conversationAssets.send(input, {
      callId: call.call_id,
      toolName: SEND_FILE_TOOL_NAME
    });
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  await appendToolLog(SEND_FILE_TOOL_NAME, call, args, result, options);
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

function generatedImageMetadata(value: unknown) {
  const result = value as Record<string, unknown>;
  return {
    prompt: stringField(result.prompt),
    size: stringField(result.size),
    resolution: stringField(result.resolution)
  };
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
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
