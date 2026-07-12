import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DiagnosticsDrawer from "./DiagnosticsDrawer.vue";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

describe("DiagnosticsDrawer", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads tools, request logs and OneBot events only when their tab opens", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/tools") return Promise.resolve({ tools: [
        { name: "assistant_text", title: "行动中消息", description: "发送行动中消息。", enabled: true, available: true, effectiveEnabled: true },
        { name: "codex", title: "Codex", description: "异步执行任务。", enabled: true, available: false, effectiveEnabled: false }
      ] });
      if (path === "/api/request-logs?limit=100") return Promise.resolve({ filePath: "/logs/requests.jsonl", logs: [{ id: "log-1", at: "2026-07-10T00:00:00.000Z", category: "provider", action: "respond" }] });
      if (path === "/api/onebot/events") return Promise.resolve({ events: [{ receivedAt: "2026-07-10T00:00:00.000Z", postType: "message", messageType: "group", text: "hello" }] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const wrapper = mount(DiagnosticsDrawer, { props: { open: true } });
    await flushPromises();

    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(["/api/tools"]);
    expect(wrapper.text()).toContain("assistant_text");
    expect(wrapper.text()).toContain("[READY]");
    expect(wrapper.text()).toContain("[UNAVAILABLE]");

    await wrapper.get("nav").findAll("button")[1]!.trigger("click");
    await flushPromises();
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(["/api/tools", "/api/request-logs?limit=100"]);
    expect(wrapper.text()).toContain("运行事件");
    expect(wrapper.text()).toContain("respond");

    await wrapper.get("nav").findAll("button")[2]!.trigger("click");
    await flushPromises();
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(["/api/tools", "/api/request-logs?limit=100", "/api/onebot/events"]);
    expect(wrapper.text()).toContain("收到群聊消息");
    expect(wrapper.text()).toContain("message.group");
  });
});
