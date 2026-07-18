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
  language?: unknown;
}

export interface SendVoiceMessageInput {
  text: string;
  language: VoiceLanguage;
}

export const sendFileTool = {
  type: "function",
  name: SEND_FILE_TOOL_NAME,
  description: "Send an existing file or image from the current Agent workbench to the current private or group conversation. The path must be relative to the Agent workbench. Use image for visible chat images, file for downloadable attachments, or auto to detect images and otherwise send a file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1_024,
        description: "Path relative to the current Agent workbench."
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
  languages: readonly VoiceLanguage[] = VOICE_LANGUAGES,
  defaultLanguage: VoiceLanguage = DEFAULT_VOICE_LANGUAGE
) {
  const availableLanguages = VOICE_LANGUAGES.filter((language) => languages.includes(language));
  const effectiveLanguages = availableLanguages.length ? availableLanguages : [defaultLanguage];
  return {
    type: "function",
    name: SEND_VOICE_MESSAGE_TOOL_NAME,
    description: "Create a cloned-voice reading of the same visible assistant message and send it immediately after that text. Use it at most once, only for a meaningful greeting, intimate or loving expression, intense emotion, shyness, or an important milestone. Never use it for routine facts, progress, errors, code, URLs, or long content. The text must exactly match the accompanying human-readable assistant text, excluding emoji markers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_VOICE_TOOL_TEXT_CHARS,
          description: "The exact human-readable assistant text to read aloud, excluding emoji markers."
        },
        language: {
          type: "string",
          enum: effectiveLanguages,
          description: `Voice language. Use ${effectiveLanguages.includes(defaultLanguage) ? defaultLanguage : effectiveLanguages[0]} unless the response itself uses another configured language.`
        }
      },
      required: ["text", "language"]
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
  if (keys.length !== 2 || keys[0] !== "language" || keys[1] !== "text") {
    throw new Error("send_voice_message arguments must contain only text and language.");
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
  if (typeof input.language !== "string" || !VOICE_LANGUAGES.includes(input.language as VoiceLanguage)) {
    throw new Error("send_voice_message language must be zh, en, or ja.");
  }
  return { text, language: input.language as VoiceLanguage };
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
