export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";
export const WORKBENCH_FILE_PATH_MAX_BYTES = 1_024;
export const WORKBENCH_FILE_MAX_BYTES = 1_048_576;
export const WORKBENCH_FILE_MAX_CONTENT_LENGTH = 262_144;
const workbenchFilePathControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const workbenchFileTextControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export interface ReadFileInput {
  path: string;
}

export interface WriteFileInput {
  path: string;
  content: string;
  overwrite: boolean;
}

export interface WorkbenchFileSuccess {
  ok: true;
  path: string;
  byteLength: number;
  content?: string;
  created?: boolean;
  overwritten?: boolean;
}

export interface WorkbenchFileFailure {
  ok: false;
  code: WorkbenchFileErrorCode;
  error: string;
}

export type WorkbenchFileResult = WorkbenchFileSuccess | WorkbenchFileFailure;

export type WorkbenchFileErrorCode =
  | "WORKBENCH_FILE_PATH_INVALID"
  | "WORKBENCH_FILE_ARGUMENTS_INVALID"
  | "WORKBENCH_FILE_NOT_FOUND"
  | "WORKBENCH_FILE_EXISTS"
  | "WORKBENCH_FILE_CONFLICT"
  | "WORKBENCH_FILE_TOO_LARGE"
  | "WORKBENCH_FILE_TEXT_INVALID"
  | "WORKBENCH_FILE_FORBIDDEN"
  | "WORKBENCH_FILE_UNSAFE"
  | "WORKBENCH_FILE_UNAVAILABLE";

export function workbenchFilePublicMessage(code: WorkbenchFileErrorCode) {
  const messages: Record<WorkbenchFileErrorCode, string> = {
    WORKBENCH_FILE_PATH_INVALID: "Path must be a safe POSIX path relative to the current Agent workbench.",
    WORKBENCH_FILE_ARGUMENTS_INVALID: "File tool arguments are invalid.",
    WORKBENCH_FILE_NOT_FOUND: "The requested workbench file or parent directory does not exist.",
    WORKBENCH_FILE_EXISTS: "The requested workbench file already exists.",
    WORKBENCH_FILE_CONFLICT: "The workbench file changed during the operation.",
    WORKBENCH_FILE_TOO_LARGE: "The workbench text file exceeds the allowed size.",
    WORKBENCH_FILE_TEXT_INVALID: "The workbench file must contain bounded UTF-8 text.",
    WORKBENCH_FILE_FORBIDDEN: "The workbench file cannot be accessed.",
    WORKBENCH_FILE_UNSAFE: "The workbench path or file identity is unsafe.",
    WORKBENCH_FILE_UNAVAILABLE: "The workbench file operation is unavailable."
  };
  return messages[code];
}

export interface WorkbenchFileToolPort {
  read(input: unknown): Promise<WorkbenchFileResult>;
  write(input: unknown): Promise<WorkbenchFileResult>;
}

export type WorkbenchFileInputValidation<T> =
  | { ok: true; input: T; byteLength?: number }
  | { ok: false; code: WorkbenchFileErrorCode };

export type WorkbenchFileTextValidation =
  | { ok: true; content: string; byteLength: number }
  | { ok: false; code: WorkbenchFileErrorCode };

export function isWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isWorkbenchFileRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !isWellFormedUtf16(value)
    || value !== value.normalize("NFC")
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > WORKBENCH_FILE_PATH_MAX_BYTES
    || value.includes("\\")
    || workbenchFilePathControlCharacters.test(value)
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
  ) return false;
  const segments = value.split("/");
  return !segments.some((segment) => (
    !segment
    || segment === "."
    || segment === ".."
    || Buffer.byteLength(segment, "utf8") > 255
  ));
}

export function validateWorkbenchFileText(value: unknown): WorkbenchFileTextValidation {
  if (typeof value !== "string") {
    return { ok: false, code: "WORKBENCH_FILE_ARGUMENTS_INVALID" };
  }
  if (
    !isWellFormedUtf16(value)
    || value.length > WORKBENCH_FILE_MAX_CONTENT_LENGTH
    || workbenchFileTextControlCharacters.test(value)
  ) {
    return { ok: false, code: "WORKBENCH_FILE_TEXT_INVALID" };
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > WORKBENCH_FILE_MAX_BYTES) {
    return { ok: false, code: "WORKBENCH_FILE_TOO_LARGE" };
  }
  return { ok: true, content: value, byteLength };
}

export function validateReadFileInput(input: unknown): WorkbenchFileInputValidation<ReadFileInput> {
  const value = exactRecord(input, ["path"]);
  if (!value) return { ok: false, code: "WORKBENCH_FILE_ARGUMENTS_INVALID" };
  if (!isWorkbenchFileRelativePath(value.path)) {
    return { ok: false, code: "WORKBENCH_FILE_PATH_INVALID" };
  }
  return { ok: true, input: { path: value.path } };
}

export function validateWriteFileInput(input: unknown): WorkbenchFileInputValidation<WriteFileInput> {
  const value = exactRecord(input, ["path", "content", "overwrite"]);
  if (!value || typeof value.overwrite !== "boolean") {
    return { ok: false, code: "WORKBENCH_FILE_ARGUMENTS_INVALID" };
  }
  if (!isWorkbenchFileRelativePath(value.path)) {
    return { ok: false, code: "WORKBENCH_FILE_PATH_INVALID" };
  }
  const content = validateWorkbenchFileText(value.content);
  if (!content.ok) return content;
  return {
    ok: true,
    input: { path: value.path, content: content.content, overwrite: value.overwrite },
    byteLength: content.byteLength
  };
}

function exactRecord(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return undefined;
  }
  return value;
}

export const readFileTool = {
  type: "function",
  name: READ_FILE_TOOL_NAME,
  description: "Read a UTF-8 text file from the current Agent workbench.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: WORKBENCH_FILE_PATH_MAX_BYTES,
        description: "POSIX path relative to the current Agent workbench."
      }
    },
    required: ["path"]
  },
  strict: true
} as const;

export const writeFileTool = {
  type: "function",
  name: WRITE_FILE_TOOL_NAME,
  description: "Write a UTF-8 text file in the current Agent workbench.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: WORKBENCH_FILE_PATH_MAX_BYTES,
        description: "POSIX path relative to the current Agent workbench."
      },
      content: {
        type: "string",
        maxLength: WORKBENCH_FILE_MAX_CONTENT_LENGTH,
        description: "Complete UTF-8 text content to publish."
      },
      overwrite: {
        type: "boolean",
        description: "Replace an existing safe regular file when true."
      }
    },
    required: ["path", "content", "overwrite"]
  },
  strict: true
} as const;

export function isWorkbenchFileToolName(value: string) {
  return value === READ_FILE_TOOL_NAME || value === WRITE_FILE_TOOL_NAME;
}
