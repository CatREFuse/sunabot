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
          dreamRecentWindowHours: 24,
          dreamRecentMemoryLimit: 24,
          dreamOlderMemoryLimit: 12,
          workMemoryCompressOutPrompt: "work_memory_compress_out.json"
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
    expect(wrapper.text()).not.toContain("近期窗口");
    expect(wrapper.text()).not.toContain("久远记忆");
    expect(wrapper.text()).not.toContain("归档压缩");
  });
});
