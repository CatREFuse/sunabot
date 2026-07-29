import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MemorySettingsForm from "./MemorySettingsForm.vue";

describe("MemorySettingsForm", () => {
  it("links Dream to the system prompt editor", () => {
    const wrapper = shallowMount(MemorySettingsForm, {
      props: {
        modelValue: {
          memoryModel: "gpt-5.5",
          reasoningEffort: "medium",
          messageThreshold: 48,
          workingMemoryMaxEntries: 100,
          dreamRecentWindowHours: 24,
          dreamRecentMemoryLimit: 24,
          dreamOlderMemoryLimit: 12,
          workMemoryCompressInPrompt: "work_memory_compress_in.json",
          workMemoryCompressOutPrompt: "work_memory_compress_out.json",
          userProfilePrompt: "user_profile_prompt.json"
        },
        models: []
      },
      global: {
        stubs: {
          RouterLink: {
            props: ["to"],
            template: '<a :href="to"><slot /></a>'
          }
        }
      }
    });

    const dreamLink = wrapper.find('a[href="/system-prompts/memory.dream"]');
    expect(wrapper.text()).toContain("memory_dream.json");
    expect(dreamLink.exists()).toBe(true);
    expect(dreamLink.text()).toBe("编辑正文 →");
  });
});
