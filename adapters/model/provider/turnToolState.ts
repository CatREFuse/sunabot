import type {
  ProviderAssistantTextSource,
  ProviderCompleteOptions,
  ProviderCompletedTurn,
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

export function completeProviderText(
  text: string | undefined,
  state: TurnToolState,
  options: ProviderCompleteOptions
): ProviderCompletedTurn {
  if (text) return { kind: "completed", text };
  const delivered = state.deliveredAssistantText;
  if (delivered && !options.systemConfig?.mutationStaged()) {
    return {
      kind: "completed",
      text: delivered.text,
      messageOrigin: delivered.source,
      textAlreadyDelivered: true
    };
  }
  throw new Error("模型没有返回可发送内容。");
}
