import type {
  ProviderAssistantTextSource,
  ProviderCompleteOptions,
  TurnToolState
} from "./contracts.js";

export function createTurnToolState(): TurnToolState {
  return {
    toolCallCount: 0,
    assistantTextSent: false,
    assistantTextDeliveryCount: 0,
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
      state.assistantTextDeliveryCount += 1;
      state.deliveredAssistantText = {
        text,
        source: source ?? "text"
      };
    }
  };
}

export function markAcceptedTool(state: TurnToolState, name: string) {
  state.acceptedToolNames.push(name);
}
