import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EmojiEditorDialog from "./EmojiEditorDialog.vue";

function mountDialog(emojiKey = "") {
  return mount(EmojiEditorDialog, {
    props: { open: true, emojiKey, busy: false, error: "" },
    global: {
      stubs: {
        DialogOverlay: {
          props: ["open"],
          emits: ["close"],
          template: '<div v-if="open"><slot /></div>'
        }
      }
    }
  });
}

describe("EmojiEditorDialog", () => {
  it("emits a normalized custom key and selected image", async () => {
    const wrapper = mountDialog();
    await wrapper.get('input[type="text"]').setValue("  激动  ");
    const input = wrapper.get('input[type="file"]');
    const file = new File(["png"], "excited.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("save")?.[0]?.[0]).toEqual({ key: "激动", file });
  });

  it("locks an existing key and blocks invalid custom marker characters", async () => {
    const existing = mountDialog("开心");
    expect(existing.get('input[type="text"]').attributes("disabled")).toBeDefined();
    existing.unmount();

    const custom = mountDialog();
    await custom.get('input[type="text"]').setValue("坏/名称");
    const input = custom.get('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["png"], "bad.png", { type: "image/png" })]
    });
    await input.trigger("change");
    await custom.get("form").trigger("submit");

    expect(custom.emitted("save")).toBeUndefined();
    expect(custom.text()).toContain("表情名称不能包含括号、斜杠或控制字符");
  });

  it("rejects a control character before normalizing the custom key", async () => {
    const wrapper = mountDialog();
    await wrapper.get('input[type="text"]').setValue("\t开心");
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["png"], "happy.png", { type: "image/png" })]
    });
    await input.trigger("change");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("save")).toBeUndefined();
    expect(wrapper.text()).toContain("表情名称不能包含括号、斜杠或控制字符");
  });
});
