import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AuthenticatedImage from "./AuthenticatedImage.vue";

describe("AuthenticatedImage", () => {
  it.each(["/api/media/qq-avatar?userId=123", "/api/agents/arona/avatar", "data:image/png;base64,AA==", "blob:test"])("does not thumbnail unsupported source %s", (src) => {
    const wrapper = mount(AuthenticatedImage, { props: { src } });
    expect(wrapper.find(".authenticated-image__placeholder").exists()).toBe(false);
    expect(wrapper.get("img").attributes("src")).toBe(src);
    wrapper.unmount();
  });

  it.each(["https://media.example/image.png", "/generated-images/example.png"])("loads supported source %s with a thumbnail placeholder", async (src) => {
    const wrapper = mount(AuthenticatedImage, { props: { src, thumbnail: true } });
    expect(wrapper.get(".authenticated-image__placeholder").attributes("src")).toContain("variant=placeholder");
    await wrapper.get(".authenticated-image__main").trigger("load");
    expect(wrapper.attributes("data-state")).toBe("ready");
    expect(wrapper.find(".authenticated-image__placeholder").exists()).toBe(false);
    wrapper.unmount();
  });

  it("preserves an explicit placeholder", () => {
    const wrapper = mount(AuthenticatedImage, { props: { src: "/api/agents/arona/avatar", placeholderSrc: "data:image/png;base64,AA==" } });
    expect(wrapper.get(".authenticated-image__placeholder").attributes("src")).toBe("data:image/png;base64,AA==");
    wrapper.unmount();
  });
});
