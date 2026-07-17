import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

export interface McpPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface McpCatalogClientPort {
  listTools(cursor: string | undefined, options: McpRequestOptions): Promise<McpPage<Record<string, unknown>>>;
  listResources(cursor: string | undefined, options: McpRequestOptions): Promise<McpPage<Record<string, unknown>>>;
  listResourceTemplates(cursor: string | undefined, options: McpRequestOptions): Promise<McpPage<Record<string, unknown>>>;
  listPrompts(cursor: string | undefined, options: McpRequestOptions): Promise<McpPage<Record<string, unknown>>>;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
  resetTimeoutOnProgress: false;
}

export interface McpCatalogSnapshot {
  digestSha256: string;
  tools: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  resourceTemplates: Record<string, unknown>[];
  prompts: Record<string, unknown>[];
  refreshedAt: string;
}

export interface McpCatalogCommit {
  snapshot: McpCatalogSnapshot;
  generation: number;
}

export interface McpCatalogRefreshResult {
  status: "ready" | "degraded";
  snapshot: McpCatalogSnapshot | null;
  errorCode?: "MCP_CATALOG_REFRESH_FAILED";
}

const LIMITS = {
  pages: 32,
  totalBytes: 2 * 1024 * 1024,
  tools: 256,
  resources: 512,
  resourceTemplates: 256,
  prompts: 256,
  schemaDepth: 16
} as const;

export async function refreshMcpCatalog(input: {
  client: McpCatalogClientPort;
  capabilities: { tools?: boolean; resources?: boolean; prompts?: boolean };
  previous?: McpCatalogSnapshot | null;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<McpCatalogRefreshResult> {
  const requestOptions: McpRequestOptions = {
    signal: input.signal,
    timeout: 10_000,
    maxTotalTimeout: 30_000,
    resetTimeoutOnProgress: false
  };
  try {
    const byteBudget = { used: 0 };
    const tools = input.capabilities.tools
      ? await collectPages("tools", input.client.listTools.bind(input.client), "name", LIMITS.tools, requestOptions, byteBudget)
      : [];
    const resources = input.capabilities.resources
      ? await collectPages("resources", input.client.listResources.bind(input.client), "uri", LIMITS.resources, requestOptions, byteBudget)
      : [];
    const resourceTemplates = input.capabilities.resources
      ? await collectPages(
          "resourceTemplates",
          input.client.listResourceTemplates.bind(input.client),
          "uriTemplate",
          LIMITS.resourceTemplates,
          requestOptions,
          byteBudget
        )
      : [];
    const prompts = input.capabilities.prompts
      ? await collectPages("prompts", input.client.listPrompts.bind(input.client), "name", LIMITS.prompts, requestOptions, byteBudget)
      : [];
    const content = { tools, resources, resourceTemplates, prompts };
    const encoded = stableJson(content);
    if (Buffer.byteLength(encoded, "utf8") > LIMITS.totalBytes) throw new Error("MCP_CATALOG_LIMIT");
    return {
      status: "ready",
      snapshot: {
        digestSha256: createHash("sha256").update(encoded).digest("hex"),
        ...content,
        refreshedAt: (input.now ?? (() => new Date()))().toISOString()
      }
    };
  } catch {
    return {
      status: "degraded",
      snapshot: input.previous ?? null,
      errorCode: "MCP_CATALOG_REFRESH_FAILED"
    };
  }
}

async function collectPages(
  kind: keyof typeof LIMITS,
  request: (cursor: string | undefined, options: McpRequestOptions) => Promise<McpPage<Record<string, unknown>>>,
  uniqueKey: string,
  maxItems: number,
  options: McpRequestOptions,
  byteBudget: { used: number }
) {
  const values: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  const keys = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < LIMITS.pages; page += 1) {
    const response = await request(cursor, options);
    if (!response || !Array.isArray(response.items)) throw new Error(`MCP_${String(kind)}_INVALID`);
    for (const item of response.items) {
      const sanitized = sanitizeCatalogItem(kind, item);
      const key = sanitized[uniqueKey];
      if (typeof key !== "string" || !key || key.length > 2_048 || keys.has(key)) throw new Error("MCP_CATALOG_DUPLICATE");
      byteBudget.used += Buffer.byteLength(stableJson(sanitized), "utf8");
      if (byteBudget.used > LIMITS.totalBytes) throw new Error("MCP_CATALOG_LIMIT");
      keys.add(key);
      values.push(sanitized);
      if (values.length > maxItems) throw new Error("MCP_CATALOG_LIMIT");
    }
    const next = response.nextCursor;
    if (next == null || next === "") return values;
    if (typeof next !== "string" || next.length > 1_024 || !isSafeIdentity(next) || cursors.has(next)) {
      throw new Error("MCP_CATALOG_CURSOR_INVALID");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("MCP_CATALOG_PAGE_LIMIT");
}

function sanitizeCatalogItem(kind: keyof typeof LIMITS, value: unknown) {
  const item = inertCatalogValue(value, 0) as Record<string, unknown>;
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP_CATALOG_VALUE_LIMIT");
  if (kind === "tools" || kind === "prompts") {
    if (typeof item.name !== "string" || item.name.length > 128 || !/^[A-Za-z0-9_.:/-]+$/u.test(item.name)) {
      throw new Error("MCP_CATALOG_IDENTITY_INVALID");
    }
  } else if (kind === "resources") {
    if (typeof item.uri !== "string" || item.uri.length > 2_048 || !isSafeIdentity(item.uri)) {
      throw new Error("MCP_CATALOG_IDENTITY_INVALID");
    }
  } else if (kind === "resourceTemplates") {
    if (typeof item.uriTemplate !== "string" || item.uriTemplate.length > 2_048 || !isSafeIdentity(item.uriTemplate)) {
      throw new Error("MCP_CATALOG_IDENTITY_INVALID");
    }
  }
  for (const field of ["name", "title", "uri", "uriTemplate", "mimeType"] as const) {
    const identity = item[field];
    if (identity !== undefined && (typeof identity !== "string" || identity.length > 2_048 || !isSafeIdentity(identity))) {
      throw new Error("MCP_CATALOG_IDENTITY_INVALID");
    }
  }
  return item;
}

function inertCatalogValue(value: unknown, depth: number, field?: string): unknown {
  if (depth > LIMITS.schemaDepth) throw new Error("MCP_CATALOG_SCHEMA_DEPTH");
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP_CATALOG_VALUE_LIMIT");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 64 * 1024) throw new Error("MCP_CATALOG_VALUE_LIMIT");
    if (field === "description") return externalDescription(value);
    if (!isSafeIdentity(value)) throw new Error("MCP_CATALOG_VALUE_LIMIT");
    return value;
  }
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value)) throw new Error("MCP_CATALOG_VALUE_LIMIT");
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 1_024) throw new Error("MCP_CATALOG_VALUE_LIMIT");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error("MCP_CATALOG_VALUE_LIMIT");
      }
      output.push(inertCatalogValue(descriptor.value, depth + 1));
    }
    return output;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error("MCP_CATALOG_VALUE_LIMIT");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 1_024 || keys.some((key) => typeof key !== "string")) throw new Error("MCP_CATALOG_VALUE_LIMIT");
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor) ||
        !key || key.length > 256 || !isSafeIdentity(key) ||
        key === "__proto__" || key === "prototype" || key === "constructor" || key === "toJSON") {
      throw new Error("MCP_CATALOG_VALUE_LIMIT");
    }
    output[key] = inertCatalogValue(descriptor.value, depth + 1, key);
  }
  return output;
}

function externalDescription(value: string) {
  const text = toWellFormed(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  return `[External MCP input] ${text}`.slice(0, 4_096);
}

function isSafeIdentity(value: string) {
  return isWellFormed(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isWellFormed(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function toWellFormed(value: string) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      } else output += "�";
    } else if (unit >= 0xdc00 && unit <= 0xdfff) output += "�";
    else output += value.charAt(index);
  }
  return output;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
