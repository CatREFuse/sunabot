import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import FinalPromptWorkspace from "./FinalPromptWorkspace.vue";

const sections = [
  { id: "system", kicker: "MESSAGE 01", label: "system 提示词", kind: "message" as const, index: 0 },
  { id: "history", kicker: "MESSAGE GROUP 02", label: "消息组 2", kind: "message" as const, index: 1 },
  { id: "response", kicker: "RESPONSE FORMAT", label: "输出格式", kind: "response" as const },
  { id: "tools", kicker: "TOOLS", label: "Function Call", kind: "tools" as const }
];

describe("FinalPromptWorkspace", () => {
  it("switches the active slot through tabs", async () => {
    const wrapper = mount(FinalPromptWorkspace, {
      props: { modelValue: "system", sections },
      slots: { default: '<template #default="{ section }"><span>{{ section.id }}</span></template>' }
    });

    const responseTab = wrapper.get('[role="tab"][aria-controls="prompt-panel-response"]');
    await responseTab.trigger("click");

    expect(responseTab.attributes("aria-selected")).toBe("true");
    expect(wrapper.get("#prompt-panel-response").classes()).toContain("prompt-workspace__panel--active");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["response"]);
  });

  it("supports arrow-key navigation", async () => {
    const wrapper = mount(FinalPromptWorkspace, { props: { modelValue: "system", sections } });
    await wrapper.get('[role="tab"][aria-controls="prompt-panel-system"]').trigger("keydown", { key: "ArrowRight" });

    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["history"]);
  });

  it("emits message order changes after a drag and drop", async () => {
    const wrapper = mount(FinalPromptWorkspace, {
      props: { modelValue: "system", sections },
      slots: { default: '<div data-message-drag-handle draggable="true">拖动</div>' }
    });
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn()
    };

    await wrapper.get("#prompt-panel-system [data-message-drag-handle]").trigger("dragstart", { dataTransfer });
    await wrapper.get("#prompt-panel-history").trigger("dragover", { dataTransfer });
    await wrapper.get("#prompt-panel-history").trigger("drop", { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "system");
    expect(wrapper.emitted("reorder")?.at(-1)).toEqual([0, 1]);
  });
});
