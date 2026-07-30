export const EXPORT_CHAT_MEDIA_TOOL_NAME = "export_chat_media";
export const IMPORT_CHAT_EMOJI_TOOL_NAME = "import_chat_emoji";
export const IMPORT_CHAT_SELFIE_TOOL_NAME = "import_chat_selfie";
export const CHAT_MEDIA_HANDLE_MAX_LENGTH = 512;

export interface ExportChatMediaInput {
  handle: string;
}

export interface ImportChatEmojiInput {
  handle: string;
  key: string;
}

export interface ImportChatSelfieInput {
  handle: string;
  note: string;
}

export interface ExportedChatMedia {
  ok: true;
  path: string;
  sha256: string;
  mimeType: string;
  extension: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  deduplicated: boolean;
}

export interface ImportedChatEmoji {
  ok: true;
  key: string;
  fileName: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  deduplicated: boolean;
}

export interface ImportedChatSelfie {
  ok: true;
  id: string;
  fileName: string;
  note: string;
  byteLength: number;
  width: number;
  height: number;
  deduplicated: boolean;
}

export interface ChatMediaToolPort {
  export(input: ExportChatMediaInput): Promise<ExportedChatMedia>;
  freezeCodexInputs?: (
    handles: readonly string[],
    jobDir: string
  ) => Promise<import("../../packages/contracts/tools/codex.js").FrozenCodexInputV1[]>;
  importEmoji?: (input: ImportChatEmojiInput) => Promise<ImportedChatEmoji>;
  importSelfie?: (input: ImportChatSelfieInput) => Promise<ImportedChatSelfie>;
}

export function readExportChatMediaInput(value: unknown): ExportChatMediaInput {
  const input = strictRecord(value, ["handle"]);
  return { handle: chatMediaHandle(input.handle) };
}

export function readImportChatEmojiInput(value: unknown): ImportChatEmojiInput {
  const input = strictRecord(value, ["handle", "key"]);
  const handle = chatMediaHandle(input.handle);
  if (!handle.includes(":image:")) {
    throw new Error("Chat emoji import requires an image handle.");
  }
  const key = typeof input.key === "string" ? input.key : "";
  if (!key || key.length > 24 || /[()\u0000-\u001f\u007f/\\]/u.test(key)) {
    throw new Error("Emoji key must be 1 to 24 characters and cannot contain brackets, slashes, or control characters.");
  }
  return {
    handle,
    key
  };
}

export function readImportChatSelfieInput(value: unknown): ImportChatSelfieInput {
  const input = strictRecord(value, ["handle", "note"]);
  const handle = chatMediaHandle(input.handle);
  if (!handle.includes(":image:")) {
    throw new Error("Chat selfie import requires an image handle.");
  }
  const note = typeof input.note === "string" ? input.note.normalize("NFC").trim() : "";
  if (!note || [...note].length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(note)) {
    throw new Error("Selfie reference note must be 1 to 120 characters without control characters.");
  }
  return { handle, note };
}

export const exportChatMediaTool = {
  type: "function",
  name: EXPORT_CHAT_MEDIA_TOOL_NAME,
  description: "Export one image or file from the current user message or an explicitly quoted message into the current Agent workbench. Use only an exact media handle shown in the current prompt. The tool never accepts a URL, local path, Agent ID, or destination path. It returns a relative workbench path, SHA-256, MIME type, extension, dimensions, and byte length. Native Bash can use the returned path directly; Docker Bash reads the same file through native-workbench/<path>.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      handle: {
        type: "string",
        minLength: 1,
        maxLength: CHAT_MEDIA_HANDLE_MAX_LENGTH,
        pattern: "^message:[0-9]+:(image|file):[0-9]+$",
        description: "An exact current-message or quoted-message handle shown in the prompt, such as message:1893632182:image:0."
      }
    },
    required: ["handle"]
  }
} as const;

export const importChatEmojiTool = {
  type: "function",
  name: IMPORT_CHAT_EMOJI_TOOL_NAME,
  description: "Import one exact image from the current user message or an explicitly quoted message into the current Agent emoji library. This mutating capability is available only in an authorized administrator QQ private chat or group chat. It validates the image, normalizes it, stores it under a SHA-256 name, deduplicates content, and atomically updates emojis.jsonl. Native and Docker resource views address the same authoritative catalog; do not edit emoji files or emojis.jsonl with Bash.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      handle: {
        type: "string",
        minLength: 1,
        maxLength: CHAT_MEDIA_HANDLE_MAX_LENGTH,
        pattern: "^message:[0-9]+:image:[0-9]+$",
        description: "An exact current-message or quoted-message image handle shown in the prompt."
      },
      key: {
        type: "string",
        minLength: 1,
        maxLength: 24,
        description: "The emoji key used in the Agent emoji catalog."
      }
    },
    required: ["handle", "key"]
  }
} as const;

export const importChatSelfieTool = {
  type: "function",
  name: IMPORT_CHAT_SELFIE_TOOL_NAME,
  description: "Import one exact image from the current user message or an explicitly quoted message into the current Agent selfie-reference library. This mutating capability is available only in an authorized administrator QQ private chat or group chat. Private chat writes the Native Workbench catalog; group chat writes the Docker Workbench catalog. It validates the image, stores it with a content-derived ID, deduplicates content, and atomically updates references.jsonl.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      handle: {
        type: "string",
        minLength: 1,
        maxLength: CHAT_MEDIA_HANDLE_MAX_LENGTH,
        pattern: "^message:[0-9]+:image:[0-9]+$",
        description: "An exact current-message or quoted-message image handle shown in the prompt."
      },
      note: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "A concrete note describing the character appearance, view, pose, clothing, or other useful selection cues."
      }
    },
    required: ["handle", "note"]
  }
} as const;

function chatMediaHandle(value: unknown) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > CHAT_MEDIA_HANDLE_MAX_LENGTH
    || !/^message:[0-9]+:(?:image|file):[0-9]+$/.test(value)
  ) {
    throw new Error("Chat media handle is invalid.");
  }
  return value;
}

function strictRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
  ) {
    throw new Error("Tool arguments contain unsupported fields.");
  }
  return input;
}
