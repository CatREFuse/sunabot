import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import OrchestratorSettingsForm from "./OrchestratorSettingsForm.vue";

const orchestrator = {
  enabled: false,
  userGroupchatOrchestratorModel: "gpt-5.4-mini",
  reasoningEffort: "medium" as const,
  promptFile: "orchestrator.md",
  messageThreshold: 10,
  recentMessageWindowMs: 60_000
};

describe("OrchestratorSettingsForm", () => {
  it("links the orchestrator control to the user-group master gate", async () => {
    const wrapper = mount(OrchestratorSettingsForm, {
      props: {
        modelValue: { ...orchestrator },
        groupEnabled: false,
        models: []
      },
      global: { stubs: { RouterLink: true } }
    });
    const toggles = wrapper.findAll('input[type="checkbox"]');

    expect(toggles).toHaveLength(2);
    expect(toggles[1]?.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).not.toContain("使用规则匹配回复");

    await wrapper.setProps({ groupEnabled: true });
    expect(wrapper.text()).toContain("使用规则匹配回复");

    await wrapper.setProps({ modelValue: { ...orchestrator, enabled: true } });
    expect(wrapper.text()).toContain("每个群每分钟最多主动回复 1 次");
  });
});
