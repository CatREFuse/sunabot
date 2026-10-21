import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentManagementSettings from "./AgentManagementSettings.vue";

const state = vi.hoisted(() => ({
  agents: { value: [
    { id: "plana", name: "普拉娜", enabled: true, accounts: [] },
    { id: "arona", name: "阿罗娜", enabled: true, accounts: [] }
  ] },
  error: { value: "" }, select: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn()
}));
vi.mock("../../composables/useAgents", () => ({ useAgents: () => state }));
const stubs = { CreateAgentDialog: true, DeleteAgentDialog: true };
beforeEach(() => vi.clearAllMocks());

describe("unified Agent management", () => {
  it("switches the selected Agent and keeps default Agent deletion unavailable", async () => {
    const wrapper = mount(AgentManagementSettings, { props: { agentId: "plana", beforeChange: vi.fn() }, global: { stubs } });
    expect(wrapper.text()).not.toContain("删除 Bot");
    await wrapper.get('[aria-label="选择 阿罗娜"]').trigger("click");
    expect(state.select).toHaveBeenCalledWith("arona");
    await wrapper.setProps({ agentId: "arona" });
    expect(wrapper.text()).toContain("删除 Bot");
    expect(wrapper.get('[aria-label="选择 阿罗娜"]').attributes("aria-pressed")).toBe("true");
  });

  it("does not create or delete when confirmed settings could not be saved", async () => {
    const beforeChange = vi.fn().mockResolvedValue(false);
    const wrapper = mount(AgentManagementSettings, { props: { agentId: "arona", beforeChange }, global: { stubs } });
    wrapper.findComponent({ name: "CreateAgentDialog" }).vm.$emit("submit", { id: "seia", name: "圣娅" });
    await flushPromises();
    expect(state.create).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("设置保存失败");
    wrapper.findComponent({ name: "DeleteAgentDialog" }).vm.$emit("confirm", "确认删除");
    await flushPromises();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("flushes settings before creation and preserves the import payload", async () => {
    const beforeChange = vi.fn().mockResolvedValue(true);
    const wrapper = mount(AgentManagementSettings, { props: { agentId: "arona", beforeChange }, global: { stubs } });
    const input = { id: "seia", name: "圣娅", import: { fixture: true } };
    wrapper.findComponent({ name: "CreateAgentDialog" }).vm.$emit("submit", input);
    await flushPromises();
    expect(beforeChange.mock.invocationCallOrder[0]).toBeLessThan(state.create.mock.invocationCallOrder[0]!);
    expect(state.create).toHaveBeenCalledWith(input);
  });

  it("shows a failed status mutation and keeps targeting the visible Agent", async () => {
    state.update.mockRejectedValueOnce(new Error("状态更新失败"));
    const wrapper = mount(AgentManagementSettings, { props: { agentId: "arona", beforeChange: vi.fn().mockResolvedValue(true) }, global: { stubs } });
    await wrapper.findAll("button").find((button) => button.text() === "停用")!.trigger("click");
    await flushPromises();
    expect(state.update).toHaveBeenCalledWith("arona", { enabled: false });
    expect(wrapper.get('[role="alert"]').text()).toBe("状态更新失败");
  });

  it("passes explicit delete confirmation only for the current Agent", async () => {
    const wrapper = mount(AgentManagementSettings, { props: { agentId: "arona", beforeChange: vi.fn().mockResolvedValue(true) }, global: { stubs } });
    wrapper.findComponent({ name: "DeleteAgentDialog" }).vm.$emit("confirm", "确认删除");
    await flushPromises();
    expect(state.remove).toHaveBeenCalledWith("arona", "确认删除");
  });
});
