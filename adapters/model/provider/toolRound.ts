import type {
  ProviderCompleteOptions,
  ProviderToolExecutorPort,
  ProviderTurnResult,
  ResponseFunctionCallItem,
  TurnToolState
} from "./contracts.js";
import { preflightProviderToolResponse } from "./toolResponsePreflight.js";

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

  const preflight = preflightProviderToolResponse(calls, siblingText, options, state);
  if (!preflight.rejected) {
    const deferred = executor.deferredTurn(calls, options, definitions, state);
    if (deferred) return { terminal: deferred };
    const noReply = await executor.noReplyTurn(calls, options, definitions, state);
    if (noReply) return { terminal: noReply };
    if (preflight.emitAssistantText) await input.emitAssistantText();
  }

  return {
    outputs: preflight.rejected ?? await executor.execute(calls, options, definitions, state)
  };
}
