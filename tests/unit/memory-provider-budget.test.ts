import { describe, expect, it } from "vitest";
import {
  MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS,
  MEMORY_PROVIDER_TOTAL_TIMEOUT_MS,
  memoryProviderCompleteOptions
} from "../../src/runtime/memoryProviderBudget.js";

describe("memory provider budget", () => {
  it("uses one bounded attempt with an outer cleanup margin", () => {
    const controller = new AbortController();
    const logContext = {
      conversationId: "group:7",
      stage: "memory" as const,
      promptFamily: "memory.compress-in",
      memoryKind: "working_long_term" as const
    };

    expect(memoryProviderCompleteOptions(controller.signal, logContext)).toEqual({
      signal: controller.signal,
      modelRequestMaxRetries: 0,
      modelRequestAttemptTimeoutMs: 120_000,
      logContext
    });
    expect(MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS).toBe(120_000);
    expect(MEMORY_PROVIDER_TOTAL_TIMEOUT_MS).toBe(135_000);
    expect(MEMORY_PROVIDER_TOTAL_TIMEOUT_MS).toBeGreaterThan(MEMORY_PROVIDER_ATTEMPT_TIMEOUT_MS);
  });
});
