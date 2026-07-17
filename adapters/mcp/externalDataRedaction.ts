import { redactMcpHostPaths } from "../../packages/contracts/extensions/mcpExternalData.js";

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 32;
const MAX_NODES = 16_384;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_SECRET_VALUES = 64;
const MAX_SECRET_BYTES = 16 * 1024;

export type McpExternalDataMode = "catalog" | "output";

export class McpExternalDataSanitizer {
  private readonly secrets: string[];
  private secretValueCount = 0;

  constructor(values: Iterable<string>) {
    this.secrets = [];
    this.addSecrets(values);
  }

  addSecrets(values: Iterable<string>) {
    const source = [...values].filter(Boolean);
    if (this.secretValueCount + source.length > MAX_SECRET_VALUES || source.some((value) =>
      typeof value !== "string" || !isWellFormedUnicode(value) || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES)) {
      throw stableError("MCP_SECRET_VALUE_INVALID");
    }
    this.secretValueCount += source.length;
    const merged = new Set([...this.secrets, ...secretRedactionVariants(source)]);
    this.secrets.splice(0, this.secrets.length, ...[...merged]
      .sort((left, right) => right.length - left.length));
  }

  sanitize<T>(value: T, mode: McpExternalDataMode): T {
    const state = { seen: new Set<object>(), nodes: 0 };
    return this.clone(value, mode, state, 0) as T;
  }

  sanitizeText(value: string, mode: McpExternalDataMode) {
    return this.sanitizeString(value, mode);
  }

  clear() {
    this.secrets.fill("");
    this.secrets.splice(0, this.secrets.length);
    this.secretValueCount = 0;
  }

  private clone(
    value: unknown,
    mode: McpExternalDataMode,
    state: { seen: Set<object>; nodes: number },
    depth: number
  ): unknown {
    if (depth > MAX_DEPTH || state.nodes++ > MAX_NODES) throw stableError("MCP_EXTERNAL_DATA_INVALID");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return this.sanitizeString(value, mode);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw stableError("MCP_EXTERNAL_DATA_INVALID");
      return value;
    }
    if (typeof value !== "object") throw stableError("MCP_EXTERNAL_DATA_INVALID");
    if (state.seen.has(value)) throw stableError("MCP_EXTERNAL_DATA_INVALID");
    state.seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_NODES) throw stableError("MCP_EXTERNAL_DATA_INVALID");
        const output: unknown[] = [];
        let keys: Array<string | symbol>;
        try { keys = Reflect.ownKeys(value); } catch { throw stableError("MCP_EXTERNAL_DATA_INVALID"); }
        if ([...keys].some((key) => typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)))) {
          throw stableError("MCP_EXTERNAL_DATA_INVALID");
        }
        for (let index = 0; index < value.length; index += 1) {
          let descriptor: PropertyDescriptor | undefined;
          try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch {
            throw stableError("MCP_EXTERNAL_DATA_INVALID");
          }
          if (!descriptor || descriptor.get || descriptor.set) throw stableError("MCP_EXTERNAL_DATA_INVALID");
          output.push(this.clone(descriptor.value, mode, state, depth + 1));
        }
        return output;
      }
      let prototype: object | null;
      let keys: Array<string | symbol>;
      try {
        prototype = Object.getPrototypeOf(value) as object | null;
        keys = Reflect.ownKeys(value);
      } catch {
        throw stableError("MCP_EXTERNAL_DATA_INVALID");
      }
      if (prototype !== Object.prototype && prototype !== null) throw stableError("MCP_EXTERNAL_DATA_INVALID");
      if (keys.length > MAX_NODES) throw stableError("MCP_EXTERNAL_DATA_INVALID");
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (typeof key !== "string") throw stableError("MCP_EXTERNAL_DATA_INVALID");
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
          throw stableError("MCP_EXTERNAL_DATA_INVALID");
        }
        if (!descriptor || descriptor.get || descriptor.set) throw stableError("MCP_EXTERNAL_DATA_INVALID");
        if (!descriptor.enumerable) continue;
        const safeKey = this.sanitizeString(key, mode);
        if (!safeKey || safeKey === "__proto__" || safeKey === "prototype" || safeKey === "constructor") {
          throw stableError("MCP_EXTERNAL_DATA_INVALID");
        }
        if (Object.prototype.hasOwnProperty.call(output, safeKey)) {
          throw stableError("MCP_EXTERNAL_DATA_INVALID");
        }
        output[safeKey] = this.clone(descriptor.value, mode, state, depth + 1);
      }
      return output;
    } finally {
      state.seen.delete(value);
    }
  }

  private sanitizeString(value: string, mode: McpExternalDataMode) {
    if (!isWellFormedUnicode(value) || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      throw stableError("MCP_EXTERNAL_DATA_INVALID");
    }
    let sanitized = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
    for (const secret of this.secrets) sanitized = sanitized.split(secret).join(REDACTED);
    sanitized = redactMcpHostPaths(sanitized);
    if (mode === "catalog" && sanitized !== value) throw stableError("MCP_EXTERNAL_CATALOG_UNSAFE");
    return sanitized;
  }
}

function secretRedactionVariants(values: string[]) {
  const variants = new Set<string>();
  for (const value of values) {
    const encoded = Buffer.from(value, "utf8");
    const forms = new Set<string>([
      value,
      encoded.toString("base64"),
      encoded.toString("base64").replace(/=+$/u, ""),
      encoded.toString("base64url"),
      encoded.toString("hex"),
      encoded.toString("hex").toUpperCase(),
      [...encoded].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
      [...encoded].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("")
    ]);
    try { forms.add(encodeURIComponent(value)); } catch { /* the byte-wise percent form remains available */ }
    for (const form of forms) {
      if (!form) continue;
      variants.add(form);
      variants.add(`Bearer ${form}`);
    }
  }
  return variants;
}

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
