import { SEND_VOICE_MESSAGE_TOOL_NAME } from "../../../services/tools/sendConversationAssetTool.js";
import { ASSISTANT_TEXT_TOOL_NAME } from "../../../services/tools/assistantTextTool.js";
import {
  isProviderDeferredTool,
  isProviderToolAvailable,
} from "../../../services/tools/toolRegistry.js";
import type {
  ProviderCompleteOptions,
  ProviderCompletedTurn,
  ProviderDeferredTurn,
  ResponseFunctionCallItem,
  TurnToolState,
} from "./contracts.js";
import { readToolName } from "./promptMapping.js";
import { hasAcceptedTurnActivity, markAcceptedTool } from "./turnToolState.js";
import { parseVoiceCompanion } from "./voiceCompanion.js";

export function providerVoiceCompanionTurn(
  calls: ResponseFunctionCallItem[],
  siblingText: string,
  options: ProviderCompleteOptions,
  definitions: readonly Record<string, unknown>[],
  state: TurnToolState,
): ProviderCompletedTurn | ProviderDeferredTurn | null {
  const deliveredAssistantText = crossRoundAssistantText(calls, siblingText, state);
  const companion = parseVoiceCompanion(calls, deliveredAssistantText?.text ?? siblingText, (name) =>
    isProviderDeferredTool(name, options),
  );
  if (!companion) return null;
  if (
    options.systemConfig?.mutationStaged() ||
    options.systemConfig?.turnRejected() ||
    state.acceptedToolNames.includes("system_config") ||
    (hasAcceptedTurnActivity(state) && !deliveredAssistantText)
  ) {
    throw new Error(
      "send_voice_message must be the first accepted activity in the provider turn.",
    );
  }
  assertEnabled(SEND_VOICE_MESSAGE_TOOL_NAME, options, definitions);
  if (!options.voice?.enabled) {
    throw new Error(
      "send_voice_message is unavailable for the current conversation.",
    );
  }
  if (!options.voice.languages.includes(companion.language)) {
    throw new Error(
      `send_voice_message language ${companion.language} is not configured.`,
    );
  }
  if (companion.sourceCall)
    acceptCall(companion.sourceCall.name, options, definitions, state);
  acceptCall(SEND_VOICE_MESSAGE_TOOL_NAME, options, definitions, state);
  state.terminal = "voice";
  const voice = {
    text: companion.text,
    language: companion.language,
    callId: companion.voiceCall.call_id,
    toolName: SEND_VOICE_MESSAGE_TOOL_NAME,
  } as const;
  return companion.deferred
    ? {
        kind: "deferred",
        acknowledgement: companion.text,
        toolCall: companion.deferred,
        voice,
      }
    : {
        kind: "completed",
        text: companion.text,
        ...(companion.source === "assistant_text"
          ? { messageOrigin: "assistant_text" as const }
          : {}),
        ...(deliveredAssistantText
          ? {
              messageOrigin: "assistant_text" as const,
              textAlreadyDelivered: true as const,
            }
          : {}),
        voice,
      };
}

function crossRoundAssistantText(
  calls: readonly ResponseFunctionCallItem[],
  siblingText: string,
  state: TurnToolState,
) {
  if (
    siblingText.trim() ||
    calls.length !== 1 ||
    calls[0]?.name !== SEND_VOICE_MESSAGE_TOOL_NAME ||
    state.assistantTextDeliveryCount !== 1 ||
    state.acceptedToolNames.length !== 1 ||
    state.acceptedToolNames[0] !== ASSISTANT_TEXT_TOOL_NAME ||
    state.terminal !== undefined ||
    state.deliveredAssistantText?.source !== "assistant_text"
  ) {
    return undefined;
  }
  return state.deliveredAssistantText;
}

function acceptCall(
  name: string,
  options: ProviderCompleteOptions,
  definitions: readonly Record<string, unknown>[],
  state: TurnToolState,
) {
  assertEnabled(name, options, definitions);
  options.onToolCall?.(name);
  markAcceptedTool(state, name);
}

function assertEnabled(
  name: string,
  options: ProviderCompleteOptions,
  definitions: readonly Record<string, unknown>[],
) {
  if (!isProviderToolAvailable(name, options))
    throw new Error(`Tool ${name} is unavailable.`);
  if (!definitions.some((definition) => readToolName(definition) === name)) {
    throw new Error(`Tool ${name} is not enabled for this prompt.`);
  }
}
