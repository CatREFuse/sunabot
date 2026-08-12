import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerDirectorRoutes, type DirectorAdminRuntime } from "../../apps/api/plugins/directorRoutes.js";

function runtime(): DirectorAdminRuntime {
  return {
    listDirectorSchedules: vi.fn(() => ({
      schedules: [{ date: "2026-07-23", summary: "整理资料" }],
      pagination: { page: 2, pageSize: 14, total: 15, pageCount: 2 }
    }))
  };
}

describe("director routes", () => {
  it("reads decision history from the selected Agent runtime", async () => {
    const plana = runtime();
    const arona = runtime();
    const app = Fastify();
    registerDirectorRoutes(app, {
      runtime: plana,
      getRuntime: (agentId) => agentId === "arona" ? arona : plana
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/director/schedules?agentId=arona&page=2&pageSize=14"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ schedules: [{ date: "2026-07-23" }] });
    expect(arona.listDirectorSchedules).toHaveBeenCalledWith({ page: 2, pageSize: 14 });
    expect((await app.inject({
      method: "GET",
      url: "/api/director/schedules?agentId=arona&page=0&pageSize=32"
    })).statusCode).toBe(400);
    await app.close();
  });
});
