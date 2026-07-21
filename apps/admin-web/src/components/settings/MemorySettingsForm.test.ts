import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MemorySettingsForm from "./MemorySettingsForm.vue";

describe("MemorySettingsForm", () => {
  it("edits the per-Agent Dream sampling window and bucket limits", async () => {
    const modelValue = {
      memoryModel: "gpt-5.4-mini",
      reasoningEffort: "low" as const,
      messageThreshold: 48,
      workingMemoryMaxEntries: 100,
      dreamRecentWindowHours: 48,
      dreamRecentMemoryLimit: 12,
      dreamOlderMemoryLimit: 12,
      workMemoryCompressInPrompt: "work_memory_compress_in.json",
      workMemoryCompressOutPrompt: "work_memory_compress_out.json",
      userProfilePrompt: "user_profile_prompt.json"
    };
    const wrapper = mount(MemorySettingsForm, {
      props: {
        modelValue,
        models: [{
          id: "gpt-5.4-mini",
          label: "5.4 Mini",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "medium"]
        }]
      },
      global: {
        stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } }
      }
    });

    await wrapper.get('[data-config-field="memory.dreamRecentWindowHours"]').setValue("36");
    await wrapper.get('[data-confirm-label="确认近期窗口"]').trigger("click");
    await wrapper.get('[data-config-field="memory.dreamRecentMemoryLimit"]').setValue("8");
    await wrapper.get('[data-confirm-label="确认近期记忆数"]').trigger("click");
    await wrapper.get('[data-config-field="memory.dreamOlderMemoryLimit"]').setValue("10");
    await wrapper.get('[data-confirm-label="确认更早记忆数"]').trigger("click");

    expect(modelValue).toMatchObject({
      dreamRecentWindowHours: 36,
      dreamRecentMemoryLimit: 8,
      dreamOlderMemoryLimit: 10
    });
    expect(wrapper.text()).toContain("近期与更早记忆合计最多 24 条");
  });
});
