import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PromptTextField from "./PromptTextField.vue";

const variables = [
  {
    name: "user.input",
    description: "当前用户输入",
    type: "string" as const,
    source: "当前请求",
    required: true
  },
  {
    name: "persona.soul",
    description: "角色核心人格",
    type: "string" as const,
    source: "SOUL.md",
    required: true
  }
];

describe("PromptTextField", () => {
  it("searches variables by annotation and inserts the @{name} syntax", async () => {
    const wrapper = mount(PromptTextField, {
      props: { modelValue: "", variables, label: "系统提示词" }
    });
    const textarea = wrapper.get("textarea");

    await textarea.setValue("@用户");
    const option = wrapper.get('[role="option"]');
    expect(option.text()).toContain("当前用户输入");
    await option.trigger("mousedown");

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["@{user.input}"]);
  });

  it("shows every directly available variable below the input", () => {
    const wrapper = mount(PromptTextField, {
      props: { modelValue: "", variables, label: "用户提示词" }
    });

    expect(wrapper.text()).toContain("可用变量");
    expect(wrapper.text()).toContain("@{user.input}");
    expect(wrapper.text()).toContain("@{persona.soul}");
  });

  it("optionally wraps inserted variables in semantic XML and marks variables already in use", async () => {
    const wrapper = mount(PromptTextField, {
      props: { modelValue: "{{ persona.soul }}\n", variables, label: "系统提示词", semanticXml: true }
    });
    const textarea = wrapper.get("textarea").element as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await wrapper.findAll(".variable-context__row")[0]!.trigger("click");

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([
      "{{ persona.soul }}\n<user_input>@{user.input}</user_input>"
    ]);
    expect(wrapper.findAll(".variable-context__row--used").map((row) => row.text()).join(" ")).toContain("persona.soul");
  });
});
