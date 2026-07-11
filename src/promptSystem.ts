import type { ChatMessage } from "./types.js";

export type PromptFileKind = "fragment" | "final";

export interface PromptVariableDefinition {
  name: string;
  description: string;
  type: "string" | "message[]" | "json" | "number" | "boolean";
  source: string;
  required: boolean;
}

export interface OpenAIFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: OpenAIFunctionDefinition;
}

export interface FinalPromptTemplate extends Record<string, unknown> {
  messages: Array<Record<string, unknown> | string>;
  tools?: OpenAIToolDefinition[];
  response_format: Record<string, unknown>;
}

export interface RenderedPromptRequest extends Record<string, unknown> {
  messages: ChatMessage[];
  tools?: OpenAIToolDefinition[];
  response_format: Record<string, unknown>;
}

export type PromptVariableValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export class PromptTemplateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "PromptTemplateError";
  }
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}|@\{\s*([A-Za-z_][\w.-]*)\s*\}/g;
const EXACT_VARIABLE_PATTERN = /^(?:\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}|@\{\s*([A-Za-z_][\w.-]*)\s*\})$/;

export function parseFinalPromptTemplate(content: string): FinalPromptTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new PromptTemplateError("PROMPT_JSON_INVALID", `最终提示词不是合法 JSON：${errorMessage(error)}`, "content");
  }
  if (!isRecord(parsed)) {
    throw new PromptTemplateError("PROMPT_JSON_INVALID", "最终提示词必须是 JSON 对象。", "content");
  }
  if (!Array.isArray(parsed.messages) || !parsed.messages.length) {
    throw new PromptTemplateError("PROMPT_MESSAGES_INVALID", "最终提示词必须包含非空 messages 数组。", "messages");
  }
  let hasSystem = false;
  let hasUser = false;
  parsed.messages.forEach((message, index) => {
    if (typeof message === "string") {
      if (!EXACT_VARIABLE_PATTERN.test(message.trim())) {
        throw new PromptTemplateError(
          "PROMPT_MESSAGE_INVALID",
          "消息数组中的文本项必须是完整的消息数组变量。",
          `messages.${index}`
        );
      }
      return;
    }
    if (!isRecord(message) || typeof message.role !== "string" || typeof message.content !== "string") {
      throw new PromptTemplateError(
        "PROMPT_MESSAGE_INVALID",
        "每条消息必须包含 role 和文本 content。",
        `messages.${index}`
      );
    }
    if (message.role === "system") hasSystem = true;
    if (message.role === "user") hasUser = true;
  });
  if (!hasSystem) {
    throw new PromptTemplateError("PROMPT_SYSTEM_MISSING", "最终提示词必须包含系统提示词。", "messages");
  }
  if (!hasUser) {
    throw new PromptTemplateError("PROMPT_USER_MISSING", "最终提示词必须包含用户输入提示词。", "messages");
  }
  if (!isRecord(parsed.response_format)) {
    throw new PromptTemplateError(
      "PROMPT_RESPONSE_FORMAT_INVALID",
      "最终提示词必须包含 response_format 对象。",
      "response_format"
    );
  }
  if (parsed.tools != null) validateTools(parsed.tools);
  return parsed as FinalPromptTemplate;
}

export function validatePromptFragment(_content: string) {}

export function validatePromptContent(kind: PromptFileKind, content: string) {
  if (kind === "final") parseFinalPromptTemplate(content);
  else validatePromptFragment(content);
}

export function extractPromptVariables(content: string) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? match[2] ?? "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function renderFinalPromptTemplate(
  template: FinalPromptTemplate,
  variables: Readonly<Record<string, PromptVariableValue>>
): RenderedPromptRequest {
  const resolve = createVariableResolver(variables);
  const rendered = renderValue(template, resolve, "") as Record<string, unknown>;
  const messages = normalizeRenderedMessages(rendered.messages);
  if (!messages.length) {
    throw new PromptTemplateError("PROMPT_MESSAGES_EMPTY", "变量解析后 messages 不能为空。", "messages");
  }
  return { ...rendered, messages } as RenderedPromptRequest;
}

function createVariableResolver(variables: Readonly<Record<string, PromptVariableValue>>) {
  const cache = new Map<string, PromptVariableValue>();
  const resolving: string[] = [];

  const resolve = (name: string): PromptVariableValue => {
    if (cache.has(name)) return cache.get(name)!;
    if (!Object.hasOwn(variables, name) || variables[name] == null) {
      throw new PromptTemplateError("PROMPT_VARIABLE_MISSING", `缺少变量：${name}`, name);
    }
    if (resolving.includes(name)) {
      throw new PromptTemplateError(
        "PROMPT_VARIABLE_CYCLE",
        `变量存在循环引用：${[...resolving, name].join(" → ")}`,
        name
      );
    }
    resolving.push(name);
    const value = renderValue(variables[name], resolve, name) as PromptVariableValue;
    resolving.pop();
    cache.set(name, value);
    return value;
  };
  return resolve;
}

function renderValue(
  value: unknown,
  resolve: (name: string) => PromptVariableValue,
  field: string
): unknown {
  if (typeof value === "string") return renderString(value, resolve);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const rendered = renderValue(item, resolve, `${field}.${index}`);
      return Array.isArray(rendered) ? rendered : [rendered];
    });
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, renderValue(item, resolve, field ? `${field}.${key}` : key)])
  );
}

function renderString(value: string, resolve: (name: string) => PromptVariableValue) {
  const exact = value.trim().match(EXACT_VARIABLE_PATTERN);
  if (exact) return structuredClone(resolve(exact[1] ?? exact[2] ?? ""));
  return value.replace(VARIABLE_PATTERN, (_token, curlyName: string, atName: string) => {
    const resolved = resolve(curlyName || atName);
    return stringifyVariable(resolved);
  });
}

function normalizeRenderedMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    throw new PromptTemplateError("PROMPT_MESSAGES_INVALID", "变量解析后 messages 必须是数组。", "messages");
  }
  return value.map((message, index) => {
    if (!isRecord(message) || !isChatRole(message.role) || message.content == null) {
      throw new PromptTemplateError(
        "PROMPT_MESSAGE_INVALID",
        "变量解析后的消息必须包含有效 role 和文本 content。",
        `messages.${index}`
      );
    }
    const imageUrls = stringArray(message.imageUrls);
    const localImagePaths = stringArray(message.localImagePaths);
    return {
      role: message.role,
      content: typeof message.content === "string"
        ? message.content
        : stringifyVariable(message.content as PromptVariableValue),
      ...(imageUrls.length ? { imageUrls } : {}),
      ...(localImagePaths.length ? { localImagePaths } : {})
    };
  });
}

function validateTools(value: unknown) {
  if (!Array.isArray(value)) {
    throw new PromptTemplateError("PROMPT_TOOLS_INVALID", "tools 必须是数组。", "tools");
  }
  const names = new Set<string>();
  value.forEach((tool, index) => {
    const field = `tools.${index}`;
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      throw new PromptTemplateError("PROMPT_TOOL_INVALID", "Function Call 必须使用 OpenAI function 结构。", field);
    }
    const definition = tool.function;
    if (typeof definition.name !== "string" || !definition.name.trim()) {
      throw new PromptTemplateError("PROMPT_TOOL_NAME_INVALID", "Function Call 名称不能为空。", `${field}.function.name`);
    }
    if (names.has(definition.name)) {
      throw new PromptTemplateError(
        "PROMPT_TOOL_NAME_DUPLICATE",
        `Function Call 名称重复：${definition.name}`,
        `${field}.function.name`
      );
    }
    names.add(definition.name);
    if (typeof definition.description !== "string") {
      throw new PromptTemplateError(
        "PROMPT_TOOL_DESCRIPTION_INVALID",
        "Function Call 说明必须是文本。",
        `${field}.function.description`
      );
    }
    if (!isRecord(definition.parameters)) {
      throw new PromptTemplateError(
        "PROMPT_TOOL_PARAMETERS_INVALID",
        "Function Call parameters 必须是 JSON Schema 对象。",
        `${field}.function.parameters`
      );
    }
  });
}

function stringifyVariable(value: PromptVariableValue) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isChatRole(value: unknown): value is ChatMessage["role"] {
  return value === "system" || value === "developer" || value === "user" || value === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
