import { types as nodeUtilTypes } from "node:util";
import {
  WORKBENCH_FILE_MAX_BYTES,
  isWorkbenchFileRelativePath
} from "../../../services/tools/public.js";

export const PROVIDER_FILE_LOG_REDACTED = "[REDACTED]";
export const PROVIDER_FILE_LOG_INVALID_RESULT = "[INVALID TOOL RESULT]";
export const PROVIDER_REQUEST_LOG_REDACTED = "[PROVIDER REQUEST LOG REDACTED]";
const invalidValue = "[invalid]";
const maxInertDepth = 32;
const maxInertNodes = 100_000;

type FileToolName = "read_file" | "write_file";

export function projectProviderRequestLog(action: string, request: unknown): unknown {
  if (action === "responses.complete" || action === "codex.complete") {
    return projectResponsesRequest(request);
  }
  if (action === "chat.completions.complete") return projectChatRequest(request);
  if (action === "anthropic.messages.complete") return projectAnthropicRequest(request);
  if (action === "gemini.generate-content.complete") return projectGeminiRequest(request);
  return request;
}

export function projectProviderRequestLogForStorage(action: string, request: unknown): unknown {
  try {
    const inertRequest = cloneInertLogData(request, {
      active: new WeakSet<object>(),
      nodes: 0
    });
    const projected = projectProviderRequestLog(action, inertRequest);
    const serialized = JSON.stringify(projected);
    if (serialized === undefined) throw new Error("Provider request log is not serializable.");
    return JSON.parse(serialized) as unknown;
  } catch {
    return { summary: PROVIDER_REQUEST_LOG_REDACTED };
  }
}

function projectResponsesRequest(request: unknown) {
  const value = asRecord(request);
  if (!value || !Array.isArray(value.input)) return request;
  const lineage = new Map<string, FileToolName>();
  const input = mapChanged(value.input, (item) => {
    const record = asRecord(item);
    if (!record) return item;
    if (record.type === "function_call") {
      const toolName = fileToolName(record.name);
      if (!toolName) return item;
      if (typeof record.call_id === "string") lineage.set(record.call_id, toolName);
      return { ...record, arguments: projectJsonArguments(toolName, record.arguments) };
    }
    if (record.type === "function_call_output" && typeof record.call_id === "string") {
      const toolName = lineage.get(record.call_id);
      if (!toolName) return item;
      return { ...record, output: projectJsonResult(toolName, record.output) };
    }
    return item;
  });
  return input === value.input ? request : { ...value, input };
}

function projectChatRequest(request: unknown) {
  const value = asRecord(request);
  if (!value || !Array.isArray(value.messages)) return request;
  const lineage = new Map<string, FileToolName>();
  const messages = mapChanged(value.messages, (message) => {
    const record = asRecord(message);
    if (!record) return message;
    if (record.role === "assistant" && Array.isArray(record.tool_calls)) {
      const toolCalls = mapChanged(record.tool_calls, (call) => {
        const callRecord = asRecord(call);
        const fn = asRecord(callRecord?.function);
        const toolName = fileToolName(fn?.name);
        if (!callRecord || !fn || !toolName) return call;
        if (typeof callRecord.id === "string") lineage.set(callRecord.id, toolName);
        return {
          ...callRecord,
          function: { ...fn, arguments: projectJsonArguments(toolName, fn.arguments) }
        };
      });
      return toolCalls === record.tool_calls ? message : { ...record, tool_calls: toolCalls };
    }
    if (record.role === "tool" && typeof record.tool_call_id === "string") {
      const toolName = lineage.get(record.tool_call_id);
      if (!toolName) return message;
      return { ...record, content: projectJsonResult(toolName, record.content) };
    }
    return message;
  });
  return messages === value.messages ? request : { ...value, messages };
}

function projectAnthropicRequest(request: unknown) {
  const value = asRecord(request);
  if (!value || !Array.isArray(value.messages)) return request;
  const lineage = new Map<string, FileToolName>();
  const messages = mapChanged(value.messages, (message) => {
    const record = asRecord(message);
    if (!record || !Array.isArray(record.content)) return message;
    if (record.role === "assistant") {
      const content = mapChanged(record.content, (block) => {
        const blockRecord = asRecord(block);
        const toolName = blockRecord?.type === "tool_use" ? fileToolName(blockRecord.name) : undefined;
        if (!blockRecord || !toolName) return block;
        if (typeof blockRecord.id === "string") lineage.set(blockRecord.id, toolName);
        return { ...blockRecord, input: projectObjectArguments(toolName, blockRecord.input) };
      });
      return content === record.content ? message : { ...record, content };
    }
    if (record.role === "user") {
      const content = mapChanged(record.content, (block) => {
        const blockRecord = asRecord(block);
        if (!blockRecord || blockRecord.type !== "tool_result" || typeof blockRecord.tool_use_id !== "string") {
          return block;
        }
        const toolName = lineage.get(blockRecord.tool_use_id);
        if (!toolName) return block;
        return { ...blockRecord, content: projectJsonResult(toolName, blockRecord.content) };
      });
      return content === record.content ? message : { ...record, content };
    }
    return message;
  });
  return messages === value.messages ? request : { ...value, messages };
}

function projectGeminiRequest(request: unknown) {
  const value = asRecord(request);
  if (!value || !Array.isArray(value.contents)) return request;
  const contents = mapChanged(value.contents, (content) => {
    const record = asRecord(content);
    if (!record || !Array.isArray(record.parts)) return content;
    if (record.role === "model") {
      const parts = mapChanged(record.parts, (part) => {
        const partRecord = asRecord(part);
        const call = asRecord(partRecord?.functionCall);
        const toolName = fileToolName(call?.name);
        if (!partRecord || !call || !toolName) return part;
        return { ...partRecord, functionCall: { ...call, args: projectObjectArguments(toolName, call.args) } };
      });
      return parts === record.parts ? content : { ...record, parts };
    }
    if (record.role === "user") {
      const parts = mapChanged(record.parts, (part) => {
        const partRecord = asRecord(part);
        const response = asRecord(partRecord?.functionResponse);
        const toolName = fileToolName(response?.name);
        if (!partRecord || !response || !toolName) return part;
        return {
          ...partRecord,
          functionResponse: { ...response, response: projectObjectResult(toolName, response.response) }
        };
      });
      return parts === record.parts ? content : { ...record, parts };
    }
    return content;
  });
  return contents === value.contents ? request : { ...value, contents };
}

function projectJsonArguments(toolName: FileToolName, value: unknown) {
  const parsed = typeof value === "string" ? parseRecord(value) : undefined;
  return JSON.stringify(projectFileCallArguments(toolName, parsed));
}

function projectObjectArguments(toolName: FileToolName, value: unknown) {
  return projectFileCallArguments(toolName, asRecord(value));
}

function projectFileCallArguments(toolName: FileToolName, value: Record<string, unknown> | undefined) {
  if (toolName === "read_file") return { path: safePath(value?.path) };
  const content = typeof value?.content === "string" ? value.content : undefined;
  return {
    path: safePath(value?.path),
    overwrite: typeof value?.overwrite === "boolean" ? value.overwrite : invalidValue,
    contentByteLength: content === undefined ? invalidValue : Buffer.byteLength(content, "utf8"),
    content: PROVIDER_FILE_LOG_REDACTED
  };
}

function projectJsonResult(toolName: FileToolName, value: unknown) {
  const parsed = typeof value === "string" ? parseRecord(value) : undefined;
  if (!parsed) return PROVIDER_FILE_LOG_INVALID_RESULT;
  return JSON.stringify(projectFileResult(toolName, parsed));
}

function projectObjectResult(toolName: FileToolName, value: unknown) {
  const parsed = asRecord(value);
  return parsed ? projectFileResult(toolName, parsed) : PROVIDER_FILE_LOG_INVALID_RESULT;
}

function projectFileResult(toolName: FileToolName, value: Record<string, unknown>) {
  if (toolName === "read_file") {
    return {
      ok: value.ok === true,
      path: safePath(value.path),
      byteLength: safeByteLength(value.byteLength),
      content: PROVIDER_FILE_LOG_REDACTED
    };
  }
  return {
    ok: value.ok === true,
    path: safePath(value.path),
    byteLength: safeByteLength(value.byteLength),
    created: typeof value.created === "boolean" ? value.created : invalidValue,
    overwritten: typeof value.overwritten === "boolean" ? value.overwritten : invalidValue
  };
}

function safePath(value: unknown) {
  return isWorkbenchFileRelativePath(value) ? value : invalidValue;
}

function safeByteLength(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= WORKBENCH_FILE_MAX_BYTES
    ? Number(value)
    : invalidValue;
}

function fileToolName(value: unknown): FileToolName | undefined {
  return value === "read_file" || value === "write_file" ? value : undefined;
}

function parseRecord(value: string) {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mapChanged(values: unknown[], project: (value: unknown) => unknown) {
  let changed = false;
  const projected = values.map((value) => {
    const next = project(value);
    if (next !== value) changed = true;
    return next;
  });
  return changed ? projected : values;
}

interface InertCloneState {
  active: WeakSet<object>;
  nodes: number;
}

function cloneInertLogData(value: unknown, state: InertCloneState, depth = 0): unknown {
  if (depth > maxInertDepth) throw new Error("Provider request log exceeds maximum depth.");
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "undefined") return undefined;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Provider request log contains a non-data value.");
  }
  if (nodeUtilTypes.isProxy(value)) throw new Error("Provider request log contains a Proxy.");
  if (state.active.has(value)) throw new Error("Provider request log contains a cycle.");
  state.nodes += 1;
  if (state.nodes > maxInertNodes) throw new Error("Provider request log exceeds maximum nodes.");

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("Provider request log contains a custom prototype.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (!descriptor) continue;
    if (descriptor.get || descriptor.set) throw new Error("Provider request log contains an accessor.");
    if (key === "toJSON") throw new Error("Provider request log contains toJSON.");
  }

  state.active.add(value);
  try {
    if (array) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > maxInertNodes) {
        throw new Error("Provider request log contains an invalid array length.");
      }
      const output = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor && "value" in descriptor) {
          output[index] = cloneInertLogData(descriptor.value, state, depth + 1);
        }
      }
      return output;
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) continue;
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneInertLogData(descriptor.value, state, depth + 1)
      });
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}
