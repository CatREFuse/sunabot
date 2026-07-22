import type { ImageResult } from "../../../packages/contracts/media/media.js";
import { appendRequestLog } from "../../observability/requestLog.js";
import type { OpenAIToolDefinition } from "../../../services/agent/promptSystem.js";
import type { MemoryRecallInput } from "../../../services/memory/memoryService.js";
import type { KnowledgeSearchInput } from "../../../services/knowledge/public.js";
import {
  WORKSPACE_BASH_TOOL_NAME,
  isWorkspaceBashProviderOptions,
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
  SYSTEM_CONFIG_TOOL_NAME,
  runSystemConfig
} from "../../../services/tools/systemConfigTool.js";
import {
  CRON_TOOL_NAME,
  runCronTool
} from "../../../services/tools/cronTool.js";
import {
  CALL_DIRECTOR_TOOL_NAME,
  runCallDirector
} from "../../../services/tools/callDirectorTool.js";
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WORKBENCH_FILE_MAX_BYTES,
  isWorkbenchFileRelativePath,
  isWorkbenchFileToolName,
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
import { TOOL_CALL_TIMEOUT_MS } from "../../../services/tools/toolConstants.js";
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
import { assertProviderToolDefinitions } from "../../../services/tools/providerToolSchema.js";
import { runWebsearch, type WebsearchInput } from "../webSearchTool.js";
import { WEBFETCH_TOOL_NAME } from "../../../services/tools/public.js";
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
import { errorMessage, parseJson } from "./valueUtils.js";
import {
  createTurnToolState,
  hasAcceptedTurnActivity,
  markAcceptedTool,
  toolOrderingError
} from "./turnToolState.js";
import {
  LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR,
  localOutboundTurnConflict,
  preflightProviderToolResponse,
  toolCallErrors
} from "./toolResponsePreflight.js";
import { runWebFetch } from "./webFetchExecutor.js";
import { READ_AIR_TOOL_NAME, executeReadAirTool } from "./readAirExecutor.js";

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
  [WORKSPACE_BASH_TOOL_NAME, runBash],
  [WEBSEARCH_TOOL_NAME, runWebSearch],
  [WEBFETCH_TOOL_NAME, runWebFetch],
  [GENERATE_IMG_TOOL_NAME, runImageGeneration],
  [SELFIE_TOOL_NAME, runSelfie],
  [SEND_FILE_TOOL_NAME, runSendFile],
  [MEMORY_RECALL_TOOL_NAME, runMemoryRecall],
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
  resolveDefinitions(options: ProviderCompleteOptions, definitions?: OpenAIToolDefinition[]) {
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
    assertProviderToolDefinitions(resolved);
    return resolved;
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
    if (systemConfigTurnLocked(options, state)) return null;
    if (calls.length !== 1) return null;
    const call = calls[0]!;
    if (!isProviderToolAvailable(call.name, options)) return null;
    if (!isToolEnabledForTurn(call.name, definitions)) return null;
    if (!isProviderDeferredTool(call.name, options)) return null;
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const dispatch = readDeferredDispatchMessage(args as Record<string, unknown>, call.name);
    if (!dispatch.ok) return null;
    if (hasAcceptedTurnActivity(state)) return null;
    options.onToolCall?.(call.name);
    markAcceptedTool(state, call.name);
    state.terminal = "deferred";
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
    definitions: readonly Record<string, unknown>[],
    state: TurnToolState = createTurnToolState()
  ) {
    if (systemConfigTurnLocked(options, state)) return null;
    if (calls.length !== 1) return null;
    const call = calls[0]!;
    if (call.name !== NO_REPLY_TOOL_NAME) return null;
    if (!isProviderToolAvailable(call.name, options)) return null;
    if (!isToolEnabledForTurn(call.name, definitions)) return null;
    const args = parseJson(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) return null;
    if (hasAcceptedTurnActivity(state)) return null;
    options.onToolCall?.(call.name);
    markAcceptedTool(state, call.name);
    state.terminal = "no_reply";
    return { kind: "no_reply" as const };
  }

  async execute(
    calls: ResponseFunctionCallItem[],
    options: ProviderCompleteOptions,
    definitions: readonly Record<string, unknown>[],
    state: TurnToolState = createTurnToolState()
  ) {
    const preflight = preflightProviderToolResponse(calls, "", options, state);
    if (preflight.rejected) return preflight.rejected;
    if (calls.length > 1 && calls.some((call) => call.name === NO_REPLY_TOOL_NAME)) {
      return toolCallErrors(calls, "no_reply must be called alone before any other tool.");
    }
    return Promise.all(calls.map(async (call) => ({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(await executeFunctionCall(call, options, definitions, state))
    })));
  }
}

function systemConfigTurnLocked(options: ProviderCompleteOptions, state: TurnToolState) {
  return options.systemConfig?.mutationStaged() === true ||
    options.systemConfig?.turnRejected() === true ||
    state.acceptedToolNames.includes(SYSTEM_CONFIG_TOOL_NAME);
}

async function executeFunctionCall(
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions,
  definitions: readonly Record<string, unknown>[],
  state: TurnToolState
) {
  try {
    if (localOutboundTurnConflict(call.name, state, options)) {
      return { ok: false, error: LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR };
    }
    if (isMcpToolAlias(call.name)) {
      if (!options.mcp || !isToolEnabledForTurn(call.name, definitions)) {
        return { ok: false, error: `Tool ${call.name} is unavailable.` };
      }
      const args = parseJson(call.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: `Invalid tool arguments for ${call.name}.` };
      }
      options.onToolCall?.(call.name);
      markAcceptedTool(state, call.name);
      const result = await options.mcp.call({
        name: call.name,
        arguments: args as Record<string, unknown>,
        callId: call.call_id,
        signal: options.signal
      });
      await appendToolLog(call.name, call, {
        argumentKeys: Object.keys(args as Record<string, unknown>).sort()
      }, mcpToolLogSummary(result), options).catch(() => undefined);
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
          ? hasAcceptedTurnActivity(state)
            ? toolOrderingError(call.name)
            : `Deferred tool ${call.name} must be called alone in a separate model response.`
          : dispatch.error
      };
    }
    if (executionMode !== "inline") return { ok: false, error: `Tool ${call.name} is ${executionMode}.` };
    if (
      (isWorkbenchFileToolName(call.name) && hasAcceptedTurnActivity(state))
      || state.acceptedToolNames.some(isWorkbenchFileToolName)
    ) {
      return { ok: false, error: "read_file and write_file must be called before assistant text or any other tool." };
    }
    if (call.name === NO_REPLY_TOOL_NAME) {
      return {
        ok: false,
        error: hasAcceptedTurnActivity(state)
          ? toolOrderingError(call.name)
          : "no_reply must be called alone with an empty object."
      };
    }
    const executor = inlineExecutors.get(call.name);
    if (!executor) return { ok: false, error: `Unsupported tool: ${call.name}` };
    options.onToolCall?.(call.name);
    markAcceptedTool(state, call.name);
    return await executor(args as Record<string, unknown>, call, options);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
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

async function runBash(
  args: Record<string, unknown>,
  call: ResponseFunctionCallItem,
  options: ProviderCompleteOptions
) {
  if (!isWorkspaceBashProviderOptions(options.bash)) return { ok: false, error: "Bash is not enabled." };
  try {
    if (!options.bash.isCurrent()) return { ok: false, error: "Bash is not enabled." };
  } catch {
    return { ok: false, error: "Bash is not enabled." };
  }
  const input = readWorkspaceBashInput(args);
  if (!input) return { ok: false, error: "Invalid Bash arguments." };
  const result = await runWorkspaceBash(input, options.bash.workspacePath, {
    backend: options.bash.backend,
    accessMode: options.bash.accessMode,
    strictMode: options.bash.strictMode,
    isCurrent: options.bash.isCurrent,
    audit: options.bash.audit,
    approvalContext: options.bash.approvalContext,
    ...(options.bash.confirmedApprovalId ? { confirmedApprovalId: options.bash.confirmedApprovalId } : {}),
    ...(options.signal ? { abortSignal: options.signal } : {})
  });
  await appendToolLog(WORKSPACE_BASH_TOOL_NAME, call, args, result, options);
  return result;
}

function readWorkspaceBashInput(args: Record<string, unknown>): WorkspaceBashInput | undefined {
  const keys = Object.keys(args);
  if (
    keys.length !== 2
    || !keys.includes("command")
    || !keys.includes("timeoutMs")
    || typeof args.command !== "string"
    || (args.timeoutMs !== null && args.timeoutMs !== TOOL_CALL_TIMEOUT_MS)
  ) return undefined;
  return { command: args.command, timeoutMs: args.timeoutMs };
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
