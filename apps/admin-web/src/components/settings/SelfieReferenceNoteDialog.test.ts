import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SelfieReferenceNoteDialog from "./SelfieReferenceNoteDialog.vue";

function mountDialog(options: { mode?: "upload" | "edit"; notes?: string[] } = {}) {
  return mount(SelfieReferenceNoteDialog, {
    props: {
      open: true,
      mode: options.mode,
      items: [
        { id: "first", label: "swimsuit.png", note: options.notes?.[0] ?? "" },
        { id: "second", label: "maid.png", note: options.notes?.[1] ?? "" }
      ]
    },
    global: {
      stubs: {
        DialogOverlay: { props: ["open"], template: '<div v-if="open"><slot /></div>' }
      }
    }
  });
}

describe("SelfieReferenceNoteDialog", () => {
  it("requires a valid note for every image", async () => {
    const wrapper = mountDialog();
    await wrapper.get('input[aria-label="swimsuit.png 的备注"]').setValue("泳装");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.text()).toContain("请填写每张图片的备注");
    expect(wrapper.emitted("save")).toBeUndefined();

    await wrapper.get('input[aria-label="maid.png 的备注"]').setValue(`女仆装${String.fromCharCode(0x7f)}正面`);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.text()).toContain("备注无效");
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("normalizes and emits every note in file order", async () => {
    const wrapper = mountDialog();
    await wrapper.get('input[aria-label="swimsuit.png 的备注"]').setValue(" 泳装 ");
    await wrapper.get('input[aria-label="maid.png 的备注"]').setValue(" e\u0301 ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("save")?.[0]?.[0]).toEqual([
      { id: "first", note: "泳装" },
      { id: "second", note: "é" }
    ]);
  });

  it("uses the edit action for an existing note", async () => {
    const wrapper = mountDialog({ mode: "edit", notes: ["日常服", "女仆装"] });
    expect(wrapper.text()).toContain("编辑图片备注");
    expect(wrapper.findAll("input")).toHaveLength(2);
    expect(wrapper.text()).toContain("保存");
  });
});
