import { createHash } from "node:crypto";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import type { ProviderConfig } from "../../../src/types.js";

const CACHE_KEY_PREFIX = "sunabot:";
const CACHE_KEY_HASH_LENGTH = 48;

export function promptCacheKey(
  provider: ProviderConfig,
  context: ProviderLogContext | undefined,
  toolNames: readonly string[]
) {
  const cacheScope = {
    providerId: provider.id,
    providerKind: provider.kind,
    model: provider.model,
    stage: normalizedPart(context?.stage) || "other",
    memoryKind: normalizedPart(context?.memoryKind),
    conversationId: normalizedPart(context?.conversationId),
    tools: [...new Set(toolNames.map(normalizedPart).filter(Boolean))].sort()
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(cacheScope))
    .digest("hex")
    .slice(0, CACHE_KEY_HASH_LENGTH);
  return `${CACHE_KEY_PREFIX}${digest}`;
}

function normalizedPart(value: unknown) {
  return String(value ?? "").trim();
}
