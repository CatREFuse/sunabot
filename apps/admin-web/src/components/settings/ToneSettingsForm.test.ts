import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToneSettingsForm from "./ToneSettingsForm.vue";

describe("ToneSettingsForm", () => {
  it("edits the tone provider and independent model parameters", async () => {
    const modelValue = {
      enabled: false,
      providerId: "",
      model: "gpt-5.4-mini",
      reasoningEffort: "low" as const,
      temperature: 0.7,
      maxOutputTokens: 2400,
      maxRetries: 2
    };
    const wrapper = mount(ToneSettingsForm, {
      props: {
        modelValue,
        providers: [
          { id: "default", label: "Default", kind: "openai-official", enabled: true, model: "gpt-5.4-mini", imageModel: "gpt-image-2", apiKeyEnv: "OPENAI_API_KEY", temperature: 0.7, maxOutputTokens: 2400 },
          { id: "disabled", label: "Disabled", kind: "openai-official", enabled: false, model: "gpt-5.4-mini", imageModel: "gpt-image-2", apiKeyEnv: "OPENAI_API_KEY", temperature: 0.7, maxOutputTokens: 2400 }
        ],
        models: [
          { id: "gpt-5.4-mini", label: "5.4 Mini", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium"] },
          { id: "tone-model", label: "Tone", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"] }
        ]
      },
      global: {
        stubs: {
          RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' }
        }
      }
    });

    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.get('[data-config-field="tone.providerId"]').setValue("default");
    await wrapper.findAll("select")[1]!.setValue("tone-model");
    await wrapper.findAll("select")[2]!.setValue("high");
    await wrapper.get('[data-config-field="tone.temperature"]').setValue("1.1");
    await wrapper.get('[data-confirm-label="确认随机性"]').trigger("click");
    await wrapper.get('[data-config-field="tone.maxOutputTokens"]').setValue("3200");
    await wrapper.get('[data-confirm-label="确认最大输出 Token"]').trigger("click");
    await wrapper.get('[data-config-field="tone.maxRetries"]').setValue("4");
    await wrapper.get('[data-confirm-label="确认失败重试次数"]').trigger("click");

    expect(modelValue).toEqual({
      enabled: true,
      providerId: "default",
      model: "tone-model",
      reasoningEffort: "high",
      temperature: 1.1,
      maxOutputTokens: 3200,
      maxRetries: 4
    });
    expect(wrapper.text()).not.toContain("Disabled");
    expect(wrapper.get('a[href="/system-prompts/conversation.tone-rewrite"]').text()).toContain("编辑正文");
  });
});
