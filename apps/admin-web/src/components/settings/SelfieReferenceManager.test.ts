import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { SelfieReferenceImage } from "../../types";
import SelfieReferenceManager from "./SelfieReferenceManager.vue";

const image: SelfieReferenceImage = {
  id: "a".repeat(64),
  fileName: "plana.png",
  note: "日常服",
  sizeBytes: 240_000,
  width: 1200,
  height: 1393,
  updatedAt: "2026-07-12T10:00:00.000Z",
  originalUrl: "/api/selfie-references/plana.png/content?variant=original",
  displayUrl: "/api/selfie-references/plana.png/content?variant=display",
  placeholderUrl: "/api/selfie-references/plana.png/content?variant=placeholder"
};

function mountManager() {
  return mount(SelfieReferenceManager, {
    props: {
      images: [image],
      maxImages: 9,
      loading: false,
      uploading: false,
      updatingId: "",
      deletingId: "",
      status: { kind: "idle", message: "" }
    },
    global: { stubs: { DialogOverlay: { props: ["open"], template: '<div v-if="open"><slot /></div>' } } }
  });
}

describe("SelfieReferenceManager", () => {
  it("shows the compact catalog and collects a required note for every selected file", async () => {
    const wrapper = mountManager();
    expect(wrapper.get('section[aria-labelledby="selfie-reference-title"]').classes()).toContain("border-t");
    expect(wrapper.text()).toContain("素材库最多 9 张，每次自拍选用 1–3 张");
    expect(wrapper.text()).not.toContain("管理参考图");

    const input = wrapper.get('input[type="file"]');
    const first = new File(["one"], "swimsuit.png", { type: "image/png" });
    const second = new File(["two"], "maid.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [first, second] });
    await input.trigger("change");

    expect(wrapper.emitted("upload")).toBeUndefined();
    await wrapper.get('input[aria-label="swimsuit.png 的备注"]').setValue("泳装");
    await wrapper.get('input[aria-label="maid.png 的备注"]').setValue("女仆装");
    await wrapper.get("#selfie-note-form").trigger("submit");

    expect(wrapper.emitted("upload")?.[0]?.[0]).toEqual([
      { file: first, note: "泳装" },
      { file: second, note: "女仆装" }
    ]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("emits note edits and preserves the draft when saving fails", async () => {
    const wrapper = mountManager();
    await wrapper.get('button[aria-label="编辑备注 日常服"]').trigger("click");
    const note = wrapper.get('input[aria-label="plana.png 的备注"]');
    expect((note.element as HTMLInputElement).value).toBe("日常服");
    await note.setValue("泳装");
    await wrapper.get("#selfie-note-form").trigger("submit");

    expect(wrapper.emitted("updateNote")?.[0]).toEqual([image.id, "泳装"]);
    await wrapper.setProps({ status: { kind: "error", message: "备注保存失败" } });
    expect(wrapper.get('input[aria-label="plana.png 的备注"]').element).toHaveProperty("value", "泳装");
    expect(wrapper.text()).toContain("备注保存失败");
  });

  it("loads the original only after preview is requested", async () => {
    const wrapper = mountManager();
    expect(wrapper.find(`img[src="${image.originalUrl}"]`).exists()).toBe(false);

    await wrapper.get(`button[aria-label="查看原图 ${image.note}"]`).trigger("click");

    expect(wrapper.find(`img[src="${image.originalUrl}"]`).exists()).toBe(true);
  });

  it("confirms deletion before emitting remove", async () => {
    const wrapper = mountManager();
    await wrapper.get(`button[aria-label="删除 ${image.note}"]`).trigger("click");
    expect(wrapper.text()).toContain("删除这张参考图？");

    const confirm = wrapper.findAll("button").find((button) => button.text() === "删除");
    await confirm?.trigger("click");
    expect(wrapper.emitted("remove")?.[0]).toEqual([image.id]);
  });
});
