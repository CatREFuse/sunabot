import type { ProviderCompleteOptions } from "./contracts.js";
import type { ResponseFunctionCallItem } from "./contracts.js";
import { ADD_WORKMEMORY_TOOL_NAME } from "../../../services/tools/addWorkMemoryTool.js";
import { ADD_USER_PROFILE_TOOL_NAME } from "../../../services/tools/addUserProfileTool.js";

const DEFAULT_MAX_TOOL_CALLS = 20;
const MAX_CONFIGURED_TOOL_CALLS = 100;

export function resolveMaxToolCalls(options: ProviderCompleteOptions) {
  const value = Number(options.bot?.tools.maxCalls ?? DEFAULT_MAX_TOOL_CALLS);
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOOL_CALLS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_CONFIGURED_TOOL_CALLS);
}

export function claimToolCalls(current: number, additional: number, maximum: number) {
  if (current + additional > maximum) throw toolCallLimitError(maximum);
  return current + additional;
}

export function claimBusinessToolCalls(
  current: number,
  calls: readonly ResponseFunctionCallItem[],
  maximum: number
) {
  const additional = calls.filter((call) =>
    call.name !== ADD_WORKMEMORY_TOOL_NAME
    && call.name !== ADD_USER_PROFILE_TOOL_NAME
  ).length;
  return claimToolCalls(current, additional, maximum);
}

export function resolveToolRoundLimit(
  options: ProviderCompleteOptions,
  maximum: number
) {
  const dedicatedMemoryRounds = [
    options.workingMemory,
    options.userProfile
  ].filter((port) =>
    port?.decisionRequired === true
    && port.decisionResolved?.() !== true
  ).length;
  return maximum + dedicatedMemoryRounds;
}

export function toolCallLimitError(maximum: number) {
  return new Error(`工具调用超过上限：最多 ${maximum} 次。`);
}
