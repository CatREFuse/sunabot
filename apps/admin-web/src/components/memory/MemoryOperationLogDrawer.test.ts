import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MemoryOperationLogDrawer from "./MemoryOperationLogDrawer.vue";

describe("MemoryOperationLogDrawer", () => {
  it("shows human-readable memory operation history and pagination", async () => {
    const wrapper = mount(MemoryOperationLogDrawer, {
      props: {
        open: true,
        logs: [{
          id: "operation-1",
          at: "2026-07-24T01:00:00.000Z",
          category: "memory.operation",
          action: "working.append",
          request: {
            source: "working",
            operation: "append",
            actor: "model_tool",
            conversationId: "group:10001",
            conversationScope: "user_group",
            batchId: "batch-1"
          },
          response: {
            outcome: "applied",
            beforeCount: 1,
            afterCount: 2,
            changedCount: 1,
            afterRevision: "revision-2"
          }
        }],
        page: 1,
        pageSize: 50,
        total: 51,
        pageCount: 2,
        loading: false,
        error: ""
      },
      global: {
        stubs: {
          Teleport: true
        }
      }
    });

    expect(wrapper.get('[aria-label="记忆操作日志列表"]').text()).toContain("已写入");
    expect(wrapper.get('[aria-label="记忆操作日志列表"]').text()).toContain("工作记忆 · 追加");
    expect(wrapper.get('[aria-label="记忆操作日志列表"]').text()).toContain("模型工具");
    expect(wrapper.get('[aria-label="记忆操作日志列表"]').text()).toContain("group:10001 · user_group");
    expect(wrapper.get('[aria-label="记忆操作日志列表"]').text()).toContain("数量 1 → 2 · 变更 1");

    await wrapper.get('[aria-label="记忆操作日志分页"]').findAll("button")[1]!.trigger("click");
    expect(wrapper.emitted("page")).toEqual([[2]]);
    await wrapper.findAll("button").find((button) => button.text() === "关闭")!.trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
