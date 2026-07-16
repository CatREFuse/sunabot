import type {
  ProviderAssistantTextSource,
  ProviderCompleteOptions,
  ResponseFunctionCallItem,
  TurnToolState
} from "./contracts.js";

export function createTurnToolState(): TurnToolState {
  return {
    toolCallCount: 0,
    assistantTextSent: false,
    acceptedToolNames: []
  };
}

export function withTurnToolState(
  options: ProviderCompleteOptions,
  state: TurnToolState
): ProviderCompleteOptions {
  if (!options.onAssistantText) return options;
  const deliver = options.onAssistantText;
  return {
    ...options,
    onAssistantText: async (text: string, source?: ProviderAssistantTextSource) => {
      await deliver(text, source);
      state.assistantTextSent = true;
    }
  };
}

export function hasAcceptedTurnActivity(state: TurnToolState) {
  return state.assistantTextSent || state.acceptedToolNames.length > 0 || state.terminal !== undefined;
}

export function markAcceptedTool(state: TurnToolState, name: string) {
  state.acceptedToolNames.push(name);
}

export function shouldEmitIntermediateAssistantText(
  calls: readonly ResponseFunctionCallItem[],
  options: ProviderCompleteOptions,
  state: TurnToolState,
  assistantTextPresent: boolean
) {
  if (
    assistantTextPresent &&
    calls.some((call) => call.name === "system_config") &&
    !options.systemConfig?.turnRejected()
  ) {
    options.systemConfig?.rejectTurn();
  }
  return !options.systemConfig?.mutationStaged() &&
    !options.systemConfig?.turnRejected() &&
    !state.acceptedToolNames.includes("system_config") &&
    !calls.some((call) => call.name === "system_config");
}

export function toolOrderingError(name: string) {
  return name === "no_reply"
    ? "no_reply must be called before assistant text or any other tool."
    : `Deferred tool ${name} must be called before assistant text or any other tool.`;
}
