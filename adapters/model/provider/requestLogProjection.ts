import { types as nodeUtilTypes } from "node:util";
import {
  WORKBENCH_FILE_MAX_BYTES,
  isWorkbenchFileRelativePath
} from "../../../services/tools/public.js";
import {
  ADD_WORKMEMORY_TOOL_NAME,
  isAddWorkMemoryStableErrorCode
} from "../../../services/tools/addWorkMemoryTool.js";
import {
  ADD_USER_PROFILE_TOOL_NAME,
  isAddUserProfileStableErrorCode
} from "../../../services/tools/addUserProfileTool.js";
import { isMcpToolAlias } from "../../../services/extensions/public.js";

export const PROVIDER_FILE_LOG_REDACTED = "[REDACTED]";
export const PROVIDER_FILE_LOG_INVALID_RESULT = "[INVALID TOOL RESULT]";
export const PROVIDER_WORKMEMORY_LOG_REDACTED = "[WORKING MEMORY CONTENT REDACTED]";
export const PROVIDER_USER_PROFILE_LOG_REDACTED = "[USER PROFILE CONTENT REDACTED]";
export const PROVIDER_REQUEST_LOG_REDACTED = "[PROVIDER REQUEST LOG REDACTED]";
export const PROVIDER_RESPONSE_LOG_REDACTED = "[PROVIDER RESPONSE LOG REDACTED]";
export const PROVIDER_MCP_LOG_REDACTED = "[EXTERNAL MCP DATA REDACTED]";
const invalidValue = "[invalid]";
const maxInertDepth = 32;
const maxInertNodes = 100_000;

type FileToolName = "read_file" | "write_file";
type MemoryToolName = typeof ADD_WORKMEMORY_TOOL_NAME | typeof ADD_USER_PROFILE_TOOL_NAME;
type ProjectedToolName = FileToolName | MemoryToolName | "mcp";

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

export function projectProviderResponseLogForStorage(action: string, response: unknown): unknown {
  try {
    const inertResponse = cloneInertLogData(response, {
      active: new WeakSet<object>(),
      nodes: 0
    });
    const value = asRecord(inertResponse);
    const projected = value && Object.hasOwn(value, "payload")
      ? { ...value, payload: projectProviderResponsePayload(action, value.payload) }
      : inertResponse;
    const serialized = JSON.stringify(projected);
    if (serialized === undefined) throw new Error("Provider response log is not serializable.");
    return JSON.parse(serialized) as unknown;
  } catch {
    return { summary: PROVIDER_RESPONSE_LOG_REDACTED };
  }
}

export function projectAddWorkMemoryResultLog(value: unknown) {
  return projectWorkingMemoryResult(asRecord(value));
}

export function projectAddWorkMemoryArgumentsLog(value: unknown) {
  return projectWorkingMemoryCallArguments(asRecord(value));
}

export function projectAddUserProfileResultLog(value: unknown) {
  return projectUserProfileResult(asRecord(value));
}

export function projectAddUserProfileArgumentsLog(value: unknown) {
  return projectUserProfileCallArguments(asRecord(value));
}

function projectProviderResponsePayload(action: string, payload: unknown) {
  if (action === "responses.complete" || action === "codex.complete") {
    return projectResponsesResponse(payload);
  }
  if (action === "chat.completions.complete") return projectChatResponse(payload);
  if (action === "anthropic.messages.complete") return projectAnthropicResponse(payload);
  if (action === "gemini.generate-content.complete") return projectGeminiResponse(payload);
  return payload;
}

function projectResponsesResponse(payload: unknown) {
  const value = asRecord(payload);
  if (!value || !Array.isArray(value.output)) return payload;
  const output = mapChanged(value.output, (item) => {
    const record = asRecord(item);
    const toolName = record?.type === "function_call" ? responseProjectedToolName(record.name) : undefined;
    return record && toolName
      ? { ...record, arguments: projectJsonArguments(toolName, record.arguments) }
      : item;
  });
  return output === value.output ? payload : { ...value, output };
}

function projectChatResponse(payload: unknown) {
  const value = asRecord(payload);
  if (!value || !Array.isArray(value.choices)) return payload;
  const choices = mapChanged(value.choices, (choice) => {
    const choiceRecord = asRecord(choice);
    const message = asRecord(choiceRecord?.message);
    if (!choiceRecord || !message || !Array.isArray(message.tool_calls)) return choice;
    const toolCalls = mapChanged(message.tool_calls, (call) => {
      const callRecord = asRecord(call);
      const fn = asRecord(callRecord?.function);
      const toolName = responseProjectedToolName(fn?.name);
      return callRecord && fn && toolName
        ? { ...callRecord, function: { ...fn, arguments: projectJsonArguments(toolName, fn.arguments) } }
        : call;
    });
    return toolCalls === message.tool_calls
      ? choice
      : { ...choiceRecord, message: { ...message, tool_calls: toolCalls } };
  });
  return choices === value.choices ? payload : { ...value, choices };
}

function projectAnthropicResponse(payload: unknown) {
  const value = asRecord(payload);
  if (!value || !Array.isArray(value.content)) return payload;
  const content = mapChanged(value.content, (block) => {
    const record = asRecord(block);
    const toolName = record?.type === "tool_use" ? responseProjectedToolName(record.name) : undefined;
    return record && toolName
      ? { ...record, input: projectObjectArguments(toolName, record.input) }
      : block;
  });
  return content === value.content ? payload : { ...value, content };
}

function projectGeminiResponse(payload: unknown) {
  const value = asRecord(payload);
  if (!value || !Array.isArray(value.candidates)) return payload;
  const candidates = mapChanged(value.candidates, (candidate) => {
    const candidateRecord = asRecord(candidate);
    const content = asRecord(candidateRecord?.content);
    if (!candidateRecord || !content || !Array.isArray(content.parts)) return candidate;
    const parts = mapChanged(content.parts, (part) => {
      const partRecord = asRecord(part);
      const call = asRecord(partRecord?.functionCall);
      const toolName = responseProjectedToolName(call?.name);
      return partRecord && call && toolName
        ? { ...partRecord, functionCall: { ...call, args: projectObjectArguments(toolName, call.args) } }
        : part;
    });
    return parts === content.parts
      ? candidate
      : { ...candidateRecord, content: { ...content, parts } };
  });
  return candidates === value.candidates ? payload : { ...value, candidates };
}

function projectResponsesRequest(request: unknown) {
  const value = asRecord(request);
  if (!value || !Array.isArray(value.input)) return request;
  const trustedMcp = trustedMcpToolNames(value.tools);
  const lineage = new Map<string, ProjectedToolName>();
  const input = mapChanged(value.input, (item) => {
    const record = asRecord(item);
    if (!record) return item;
    if (record.type === "function_call") {
      const toolName = projectedToolName(record.name, trustedMcp);
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
  const trustedMcp = trustedMcpToolNames(value.tools);
  const lineage = new Map<string, ProjectedToolName>();
  const messages = mapChanged(value.messages, (message) => {
    const record = asRecord(message);
    if (!record) return message;
    if (record.role === "assistant" && Array.isArray(record.tool_calls)) {
      const toolCalls = mapChanged(record.tool_calls, (call) => {
        const callRecord = asRecord(call);
        const fn = asRecord(callRecord?.function);
        const toolName = projectedToolName(fn?.name, trustedMcp);
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
  const trustedMcp = trustedMcpToolNames(value.tools);
  const lineage = new Map<string, ProjectedToolName>();
  const messages = mapChanged(value.messages, (message) => {
    const record = asRecord(message);
    if (!record || !Array.isArray(record.content)) return message;
    if (record.role === "assistant") {
      const content = mapChanged(record.content, (block) => {
        const blockRecord = asRecord(block);
        const toolName = blockRecord?.type === "tool_use"
          ? projectedToolName(blockRecord.name, trustedMcp)
          : undefined;
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
  const trustedMcp = trustedMcpToolNames(value.tools);
  const contents = mapChanged(value.contents, (content) => {
    const record = asRecord(content);
    if (!record || !Array.isArray(record.parts)) return content;
    if (record.role === "model") {
      const parts = mapChanged(record.parts, (part) => {
        const partRecord = asRecord(part);
        const call = asRecord(partRecord?.functionCall);
        const toolName = projectedToolName(call?.name, trustedMcp);
        if (!partRecord || !call || !toolName) return part;
        return { ...partRecord, functionCall: { ...call, args: projectObjectArguments(toolName, call.args) } };
      });
      return parts === record.parts ? content : { ...record, parts };
    }
    if (record.role === "user") {
      const parts = mapChanged(record.parts, (part) => {
        const partRecord = asRecord(part);
        const response = asRecord(partRecord?.functionResponse);
        const toolName = projectedToolName(response?.name, trustedMcp);
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

function projectJsonArguments(toolName: ProjectedToolName, value: unknown) {
  const parsed = typeof value === "string" ? parseRecord(value) : undefined;
  if (toolName === "mcp") return JSON.stringify(projectMcpValue(parsed, value, "arguments"));
  if (toolName === ADD_WORKMEMORY_TOOL_NAME) {
    return JSON.stringify(projectWorkingMemoryCallArguments(parsed));
  }
  if (toolName === ADD_USER_PROFILE_TOOL_NAME) {
    return JSON.stringify(projectUserProfileCallArguments(parsed));
  }
  return JSON.stringify(projectFileCallArguments(toolName, parsed));
}

function projectObjectArguments(toolName: ProjectedToolName, value: unknown) {
  if (toolName === "mcp") return projectMcpValue(value, value, "arguments");
  if (toolName === ADD_WORKMEMORY_TOOL_NAME) {
    return projectWorkingMemoryCallArguments(asRecord(value));
  }
  if (toolName === ADD_USER_PROFILE_TOOL_NAME) {
    return projectUserProfileCallArguments(asRecord(value));
  }
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

function projectJsonResult(toolName: ProjectedToolName, value: unknown) {
  const parsed = typeof value === "string" ? parseRecord(value) : undefined;
  if (toolName === "mcp") return JSON.stringify(projectMcpValue(parsed, value, "result"));
  if (toolName === ADD_WORKMEMORY_TOOL_NAME) {
    return JSON.stringify(projectWorkingMemoryResult(parsed));
  }
  if (toolName === ADD_USER_PROFILE_TOOL_NAME) {
    return JSON.stringify(projectUserProfileResult(parsed));
  }
  if (!parsed) return PROVIDER_FILE_LOG_INVALID_RESULT;
  return JSON.stringify(projectFileResult(toolName, parsed));
}

function projectObjectResult(toolName: ProjectedToolName, value: unknown) {
  if (toolName === "mcp") return projectMcpValue(value, value, "result");
  const parsed = asRecord(value);
  if (toolName === ADD_WORKMEMORY_TOOL_NAME) return projectWorkingMemoryResult(parsed);
  if (toolName === ADD_USER_PROFILE_TOOL_NAME) return projectUserProfileResult(parsed);
  return parsed ? projectFileResult(toolName, parsed) : PROVIDER_FILE_LOG_INVALID_RESULT;
}

function projectWorkingMemoryCallArguments(value: Record<string, unknown> | undefined) {
  const content = value?.content;
  const argumentKeys = value
    ? ["action", "content"].filter((key) => Object.hasOwn(value, key))
    : [];
  const unsupportedArgumentCount = value
    ? Object.keys(value).length - argumentKeys.length
    : 0;
  return {
    action: value?.action === "record" || value?.action === "skip"
      ? value.action
      : invalidValue,
    argumentKeys,
    unsupportedArgumentCount,
    content: content === null
      ? null
      : typeof content === "string"
        ? PROVIDER_WORKMEMORY_LOG_REDACTED
        : invalidValue,
    contentChars: typeof content === "string"
      ? Array.from(content).length
      : content === null
        ? 0
        : invalidValue
  };
}

function projectWorkingMemoryResult(value: Record<string, unknown> | undefined) {
  return {
    ok: typeof value?.ok === "boolean" ? value.ok : invalidValue,
    action: value?.action === "record" || value?.action === "skip"
      ? value.action
      : invalidValue,
    code: isAddWorkMemoryStableErrorCode(value?.code) ? value.code : invalidValue,
    deduplicated: typeof value?.deduplicated === "boolean"
      ? value.deduplicated
      : invalidValue
  };
}

function projectUserProfileCallArguments(value: Record<string, unknown> | undefined) {
  const profile = value?.profile;
  const addressNames = value?.addressNames;
  const argumentKeys = value
    ? ["action", "profile", "addressNames"].filter((key) => Object.hasOwn(value, key))
    : [];
  const unsupportedArgumentCount = value
    ? Object.keys(value).length - argumentKeys.length
    : 0;
  return {
    action: value?.action === "record" || value?.action === "skip"
      ? value.action
      : invalidValue,
    argumentKeys,
    unsupportedArgumentCount,
    profile: profile === null
      ? null
      : typeof profile === "string"
        ? PROVIDER_USER_PROFILE_LOG_REDACTED
        : invalidValue,
    profileChars: typeof profile === "string"
      ? Array.from(profile).length
      : profile === null
        ? 0
        : invalidValue,
    addressNameCount: Array.isArray(addressNames)
      ? addressNames.length
      : addressNames === null
        ? 0
        : invalidValue
  };
}

function projectUserProfileResult(value: Record<string, unknown> | undefined) {
  return {
    ok: typeof value?.ok === "boolean" ? value.ok : invalidValue,
    action: value?.action === "record" || value?.action === "skip"
      ? value.action
      : invalidValue,
    code: isAddUserProfileStableErrorCode(value?.code) ? value.code : invalidValue,
    addressNameCount: Number.isSafeInteger(value?.addressNameCount)
      && Number(value?.addressNameCount) >= 0
      && Number(value?.addressNameCount) <= 16
      ? value?.addressNameCount
      : invalidValue,
    deduplicated: typeof value?.deduplicated === "boolean"
      ? value.deduplicated
      : invalidValue
  };
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

function projectedToolName(value: unknown, trustedMcp: Set<string>): ProjectedToolName | undefined {
  const file = fileToolName(value);
  if (file) return file;
  if (value === ADD_WORKMEMORY_TOOL_NAME || value === ADD_USER_PROFILE_TOOL_NAME) return value;
  return typeof value === "string" && trustedMcp.has(value) ? "mcp" : undefined;
}

function responseProjectedToolName(value: unknown): ProjectedToolName | undefined {
  const file = fileToolName(value);
  if (file) return file;
  if (value === ADD_WORKMEMORY_TOOL_NAME || value === ADD_USER_PROFILE_TOOL_NAME) return value;
  return typeof value === "string" && isMcpToolAlias(value) ? "mcp" : undefined;
}

function trustedMcpToolNames(value: unknown) {
  const names = new Set<string>();
  if (!Array.isArray(value)) return names;
  for (const item of value) {
    const record = asRecord(item);
    const direct = record?.name;
    const nested = asRecord(record?.function)?.name;
    if (typeof direct === "string" && isMcpToolAlias(direct)) names.add(direct);
    if (typeof nested === "string" && isMcpToolAlias(nested)) names.add(nested);
    const declarations = record?.functionDeclarations;
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        const name = asRecord(declaration)?.name;
        if (typeof name === "string" && isMcpToolAlias(name)) names.add(name);
      }
    }
  }
  return names;
}

function projectMcpValue(value: unknown, encoded: unknown, kind: "arguments" | "result") {
  const record = asRecord(value);
  const array = Array.isArray(value) ? value : undefined;
  const byteLength = typeof encoded === "string"
    ? Buffer.byteLength(encoded, "utf8")
    : safeSerializedBytes(value);
  return {
    externalMcpData: PROVIDER_MCP_LOG_REDACTED,
    kind,
    byteLength,
    rootType: record ? "object" : array ? "array" : value === null ? "null" : typeof value,
    ...(record ? { propertyCount: Object.keys(record).length } : {}),
    ...(array ? { itemCount: array.length } : {})
  };
}

function safeSerializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return invalidValue;
  }
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
