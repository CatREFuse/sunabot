import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { BotToolSettingsDraft } from "../../types";
import ToolsSettingsForm from "./ToolsSettingsForm.vue";

function toolsDraft(): BotToolSettingsDraft {
  return {
    maxCalls: 20,
    websearch: {
      provider: "tavily",
      tavilyApiKey: "",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "TAVILY_API_KEY",
      maxResults: 5,
      removeTavilyApiKeyIndexes: []
    },
    codex: {
      enabled: true,
      model: "gpt-5.4-mini",
      codexExecutable: "auto",
      timeoutMs: 900_000,
      maxConcurrency: 2
    },
    generateImg: {
      provider: "codex-image-gen",
      size: "1024x1024",
      resolution: "1K",
      quality: "high"
    }
  };
}

describe("ToolsSettingsForm", () => {
  it("renders Web Search and Codex as separate tools", () => {
    const wrapper = mount(ToolsSettingsForm, {
      props: {
        modelValue: toolsDraft(),
        models: [{
          id: "gpt-5.4-mini",
          label: "GPT-5.4 mini",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"]
        }]
      }
    });

    expect(wrapper.text()).toContain("Web Search");
    expect(wrapper.text()).toContain("Tavily Key 池");
    expect(wrapper.text()).toContain("Codex");
    expect(wrapper.text()).not.toContain("Codex Search");
    expect(wrapper.text()).not.toContain("Codex 搜索");
    expect(wrapper.find('input[type="number"][max="10"]').exists()).toBe(true);
    expect((wrapper.find('input[type="number"][max="16"]').element as HTMLInputElement).value).toBe("2");
  });

  it("disables Codex worker settings when Codex is disabled", () => {
    const draft = toolsDraft();
    draft.codex.enabled = false;
    const wrapper = mount(ToolsSettingsForm, {
      props: { modelValue: draft, models: [] }
    });

    expect(wrapper.find('input[placeholder="auto"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('input[type="number"][max="86400000"]').attributes("disabled")).toBeDefined();
  });
});
