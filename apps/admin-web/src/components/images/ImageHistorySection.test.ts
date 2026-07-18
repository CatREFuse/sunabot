import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ImageHistorySection from "./ImageHistorySection.vue";

describe("ImageHistorySection", () => {
  it("keeps preview and download as isolated sibling actions without reuse", async () => {
    const image = { id: "image-1", url: "/generated-images/image-1.png", prompt: "测试", createdAt: "2026-07-10T00:00:00.000Z" };
    const wrapper = shallowMount(ImageHistorySection, { props: { images: [image], loading: false, downloadingId: "" } });

    await wrapper.get('button[aria-label="下载图片 image-1"]').trigger("click");
    expect(wrapper.emitted("download")).toEqual([[image]]);
    expect(wrapper.emitted("preview")).toBeUndefined();
    expect(wrapper.text()).not.toContain("复用参数");
  });

  it("uses a compact responsive image grid", () => {
    const wrapper = shallowMount(ImageHistorySection, { props: { images: [], loading: false, downloadingId: "" } });

    expect(wrapper.get('[data-slot="image-history-grid"]').classes()).toEqual(expect.arrayContaining([
      "grid-cols-2",
      "sm:grid-cols-3",
      "xl:grid-cols-5",
      "2xl:grid-cols-6"
    ]));
  });
});
