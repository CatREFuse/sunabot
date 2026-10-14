import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import OneBotLoginDialog from "./OneBotLoginDialog.vue";

describe("OneBotLoginDialog", () => {
  it("keeps explicit logout and invalid-session recovery available while offline", async () => {
    const wrapper = mount(OneBotLoginDialog, {
      props: {
        open: true, accountId: "primary", accountLabel: "主账号", busy: false, checking: false,
        snapshot: { connected: true, online: false, authenticated: true, available: true, phase: "reconnecting" },
        error: "", confirmingLogout: false
      },
      global: { stubs: { Teleport: true, AuthenticatedImage: true, IdentityAvatar: true } }
    });
    await wrapper.findAll("button").find((button) => button.text().includes("退出 QQ"))!.trigger("click");
    expect(wrapper.emitted("requestLogout")).toHaveLength(1);
    await wrapper.setProps({ confirmingLogout: true });
    expect(wrapper.text()).toContain("确认退出当前 QQ");
    await wrapper.setProps({ confirmingLogout: false, snapshot: {
      connected: true, online: false, authenticated: false, available: true, phase: "restarting", action: "recover_login"
    } });
    const recovery = wrapper.findAll("button").find((button) => button.text().includes("重新登录"))!;
    expect(recovery.attributes("disabled")).toBeUndefined();
    await recovery.trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
    wrapper.unmount();
  });

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
