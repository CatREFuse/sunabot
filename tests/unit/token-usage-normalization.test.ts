import { describe, expect, it } from "vitest";
import { normalizeTokenUsageRecord } from "../../packages/contracts/model/tokenUsage.js";

describe("compatible provider token usage", () => {
  it("recognizes prompt cache hit and miss counters", () => {
    expect(normalizeTokenUsageRecord({
      providerKind: "openai-compatible",
      response: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20
        }
      }
    })).toMatchObject({
      input: 100,
      output: 10,
      total: 110,
      cachedInput: 80,
      cacheRate: 0.8,
      cacheReported: true
    });
  });

  it("keeps an explicit compatible-provider cache miss distinct from missing cache data", () => {
    expect(normalizeTokenUsageRecord({
      response: {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_miss_tokens: 100
        }
      }
    })).toMatchObject({ cachedInput: 0, cacheRate: 0, cacheReported: true });
  });
});
