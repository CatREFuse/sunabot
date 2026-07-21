import {
  READ_FILE_TOOL_NAME,
  SEND_FILE_TOOL_NAME,
  SYSTEM_CONFIG_TOOL_NAME,
  CRON_TOOL_NAME,
  WORKSPACE_BASH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  READ_SKILL_RESOURCE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
  MEMORY_RECALL_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  CODEX_TOOL_NAME,
  GENERATE_IMG_TOOL_NAME,
  SELFIE_TOOL_NAME,
  WEBFETCH_TOOL_NAME,
  WEBSEARCH_TOOL_NAME,
  isWorkbenchFileToolName
} from "../../../services/tools/public.js";
import { isMcpToolAlias } from "../../../services/extensions/public.js";
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
export const LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR =
  "Local data tools and outbound network tools cannot be combined in the same provider turn.";

const localDataTools = new Set([
  SYSTEM_CONFIG_TOOL_NAME,
  CRON_TOOL_NAME,
  SEND_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WORKSPACE_BASH_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  READ_SKILL_RESOURCE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
  MEMORY_RECALL_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME
]);

const outboundNetworkTools = new Set([
  WEBSEARCH_TOOL_NAME,
  WEBFETCH_TOOL_NAME,
  CODEX_TOOL_NAME,
  GENERATE_IMG_TOOL_NAME,
  SELFIE_TOOL_NAME
]);

const restrictedToolNames = new Set([
  SYSTEM_CONFIG_TOOL_NAME,
  CRON_TOOL_NAME,
  SEND_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WORKSPACE_BASH_TOOL_NAME,
  ACTIVATE_SKILL_TOOL_NAME,
  READ_SKILL_RESOURCE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME
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

  if (hasLocalOutboundBatchConflict(calls, options) ||
      calls.some((call) => localOutboundTurnConflict(call.name, state, options))) {
    return {
      emitAssistantText: false,
      rejected: toolCallErrors(calls, LOCAL_DATA_OUTBOUND_TURN_CONFLICT_ERROR)
    };
  }

  if (siblingText.trim()) {
    const restricted = calls.find((call) => restrictedToolNames.has(call.name) || isMcpToolAlias(call.name));
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

export function localOutboundTurnConflict(
  name: string,
  state: TurnToolState,
  options: ProviderCompleteOptions
) {
  const current = toolBoundary(name, options);
  return state.acceptedToolNames.some((accepted) =>
    toolBoundariesConflict(current, toolBoundary(accepted, options)));
}

function hasLocalOutboundBatchConflict(
  calls: ResponseFunctionCallItem[],
  options: ProviderCompleteOptions
) {
  const boundaries = calls.map((call) => toolBoundary(call.name, options));
  return boundaries.some((left, index) => boundaries.slice(index + 1)
    .some((right) => toolBoundariesConflict(left, right)));
}

interface ToolBoundary {
  kind: "local_data" | "outbound_network" | "ordinary";
  mcpServerId?: string;
}

function toolBoundary(name: string, options: ProviderCompleteOptions): ToolBoundary {
  if (localDataTools.has(name)) return { kind: "local_data" };
  if (outboundNetworkTools.has(name)) return { kind: "outbound_network" };
  if (!isMcpToolAlias(name)) return { kind: "ordinary" };
  try {
    const described = options.mcp?.describe(name);
    if (!described || !described.serverId ||
        (described.transport !== "stdio" && described.transport !== "streamable_http")) {
      return { kind: "outbound_network", mcpServerId: `unresolved:${name}` };
    }
    return {
      kind: described.transport === "stdio" ? "local_data" : "outbound_network",
      mcpServerId: described.serverId
    };
  } catch {
    return { kind: "outbound_network", mcpServerId: `unresolved:${name}` };
  }
}

function toolBoundariesConflict(left: ToolBoundary, right: ToolBoundary) {
  if (left.kind !== "ordinary" && right.kind !== "ordinary" && left.kind !== right.kind) return true;
  return left.mcpServerId !== undefined && right.mcpServerId !== undefined &&
    left.mcpServerId !== right.mcpServerId;
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
  if (calls.some((call) => call.name === CRON_TOOL_NAME)) {
    return "cron must be called alone before any other tool.";
  }
  if (calls.some((call) => isWorkbenchFileToolName(call.name))) {
    return "read_file and write_file must be called alone before any other tool.";
  }
  if (calls.some((call) => call.name === WORKSPACE_BASH_TOOL_NAME)) {
    return "workspace_bash must be called alone before any other tool.";
  }
  if (calls.some((call) => call.name === ACTIVATE_SKILL_TOOL_NAME)) {
    return "activate_skill must be called alone before any other tool.";
  }
  if (calls.some((call) => call.name === READ_SKILL_RESOURCE_TOOL_NAME)) {
    return "read_skill_resource must be called alone before any other tool.";
  }
  if (calls.some((call) => call.name === RUN_SKILL_SCRIPT_TOOL_NAME)) {
    return "run_skill_script must be called alone before any other tool.";
  }
  if (calls.some((call) => isMcpToolAlias(call.name))) {
    return "MCP tools must be called alone before any other tool.";
  }
  return undefined;
}
