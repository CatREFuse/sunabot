import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import OneBotLoginDialog from "./OneBotLoginDialog.vue";

describe("OneBotLoginDialog", () => {
  it("shows a recovery state without exposing the raw kickoff warning", () => {
    const wrapper = mount(OneBotLoginDialog, {
      props: {
        open: true,
        accountId: "primary",
        accountLabel: "主账号",
        busy: true,
        checking: false,
        snapshot: {
          connected: true,
          online: false,
          available: true,
          phase: "restarting",
          action: "recover_login"
        },
        error: "",
        confirmingLogout: false
      },
      global: {
        stubs: {
          Teleport: true,
          AuthenticatedImage: true,
          IdentityAvatar: true
        }
      }
    });

    expect(wrapper.text()).toContain("正在恢复登录");
    expect(wrapper.text()).toContain("正在准备新的登录二维码");
    expect(wrapper.text()).not.toContain("KICKEDOFFLINE");
  });
});
