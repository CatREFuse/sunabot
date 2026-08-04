import {
  ADD_USER_PROFILE_TOOL_NAME,
  ADD_WORKMEMORY_TOOL_NAME
} from "../../../services/tools/public.js";
import type { ProviderCompleteOptions } from "./contracts.js";

export function pendingMemoryDecisionToolName(options: ProviderCompleteOptions) {
  if (
    options.workingMemory?.decisionRequired === true
    && options.workingMemory.decisionResolved?.() !== true
  ) return ADD_WORKMEMORY_TOOL_NAME;
  if (
    options.userProfile?.decisionRequired === true
    && options.userProfile.decisionResolved?.() !== true
  ) return ADD_USER_PROFILE_TOOL_NAME;
  return undefined;
}

export function memoryToolDecisionPending(options: ProviderCompleteOptions) {
  return pendingMemoryDecisionToolName(options) !== undefined;
}

export function assertMemoryToolDecisionsResolved(options: ProviderCompleteOptions) {
  const pending = pendingMemoryDecisionToolName(options);
  if (!pending) return;
  throw Object.assign(
    new Error(`The main reply model did not complete its required ${pending} decision.`),
    { code: pending === ADD_WORKMEMORY_TOOL_NAME
      ? "WORKING_MEMORY_DECISION_REQUIRED"
      : "USER_PROFILE_DECISION_REQUIRED" }
  );
}

export function responsesMemoryToolChoice(options: ProviderCompleteOptions) {
  const name = pendingMemoryDecisionToolName(options);
  return name ? { type: "function" as const, name } : undefined;
}

export function chatMemoryToolChoice(options: ProviderCompleteOptions) {
  const name = pendingMemoryDecisionToolName(options);
  return name
    ? {
        type: "function" as const,
        function: { name }
      }
    : undefined;
}

export function anthropicMemoryToolChoice(options: ProviderCompleteOptions) {
  const name = pendingMemoryDecisionToolName(options);
  return name
    ? {
        type: "tool" as const,
        name,
        disable_parallel_tool_use: true
      }
    : undefined;
}

export function geminiMemoryToolConfig(options: ProviderCompleteOptions) {
  const name = pendingMemoryDecisionToolName(options);
  return name
    ? {
        functionCallingConfig: {
          mode: "ANY" as const,
          allowedFunctionNames: [name]
        }
      }
    : undefined;
}
