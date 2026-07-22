import { createHash } from "node:crypto";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import type { ProviderConfig } from "../../../packages/contracts/admin/public.js";

const CACHE_KEY_PREFIX = "sunabot:";
const CACHE_KEY_HASH_LENGTH = 48;
const CACHE_PROTOCOL_VERSION = 2;

export interface PromptCacheDescriptor {
  staticPrefix: unknown;
  tools: readonly unknown[];
  responseFormat: unknown;
}

export function promptCacheKey(
  provider: ProviderConfig,
  context: ProviderLogContext | undefined,
  descriptor: PromptCacheDescriptor
) {
  const stablePrefix = supportsStablePrefixCaching(provider) && hasStablePrefix(descriptor.staticPrefix);
  const cacheScope = {
    version: CACHE_PROTOCOL_VERSION,
    providerId: provider.id,
    providerKind: provider.kind,
    model: provider.model,
    stage: normalizedPart(context?.stage) || "other",
    promptFamily: normalizedPart(context?.promptFamily) || defaultPromptFamily(context),
    memoryKind: normalizedPart(context?.memoryKind),
    ...(stablePrefix ? {} : { conversationId: normalizedPart(context?.conversationId) }),
    staticPrefix: digestValue(descriptor.staticPrefix),
    tools: digestValue(descriptor.tools),
    responseFormat: digestValue(descriptor.responseFormat)
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(cacheScope))
    .digest("hex")
    .slice(0, CACHE_KEY_HASH_LENGTH);
  return `${CACHE_KEY_PREFIX}${digest}`;
}

export function supportsExplicitPromptCaching(provider: ProviderConfig) {
  return provider.kind === "openai-official" && isGpt56OrNewer(provider.model);
}

export function supportsStablePrefixCaching(provider: ProviderConfig) {
  return (provider.kind === "openai-official" || provider.kind === "codex-responses") &&
    isGpt56OrNewer(provider.model);
}

function isGpt56OrNewer(model: string) {
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(model.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

function defaultPromptFamily(context: ProviderLogContext | undefined) {
  return [normalizedPart(context?.stage) || "other", normalizedPart(context?.memoryKind)]
    .filter(Boolean)
    .join(":");
}

function hasStablePrefix(value: unknown) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value != null;
}

function digestValue(value: unknown) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(",")}}`;
}

function normalizedPart(value: unknown) {
  return String(value ?? "").trim();
}
