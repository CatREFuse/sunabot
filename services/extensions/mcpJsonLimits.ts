export const MCP_TOOL_ARGUMENT_MAX_BYTES = 256 * 1024;
export const MCP_TOOL_ARGUMENT_MAX_DEPTH = 24;
export const MCP_TOOL_ARGUMENT_MAX_NODES = 4_096;
export const MCP_TOOL_ARGUMENT_MAX_KEYS = 4_096;
export const MCP_TOOL_ARGUMENT_MAX_ARRAY_ITEMS = 4_096;
export const MCP_TOOL_ARGUMENT_MAX_STRING_BYTES = 64 * 1024;
export const MCP_TOOL_ARGUMENT_MAX_KEY_BYTES = 256;

interface PendingValue {
  value: unknown;
  depth: number;
}

export function assertBoundedMcpToolArguments(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) invalid();
  const pending: PendingValue[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  let keys = 0;
  let arrayItems = 0;

  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MCP_TOOL_ARGUMENT_MAX_NODES || current.depth > MCP_TOOL_ARGUMENT_MAX_DEPTH) invalid();
    const item = current.value;
    if (item === null) {
      bytes += 4;
    } else if (typeof item === "string") {
      const stringBytes = utf8(item);
      if (stringBytes > MCP_TOOL_ARGUMENT_MAX_STRING_BYTES) invalid();
      bytes += quotedBytes(item);
    } else if (typeof item === "boolean") {
      bytes += item ? 4 : 5;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid();
      bytes += utf8(String(item));
    } else if (Array.isArray(item)) {
      if (seen.has(item)) invalid();
      seen.add(item);
      const descriptors = ownDescriptors(item);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !isArrayIndex(key, item.length)))) {
        invalid();
      }
      arrayItems += item.length;
      if (arrayItems > MCP_TOOL_ARGUMENT_MAX_ARRAY_ITEMS) invalid();
      bytes += 2 + Math.max(0, item.length - 1);
      for (let index = item.length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) invalid();
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else if (isPlainObject(item)) {
      if (seen.has(item)) invalid();
      seen.add(item);
      const descriptors = ownDescriptors(item);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== "string")) invalid();
      keys += ownKeys.length;
      if (keys > MCP_TOOL_ARGUMENT_MAX_KEYS) invalid();
      bytes += 2 + Math.max(0, ownKeys.length - 1);
      for (let index = ownKeys.length - 1; index >= 0; index -= 1) {
        const key = ownKeys[index] as string;
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true ||
            key === "__proto__" || key === "prototype" || key === "constructor" ||
            utf8(key) > MCP_TOOL_ARGUMENT_MAX_KEY_BYTES) invalid();
        bytes += quotedBytes(key) + 1;
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    } else {
      invalid();
    }
    if (bytes > MCP_TOOL_ARGUMENT_MAX_BYTES) invalid();
  }
}

function ownDescriptors(value: object) {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    invalid();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isArrayIndex(value: string, length: number) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function quotedBytes(value: string) {
  return utf8(JSON.stringify(value));
}

function utf8(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function invalid(): never {
  throw new Error("MCP_TOOL_ARGUMENTS_INVALID");
}
