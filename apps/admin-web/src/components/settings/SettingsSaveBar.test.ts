import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SettingsSaveBar from "./SettingsSaveBar.vue";

describe("SettingsSaveBar", () => {
  it("shows a direct validation error without the implementation field path", () => {
    const wrapper = mount(SettingsSaveBar, {
      props: { dirty: true, busy: false, kind: "error", field: "bot.adminQq", message: "管理员 QQ 必须是数字。" }
    });
    expect(wrapper.text()).toContain("管理员 QQ 必须是数字");
    expect(wrapper.text()).not.toContain("bot.adminQq");
    expect(wrapper.text()).not.toContain("[ERROR:");
  });

  it("shows the save state", () => {
    const wrapper = mount(SettingsSaveBar, {
      props: { dirty: false, busy: false, kind: "restart", message: "已保存，重启后生效" }
    });

    expect(wrapper.text()).toContain("已保存，重启后生效");
    expect(wrapper.text()).not.toContain("RESTART REQUIRED");
  });
});
