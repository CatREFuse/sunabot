// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dreamHistoryItem } from "../../src/runtime/dreamHistory.js";

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "dream-run-1",
    localDate: "2026-07-20",
    status: "failed" as const,
    dreamText: null,
    scheduledFor: "2026-07-20T04:00:00.000Z",
    completedAt: null,
    personaStatus: "pending" as const,
    persona: null,
    result: null,
    attemptCount: 1,
    errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
    errorText: "Dream output failed. Bearer hidden-token api_key=hidden-key\nretry follows.",
    nextRetryAt: "2026-07-20T04:20:00.000Z",
    failedAt: "2026-07-20T04:05:00.000Z",
    ...overrides
  };
}

describe("Dream history projection", () => {
  it("projects retry metadata with a fixed contract error message", () => {
    const item = dreamHistoryItem(source({
      errorText: [
        "Dream output failed.",
        "Bearer hidden-token api_key=hidden-key",
        "/Users/private/workspace",
        "{\"provider\":\"raw output\"}"
      ].join("\n")
    }));

    expect(item).toEqual(expect.objectContaining({
      status: "failed",
      attemptCount: 1,
      maxAttempts: 3,
      errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
      errorText: "Dream 输出格式校验未通过。",
      nextRetryAt: "2026-07-20T04:20:00.000Z",
      failedAt: "2026-07-20T04:05:00.000Z"
    }));
    expect(JSON.stringify(item)).not.toMatch(
      /hidden-token|hidden-key|\/Users\/private|raw output/u
    );
  });

  it("maps malformed stored error codes and text to a generic safe failure", () => {
    const item = dreamHistoryItem(source({
      errorCode: "SK_LIVE_SECRET_ABC123",
      errorText: "sk-live-secret provider payload"
    }));

    expect(item).toEqual(expect.objectContaining({
      errorCode: "DREAM_RUN_FAILED",
      errorText: "Dream 处理失败。"
    }));
    expect(JSON.stringify(item)).not.toMatch(/SK_LIVE_SECRET|sk-live-secret|provider payload/u);
  });

  it("keeps the third contract failure terminal without inventing a retry time", () => {
    expect(dreamHistoryItem(source({
      attemptCount: 3,
      nextRetryAt: null
    }))).toMatchObject({
      attemptCount: 3,
      maxAttempts: 3,
      errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
      status: "failed"
    });
    expect(dreamHistoryItem(source({
      attemptCount: 3,
      nextRetryAt: null
    }))).not.toHaveProperty("nextRetryAt");
  });
});
