import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDreams } from "./useDreams";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("./useAdminApi", () => ({ apiRequest }));

describe("useDreams", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("retains retry and terminal failure metadata from the active Agent history", async () => {
    apiRequest.mockResolvedValue({
      items: [{
        id: "dream-run-1",
        date: "2026-07-20",
        status: "failed",
        scheduledFor: "2026-07-20T04:00:00.000Z",
        attemptCount: 1,
        maxAttempts: 3,
        errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
        errorText: "Dream output contract is invalid.",
        nextRetryAt: "2026-07-20T04:20:00.000Z",
        failedAt: "2026-07-20T04:05:00.000Z"
      }],
      timeZone: "Asia/Shanghai",
      nextScheduledFor: "2026-07-21T04:00:00.000Z"
    });
    const dreams = useDreams("plana");

    await expect(dreams.load("plana")).resolves.toBe(true);
    expect(dreams.items.value[0]).toMatchObject({
      attemptCount: 1,
      maxAttempts: 3,
      errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
      nextRetryAt: "2026-07-20T04:20:00.000Z"
    });
  });
});
