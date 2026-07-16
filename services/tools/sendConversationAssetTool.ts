import path from "node:path";
import type { PrepareOutboundConversationAssetInput } from "../delivery/public.js";

export const SEND_FILE_TOOL_NAME = "send_file";
export const SEND_VOICE_MESSAGE_TOOL_NAME = "send_voice_message";

export interface SendFileToolInput {
  path?: unknown;
  kind?: unknown;
  name?: unknown;
}

export interface SendVoiceMessageToolInput {
  path?: unknown;
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

export const sendVoiceMessageTool = {
  type: "function",
  name: SEND_VOICE_MESSAGE_TOOL_NAME,
  description: "Send an existing audio file from the current Agent workbench as a voice message to the current private or group conversation. The path must be relative to the Agent workbench.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1_024,
        description: "Path to a recognized audio file, relative to the current Agent workbench."
      }
    },
    required: ["path"]
  },
  strict: true
} as const;

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

export function readSendVoiceMessageInput(input: SendVoiceMessageToolInput): PrepareOutboundConversationAssetInput {
  return { path: readRelativePath(input.path), kind: "voice" };
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
