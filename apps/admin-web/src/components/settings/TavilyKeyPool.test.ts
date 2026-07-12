import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { BotToolSettingsDraft } from "../../types";
import TavilyKeyPool from "./TavilyKeyPool.vue";

function websearchDraft(): BotToolSettingsDraft["websearch"] {
  return {
    provider: "tavily",
    tavilyApiKey: "",
    tavilyApiKeys: [],
    tavilyApiKeyEnv: "TAVILY_API_KEY",
    maxResults: 5,
    removeTavilyApiKeyIndexes: []
  };
}

describe("TavilyKeyPool", () => {
  it("shows persisted key status without exposing secrets", async () => {
    const draft = websearchDraft();
    const wrapper = mount(TavilyKeyPool, {
      props: {
        modelValue: draft,
        fieldState: {
          applyMode: "hot",
          secretConfigured: true,
          secretCount: 3,
          storedSecretCount: 2
        }
      }
    });

    expect(wrapper.get(".key-pool__summary").text().replace(/\s+/g, " ")).toBe("2 个已保存 · 1 个环境变量来源");
    expect(wrapper.text()).toContain("Key 1");
    expect(wrapper.text()).toContain("已保存");
    expect(wrapper.text()).not.toContain("tvly-");

    await wrapper.get('button[aria-label="删除 Key 1"]').trigger("click");
    expect(draft.removeTavilyApiKeyIndexes).toEqual([0]);
    expect(wrapper.text()).toContain("待删除");
  });

  it("adds multiple write-only key inputs", async () => {
    const draft = websearchDraft();
    const wrapper = mount(TavilyKeyPool, { props: { modelValue: draft } });

    await wrapper.get("button.btn-ghost").trigger("click");
    await wrapper.get('[aria-label="Tavily API Key 1"]').setValue("tvly-new-key-1234567890");

    expect(draft.tavilyApiKeys).toEqual(["tvly-new-key-1234567890"]);
    expect(wrapper.get(".key-pool__summary").text().replace(/\s+/g, " ")).toBe("0 个已保存 · 1 个待保存");
  });
});
