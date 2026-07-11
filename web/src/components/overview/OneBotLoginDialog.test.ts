import { shallowMount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AuthenticatedImage from "../ui/AuthenticatedImage.vue";
import OneBotLoginDialog from "./OneBotLoginDialog.vue";

const baseProps = { open: true, busy: false, checking: false, check: null, error: "" };

describe("OneBotLoginDialog", () => {
  it("uses every supported QR source and exposes the NapCat WebUI", async () => {
    const wrapper = shallowMount(OneBotLoginDialog, {
      props: { ...baseProps, qr: { available: true, connected: false, online: false, imageDataUrl: "data:image/png;base64,AAAA", imageUrl: "https://example.com/fallback.png", webuiUrl: "http://127.0.0.1:6099" } }
    });
    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toBe("data:image/png;base64,AAAA");
    await wrapper.get("button.btn.justify-self-start").trigger("click");
    expect(wrapper.emitted("webui")).toEqual([["http://127.0.0.1:6099"]]);

    await wrapper.setProps({ qr: { available: true, connected: false, online: false, imageUrl: "https://example.com/qr.png" } });
    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toBe("https://example.com/qr.png");

    await wrapper.setProps({ qr: { available: true, connected: false, online: false, qrcode: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } });
    expect(wrapper.getComponent(AuthenticatedImage).props("src")).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB");
  });
});
