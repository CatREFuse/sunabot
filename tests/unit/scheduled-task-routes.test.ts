import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  registerScheduledTaskRoutes,
  type ScheduledTaskAdminRuntime
} from "../../apps/api/plugins/scheduledTaskRoutes.js";

function runtime(): ScheduledTaskAdminRuntime {
  return {
    listScheduledTasks: vi.fn(() => [{ id: "task-1" }]),
    getScheduledTask: vi.fn((id) => ({ id })),
    createScheduledTask: vi.fn((input) => ({ id: "task-2", input })),
    updateScheduledTask: vi.fn((id, input) => ({ id, input })),
    deleteScheduledTask: vi.fn((id, input) => ({ id, input }))
  };
}

describe("scheduled task routes", () => {
  it("routes all CRUD operations through the selected Agent runtime", async () => {
    const plana = runtime();
    const arona = runtime();
    const app = Fastify();
    registerScheduledTaskRoutes(app, {
      runtime: plana,
      getRuntime: (agentId) => agentId === "arona" ? arona : plana
    });

    expect((await app.inject({ method: "GET", url: "/api/scheduled-tasks?agentId=arona" })).json())
      .toEqual({ tasks: [{ id: "task-1" }] });
    expect(arona.listScheduledTasks).toHaveBeenCalledOnce();

    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks?agentId=arona",
      payload: { name: "提醒" }
    });
    expect(created.statusCode).toBe(201);
    expect(arona.createScheduledTask).toHaveBeenCalledWith({ name: "提醒" });

    await app.inject({
      method: "PUT",
      url: "/api/scheduled-tasks/task-1?agentId=arona",
      payload: { revision: 2, enabled: false }
    });
    expect(arona.updateScheduledTask).toHaveBeenCalledWith("task-1", { revision: 2, enabled: false });

    await app.inject({
      method: "DELETE",
      url: "/api/scheduled-tasks/task-1?agentId=arona",
      payload: { revision: 2 }
    });
    expect(arona.deleteScheduledTask).toHaveBeenCalledWith("task-1", { revision: 2 });

    await app.close();
  });
});
