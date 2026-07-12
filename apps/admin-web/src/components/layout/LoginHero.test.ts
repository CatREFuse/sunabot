import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import LoginHero from "./LoginHero.vue";

describe("LoginHero", () => {
  it("shows the Sunabot product entry without implementation copy", () => {
    const wrapper = mount(LoginHero);

    expect(wrapper.get("h1").text()).toBe("Sunabot");
    expect(wrapper.text()).toContain("管理普拉娜的会话、记忆与工具");
    expect(wrapper.text()).not.toMatch(/HttpOnly|Secure session|ADMIN ACCESS/i);
  });
});
