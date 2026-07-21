import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import PromptVariableTable from "./PromptVariableTable.vue";

const variables = [{
  name: "tone.output_contract",
  description: "当前回复方式的完整输出格式契约",
  type: "string" as const,
  source: "语气处理设置",
  required: true
}];

describe("PromptVariableTable", () => {
  afterEach(() => {
    document.querySelectorAll('[role="tooltip"]').forEach((element) => element.remove());
  });

  it("shows the full variable description on pointer hover and keyboard focus", async () => {
    const wrapper = mount(PromptVariableTable, {
      props: { variables },
      attachTo: document.body
    });
    const token = wrapper.get(".variable-context__token");

    await token.trigger("pointerenter");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("当前回复方式的完整输出格式契约");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("语气处理设置");

    await token.trigger("pointerleave");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await wrapper.get("button").trigger("focus");
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("@{tone.output_contract}");
    wrapper.unmount();
  });

  it("keeps the rounded variable marker inside the insert action", async () => {
    const wrapper = mount(PromptVariableTable, { props: { variables } });
    expect(wrapper.get(".variable-context__token code").text()).toBe("@{tone.output_contract}");

    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("insert")).toEqual([["tone.output_contract"]]);
  });
});
