import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AgentAvatarInput } from "../../types";
import AgentAvatarCropDialog from "./AgentAvatarCropDialog.vue";
import AgentAvatarPicker from "./AgentAvatarPicker.vue";

describe("AgentAvatarPicker", () => {
  it("opens the crop dialog for supported images without a file size limit", async () => {
    const wrapper = mount(AgentAvatarPicker, {
      global: { stubs: { AgentAvatarCropDialog: true } }
    });
    const input = wrapper.get('input[type="file"]');
    const file = new File(
      [new Uint8Array(2 * 1024 * 1024 + 1)],
      "large-avatar.png",
      { type: "image/png" }
    );
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });

    await input.trigger("change");

    const crop = wrapper.getComponent(AgentAvatarCropDialog);
    expect(crop.props("open")).toBe(true);
    expect((crop.props("file") as File).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(wrapper.text()).not.toContain("MiB");

    const avatar: AgentAvatarInput = { fileName: "avatar.png", dataBase64: "data:image/png;base64,cropped" };
    crop.vm.$emit("confirm", avatar);
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("change")?.[0]).toEqual([avatar]);
  });

  it("rejects unsupported image formats", async () => {
    const wrapper = mount(AgentAvatarPicker, {
      global: { stubs: { AgentAvatarCropDialog: true } }
    });
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["text"], "avatar.txt", { type: "text/plain" })]
    });

    await input.trigger("change");

    expect(wrapper.get('[role="alert"]').text()).toBe("请选择 PNG、JPEG 或 WebP 图片。");
    expect(wrapper.getComponent(AgentAvatarCropDialog).props("open")).toBe(false);
  });
});
