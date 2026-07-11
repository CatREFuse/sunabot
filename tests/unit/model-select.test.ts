import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ModelSelect from "../../apps/admin-web/src/components/settings/ModelSelect.vue";
import ReasoningEffortSelect from "../../apps/admin-web/src/components/settings/ReasoningEffortSelect.vue";
import type { ModelCatalogItem } from "../../apps/admin-web/src/types";

const models: ModelCatalogItem[] = [
  model("gpt-5.5", "5.5", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.6-sol", "5.6 Sol", "low", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-terra", "5.6 Terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-luna", "5.6 Luna", "medium", ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.4", "5.4", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.4-mini", "5.4 Mini", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.3-codex-spark", "5.3 Codex Spark", "high", ["low", "medium", "high", "xhigh"])
];

describe("model settings controls", () => {
  it("renders the seven requested models in product order", () => {
    const wrapper = mount(ModelSelect, {
      props: { modelValue: "gpt-5.5", models }
    });

    expect(wrapper.findAll("option").map((option) => option.text())).toEqual([
      "5.5",
      "5.6 Sol",
      "5.6 Terra",
      "5.6 Luna",
      "5.4",
      "5.4 Mini",
      "5.3 Codex Spark",
      "自定义"
    ]);
  });

  it("limits Luna reasoning and resets unsupported ultra to its default", async () => {
    const wrapper = mount(ReasoningEffortSelect, {
      props: { modelValue: "ultra", model: "gpt-5.6-luna", models }
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll("option").map((option) => option.text())).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["medium"]);
    expect(wrapper.text()).toContain("[ADJUSTED TO MEDIUM]");
  });

  it("keeps the full compatible effort set for a custom model", () => {
    const wrapper = mount(ReasoningEffortSelect, {
      props: { modelValue: "minimal", model: "local-model", models }
    });

    expect(wrapper.findAll("option").map((option) => option.text())).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});

function model(
  id: string,
  label: string,
  defaultReasoningEffort: ModelCatalogItem["defaultReasoningEffort"],
  supportedReasoningEfforts: ModelCatalogItem["supportedReasoningEfforts"]
): ModelCatalogItem {
  return { id, label, defaultReasoningEffort, supportedReasoningEfforts };
}
