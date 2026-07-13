import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AppConfig, ModelCatalogItem } from "../../types";
import ToggleSwitch from "../ui/ToggleSwitch.vue";
import ProviderSettings from "./ProviderSettings.vue";

const models: ModelCatalogItem[] = [
  { id: "gpt-5.6-terra", label: "5.6 Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"] },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }
];

const providers = (): AppConfig["providers"] => ({
  defaultProviderId: "codex",
  items: [
    {
      id: "codex",
      label: "Codex 订阅",
      kind: "codex-responses",
      enabled: true,
      model: "gpt-5.6-terra",
      imageModel: "gpt-image-2",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKeyEnv: "CODEX_ACCESS_TOKEN",
      temperature: 0.7,
      maxOutputTokens: 8192,
      reasoningEffort: "medium",
      modelSource: "remote",
      multimodal: "auto"
    },
    {
      id: "anthropic",
      label: "Anthropic",
      kind: "anthropic-official",
      enabled: true,
      model: "claude-sonnet-4-6",
      imageModel: "",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      temperature: 0.7,
      maxOutputTokens: 8192,
      modelSource: "remote",
      multimodal: "auto"
    }
  ]
});

describe("ProviderSettings", () => {
  it("only marks the selected default provider as locked", async () => {
    const wrapper = mount(ProviderSettings, {
      props: {
        modelValue: providers(),
        models,
        fieldStates: {}
      },
      global: {
        stubs: { CodexSubscriptionAuth: true }
      }
    });

    expect(wrapper.getComponent(ToggleSwitch).props()).toMatchObject({
      disabled: true,
      description: "默认"
    });

    const anthropicButton = wrapper.findAll("aside button").find((button) => button.text().includes("Anthropic"));
    expect(anthropicButton).toBeTruthy();
    await anthropicButton!.trigger("click");

    expect(wrapper.getComponent(ToggleSwitch).props()).toMatchObject({
      disabled: false,
      description: ""
    });
  });

  it("places the API key state in the field label row", () => {
    const wrapper = mount(ProviderSettings, {
      props: {
        modelValue: providers(),
        models,
        fieldStates: {
          "providers.items.codex.apiKeyEnv": { secretConfigured: true }
        }
      },
      global: {
        stubs: { CodexSubscriptionAuth: true }
      }
    });
    const apiKeyLabel = wrapper.findAll(".field-label").find((label) => label.text().includes("API Key 环境变量"));

    expect(apiKeyLabel?.text()).toContain("已配置");
    expect(apiKeyLabel?.classes()).toContain("justify-between");
    expect(wrapper.text()).not.toContain("默认 Provider 保持启用");
    expect(wrapper.text()).not.toContain("名称与固定标识");
  });
});
