import type {
  ProviderCompleteOptions,
  ProviderToolExecutorPort,
  ProviderTurnResult,
  ResponseFunctionCallItem,
  TurnToolState
} from "./contracts.js";
import { NO_REPLY_TOOL_NAME } from "../../../services/tools/noReplyTool.js";
import { ASSISTANT_TEXT_TOOL_NAME } from "../../../services/tools/assistantTextTool.js";
import { ADD_WORKMEMORY_TOOL_NAME } from "../../../services/tools/addWorkMemoryTool.js";
import { ADD_USER_PROFILE_TOOL_NAME } from "../../../services/tools/addUserProfileTool.js";
import {
  assertMemoryToolDecisionsResolved,
  memoryToolDecisionPending
} from "./memoryToolDecisions.js";

interface ProcessProviderToolRoundInput {
  calls: ResponseFunctionCallItem[];
  siblingText: string;
  options: ProviderCompleteOptions;
  definitions: readonly Record<string, unknown>[];
  state: TurnToolState;
  executor: ProviderToolExecutorPort;
  emitAssistantText(): Promise<void>;
}

export type ProviderToolRoundResult =
  | { terminal: ProviderTurnResult; outputs?: never }
  | { terminal?: never; outputs: Array<Record<string, unknown>> };

export async function processProviderToolRound(
  input: ProcessProviderToolRoundInput
): Promise<ProviderToolRoundResult> {
  const {
    calls,
    siblingText,
    options,
    definitions,
    state,
    executor
  } = input;
  const memoryDecisionWasPending = memoryToolDecisionPending(options);
  const companion = executor.companionTurn(calls, siblingText, options, definitions, state);
  if (companion) {
    assertMemoryToolDecisionsResolved(options);
    return { terminal: companion };
  }

  const deferred = executor.deferredTurn(calls, options, definitions, state);
  const noReply = deferred
    ? null
    : await executor.noReplyTurn(calls, options, definitions, state);
  if (deferred || noReply) {
    const terminalCalls = deferred
      ? new Set([deferred.toolCall.callId])
      : new Set(calls
        .filter((call) => call.name === NO_REPLY_TOOL_NAME)
        .map((call) => call.call_id));
    const inlineCalls = calls.filter((call) =>
      !terminalCalls.has(call.call_id) && call.name !== ASSISTANT_TEXT_TOOL_NAME
    );
    if (inlineCalls.length) {
      await executor.execute(inlineCalls, options, definitions, state);
    }
    assertMemoryToolDecisionsResolved(options);
    return { terminal: deferred ?? noReply! };
  }

  if (siblingText.trim() && !memoryDecisionWasPending) await input.emitAssistantText();
  const outputs = await executor.execute(calls, options, definitions, state);
  if (
    memoryDecisionWasPending
    && !memoryToolDecisionPending(options)
    && siblingText.trim()
    && calls.length === 1
    && (
      calls[0]?.name === ADD_WORKMEMORY_TOOL_NAME
      || calls[0]?.name === ADD_USER_PROFILE_TOOL_NAME
    )
  ) {
    return {
      terminal: {
        kind: "completed",
        text: siblingText
      }
    };
  }
  return { outputs };
}
