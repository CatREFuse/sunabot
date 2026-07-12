import type { ProviderCompleteOptions } from "./contracts.js";

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

export function toolCallLimitError(maximum: number) {
  return new Error(`工具调用超过上限：最多 ${maximum} 次。`);
}
