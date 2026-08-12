// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { forceRuntimeDreamForHost } from "../../src/runtime/dreamRuntime.js";

describe("manual Dream runtime trigger", () => {
  it("queues one distinct administrator notice for each accepted cycle on the same daily run", async () => {
    const acceptedRuns = [
      { id: "dream-daily", seed: "manual-cycle-a", attemptCount: 1 },
      { id: "dream-daily", seed: "manual-cycle-b", attemptCount: 1 }
    ];
    let acceptedIndex = 0;
    let currentRun = acceptedRuns[0]!;
    const enqueueSystemCallback = vi.fn(async () => undefined);
    const host = {
      config: { bot: { adminQq: "99112233" } },
      dreams: {
        force: async (_now: Date, onAccepted: (run: typeof currentRun) => Promise<void>) => {
          currentRun = acceptedRuns[acceptedIndex++]!;
          await onAccepted(currentRun);
          return currentRun;
        },
        listHistory: () => ({
          items: [{ id: currentRun.id, date: "2026-08-07", status: "running" }]
        })
      },
      scheduledTasks: { enqueueSystemCallback }
    } as unknown as Parameters<typeof forceRuntimeDreamForHost>[0];

    await forceRuntimeDreamForHost(host, { accountId: "primary" });
    await forceRuntimeDreamForHost(host, { accountId: "primary" });

    expect(enqueueSystemCallback).toHaveBeenCalledTimes(2);
    const noticeIds = enqueueSystemCallback.mock.calls.map(([notice]) => notice.id);
    expect(new Set(noticeIds).size).toBe(2);
    expect(enqueueSystemCallback.mock.calls[0]![0]).toMatchObject({
      kind: "dream-manual-start",
      target: { conversationId: "account:primary:private:99112233" }
    });
  });
});
