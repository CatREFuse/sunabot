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

  it("stays visible at the scroll edge and respects the device safe area", () => {
    const wrapper = mount(SettingsSaveBar, {
      props: { dirty: true, busy: false, kind: "idle", message: "" }
    });
    const bar = wrapper.get('[data-slot="settings-save-bar"]');

    expect(bar.classes()).toContain("sticky");
    expect(bar.classes()).toContain("bottom-0");
    expect(bar.classes()).toContain("bg-page");
    expect(bar.classes()).toContain("pb-[max(1rem,env(safe-area-inset-bottom))]");
  });
});
