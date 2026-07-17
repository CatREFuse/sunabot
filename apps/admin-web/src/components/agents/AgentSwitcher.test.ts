import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSwitcher from "./AgentSwitcher.vue";

const state = vi.hoisted(() => {
  const agents = [
    { id: "plana", name: "普拉娜", enabled: true, workspace: "plana", createdAt: "", updatedAt: "", accounts: [] },
    { id: "arona", name: "阿罗娜", enabled: true, workspace: "arona", createdAt: "", updatedAt: "", accounts: [] }
  ];
  return {
    agents: { value: agents },
    currentAgent: { value: agents[0] },
    load: vi.fn(async () => agents),
    select: vi.fn()
  };
});

vi.mock("../../composables/useAgents", () => ({ useAgents: () => state }));
vi.mock("../../utils/agentIdentity", () => ({ agentAvatarUrl: () => "" }));

function navigation() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/overview", component: { template: "<div />" } },
      { path: "/agents", component: { template: "<div />" } }
    ]
  });
}

describe("AgentSwitcher", () => {
  beforeEach(() => {
    state.load.mockClear();
    state.select.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("supports roving keyboard focus and restores focus on Escape", async () => {
    const router = navigation();
    await router.push("/overview");
    const wrapper = mount(AgentSwitcher, { attachTo: document.body, global: { plugins: [router] } });
    const trigger = wrapper.get<HTMLButtonElement>('button[aria-haspopup="listbox"]');

    await trigger.trigger("keydown", { key: "ArrowDown" });
    const options = wrapper.findAll<HTMLButtonElement>("[data-agent-option]");
    expect(options).toHaveLength(2);
    expect(document.activeElement).toBe(options[0]!.element);

    await options[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]!.element);
    await options[1]!.trigger("keydown", { key: "Home" });
    expect(document.activeElement).toBe(options[0]!.element);
    await options[0]!.trigger("keydown", { key: "End" });
    expect(document.activeElement).toBe(options[1]!.element);

    await options[1]!.trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it("closes without a shadow when focus or pointer moves outside", async () => {
    const router = navigation();
    await router.push("/overview");
    const wrapper = mount(AgentSwitcher, { attachTo: document.body, global: { plugins: [router] } });
    const outside = document.createElement("button");
    document.body.append(outside);

    await wrapper.get('button[aria-haspopup="listbox"]').trigger("click");
    const popup = wrapper.get('[role="listbox"]').element.parentElement!;
    expect(popup.className).not.toContain("shadow");
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);

    await wrapper.get('button[aria-haspopup="listbox"]').trigger("click");
    outside.focus();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("selects in-place on the Agent directory and returns focus", async () => {
    const router = navigation();
    await router.push("/agents");
    const wrapper = mount(AgentSwitcher, { attachTo: document.body, global: { plugins: [router] } });
    const trigger = wrapper.get<HTMLButtonElement>('button[aria-haspopup="listbox"]');

    await trigger.trigger("keydown", { key: "ArrowDown" });
    const options = wrapper.findAll<HTMLButtonElement>("[data-agent-option]");
    await options[1]!.trigger("click");

    expect(state.select).toHaveBeenCalledWith("arona");
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });
});
