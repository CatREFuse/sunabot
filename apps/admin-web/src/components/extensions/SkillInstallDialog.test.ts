import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SkillInstallDialog from "./SkillInstallDialog.vue";

describe("SkillInstallDialog", () => {
  it("keeps short-height content scrollable with reachable actions", () => {
    const wrapper = mount(SkillInstallDialog, {
      props: {
        open: true,
        busy: false,
        error: "Skill ZIP 校验失败"
      },
      global: { stubs: { Teleport: true, Transition: false } }
    });

    expect(wrapper.get("form").classes()).toContain("max-h-[calc(100dvh-2rem)]");
    expect(wrapper.get('[data-slot="dialog-scroll"]').classes()).toContain("overflow-y-auto");
    expect(wrapper.get('[data-slot="dialog-actions"]').classes()).toContain("shrink-0");
    expect(wrapper.get('[data-slot="dialog-actions"]').text()).toContain("取消");
    expect(wrapper.get('[data-slot="dialog-actions"]').text()).toContain("安装");
    expect(wrapper.get('[role="alert"]').text()).toBe("Skill ZIP 校验失败");
  });
});
