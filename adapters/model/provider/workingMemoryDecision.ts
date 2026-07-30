import { ADD_WORKMEMORY_TOOL_NAME } from "../../../services/tools/addWorkMemoryTool.js";
import type { ProviderCompleteOptions } from "./contracts.js";

export function workingMemoryDecisionPending(options: ProviderCompleteOptions) {
  return options.workingMemory?.decisionRequired === true
    && options.workingMemory.decisionResolved?.() !== true;
}

export function assertWorkingMemoryDecisionResolved(options: ProviderCompleteOptions) {
  if (!workingMemoryDecisionPending(options)) return;
  throw Object.assign(
    new Error("The main reply model did not complete its required working-memory decision."),
    { code: "WORKING_MEMORY_DECISION_REQUIRED" }
  );
}

export function responsesWorkingMemoryToolChoice(options: ProviderCompleteOptions) {
  return workingMemoryDecisionPending(options)
    ? { type: "function" as const, name: ADD_WORKMEMORY_TOOL_NAME }
    : undefined;
}

export function chatWorkingMemoryToolChoice(options: ProviderCompleteOptions) {
  return workingMemoryDecisionPending(options)
    ? {
        type: "function" as const,
        function: { name: ADD_WORKMEMORY_TOOL_NAME }
      }
    : undefined;
}

export function anthropicWorkingMemoryToolChoice(options: ProviderCompleteOptions) {
  return workingMemoryDecisionPending(options)
    ? {
        type: "tool" as const,
        name: ADD_WORKMEMORY_TOOL_NAME,
        disable_parallel_tool_use: true
      }
    : undefined;
}

export function geminiWorkingMemoryToolConfig(options: ProviderCompleteOptions) {
  return workingMemoryDecisionPending(options)
    ? {
        functionCallingConfig: {
          mode: "ANY" as const,
          allowedFunctionNames: [ADD_WORKMEMORY_TOOL_NAME]
        }
      }
    : undefined;
}
