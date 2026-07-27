import path from "node:path";
import type { PrepareOutboundConversationAssetInput } from "../delivery/public.js";
import {
  DEFAULT_VOICE_LANGUAGE,
  MAX_VOICE_TOOL_TEXT_CHARS,
  VOICE_LANGUAGES,
  type VoiceLanguage
} from "../voice/public.js";

export const SEND_FILE_TOOL_NAME = "send_file";
export const SEND_VOICE_MESSAGE_TOOL_NAME = "send_voice_message";

export interface SendFileToolInput {
  path?: unknown;
  kind?: unknown;
  name?: unknown;
}

export interface SendVoiceMessageToolInput {
  text?: unknown;
}

export interface SendVoiceMessageInput {
  text: string;
}

export const LEGACY_SEND_FILE_TOOL_DESCRIPTION = "Send an existing file or image from the current conversation workbench to the current private or group conversation. Administrator private chat prefers the Native workbench and may return a same-Agent Docker workbench file when the relative path is absent from Native; group chats and ordinary private chats use only the isolated Docker workbench. The path must be relative to the selected workbench. Use image for visible chat images, file for downloadable attachments, or auto to detect images and otherwise send a file.";

export const sendFileTool = {
  type: "function",
  name: SEND_FILE_TOOL_NAME,
  description: "Send an existing file or image from the current conversation workbench to the current private or group conversation. A portable knowledge/... relative path always resolves from the current Agent's indexed Native knowledge directory and can be sent from any permitted conversation. Other relative paths use the current conversation workbench: administrator private chat prefers Native and may return a same-Agent Docker file when absent from Native; group chats and ordinary private chats use Docker only. Use image for visible chat images, file for downloadable attachments, or auto to detect images and otherwise send a file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1_024,
        description: "Path relative to the current Agent workbench, or a portable knowledge/... path for an indexed knowledge image."
      },
      kind: {
        type: "string",
        enum: ["auto", "file", "image"],
        description: "How to send the asset. Use auto unless the user explicitly needs an image or downloadable file."
      },
      name: {
        type: ["string", "null"],
        minLength: 1,
        maxLength: 255,
        description: "Optional displayed file name. Use null to keep the source file name."
      }
    },
    required: ["path", "kind", "name"]
  },
  strict: true
} as const;

export function createSendVoiceMessageTool(
  _languages: readonly VoiceLanguage[] = VOICE_LANGUAGES,
  _defaultLanguage: VoiceLanguage = DEFAULT_VOICE_LANGUAGE
) {
  return {
    type: "function",
    name: SEND_VOICE_MESSAGE_TOOL_NAME,
    description: "Create a synthesized-voice reading as a companion to the same visible assistant message. Use it at most once, only for a meaningful greeting, intimate or loving expression, intense emotion, shyness, or an important milestone. Never use it for routine facts, progress, errors, code, URLs, or long content. Pass only the exact human-readable assistant text, excluding emoji markers. The Voice Profile selects the synthesis language and online voice independently from the conversation language. If matching text was sent through assistant_text earlier in the current turn, the next model response may contain only send_voice_message.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_VOICE_TOOL_TEXT_CHARS,
          description: "The exact human-readable assistant text to read aloud, excluding emoji markers."
        }
      },
      required: ["text"]
    },
    strict: true
  } as const;
}

export const sendVoiceMessageTool = createSendVoiceMessageTool();

export function readSendFileInput(input: SendFileToolInput): PrepareOutboundConversationAssetInput {
  const unsupported = Object.keys(input).filter((key) => key !== "path" && key !== "kind" && key !== "name");
  if (unsupported.length) throw new Error("send_file arguments contain unsupported fields.");
  if (!["path", "kind", "name"].every((key) => Object.prototype.hasOwnProperty.call(input, key))) {
    throw new Error("send_file arguments must include path, kind, and name.");
  }
  const assetPath = readRelativePath(input.path);
  const kind = input.kind;
  if (kind !== "auto" && kind !== "file" && kind !== "image") {
    throw new Error("send_file kind must be auto, file, or image.");
  }
  if (input.name !== null && input.name !== undefined && typeof input.name !== "string") {
    throw new Error("send_file name must be a string or null.");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (typeof input.name === "string" && (
    !name ||
    name.length > 255 ||
    /[\0-\x1f\x7f/\\]/.test(name) ||
    path.posix.basename(name) !== name ||
    path.win32.basename(name) !== name
  )) {
    throw new Error("send_file name must be a valid file name between 1 and 255 characters.");
  }
  return { path: assetPath, kind, ...(name ? { name } : {}) };
}

export function readSendVoiceMessageInput(input: SendVoiceMessageToolInput): SendVoiceMessageInput {
  const keys = Object.keys(input).sort();
  if (keys.length !== 1 || keys[0] !== "text") {
    throw new Error("send_voice_message arguments must contain only text.");
  }
  if (typeof input.text !== "string") {
    throw new Error("send_voice_message text must be a string.");
  }
  const text = input.text.trim();
  if (!text) throw new Error("send_voice_message text is required.");
  if (text.includes("\0")) throw new Error("send_voice_message text contains unsupported characters.");
  if ([...text].length > MAX_VOICE_TOOL_TEXT_CHARS) {
    throw new Error(`send_voice_message text must not exceed ${MAX_VOICE_TOOL_TEXT_CHARS} characters.`);
  }
  return { text };
}

function readRelativePath(value: unknown) {
  if (typeof value !== "string") throw new Error("Conversation asset path must be a string.");
  const assetPath = value.trim();
  if (!assetPath) throw new Error("Conversation asset path is required.");
  if (assetPath.length > 1_024) throw new Error("Conversation asset path is too long.");
  if (assetPath.includes("\\")) {
    throw new Error("Conversation asset path must use POSIX separators.");
  }
  if (path.posix.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) {
    throw new Error("Conversation asset path must be relative to the Agent workbench.");
  }
  if (assetPath.split(/[\\/]/).includes("..")) {
    throw new Error("Conversation asset path must not contain traversal segments.");
  }
  return assetPath;
}
