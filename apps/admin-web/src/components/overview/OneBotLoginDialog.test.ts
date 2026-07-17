import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import OneBotLoginDialog from "./OneBotLoginDialog.vue";

const baseProps = { open: true, accountId: "primary", accountLabel: "主账号", busy: false, checking: false, confirmingLogout: false, error: "" };

describe("OneBotLoginDialog", () => {
  it("uses every supported QR source and exposes the NapCat WebUI", async () => {
    const wrapper = shallowMount(OneBotLoginDialog, {
      props: { ...baseProps, snapshot: { available: true, connected: false, online: false, phase: "waiting_scan", imageDataUrl: "data:image/png;base64,AAAA", imageUrl: "https://example.com/fallback.png", webuiUrl: "http://127.0.0.1:6099" } }
    });
    expect(wrapper.text()).toContain("主账号 · primary");
    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toBe("data:image/png;base64,AAAA");
    await wrapper.get("button.btn.justify-self-start").trigger("click");
    expect(wrapper.emitted("webui")).toEqual([["http://127.0.0.1:6099"]]);

    await wrapper.setProps({ snapshot: { available: true, connected: false, online: false, phase: "waiting_scan", imageUrl: "https://example.com/qr.png" } });
    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toBe("https://example.com/qr.png");

    await wrapper.setProps({ snapshot: { available: true, connected: false, online: false, phase: "waiting_scan", qrcode: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } });
    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB");
  });

  it("shows an explicit confirmation before emitting QQ logout", async () => {
    const wrapper = shallowMount(OneBotLoginDialog, {
      props: {
        ...baseProps,
        snapshot: { available: true, connected: true, online: true, phase: "online", data: { user_id: 985436737, nickname: "测试 Bot" } }
      }
    });

    await wrapper.get("button.btn-danger").trigger("click");
    expect(wrapper.emitted("requestLogout")).toHaveLength(1);
    await wrapper.setProps({ confirmingLogout: true });
    const buttons = wrapper.findAll("footer button");
    await buttons.at(-1)?.trigger("click");
    expect(wrapper.emitted("logout")).toHaveLength(1);
  });
});
