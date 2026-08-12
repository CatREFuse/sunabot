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
    if (!visibleSibling) {
      throw voiceContractError(
        "send_voice_message requires accompanying visible assistant text.",
      );
    }
    assertSameVoiceText(visibleSibling, voiceInput.text);
    return {
      source: "text",
      text: visibleSibling,
      voiceCall,
    };
  }

  if (calls.length !== 2 || voiceCall !== calls[1] || visibleSibling) {
    throw voiceContractError(
      "send_voice_message must follow exactly one assistant_text or deferred tool call without sibling text.",
    );
  }

  const sourceCall = calls[0]!;
  const sourceArguments = readCallArguments(sourceCall);
  if (sourceCall.name === ASSISTANT_TEXT_TOOL_NAME) {
    if (!hasExactKeys(sourceArguments, ["text"])) {
      throw voiceContractError(
        "assistant_text companion arguments must contain only text.",
      );
    }
    const sourceText = readAssistantText(sourceArguments);
    if (!sourceText)
      throw voiceContractError("assistant_text companion text is empty.");
    assertSameVoiceText(sourceText, voiceInput.text);
    return {
      source: "assistant_text",
      text: sourceText,
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
  assertSameVoiceText(dispatch.message, voiceInput.text);
  return {
    source: "dispatch_message",
    text: dispatch.message,
    voiceCall,
    sourceCall,
    deferred: {
      name: sourceCall.name,
      callId: sourceCall.call_id,
      arguments: dispatch.workerArguments,
    },
  };
}

export function voiceReadableText(value: string) {
  return value
    .replace(/(^|[^\\])\[\/[^\]\r\n]{1,64}\]/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
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

function assertSameVoiceText(sourceText: string, voiceText: string) {
  const source = voiceReadableText(sourceText);
  const voice = voiceReadableText(voiceText);
  if (!source || source !== voice) {
    throw voiceContractError(
      "send_voice_message text must exactly match the accompanying human-readable assistant text.",
    );
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function voiceContractError(message: string) {
  const error = new Error(message);
  error.name = "VoiceCompanionContractError";
  return error;
}
