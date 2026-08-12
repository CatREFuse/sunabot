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
  it("renders one standard Markdown contenteditable with line numbers", () => {
    const wrapper = mount(PromptTextField, {
      props: { modelValue: "# 标题\n正文", variables, label: "系统提示词" }
    });

    expect(wrapper.get('[role="textbox"]').attributes("contenteditable")).toBe("true");
    expect(wrapper.get('[role="textbox"]').attributes("data-language")).toBe("markdown");
    expect(wrapper.find(".cm-lineNumbers").exists()).toBe(true);
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.find(".prompt-field__highlight").exists()).toBe(false);
  });

  it("shows every directly available variable below the editor", () => {
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

    await wrapper.findAll(".variable-context__row")[0]!.trigger("click");

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([
      "<user_input>@{user.input}</user_input>{{ persona.soul }}\n"
    ]);
    expect(wrapper.findAll(".variable-context__row--used").map((row) => row.text()).join(" ")).toContain("persona.soul");
  });

  it("keeps the editor scroll position when a variable is inserted", async () => {
    const content = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const wrapper = mount(PromptTextField, {
      props: { modelValue: content, variables, label: "系统提示词" }
    });
    const scroller = wrapper.get(".cm-scroller").element as HTMLElement;
    scroller.scrollTop = 240;

    await wrapper.findAll(".variable-context__row")[0]!.trigger("click");

    expect(scroller.scrollTop).toBe(240);
    expect(wrapper.emitted("update:modelValue")?.at(-1)?.[0]).toContain("@{user.input}");
  });

  it("renders Markdown, embedded HTML, conditional directives, and registered variables", () => {
    const wrapper = mount(PromptTextField, {
      props: {
        modelValue: "# 标题\n- **重点**\n<context s-if=\"tone_mode == true\">@{user.input}</context>",
        variables,
        label: "系统提示词"
      }
    });
    const content = wrapper.get(".cm-content");

    expect(content.text()).toContain("# 标题");
    expect(content.findAll("span").length).toBeGreaterThan(4);
    expect(content.get(".cm-prompt-directive").text()).toContain("s-if=");
    expect(content.get(".cm-prompt-condition").text()).toBe("tone_mode == true");
    expect(content.get(".cm-prompt-variable").text()).toBe("@{user.input}");
  });

  it("styles only registered variable references", () => {
    const wrapper = mount(PromptTextField, {
      props: {
        modelValue: "@{user.input} @{missing.value}",
        variables,
        label: "系统提示词"
      }
    });

    expect(wrapper.findAll(".cm-prompt-variable")).toHaveLength(1);
    expect(wrapper.get(".cm-prompt-variable").text()).toBe("@{user.input}");
    expect(wrapper.get(".cm-content").text()).toContain("@{missing.value}");
  });

  it("reflects an external model update without creating a second text layer", async () => {
    const wrapper = mount(PromptTextField, {
      props: { modelValue: "旧内容", variables, label: "系统提示词" }
    });

    await wrapper.setProps({ modelValue: "# 新内容\n@{user.input}" });

    expect(wrapper.get(".cm-content").text()).toContain("# 新内容");
    expect(wrapper.findAll(".cm-content")).toHaveLength(1);
    expect(wrapper.findAll(".cm-prompt-variable")).toHaveLength(1);
  });
});
