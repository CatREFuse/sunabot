import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../src/types.js";
import { promptCacheKey } from "../../adapters/model/provider/promptCaching.js";

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
  it("keeps the key stable inside one conversation and hides identity values", () => {
    const context = { conversationId: "group:1030412235", stage: "reply" };
    const first = promptCacheKey(provider, context, ["selfie", "websearch"]);
    const second = promptCacheKey(provider, context, ["websearch", "selfie", "selfie"]);

    expect(first).toBe(second);
    expect(first).toMatch(/^sunabot:[a-f0-9]{48}$/);
    expect(first).not.toContain("1030412235");
  });

  it("partitions cache routing when the behavior, conversation, model or tool set changes", () => {
    const base = promptCacheKey(provider, { conversationId: "group:1", stage: "reply" }, ["websearch"]);
    const variants = [
      promptCacheKey(provider, { conversationId: "group:2", stage: "reply" }, ["websearch"]),
      promptCacheKey(provider, { conversationId: "group:1", stage: "memory", memoryKind: "user_profile" }, ["websearch"]),
      promptCacheKey({ ...provider, model: "gpt-5.6-luna" }, { conversationId: "group:1", stage: "reply" }, ["websearch"]),
      promptCacheKey(provider, { conversationId: "group:1", stage: "reply" }, ["selfie", "websearch"])
    ];

    expect(new Set([base, ...variants])).toHaveLength(variants.length + 1);
  });
});
