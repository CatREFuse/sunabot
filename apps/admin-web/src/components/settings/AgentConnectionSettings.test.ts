import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentConnectionSettings from "./AgentConnectionSettings.vue";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));
const info = { mode: "remote", host: "ecs.example.test", transport: "ssh", onebotPort: 8788, onebotUrl: "ws://172.30.77.1:8788/ws", coreUrl: "ws://127.0.0.1:8788/ws" };
const agents = ["plana", "arona"].map((id) => ({
  id, name: id, enabled: true,
  accounts: [{ id: `qq_${id}`, agentId: id, label: `${id} QQ`, enabled: true, connected: true, runtimeReady: true, webuiPort: 6099 }]
}));
beforeEach(() => {
  vi.useFakeTimers();
  apiRequest.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/agents") return { agents };
    if (url.endsWith("/connection")) return info;
    if (url.endsWith("/login/status")) return { online: false, connected: true };
    throw new Error(`Unexpected URL ${url}`);
  });
});
afterEach(() => vi.useRealTimers());

describe("Agent QQ connection", () => {
  it("separates QQ login from OneBot and shows host, ports and autostart", async () => {
    const wrapper = mount(AgentConnectionSettings, { props: { agentId: "plana" } });
    await flushPromises();
    expect(wrapper.text()).toContain("远程托管");
    expect(wrapper.text()).toContain("ecs.example.test");
    expect(wrapper.text()).toContain("8788");
    expect(wrapper.text()).toContain("6099");
    expect(wrapper.text()).toContain("自启动已启用");
    expect(wrapper.text()).toContain("OneBot 已连接");
    expect(wrapper.text()).toContain("QQ 未登录");
    expect(wrapper.text()).not.toContain("QQ 在线");
    expect(wrapper.findAll("button").some((button) => button.text() === "接入 QQ")).toBe(false);
    wrapper.unmount();
    apiRequest.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("ignores a delayed login response after switching Agent", async () => {
    const original = apiRequest.getMockImplementation()!;
    let release!: (value: unknown) => void;
    apiRequest.mockImplementation((url: string, options: unknown) => url.includes("/plana/") && url.endsWith("/login/status")
      ? new Promise((resolve) => { release = resolve; }) : original(url, options));
    const wrapper = mount(AgentConnectionSettings, { props: { agentId: "plana" } });
    await flushPromises();
    await wrapper.setProps({ agentId: "arona" });
    await flushPromises();
    release({ online: true, connected: true, data: { user_id: 111 } });
    await flushPromises();
    expect(wrapper.text()).toContain("arona QQ");
    expect(wrapper.text()).not.toContain("plana QQ");
    expect(wrapper.text()).toContain("QQ 未登录");
    wrapper.unmount();
  });

  it("keeps authenticated but temporarily offline QQ separate from signed out", async () => {
    const original = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation((url: string, options: unknown) => url.endsWith("/login/status")
      ? Promise.resolve({ online: false, connected: false, authenticated: true, data: { user_id: 111 } })
      : original(url, options));
    const wrapper = mount(AgentConnectionSettings, { props: { agentId: "plana" } });
    await flushPromises();
    expect(wrapper.text()).toContain("QQ 等待恢复");
    expect(wrapper.text()).toContain("OneBot 未连接");
    expect(wrapper.text()).not.toContain("QQ 未登录");
    wrapper.unmount();
  });

  it("clears stale online state on failure and retains the connection address", async () => {
    const original = apiRequest.getMockImplementation()!;
    let failure = false;
    apiRequest.mockImplementation((url: string, options: unknown) => url.endsWith("/login/status")
      ? failure ? Promise.reject(new Error("登录查询失败")) : Promise.resolve({ online: true, connected: true, data: { user_id: 111 } })
      : original(url, options));
    const wrapper = mount(AgentConnectionSettings, { props: { agentId: "plana" } });
    await flushPromises();
    expect(wrapper.text()).toContain("QQ 在线");
    failure = true;
    await wrapper.findAll("button").find((button) => button.text() === "刷新状态")!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("登录查询失败");
    expect(wrapper.text()).toContain("QQ 状态未知");
    expect(wrapper.text()).not.toContain("QQ 在线");
    expect(wrapper.text()).toContain("ecs.example.test");
    wrapper.unmount();
  });
});
