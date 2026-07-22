import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import FinalPromptForm from "./FinalPromptForm.vue";
import FinalPromptWorkspace from "./FinalPromptWorkspace.vue";
import PromptTextField from "./PromptTextField.vue";

const content = `${JSON.stringify({
  messages: [
    { role: "system", content: "@{persona.soul}" },
    "@{messages_64}",
    { role: "user", content: "@{user.input}" }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "search_content",
        description: "搜索内容",
        parameters: { type: "object", properties: {}, required: [] },
        strict: true
      }
    }
  ],
  response_format: { type: "text" },
  temperature: 0.3
}, null, 2)}\n`;

const variables = [
  { name: "persona.soul", description: "核心人格", type: "string" as const, source: "SOUL.md", required: true },
  { name: "messages_64", description: "最近 64 条消息", type: "message[]" as const, source: "会话上下文", required: true },
  { name: "user.input", description: "当前输入", type: "string" as const, source: "当前请求", required: true },
  { name: "conversation.voice.settings", description: "语音语言设置", type: "json" as const, source: "Voice Profile", required: true }
];

describe("FinalPromptForm", () => {
  it("shows ordered messages, message groups, output format and Function Call without raw JSON", () => {
    const wrapper = mount(FinalPromptForm, { props: { modelValue: content, variables } });

    expect(wrapper.find('[aria-label="system 提示词"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="user 提示词"]').exists()).toBe(true);
    expect(wrapper.get('[aria-label="消息组变量"]').element).toMatchObject({ value: "messages_64" });
    expect(wrapper.text()).toContain("Function Call");
    expect(wrapper.text()).toContain("search_content");
    expect(wrapper.text()).toContain("提示词内说明");
    expect(wrapper.text()).not.toContain("全局工具说明优先。");
    expect(wrapper.text()).toContain("输出格式");
    expect(wrapper.find('[aria-label="完整请求 JSON"]').exists()).toBe(false);
    expect(wrapper.get('[data-message-drag-handle]').element.tagName).toBe("DIV");
  });

  it("adds and drag-reorders message slots in the stored messages array", async () => {
    const wrapper = mount(FinalPromptForm, { props: { modelValue: content, variables } });

    wrapper.getComponent(FinalPromptWorkspace).vm.$emit("reorder", 1, 2);
    await wrapper.vm.$nextTick();
    let latest = String(wrapper.emitted("update:modelValue")?.at(-1)?.[0] ?? "");
    expect(JSON.parse(latest).messages).toEqual([
      { role: "system", content: "@{persona.soul}" },
      { role: "user", content: "@{user.input}" },
      "@{messages_64}"
    ]);

    await wrapper.get('[aria-label="添加消息组"]').trigger("click");
    latest = String(wrapper.emitted("update:modelValue")?.at(-1)?.[0] ?? "");
    expect(JSON.parse(latest).messages.at(-1)).toBe("@{messages_64}");
  });

  it("tests OpenAI structure and keeps Function fields synchronized", async () => {
    const wrapper = mount(FinalPromptForm, { props: { modelValue: content, variables } });

    await wrapper.get('[aria-label="测试 OpenAI 格式"]').trigger("click");
    expect(wrapper.text()).toContain("符合 OpenAI 请求结构");
    expect(wrapper.text()).not.toContain("[VALID]");

    const nameInput = wrapper.get('input[type="text"]');
    await nameInput.setValue("find_article");

    const latest = String(wrapper.emitted("update:modelValue")?.at(-1)?.[0] ?? "");
    expect(JSON.parse(latest).tools[0].function.name).toBe("find_article");
    expect(JSON.parse(latest).temperature).toBe(0.3);
  });

  it("inserts prompt variables into Function descriptions", async () => {
    const wrapper = mount(FinalPromptForm, { props: { modelValue: content, variables } });
    const description = wrapper.findAllComponents(PromptTextField)
      .find((component) => component.props("label") === "search_content 工具说明");
    expect(description).toBeDefined();

    description?.vm.insertVariable("conversation.voice.settings");
    await wrapper.vm.$nextTick();

    const latest = String(wrapper.emitted("update:modelValue")?.at(-1)?.[0] ?? "");
    expect(JSON.parse(latest).tools[0].function.description).toBe("@{conversation.voice.settings}搜索内容");
  });

  it("inserts shared-table variables into the active CodeMirror message", async () => {
    const wrapper = mount(FinalPromptForm, {
      props: { modelValue: content, variables, semanticXml: true }
    });

    wrapper.vm.insertVariable("conversation.voice.settings");
    await wrapper.vm.$nextTick();

    const latest = String(wrapper.emitted("update:modelValue")?.at(-1)?.[0] ?? "");
    expect(JSON.parse(latest).messages[0].content).toBe(
      "<conversation_voice_settings>@{conversation.voice.settings}</conversation_voice_settings>@{persona.soul}"
    );
  });

  it("refreshes structured fields when the backing JSON changes externally", async () => {
    const wrapper = mount(FinalPromptForm, { props: { modelValue: content, variables } });
    const next = `${JSON.stringify({
      messages: [
        { role: "system", content: "新的系统提示词" },
        { role: "user", content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "json_object" },
      max_output_tokens: 640
    }, null, 2)}\n`;

    await wrapper.setProps({ modelValue: next });

    expect(wrapper.get('[aria-label="system 提示词"]').text()).toContain("新的系统提示词");
    expect(wrapper.find('[aria-label="完整请求 JSON"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("当前请求不启用 Function Call");
  });
});
