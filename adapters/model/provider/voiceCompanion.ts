import {
  ASSISTANT_TEXT_TOOL_NAME,
  readAssistantText,
} from "../../../services/tools/assistantTextTool.js";
import {
  SEND_VOICE_MESSAGE_TOOL_NAME,
  readSendVoiceMessageInput,
} from "../../../services/tools/sendConversationAssetTool.js";
import { readDeferredDispatchMessage } from "../../../services/tools/deferredDispatch.js";
import type { ResponseFunctionCallItem } from "./contracts.js";
import { parseJson } from "./valueUtils.js";

export type VoiceCompanionSource =
  | "text"
  | "assistant_text"
  | "dispatch_message";

export interface ParsedVoiceCompanion {
  source: VoiceCompanionSource;
  text: string;
  voiceText: string;
  voiceCall: ResponseFunctionCallItem;
  sourceCall?: ResponseFunctionCallItem;
  deferred?: {
    name: string;
    callId: string;
    arguments: Record<string, unknown>;
  };
}

export function parseVoiceCompanion(
  calls: readonly ResponseFunctionCallItem[],
  siblingText: string,
  isDeferredTool: (name: string) => boolean,
): ParsedVoiceCompanion | undefined {
  const voiceCalls = calls.filter(
    (call) => call.name === SEND_VOICE_MESSAGE_TOOL_NAME,
  );
  if (!voiceCalls.length) return undefined;
  if (voiceCalls.length !== 1)
    throw voiceContractError("send_voice_message may be called at most once.");

  const voiceCall = voiceCalls[0]!;
  const voiceInput = readVoiceCall(voiceCall);
  const visibleSibling = siblingText.trim();

  if (calls.length === 1) {
    return {
      source: "text",
      text: visibleSibling || voiceInput.text,
      voiceText: voiceInput.text,
      voiceCall,
    };
  }

  if (calls.length !== 2) {
    throw voiceContractError(
      "send_voice_message supports one accompanying assistant_text or deferred tool call.",
    );
  }

  const sourceCall = calls.find((call) => call !== voiceCall)!;
  const sourceArguments = readCallArguments(sourceCall);
  if (sourceCall.name === ASSISTANT_TEXT_TOOL_NAME) {
    const sourceText = readAssistantText(sourceArguments);
    if (!sourceText)
      throw voiceContractError("assistant_text companion text is empty.");
    return {
      source: "assistant_text",
      text: [visibleSibling, sourceText].filter(Boolean).join("\n"),
      voiceText: voiceInput.text,
      voiceCall,
      sourceCall,
    };
  }

  if (!isDeferredTool(sourceCall.name)) {
    throw voiceContractError(
      "send_voice_message can accompany only visible text, assistant_text, or a deferred dispatch_message.",
    );
  }
  const dispatch = readDeferredDispatchMessage(
    sourceArguments,
    sourceCall.name,
  );
  if (!dispatch.ok) throw voiceContractError(dispatch.error);
  return {
    source: "dispatch_message",
    text: [visibleSibling, dispatch.message].filter(Boolean).join("\n"),
    voiceText: voiceInput.text,
    voiceCall,
    sourceCall,
    deferred: {
      name: sourceCall.name,
      callId: sourceCall.call_id,
      arguments: dispatch.workerArguments,
    },
  };
}

function readVoiceCall(call: ResponseFunctionCallItem) {
  try {
    return readSendVoiceMessageInput(readCallArguments(call));
  } catch (error) {
    throw voiceContractError(
      error instanceof Error
        ? error.message
        : "Invalid send_voice_message arguments.",
    );
  }
}

function readCallArguments(call: ResponseFunctionCallItem) {
  const value = parseJson(call.arguments);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw voiceContractError(`Invalid tool arguments for ${call.name}.`);
  }
  return value as Record<string, unknown>;
}

function voiceContractError(message: string) {
  const error = new Error(message);
  error.name = "VoiceCompanionContractError";
  return error;
}
