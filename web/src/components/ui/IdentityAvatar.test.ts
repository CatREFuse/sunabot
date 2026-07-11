import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AuthenticatedImage from "./AuthenticatedImage.vue";
import IdentityAvatar from "./IdentityAvatar.vue";

describe("IdentityAvatar", () => {
  it("shows only the QQ image and never generates a text avatar", async () => {
    const wrapper = shallowMount(IdentityAvatar, {
      props: { src: "/api/media/qq-avatar?kind=user&id=171419991", name: "王橘子" }
    });

    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toContain("kind=user&id=171419991");
    expect(wrapper.text()).toBe("");
    wrapper.getComponent(AuthenticatedImage).vm.$emit("error");
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent(AuthenticatedImage).exists()).toBe(false);
    expect(wrapper.text()).toBe("");
  });
});
