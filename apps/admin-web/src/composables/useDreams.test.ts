import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDreams } from "./useDreams";
import type { DreamHistoryPayload } from "./useDreams";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("./useAdminApi", () => ({ apiRequest }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function payload(id: string, dreamText: string): DreamHistoryPayload {
  return {
    items: [{
      id,
      date: "2026-07-20",
      status: "completed",
      dreamText,
      scheduledFor: "2026-07-20T04:00:00.000+08:00",
      completedAt: "2026-07-20T04:01:00.000+08:00"
    }],
    timeZone: "Asia/Shanghai",
    nextScheduledFor: "2026-07-21T04:00:00.000+08:00"
  };
}

describe("useDreams", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("keeps the explicit Agent in the request and ignores an older response", async () => {
    const plana = deferred<DreamHistoryPayload>();
    const arona = deferred<DreamHistoryPayload>();
    apiRequest
      .mockReturnValueOnce(plana.promise)
      .mockReturnValueOnce(arona.promise);
    const dreams = useDreams("plana");

    const planaLoad = dreams.load("plana");
    const firstSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const aronaLoad = dreams.load("arona");

    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/memory/dreams?limit=30&agentId=plana");
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/memory/dreams?limit=30&agentId=arona");
    expect(firstSignal.aborted).toBe(true);

    arona.resolve(payload("arona-dream", "阿罗娜的梦"));
    await aronaLoad;
    plana.resolve(payload("plana-dream", "普拉娜的梦"));
    await planaLoad;

    expect(dreams.items.value.map((item) => item.id)).toEqual(["arona-dream"]);
    expect(dreams.timeZone.value).toBe("Asia/Shanghai");
    expect(dreams.loading.value).toBe(false);
  });

  it("clears the previous Agent and exposes a readable load error", async () => {
    apiRequest
      .mockResolvedValueOnce(payload("plana-dream", "普拉娜的梦"))
      .mockRejectedValueOnce(new Error("服务暂不可用"));
    const dreams = useDreams("plana");

    await dreams.load("plana");
    const loaded = await dreams.load("arona");

    expect(loaded).toBe(false);
    expect(dreams.items.value).toEqual([]);
    expect(dreams.error.value).toBe("服务暂不可用");
  });

  it("triggers one Dream through the scoped admin API and refreshes history", async () => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        notificationQueued: true,
        run: payload("manual-dream", "手动梦境").items[0]
      })
      .mockResolvedValueOnce(payload("manual-dream", "手动梦境"));
    const dreams = useDreams("plana");

    await expect(dreams.trigger("plana")).resolves.toBe(true);

    expect(apiRequest.mock.calls[0]).toEqual([
      "/api/memory/dreams/trigger?agentId=plana",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })
    ]);
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/memory/dreams?limit=30&agentId=plana");
    expect(dreams.items.value[0]?.id).toBe("manual-dream");
    expect(dreams.triggerStatus.value).toBe("梦境已完成");
    expect(dreams.triggerStatusKind.value).toBe("success");
    expect(dreams.triggering.value).toBe(false);
  });

  it("shows a manual trigger conflict without clearing loaded history", async () => {
    apiRequest
      .mockResolvedValueOnce(payload("existing-dream", "已经完成的梦"))
      .mockRejectedValueOnce(new Error("今天的 Dream 已完成。"));
    const dreams = useDreams("plana");
    await dreams.load("plana");

    await expect(dreams.trigger("plana")).resolves.toBe(false);

    expect(dreams.items.value[0]?.id).toBe("existing-dream");
    expect(dreams.triggerStatus.value).toBe("今天的 Dream 已完成。");
    expect(dreams.triggerStatusKind.value).toBe("error");
  });
});
