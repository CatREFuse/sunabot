import {
  READ_FILE_TOOL_NAME,
  SEND_FILE_TOOL_NAME,
  SYSTEM_CONFIG_TOOL_NAME,
  WORKSPACE_BASH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  isWorkbenchFileToolName
} from "../../../services/tools/public.js";
import type {
  ProviderCompleteOptions,
  ResponseFunctionCallItem,
  TurnToolState
} from "./contracts.js";

export const SYSTEM_CONFIG_SOLO_ERROR =
  "system_config must be called alone in a model tool-call batch.";
export const SYSTEM_CONFIG_MUTATION_STAGED_ERROR =
  "A system_config change is already staged; send the final confirmation without calling another tool.";
export const SYSTEM_CONFIG_TURN_SOLO_ERROR =
  "system_config must be the only accepted tool activity in the provider turn.";

const restrictedToolNames = new Set([
  SYSTEM_CONFIG_TOOL_NAME,
  SEND_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WORKSPACE_BASH_TOOL_NAME
]);

export function preflightProviderToolResponse(
  calls: ResponseFunctionCallItem[],
  siblingText: string,
  options: ProviderCompleteOptions,
  state: TurnToolState
) {
  const systemConfigStateError = rejectInvalidSystemConfigState(calls, options, state);
  if (systemConfigStateError) {
    return {
      emitAssistantText: false,
      rejected: toolCallErrors(calls, systemConfigStateError)
    };
  }

  const mixedBatchError = restrictedBatchError(calls);
  if (mixedBatchError) {
    rejectSystemConfigCall(calls, options);
    return {
      emitAssistantText: false,
      rejected: toolCallErrors(calls, mixedBatchError)
    };
  }

  if (siblingText.trim()) {
    const restricted = calls.find((call) => restrictedToolNames.has(call.name));
    if (restricted) {
      rejectSystemConfigCall(calls, options);
      return {
        emitAssistantText: false,
        rejected: toolCallErrors(
          calls,
          `${restricted.name} must be called without sibling assistant text in the same model response.`
        )
      };
    }
  }

  return {
    emitAssistantText: !calls.some((call) => call.name === SYSTEM_CONFIG_TOOL_NAME),
    rejected: undefined
  };
}

export function toolCallErrors(calls: ResponseFunctionCallItem[], error: string) {
  return calls.map((call) => ({
    type: "function_call_output",
    call_id: call.call_id,
    output: JSON.stringify({ ok: false, error })
  }));
}

export function rejectSystemConfigTurn(options: ProviderCompleteOptions) {
  if (!options.systemConfig?.turnRejected()) options.systemConfig?.rejectTurn();
}

function rejectInvalidSystemConfigState(
  calls: ResponseFunctionCallItem[],
  options: ProviderCompleteOptions,
  state: TurnToolState
) {
  if (options.systemConfig?.turnRejected()) return SYSTEM_CONFIG_TURN_SOLO_ERROR;
  if (options.systemConfig?.mutationStaged()) {
    rejectSystemConfigTurn(options);
    return SYSTEM_CONFIG_MUTATION_STAGED_ERROR;
  }
  if (state.acceptedToolNames.includes(SYSTEM_CONFIG_TOOL_NAME)) {
    rejectSystemConfigTurn(options);
    return SYSTEM_CONFIG_TURN_SOLO_ERROR;
  }
  if (
    calls.some((call) => call.name === SYSTEM_CONFIG_TOOL_NAME) &&
    (state.assistantTextSent || state.acceptedToolNames.length > 0 || state.terminal !== undefined)
  ) {
    rejectSystemConfigTurn(options);
    return SYSTEM_CONFIG_TURN_SOLO_ERROR;
  }
  return undefined;
}

function rejectSystemConfigCall(
  calls: ResponseFunctionCallItem[],
  options: ProviderCompleteOptions
) {
  if (calls.some((call) => call.name === SYSTEM_CONFIG_TOOL_NAME)) {
    rejectSystemConfigTurn(options);
  }
}

function restrictedBatchError(calls: ResponseFunctionCallItem[]) {
  if (calls.length <= 1) return undefined;
  if (calls.some((call) => call.name === SEND_FILE_TOOL_NAME)) {
    return "send_file must be called alone before any other tool.";
  }
  if (calls.some((call) => call.name === SYSTEM_CONFIG_TOOL_NAME)) {
    return SYSTEM_CONFIG_SOLO_ERROR;
  }
  if (calls.some((call) => isWorkbenchFileToolName(call.name))) {
    return "read_file and write_file must be called alone before any other tool.";
  }
  if (calls.some((call) => call.name === WORKSPACE_BASH_TOOL_NAME)) {
    return "workspace_bash must be called alone before any other tool.";
  }
  return undefined;
}
