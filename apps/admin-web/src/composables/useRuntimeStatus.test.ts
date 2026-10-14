import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { setActiveAgentId } from "./agentScope";
import { useRuntimeStatus } from "./useRuntimeStatus";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest, ApiRequestError: class extends Error {} }));

afterEach(() => {
  useRuntimeStatus().stop();
  vi.useRealTimers();
  apiRequest.mockReset();
});

describe("runtime status polling", () => {
  it("lets a 15 second probe complete and reuses manual refreshes during that request", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    apiRequest.mockImplementation((_path, options) => {
      signal = options.signal;
      return new Promise((resolve) => setTimeout(() => resolve({ onebot: { connected: true } }), 15_000));
    });
    const runtime = useRuntimeStatus();
    runtime.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const manual = runtime.refresh();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await manual;
    expect(runtime.status.value?.onebot.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it("clears stale online data when the next status read fails", async () => {
    apiRequest.mockResolvedValueOnce({ onebot: { connected: true } }).mockRejectedValueOnce(new Error("unavailable"));
    const runtime = useRuntimeStatus();
    runtime.start();
    await flushPromises();
    await runtime.refresh();
    expect(runtime.status.value).toBeNull();
    expect(runtime.error.value).toBe("unavailable");
  });

  it("cancels a previous Agent read without accepting its late response", async () => {
    setActiveAgentId("plana");
    let release!: (value: unknown) => void;
    apiRequest.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce({ persona: { id: "arona" } });
    const runtime = useRuntimeStatus();
    runtime.start();
    const firstSignal = apiRequest.mock.calls[0][1].signal as AbortSignal;
    setActiveAgentId("arona");
    await flushPromises();
    expect(firstSignal.aborted).toBe(true);
    release({ persona: { id: "plana" } });
    await flushPromises();
    expect(runtime.status.value?.persona.id).toBe("arona");
    expect(apiRequest.mock.calls[1][0]).toBe("/api/status?agentId=arona");
  });
});
