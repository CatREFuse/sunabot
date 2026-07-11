import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DiagnosticsDrawer from "./DiagnosticsDrawer.vue";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

describe("DiagnosticsDrawer", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("loads tools, request logs and OneBot events only when their tab opens", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/tools") return Promise.resolve({ tools: [{ name: "system.time", title: "时间", description: "读取当前时间。", enabled: true }] });
      if (path === "/api/request-logs?limit=100") return Promise.resolve({ filePath: "/logs/requests.jsonl", logs: [{ id: "log-1", at: "2026-07-10T00:00:00.000Z", category: "provider", action: "respond" }] });
      if (path === "/api/onebot/events") return Promise.resolve({ events: [{ receivedAt: "2026-07-10T00:00:00.000Z", postType: "message", messageType: "group", text: "hello" }] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const wrapper = mount(DiagnosticsDrawer, { props: { open: true } });
    await flushPromises();

    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(["/api/tools"]);
    expect(wrapper.text()).toContain("system.time");

    await wrapper.get("nav").findAll("button")[1]!.trigger("click");
    await flushPromises();
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(["/api/tools", "/api/request-logs?limit=100"]);
    expect(wrapper.text()).toContain("provider · respond");

    await wrapper.get("nav").findAll("button")[2]!.trigger("click");
    await flushPromises();
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(["/api/tools", "/api/request-logs?limit=100", "/api/onebot/events"]);
    expect(wrapper.text()).toContain("message · group");
  });
});
