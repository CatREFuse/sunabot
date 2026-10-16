import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import OneBotLoginDialog from "./OneBotLoginDialog.vue";

describe("OneBotLoginDialog", () => {
  it("removes the image under the expired mask and emits explicit refresh", async () => {
    const wrapper = mount(OneBotLoginDialog, {
      props: {
        open: true, accountId: "primary", accountLabel: "主账号", busy: false, checking: false,
        remainingSeconds: 45, qrBlocked: false, error: "", confirmingLogout: false,
        snapshot: { connected: false, online: false, available: true, phase: "waiting_scan", imageDataUrl: "data:image/png;base64,AAAA" }
      },
      global: { stubs: { Teleport: true, AuthenticatedImage: true } }
    });
    expect(wrapper.findComponent({ name: "AuthenticatedImage" }).exists()).toBe(true);
    expect(wrapper.text()).toContain("45 秒后过期");
    await wrapper.setProps({ remainingSeconds: 0, qrBlocked: true });
    expect(wrapper.findComponent({ name: "AuthenticatedImage" }).exists()).toBe(false);
    expect(wrapper.get('[data-testid="qr-mask"]').text()).toContain("二维码已过期");
    await wrapper.get('[data-testid="qr-mask"] button').trigger("click");
    expect(wrapper.emitted("refresh")).toHaveLength(1);
    wrapper.unmount();
  });

  it("keeps explicit logout and invalid-session recovery available while offline", async () => {
    const wrapper = mount(OneBotLoginDialog, {
      props: {
        open: true, accountId: "primary", accountLabel: "主账号", busy: false, checking: false,
        snapshot: { connected: true, online: false, authenticated: true, available: true, phase: "reconnecting" },
        error: "", confirmingLogout: false, remainingSeconds: 0, qrBlocked: true
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
        remainingSeconds: 0,
        qrBlocked: true,
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
