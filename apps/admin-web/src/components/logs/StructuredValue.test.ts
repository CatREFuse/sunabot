import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StructuredValue from "./StructuredValue.vue";

describe("StructuredValue", () => {
  it("provides a visible control for opening nested prompt and response fields", async () => {
    const wrapper = mount(StructuredValue, {
      props: {
        value: {
          prompt: { text: "完整系统提示词" },
          response: { content: "完整模型返回内容" }
        }
      }
    });

    const nestedDetails = wrapper.findAll("details.structured").slice(1);
    expect(nestedDetails).toHaveLength(2);

    for (const details of nestedDetails) {
      const summary = details.get("summary");
      expect(summary.find(".structured__toggle").exists()).toBe(true);
      expect(summary.classes()).toContain("min-h-11");
      expect((details.element as HTMLDetailsElement).open).toBe(false);
      await summary.trigger("click");
      expect((details.element as HTMLDetailsElement).open).toBe(true);
    }

    expect(wrapper.text()).toContain("完整系统提示词");
    expect(wrapper.text()).toContain("完整模型返回内容");
  });
});
