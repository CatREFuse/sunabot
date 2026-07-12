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

  it("lets the editor fill the entire field when the embedded variable table is hidden", () => {
    const wrapper = mount(PromptTextField, {
      props: {
        modelValue: "# 完整高度",
        variables,
        label: "系统提示词",
        fill: true,
        showVariables: false
      }
    });

    expect(wrapper.get(".prompt-field").classes()).toContain("prompt-field--fill");
    expect(wrapper.get(".prompt-field").classes()).not.toContain("prompt-field--with-variables");
    expect(wrapper.find('[aria-label="提示词变量表"]').exists()).toBe(false);
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

  it("keeps the editor scroll position when a variable is inserted", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const wrapper = mount(PromptTextField, {
      props: { modelValue: content, variables, label: "系统提示词" }
    });
    const textarea = wrapper.get("textarea").element as HTMLTextAreaElement;
    textarea.scrollTop = 240;
    textarea.setSelectionRange(12, 12);

    await wrapper.findAll(".variable-context__row")[0]!.trigger("click");

    expect(textarea.scrollTop).toBe(240);
    expect(wrapper.emitted("update:modelValue")?.at(-1)?.[0]).toContain("@{user.input}");
  });

  it("renders escaped Markdown and XML syntax in the highlight layer", () => {
    const wrapper = mount(PromptTextField, {
      props: {
        modelValue: "# 标题\n- **重点**与*斜体*\n> 引用\n`code` <context>@{user.input}</context>\n```ts\nconst value = '<safe>';\n**代码内不是粗体**\n```",
        variables,
        label: "系统提示词"
      }
    });
    const highlight = wrapper.get(".prompt-field__highlight");

    expect(highlight.find(".markup-heading").exists()).toBe(true);
    expect(highlight.find(".markup-bold").text()).toBe("**重点**");
    expect(highlight.find(".markup-italic").text()).toBe("*斜体*");
    expect(highlight.find(".markup-quote").exists()).toBe(true);
    expect(highlight.findAll(".markup-xml")).toHaveLength(2);
    expect(highlight.find(".markup-code-block").text()).toContain("const value = '<safe>';\n**代码内不是粗体**");
    expect(highlight.findAll(".markup-code-fence")).toHaveLength(2);
    expect(highlight.find(".markup-code-block").find(".markup-bold").exists()).toBe(false);
    expect(highlight.html()).toContain("&lt;safe&gt;");
    expect(highlight.text()).toContain("@{user.input}");
  });
});
