import type { PromptVariableDefinition } from "../types";

export interface PromptMessage {
  role: string;
  content: string;
}

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface FinalPromptDocument extends Record<string, unknown> {
  messages: Array<PromptMessage | string>;
  tools?: FunctionTool[];
  response_format: Record<string, unknown>;
}

export interface FinalPromptValidationResult {
  valid: boolean;
  message: string;
}

const EXACT_VARIABLE_PATTERN = /^(?:\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}|@\{\s*([A-Za-z_][\w.-]*)\s*\})$/;
const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant"]);
const RESPONSE_FORMAT_TYPES = new Set(["text", "json_object", "json_schema"]);

export function parseFinalPromptDocument(value: string): { document: FinalPromptDocument | null; error: string } {
  try {
    const document = JSON.parse(value);
    if (!isRecord(document) || !Array.isArray(document.messages) || !isRecord(document.response_format)) {
      return { document: null, error: "需要 messages 数组和 response_format 对象" };
    }
    return { document: document as FinalPromptDocument, error: "" };
  } catch (error) {
    return { document: null, error: error instanceof Error ? error.message : "JSON 格式错误" };
  }
}

export function validateFinalPromptDocument(
  value: string,
  variables: readonly PromptVariableDefinition[]
): FinalPromptValidationResult {
  const parsed = parseFinalPromptDocument(value);
  if (!parsed.document) return invalid(parsed.error);
  const document = parsed.document;
  if (!document.messages.length) return invalid("messages 不能为空");

  const messageGroups = new Set(variables.filter((variable) => variable.type === "message[]").map((variable) => variable.name));
  let hasSystem = false;
  let hasUser = false;
  for (const [index, message] of document.messages.entries()) {
    if (typeof message === "string") {
      const name = messageGroupVariableName(message);
      if (!name) return invalid(`消息组 ${index + 1} 必须是完整变量`);
      if (!messageGroups.has(name)) return invalid(`消息组 ${index + 1} 必须使用 message[] 变量`);
      continue;
    }
    if (!isRecord(message) || !MESSAGE_ROLES.has(String(message.role)) || typeof message.content !== "string") {
      return invalid(`消息 ${index + 1} 需要有效的 role 和文本 content`);
    }
    if (message.role === "system") hasSystem = true;
    if (message.role === "user") hasUser = true;
  }
  if (!hasSystem) return invalid("至少需要一条 system 消息");
  if (!hasUser) return invalid("至少需要一条 user 消息");

  const responseType = document.response_format.type;
  if (typeof responseType !== "string" || !RESPONSE_FORMAT_TYPES.has(responseType)) {
    return invalid("response_format.type 不受支持");
  }
  if (responseType === "json_schema") {
    const jsonSchema = document.response_format.json_schema;
    if (!isRecord(jsonSchema) || typeof jsonSchema.name !== "string" || !isRecord(jsonSchema.schema)) {
      return invalid("json_schema 需要 name 和 schema 对象");
    }
  }

  if (document.tools != null) {
    if (!Array.isArray(document.tools)) return invalid("tools 必须是数组");
    const names = new Set<string>();
    for (const [index, tool] of document.tools.entries()) {
      if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
        return invalid(`Function Call ${index + 1} 结构无效`);
      }
      const definition = tool.function;
      if (typeof definition.name !== "string" || !definition.name.trim()) return invalid(`Function Call ${index + 1} 缺少名称`);
      if (names.has(definition.name)) return invalid(`Function Call 名称重复：${definition.name}`);
      names.add(definition.name);
      if (typeof definition.description !== "string" || !isRecord(definition.parameters)) {
        return invalid(`Function Call ${index + 1} 需要说明和 parameters`);
      }
    }
  }

  return { valid: true, message: "符合 OpenAI 请求结构" };
}

export function messageGroupVariableName(value: string) {
  const match = value.trim().match(EXACT_VARIABLE_PATTERN);
  return match?.[1] ?? match?.[2] ?? "";
}

export function messageGroupToken(name: string) {
  return `@{${name}}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function invalid(message: string): FinalPromptValidationResult {
  return { valid: false, message };
}
