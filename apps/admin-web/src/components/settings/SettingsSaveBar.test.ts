import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SettingsSaveBar from "./SettingsSaveBar.vue";

describe("SettingsSaveBar", () => {
  it("shows the server field path with a validation error", () => {
    const wrapper = mount(SettingsSaveBar, {
      props: { dirty: true, busy: false, kind: "error", field: "bot.adminQq", message: "[ERROR: 管理员 QQ 必须是数字。]" }
    });
    expect(wrapper.text()).toContain("bot.adminQq");
    expect(wrapper.text()).toContain("管理员 QQ 必须是数字");
  });
});
