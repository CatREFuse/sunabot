import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { SelfieReferenceImage } from "../../types";
import SelfieReferenceDialog from "./SelfieReferenceDialog.vue";

const image: SelfieReferenceImage = {
  id: "plana.png",
  fileName: "plana.png",
  sizeBytes: 240_000,
  width: 1200,
  height: 1393,
  updatedAt: "2026-07-12T10:00:00.000Z",
  originalUrl: "/api/selfie-references/plana.png/content?variant=original",
  displayUrl: "/api/selfie-references/plana.png/content?variant=display",
  placeholderUrl: "/api/selfie-references/plana.png/content?variant=placeholder"
};

function mountDialog() {
  return mount(SelfieReferenceDialog, {
    props: {
      open: true,
      images: [image],
      maxImages: 3,
      loading: false,
      uploading: false,
      deletingId: "",
      status: { kind: "idle", message: "" }
    },
    global: { stubs: { DialogOverlay: { props: ["open"], template: '<div v-if="open"><slot /></div>' } } }
  });
}

describe("SelfieReferenceDialog", () => {
  it("emits selected files and resets the file field", async () => {
    const wrapper = mountDialog();
    const input = wrapper.get('input[type="file"]');
    const file = new File(["png"], "new-plana.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });

    await input.trigger("change");

    expect(wrapper.emitted("upload")?.[0]?.[0]).toEqual([file]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("opens the original only after preview is requested", async () => {
    const wrapper = mountDialog();
    expect(wrapper.find(`img[src="${image.originalUrl}"]`).exists()).toBe(false);

    await wrapper.get(`button[aria-label="查看原图 ${image.fileName}"]`).trigger("click");

    expect(wrapper.find(`img[src="${image.originalUrl}"]`).exists()).toBe(true);
  });

  it("confirms deletion before emitting remove", async () => {
    const wrapper = mountDialog();
    await wrapper.get(`button[aria-label="删除 ${image.fileName}"]`).trigger("click");
    expect(wrapper.text()).toContain("删除这张参考图？");

    const confirm = wrapper.findAll("button").find((button) => button.text() === "删除");
    await confirm?.trigger("click");
    expect(wrapper.emitted("remove")?.[0]).toEqual([image.id]);
  });
});
