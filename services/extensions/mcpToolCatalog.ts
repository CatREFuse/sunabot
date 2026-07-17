import { createHash } from "node:crypto";

export const MCP_PROVIDER_TOOL_NAME_PATTERN = /^mcp_[a-f0-9]{48}$/u;
export const MCP_PROVIDER_TOOL_MAX_DEFINITIONS = 128;
export const MCP_PROVIDER_TOOL_MAX_BYTES = 256 * 1024;

export interface McpToolCatalogCandidate {
  agentId: string;
  serverId: string;
  toolName: string;
  snapshotDigest: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpToolAliasTarget {
  serverId: string;
  toolName: string;
  snapshotDigest: string;
}

export interface McpProviderToolCatalog {
  definitions: Record<string, unknown>[];
  aliases: Map<string, McpToolAliasTarget>;
  degradedServerIds: Set<string>;
}

export type McpToolAliasDigest = (identity: string) => string;

export function buildMcpProviderToolCatalog(
  values: McpToolCatalogCandidate[],
  digest: McpToolAliasDigest = defaultDigest
): McpProviderToolCatalog {
  const candidates = [...values].sort(compareCandidate);
  const groups = new Map<string, McpToolCatalogCandidate[]>();
  for (const candidate of candidates) {
    const name = providerAlias(candidate, digest);
    const group = groups.get(name) ?? [];
    group.push(candidate);
    groups.set(name, group);
  }

  const definitions: Record<string, unknown>[] = [];
  const aliases = new Map<string, McpToolAliasTarget>();
  const degradedServerIds = new Set<string>();
  let bytes = 0;
  for (const candidate of candidates) {
    const name = providerAlias(candidate, digest);
    const group = groups.get(name)!;
    if (group.length !== 1) {
      for (const collision of group) degradedServerIds.add(collision.serverId);
      continue;
    }
    const definition = {
      type: "function",
      name,
      description: candidate.description,
      parameters: providerSafeSchema(candidate.parameters)
    };
    const definitionBytes = Buffer.byteLength(JSON.stringify(definition), "utf8");
    if (definitions.length >= MCP_PROVIDER_TOOL_MAX_DEFINITIONS ||
        bytes + definitionBytes > MCP_PROVIDER_TOOL_MAX_BYTES) {
      degradedServerIds.add(candidate.serverId);
      continue;
    }
    bytes += definitionBytes;
    definitions.push(definition);
    aliases.set(name, {
      serverId: candidate.serverId,
      toolName: candidate.toolName,
      snapshotDigest: candidate.snapshotDigest
    });
  }
  return { definitions, aliases, degradedServerIds };
}

function providerSafeSchema(value: Record<string, unknown>) {
  const normalized = normalizeSchema(value, 0);
  if (!normalized || normalized.type !== "object") {
    return { type: "object", additionalProperties: true };
  }
  return normalized;
}

function normalizeSchema(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return undefined;
  const source = value as Record<string, unknown>;
  const type = ["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(source.type))
    ? String(source.type)
    : undefined;
  const result: Record<string, unknown> = {};
  if (type) result.type = type;
  if (Array.isArray(source.enum) && source.enum.length <= 128 &&
      source.enum.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
    result.enum = source.enum;
  }
  if (type === "object") {
    const properties = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? source.properties as Record<string, unknown>
      : {};
    const normalizedProperties: Record<string, unknown> = {};
    for (const key of Object.keys(properties).sort(compareText).slice(0, 256)) {
      const property = normalizeSchema(properties[key], depth + 1);
      if (property) normalizedProperties[key] = property;
    }
    result.properties = normalizedProperties;
    if (Array.isArray(source.required)) {
      result.required = source.required.filter((key): key is string =>
        typeof key === "string" && Object.prototype.hasOwnProperty.call(normalizedProperties, key));
    }
    result.additionalProperties = typeof source.additionalProperties === "boolean"
      ? source.additionalProperties
      : true;
  } else if (type === "array") {
    result.items = normalizeSchema(source.items, depth + 1) ?? {};
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key];
  }
  return result;
}

export function isMcpProviderToolAlias(value: string) {
  return MCP_PROVIDER_TOOL_NAME_PATTERN.test(value);
}

function providerAlias(candidate: McpToolCatalogCandidate, digest: McpToolAliasDigest) {
  const identity = JSON.stringify([
    candidate.agentId,
    candidate.serverId,
    candidate.toolName,
    candidate.snapshotDigest
  ]);
  const value = digest(identity).slice(0, 48).toLowerCase();
  if (!/^[a-f0-9]{48}$/u.test(value)) throw new Error("MCP_TOOL_ALIAS_DIGEST_INVALID");
  return `mcp_${value}`;
}

function defaultDigest(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function compareCandidate(left: McpToolCatalogCandidate, right: McpToolCatalogCandidate) {
  return compareText(left.serverId, right.serverId) || compareText(left.toolName, right.toolName);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
