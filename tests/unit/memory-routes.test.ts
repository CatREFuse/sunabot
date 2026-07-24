import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerMemoryRoutes, type MemoryRouteRuntime } from "../../apps/api/plugins/memoryRoutes.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

function runtime(): MemoryRouteRuntime {
  return {
    enrichMemoryEntries: (entries) => entries,
    reload: vi.fn()
  };
}

describe("memory routes", () => {
  it("reads operation logs from the selected Agent with bounded pagination", async () => {
    const planaConfig = createAdminTestConfig("/tmp/plana");
    const aronaConfig = {
      ...createAdminTestConfig("/tmp/arona"),
      persona: {
        ...createAdminTestConfig("/tmp/arona").persona,
        defaultAgentId: "arona"
      }
    };
    const listMemoryOperationLogs = vi.fn(() => ({
      logs: [{ id: "memory-operation-1", category: "memory.operation" }],
      page: 2,
      pageSize: 25,
      total: 26,
      pageCount: 2
    }));
    const app = Fastify();
    registerMemoryRoutes(app, {
      getConfig: () => planaConfig,
      runtime: runtime(),
      getAgentContext: (agentId) => ({
        config: agentId === "arona" ? aronaConfig : planaConfig,
        runtime: runtime()
      }),
      operations: { listMemoryOperationLogs }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/memory/operations?agentId=arona&page=2&pageSize=25"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      logs: [{ id: "memory-operation-1" }],
      page: 2,
      pageSize: 25,
      total: 26,
      pageCount: 2
    });
    expect(listMemoryOperationLogs).toHaveBeenCalledWith(
      expect.objectContaining({ persona: expect.objectContaining({ defaultAgentId: "arona" }) }),
      { page: 2, pageSize: 25 }
    );
    expect((await app.inject({
      method: "GET",
      url: "/api/memory/operations?page=0&pageSize=101"
    })).statusCode).toBe(400);
    await app.close();
  });
});
