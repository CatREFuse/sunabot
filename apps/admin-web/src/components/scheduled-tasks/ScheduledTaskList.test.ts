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
        loading: false,
        mutationBusy: false,
        deletingId: "",
        togglingId: ""
      }
    });

    for (const label of ["等待执行", "执行中", "等待投递", "上次成功", "上次失败"]) {
      expect(wrapper.text()).toContain(label);
    }
    for (const status of statuses) expect(wrapper.text()).not.toContain(status);
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
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    lastRunStatus
  };
}
