import type {
  ProviderCompleteOptions,
  ProviderToolExecutorPort,
  ProviderTurnResult,
  ResponseFunctionCallItem,
  TurnToolState
} from "./contracts.js";
import { NO_REPLY_TOOL_NAME } from "../../../services/tools/noReplyTool.js";
import { ASSISTANT_TEXT_TOOL_NAME } from "../../../services/tools/assistantTextTool.js";

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
  const companion = executor.companionTurn(calls, siblingText, options, definitions, state);
  if (companion) return { terminal: companion };

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
    return { terminal: deferred ?? noReply! };
  }

  if (siblingText.trim()) await input.emitAssistantText();
  return {
    outputs: await executor.execute(calls, options, definitions, state)
  };
}
