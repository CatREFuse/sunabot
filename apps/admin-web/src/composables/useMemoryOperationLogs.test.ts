import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryOperationLogPayload } from "../types";
import { useMemoryOperationLogs } from "./useMemoryOperationLogs";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

function payload(id: string): MemoryOperationLogPayload {
  return {
    logs: [{
      id,
      at: "2026-07-24T01:00:00.000Z",
      category: "memory.operation",
      action: "working.append"
    }],
    page: 1,
    pageSize: 50,
    total: 1,
    pageCount: 1
  };
}

describe("useMemoryOperationLogs", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads the selected Agent page and ignores a late previous Agent response", async () => {
    let resolvePlana!: (value: MemoryOperationLogPayload) => void;
    let resolveArona!: (value: MemoryOperationLogPayload) => void;
    apiRequest
      .mockReturnValueOnce(new Promise<MemoryOperationLogPayload>((resolve) => { resolvePlana = resolve; }))
      .mockReturnValueOnce(new Promise<MemoryOperationLogPayload>((resolve) => { resolveArona = resolve; }));
    const logs = useMemoryOperationLogs();

    const planaLoad = logs.load("plana", 1);
    const planaSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const aronaLoad = logs.load("arona", 1);
    resolveArona(payload("arona-operation"));
    await aronaLoad;
    resolvePlana(payload("plana-operation"));
    await planaLoad;

    expect(planaSignal.aborted).toBe(true);
    expect(apiRequest.mock.calls[0]?.[0]).toBe("/api/memory/operations?page=1&pageSize=50&agentId=plana");
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/memory/operations?page=1&pageSize=50&agentId=arona");
    expect(logs.logs.value.map((entry) => entry.id)).toEqual(["arona-operation"]);
  });
});
