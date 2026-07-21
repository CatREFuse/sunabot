import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ScheduledTask } from "../../types/scheduledTasks";
import ScheduledTaskList from "./ScheduledTaskList.vue";

describe("ScheduledTaskList", () => {
  it("shows every runtime run status in Chinese", () => {
    const statuses = ["pending", "running", "generated", "completed", "failed"] as const;
    const wrapper = mount(ScheduledTaskList, {
      props: {
        tasks: statuses.map((status, index) => task(status, index)),
        category: "all",
        loading: false,
        mutationBusy: false,
        deletingId: "",
        togglingId: "",
        retainingId: ""
      }
    });

    for (const label of ["等待执行", "执行中", "等待投递", "上次成功", "上次失败"]) {
      expect(wrapper.text()).toContain(label);
    }
    for (const status of statuses) expect(wrapper.text()).not.toContain(status);
    expect(wrapper.get("table").element.tagName).toBe("TABLE");
  });

  it("offers permanent retention only for archived tasks", () => {
    const archived = {
      ...task("completed", 0),
      schedule: { kind: "once" as const, runAt: "2026-07-19T01:00:00.000Z" },
      archived: true
    };
    const wrapper = mount(ScheduledTaskList, {
      props: {
        tasks: [archived, task("completed", 1)],
        category: "all",
        loading: false,
        mutationBusy: false,
        deletingId: "",
        togglingId: "",
        retainingId: ""
      }
    });

    expect(wrapper.findAll("button").filter((button) => button.text().includes("永久保留"))).toHaveLength(1);
    expect(wrapper.text()).toContain("归档");
  });

  it("labels Director tasks and keeps the empty Director view system-managed", async () => {
    const director = { ...task("completed", 0), director: true };
    const wrapper = mount(ScheduledTaskList, {
      props: {
        tasks: [director],
        category: "director",
        loading: false,
        mutationBusy: false,
        deletingId: "",
        togglingId: "",
        retainingId: ""
      }
    });
    expect(wrapper.text()).toContain("导演任务");

    await wrapper.setProps({ tasks: [] });
    expect(wrapper.text()).toContain("还没有导演任务");
    expect(wrapper.findAll("button").some((button) => button.text().includes("新建任务"))).toBe(false);
  });
});

function task(lastRunStatus: string, index: number): ScheduledTask {
  return {
    id: `task-${index}`,
    revision: 1,
    name: `任务 ${index + 1}`,
    enabled: true,
    context: "执行提醒",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
    targets: [{ conversationId: "group:10001", mentionUserIds: [] }],
    permanentRetention: false,
    archived: false,
    director: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastRunStatus
  };
}
