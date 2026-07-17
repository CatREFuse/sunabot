// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import WebChatComposer from "./WebChatComposer.vue";

describe("WebChatComposer", () => {
  it("submits Enter, keeps Shift + Enter for a new line, and leaves the icon unboxed", async () => {
    const wrapper = mount(WebChatComposer, {
      props: { modelValue: "检查状态", sending: false, error: "" }
    });
    const textarea = wrapper.get("textarea");

    await textarea.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("submit")).toBeUndefined();
    await textarea.trigger("keydown", { key: "Enter", shiftKey: false });
    expect(wrapper.emitted("submit")).toHaveLength(1);

    const send = wrapper.get('button[aria-label="发送"]');
    expect(send.classes().join(" ")).not.toMatch(/rounded|border|bg-/);
    expect(send.get("i").classes()).toContain("text-[30px]");
  });

  it("disables empty submissions and renders errors inline", () => {
    const wrapper = mount(WebChatComposer, {
      props: { modelValue: "   ", sending: false, error: "发送失败" }
    });

    expect(wrapper.get('button[aria-label="发送"]').attributes()).toHaveProperty("disabled");
    expect(wrapper.get('[role="alert"]').text()).toContain("发送失败");
  });

  it("grows from 44px to 160px and resets after the draft is cleared", async () => {
    const wrapper = mount(WebChatComposer, {
      props: { modelValue: "短消息", sending: false, error: "" }
    });
    const textarea = wrapper.get<HTMLTextAreaElement>("textarea");
    let scrollHeight = 44;
    Object.defineProperty(textarea.element, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });

    await textarea.trigger("input");
    expect(textarea.element.style.height).toBe("44px");
    expect(textarea.element.style.overflowY).toBe("hidden");

    scrollHeight = 240;
    await wrapper.setProps({ modelValue: "第一行\n第二行\n第三行" });
    expect(textarea.element.style.height).toBe("160px");
    expect(textarea.element.style.overflowY).toBe("auto");

    scrollHeight = 44;
    await wrapper.setProps({ modelValue: "" });
    expect(textarea.element.style.height).toBe("44px");
    expect(textarea.element.style.overflowY).toBe("hidden");
  });
});
