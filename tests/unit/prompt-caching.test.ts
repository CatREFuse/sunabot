import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/types.js";
import {
  promptCacheKey,
  supportsExplicitPromptCaching,
  supportsStablePrefixCaching
} from "../../adapters/model/provider/promptCaching.js";

const provider: ProviderConfig = {
  id: "codex-main",
  label: "Codex",
  kind: "codex-responses",
  enabled: true,
  model: "gpt-5.6-terra",
  imageModel: "gpt-image-2",
  apiKeyEnv: "CODEX_ACCESS_TOKEN",
  temperature: 0.2,
  maxOutputTokens: 1_200
};

describe("prompt cache routing", () => {
  const descriptor = {
    staticPrefix: "stable system",
    tools: [{ type: "function", name: "websearch", parameters: { type: "object" } }],
    responseFormat: { type: "text" }
  };

  it("shares a stable prefix across conversations and hides identity values", () => {
    const first = promptCacheKey(provider, {
      conversationId: "group:1030412235",
      stage: "reply",
      promptFamily: "conversation.private-reply"
    }, descriptor);
    const second = promptCacheKey(provider, {
      conversationId: "group:99887766",
      stage: "reply",
      promptFamily: "conversation.private-reply"
    }, descriptor);

    expect(first).toBe(second);
    expect(first).toMatch(/^sunabot:[a-f0-9]{48}$/);
    expect(first).not.toContain("1030412235");
  });

  it("partitions stable routing when the family, model, stable prefix, tool schema or response format changes", () => {
    const context = { conversationId: "private:1", stage: "reply", promptFamily: "conversation.private-reply" };
    const base = promptCacheKey(provider, context, descriptor);
    const variants = [
      promptCacheKey(provider, { ...context, promptFamily: "conversation.group-reply" }, descriptor),
      promptCacheKey({ ...provider, model: "gpt-5.6-luna" }, context, descriptor),
      promptCacheKey(provider, context, { ...descriptor, staticPrefix: "changed system" }),
      promptCacheKey(provider, context, {
        ...descriptor,
        tools: [{ type: "function", name: "websearch", parameters: { type: "object", required: ["query"] } }]
      }),
      promptCacheKey(provider, context, { ...descriptor, responseFormat: { type: "json_schema" } })
    ];

    expect(new Set([base, ...variants])).toHaveLength(variants.length + 1);
  });

  it("keeps legacy models conversation-scoped and only enables explicit caching for supported providers", () => {
    const legacy = { ...provider, model: "gpt-5.4-mini" };
    const first = promptCacheKey(legacy, { conversationId: "group:1", stage: "reply" }, descriptor);
    const second = promptCacheKey(legacy, { conversationId: "group:2", stage: "reply" }, descriptor);

    expect(first).not.toBe(second);
    expect(supportsExplicitPromptCaching(provider)).toBe(false);
    expect(supportsStablePrefixCaching(provider)).toBe(true);
    expect(supportsExplicitPromptCaching({ ...provider, kind: "openai-official" })).toBe(true);
    expect(supportsExplicitPromptCaching(legacy)).toBe(false);
    expect(supportsExplicitPromptCaching({ ...provider, kind: "openai-compatible" })).toBe(false);
  });

  it("keeps requests without a stable prefix conversation-scoped", () => {
    const withoutPrefix = { ...descriptor, staticPrefix: "" };
    const first = promptCacheKey(provider, { conversationId: "group:1", stage: "reply" }, withoutPrefix);
    const second = promptCacheKey(provider, { conversationId: "group:2", stage: "reply" }, withoutPrefix);

    expect(first).not.toBe(second);
  });
});
