import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AuthenticatedImage from "./AuthenticatedImage.vue";

describe("AuthenticatedImage", () => {
  it("loads through a tiny blurred placeholder and remembers completed sources", async () => {
    const source = "https://example.com/cache-test.png";
    const first = mount(AuthenticatedImage, { props: { src: source, alt: "测试图片", thumbnail: true } });
    expect(first.get(".authenticated-image__placeholder").attributes("src")).toContain("variant=placeholder");
    expect(first.get(".authenticated-image__main").attributes("src")).toContain("variant=display");
    await first.get(".authenticated-image__main").trigger("load");
    expect(first.get(".authenticated-image").attributes("data-state")).toBe("ready");
    first.unmount();

    const second = mount(AuthenticatedImage, { props: { src: source, alt: "测试图片", thumbnail: true } });
    expect(second.find(".authenticated-image__placeholder").exists()).toBe(false);
    expect(second.get(".authenticated-image").attributes("data-state")).toBe("ready");
  });

  it("uses explicit display and placeholder sources for protected asset variants", () => {
    const wrapper = mount(AuthenticatedImage, {
      props: {
        src: "/api/selfie-references/plana/content?variant=original",
        displaySrc: "/api/selfie-references/plana/content?variant=display",
        placeholderSrc: "/api/selfie-references/plana/content?variant=placeholder",
        thumbnail: true
      }
    });

    expect(wrapper.get(".authenticated-image__main").attributes("src")).toBe("/api/selfie-references/plana/content?variant=display");
    expect(wrapper.get(".authenticated-image__placeholder").attributes("src")).toBe("/api/selfie-references/plana/content?variant=placeholder");
  });
});
