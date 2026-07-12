import path from "node:path";
import type { ReasoningEffort } from "../types.js";
import { badRequest } from "./errors.js";
import { getModelCatalogEntry, isReasoningEffort } from "./models.js";

export const IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "1152x2048",
  "3840x2160",
  "2160x3840"
];

export const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"];
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"];

const OPTIONAL_KEYS = new Set([
  "baseUrl",
  "envFile",
  "reasoningEffort",
  "modelSource",
  "multimodal",
  "detectedMultimodal",
  "visionProviderId",
  "visionModel",
  "maxCalls",
  "overrides",
  "clearTavilyApiKey",
  "removeTavilyApiKeyIndexes"
]);

export function validateCatalogEffort(model: string, effort: ReasoningEffort | undefined, field: string) {
  const entry = getModelCatalogEntry(model);
  if (entry && effort && !entry.reasoningEfforts.includes(effort)) {
    badRequest("CONFIG_INVALID", `${entry.label} 不支持推理强度 ${effort}。`, field);
  }
}

export function optionalReasoningEffort(value: unknown, field: string) {
  if (value == null || value === "") return undefined;
  if (!isReasoningEffort(value)) badRequest("CONFIG_INVALID", "推理强度无效。", field);
  return value;
}

export function object(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("CONFIG_INVALID", "必须是对象。", field);
  }
  return input as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) badRequest("CONFIG_UNKNOWN_FIELD", "包含不支持的字段。", `${field}.${extra}`);
  const missing = allowed.find((key) => !(key in value) && !OPTIONAL_KEYS.has(key));
  if (missing) badRequest("CONFIG_INVALID", "缺少必填字段。", `${field}.${missing}`);
}

export function requiredString(
  value: unknown,
  field: string,
  options: { trim: boolean; min: number; max: number; allowEmpty?: boolean }
) {
  if (typeof value !== "string") badRequest("CONFIG_INVALID", "必须是文本。", field);
  const text = options.trim ? value.trim() : value;
  if ((!options.allowEmpty && text.length < options.min) || text.length > options.max) {
    badRequest("CONFIG_INVALID", `长度必须在 ${options.min} 到 ${options.max} 之间。`, field);
  }
  if (text.includes("\0")) badRequest("CONFIG_INVALID", "不能包含 NUL 字符。", field);
  return text;
}

export function optionalString(value: unknown, field: string, max: number) {
  if (value == null || value === "") return undefined;
  return requiredString(value, field, { trim: true, min: 1, max });
}

export function pathString(value: unknown, field: string, mustBeRelative: boolean) {
  const text = requiredString(value, field, { trim: true, min: 1, max: 2_048 });
  if (mustBeRelative && path.isAbsolute(text)) {
    badRequest("CONFIG_INVALID", "必须使用相对 Agent workspace 的路径。", field);
  }
  if (mustBeRelative) {
    const root = path.resolve("/agent-workspace");
    const resolved = path.resolve(root, text);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      badRequest("CONFIG_INVALID", "路径不能离开 Agent workspace。", field);
    }
  }
  return text;
}

export function boolean(value: unknown, field: string) {
  if (typeof value !== "boolean") badRequest("CONFIG_INVALID", "必须是布尔值。", field);
  return value;
}

export function finiteNumber(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    badRequest("CONFIG_INVALID", `必须是 ${min} 到 ${max} 之间的数字。`, field);
  }
  return value;
}

export function integer(value: unknown, field: string, min: number, max: number) {
  const number = finiteNumber(value, field, min, max);
  if (!Number.isInteger(number)) badRequest("CONFIG_INVALID", "必须是整数。", field);
  return number;
}

export function stringArray(value: unknown, field: string, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) {
    badRequest("CONFIG_INVALID", `必须是最多 ${maxItems} 项的文本列表。`, field);
  }
  return value.map((item, index) => requiredString(item, `${field}.${index}`, {
    trim: true,
    min: 1,
    max: maxLength
  }));
}

export function optionalSecretArray(value: unknown, field: string) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    badRequest("CONFIG_INVALID", "必须是最多 32 项的 Key 列表。", field);
  }
  return value.map((item, index) => requiredString(item, `${field}.${index}`, {
    trim: true,
    min: 0,
    max: 512,
    allowEmpty: true
  })).filter(Boolean);
}

export function optionalIntegerArray(value: unknown, field: string, maxExclusive: number) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    badRequest("CONFIG_INVALID", "必须是最多 32 项的序号列表。", field);
  }
  if (value.length && maxExclusive === 0) {
    badRequest("CONFIG_INVALID", "没有可删除的 Key。", field);
  }
  return [...new Set(value.map((item, index) => (
    integer(item, `${field}.${index}`, 0, Math.max(0, maxExclusive - 1))
  )))];
}

export function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
