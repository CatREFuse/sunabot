import { flushPromises, mount } from "@vue/test-utils";
import { shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask } from "../../types/scheduledTasks";

const dependencies = vi.hoisted(() => ({ data: null as ReturnType<typeof createData> | null }));
vi.mock("../../composables/useScheduledTasks", () => ({ useScheduledTasks: () => dependencies.data }));

import ScheduledTaskCatalog from "./ScheduledTaskCatalog.vue";

describe("ScheduledTaskCatalog", () => {
  beforeEach(() => { dependencies.data = createData(); });
  afterEach(() => { document.body.innerHTML = ""; });

  it("reloads for Agent changes and disposes its request context", async () => {
    const wrapper = mount(ScheduledTaskCatalog, {
      props: { agentId: "koharu" },
      attachTo: document.body
    });
    await flushPromises();
    expect(dependencies.data?.load).toHaveBeenCalledWith("koharu");

    await wrapper.setProps({ agentId: "plana" });
    await flushPromises();
    expect(dependencies.data?.load).toHaveBeenLastCalledWith("plana");

    wrapper.unmount();
    expect(dependencies.data?.dispose).toHaveBeenCalledOnce();
  });

  it("opens the editor and sends a valid task through the composable", async () => {
    const wrapper = mount(ScheduledTaskCatalog, {
      props: { agentId: "plana" },
      attachTo: document.body
    });
    await flushPromises();
    await wrapper.get("button.btn-primary").trigger("click");
    await flushPromises();
    expect(document.body.textContent).toContain("新建定时任务");
    wrapper.unmount();
  });

  it("passes the task revision snapshot when deleting", async () => {
    const scheduledTask = task();
    dependencies.data = createData([scheduledTask]);
    const wrapper = mount(ScheduledTaskCatalog, {
      props: { agentId: "plana" },
      attachTo: document.body
    });
    await flushPromises();

    await wrapper.get('[aria-label="删除 每日提醒"]').trigger("click");
    await flushPromises();
    const confirm = [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "删除");
    expect(confirm).toBeDefined();
    confirm?.click();
    await flushPromises();

    expect(dependencies.data?.remove).toHaveBeenCalledWith("plana", scheduledTask);
    wrapper.unmount();
  });
});

function createData(tasks: ScheduledTask[] = []) {
  return {
    tasks: shallowRef(tasks),
    conversations: shallowRef([]),
    category: shallowRef("all" as const),
    pagination: shallowRef({ page: 1, pageSize: 20, total: tasks.length, pageCount: 1 }),
    loading: shallowRef(false),
    saving: shallowRef(false),
    deletingId: shallowRef(""),
    togglingId: shallowRef(""),
    retainingId: shallowRef(""),
    mutationBusy: shallowRef(false),
    status: shallowRef({ kind: "idle" as const, message: "" as const }),
    load: vi.fn().mockResolvedValue(true),
    selectCategory: vi.fn().mockResolvedValue(true),
    changePage: vi.fn().mockResolvedValue(true),
    save: vi.fn().mockResolvedValue(true),
    setEnabled: vi.fn().mockResolvedValue(true),
    setPermanentRetention: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    clearStatus: vi.fn(),
    dispose: vi.fn()
  };
}

function task(): ScheduledTask {
  return {
    id: "daily",
    revision: 7,
    name: "每日提醒",
    enabled: true,
    context: "提醒提交日报",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
    targets: [{ conversationId: "group:10001", mentionUserIds: ["7"] }],
    permanentRetention: false,
    archived: false,
    director: false,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}
