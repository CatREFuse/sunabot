import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { BotToolSettingsDraft } from "../../types";
import ToolsSettingsForm from "./ToolsSettingsForm.vue";

const apiRequest = vi.hoisted(() => vi.fn(async () => ({ tools: [] })));
vi.mock("../../composables/useAdminApi", () => ({ apiRequest }));

function toolsDraft(): BotToolSettingsDraft {
  return {
    maxCalls: 20,
    overrides: {},
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

function bashDraft() {
  return {
    enabled: false,
    allowGroup: false,
    adminOnly: true,
    workspaceOnly: true,
    blockedKeywords: []
  };
}

describe("ToolsSettingsForm", () => {
  it("opens the semantic tool catalog tab by default", () => {
    const wrapper = mount(ToolsSettingsForm, {
      props: { modelValue: toolsDraft(), bash: bashDraft(), models: [] }
    });

    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text())).toEqual(["工具目录", "运行参数"]);
    expect(tabs[0]?.attributes("aria-selected")).toBe("true");
    expect(wrapper.get('[role="tabpanel"][aria-labelledby="tools-tab-catalog"]').attributes("hidden")).toBeUndefined();
    expect(wrapper.get('[role="tabpanel"][aria-labelledby="tools-tab-runtime"]').attributes("hidden")).toBeDefined();
  });

  it("renders web search and Codex as separate runtime settings", async () => {
    const wrapper = mount(ToolsSettingsForm, {
      props: {
        modelValue: toolsDraft(),
        bash: bashDraft(),
        models: [{
          id: "gpt-5.4-mini",
          label: "GPT-5.4 mini",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"]
        }]
      }
    });
    await wrapper.get("#tools-tab-runtime").trigger("click");

    expect(wrapper.text()).toContain("网页搜索");
    expect(wrapper.text()).toContain("Tavily Key 池");
    expect(wrapper.text()).toContain("Codex");
    expect(wrapper.text()).not.toContain("Codex Search");
    expect(wrapper.text()).not.toContain("Codex 搜索");
    expect(wrapper.find('input[type="number"][max="10"]').exists()).toBe(true);
    expect((wrapper.find('input[type="number"][max="16"]').element as HTMLInputElement).value).toBe("2");
  });

  it("shows Codex status and disables its parameters when Codex is disabled", async () => {
    const draft = toolsDraft();
    draft.codex.enabled = false;
    const wrapper = mount(ToolsSettingsForm, {
      props: { modelValue: draft, bash: bashDraft(), models: [] }
    });
    await wrapper.get("#tools-tab-runtime").trigger("click");

    expect(wrapper.text()).toContain("已停用");
    expect(wrapper.find('input[placeholder="auto"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('input[type="number"][max="86400000"]').attributes("disabled")).toBeDefined();
  });
});
