import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ToneSettingsForm from "./ToneSettingsForm.vue";

describe("ToneSettingsForm", () => {
  it("edits the tone provider and independent model parameters", async () => {
    const modelValue = {
      enabled: false,
      followMainModel: false,
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
        defaultProviderId: "default",
        mainMaxRetries: 3,
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
      followMainModel: false,
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

  it("shows and locks the main model configuration while following it", () => {
    const modelValue = {
      enabled: true,
      followMainModel: true,
      providerId: "tone-provider",
      model: "tone-model",
      reasoningEffort: "low" as const,
      temperature: 1.1,
      maxOutputTokens: 3200,
      maxRetries: 4
    };
    const wrapper = mount(ToneSettingsForm, {
      props: {
        modelValue,
        defaultProviderId: "main-provider",
        mainMaxRetries: 3,
        providers: [
          { id: "main-provider", label: "Main", kind: "openai-official", enabled: true, model: "main-model", imageModel: "gpt-image-2", apiKeyEnv: "OPENAI_API_KEY", reasoningEffort: "high", temperature: 0.4, maxOutputTokens: 9600 }
        ],
        models: [
          { id: "main-model", label: "Main Model", defaultReasoningEffort: "high", supportedReasoningEfforts: ["medium", "high"] },
          { id: "tone-model", label: "Tone", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"] }
        ]
      },
      global: {
        stubs: { RouterLink: { props: ["to"], template: '<a :href="to"><slot /></a>' } }
      }
    });

    const selects = wrapper.findAll("select");
    expect(selects.map((select) => (select.element as HTMLSelectElement).value)).toEqual([
      "main-provider", "main-model", "high"
    ]);
    expect(selects.every((select) => (select.element as HTMLSelectElement).disabled)).toBe(true);
    expect(wrapper.get('[data-config-field="tone.temperature"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-config-field="tone.maxOutputTokens"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-config-field="tone.maxRetries"]').attributes("disabled")).toBeDefined();
    expect((wrapper.get('[data-config-field="tone.temperature"]').element as HTMLInputElement).value).toBe("0.4");
    expect((wrapper.get('[data-config-field="tone.maxOutputTokens"]').element as HTMLInputElement).value).toBe("9600");
    expect((wrapper.get('[data-config-field="tone.maxRetries"]').element as HTMLInputElement).value).toBe("3");
    expect(modelValue).toMatchObject({
      providerId: "tone-provider",
      model: "tone-model",
      maxRetries: 4
    });
  });
});
