import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it } from "vitest";
import type { VoiceProviderStatus } from "../../types/voice";
import VoiceServiceControls from "./VoiceServiceControls.vue";

const ready: VoiceProviderStatus = {
  provider: "MOSS-TTS-Nano",
  ready: true,
  checkedAt: "2026-07-19T10:00:00.000Z",
  latencyMs: 42,
  serviceState: "running",
  controlsAvailable: true,
};

const stopped: VoiceProviderStatus = {
  provider: "MOSS-TTS-Nano",
  ready: false,
  checkedAt: "2026-07-19T10:00:00.000Z",
  serviceState: "stopped",
  controlsAvailable: true,
  message: "语音服务已关闭",
};

const DialogOverlayStub = defineComponent({
  name: "DialogOverlay",
  inheritAttrs: false,
  props: { open: Boolean },
  emits: ["close"],
  template: '<div v-if="open" role="dialog"><slot /></div>',
});

function mountControls(provider: VoiceProviderStatus | null = ready) {
  return mount(VoiceServiceControls, {
    props: { provider },
    global: { stubs: { DialogOverlay: DialogOverlayStub } },
  });
}

describe("VoiceServiceControls", () => {
  it("shows readiness and exposes check and stop actions", async () => {
    const wrapper = mountControls();

    expect(wrapper.text()).toContain("可用");
    expect(wrapper.text()).toContain("响应 42 ms");
    expect(wrapper.get('button:nth-of-type(2)').attributes("disabled")).toBeDefined();
    await wrapper.get('button:nth-of-type(1)').trigger("click");
    expect(wrapper.emitted("check")).toEqual([[]]);
  });

  it("starts a stopped service", async () => {
    const wrapper = mountControls(stopped);
    const start = wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "启动服务");
    if (!start) throw new Error("启动服务按钮不存在");

    await start.trigger("click");
    expect(wrapper.emitted("start")).toEqual([[]]);
  });

  it("confirms before stopping the service", async () => {
    const wrapper = mountControls();
    const stop = wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "关闭服务");
    if (!stop) throw new Error("关闭服务按钮不存在");

    await stop.trigger("click");
    expect(wrapper.get('[role="dialog"]').text()).toContain("关闭语音服务？");
    const confirm = wrapper
      .get('[role="dialog"]')
      .findAll("button")
      .find((button) => button.text().trim() === "关闭服务");
    if (!confirm) throw new Error("关闭确认按钮不存在");
    await confirm.trigger("click");

    expect(wrapper.emitted("stop")).toEqual([[]]);
  });

  it("keeps management actions disabled when host control is unavailable", () => {
    const wrapper = mountControls({
      ...stopped,
      serviceState: "unknown",
      controlsAvailable: false,
      message: "语音服务不可用",
    });
    const buttons = wrapper.findAll("button");

    expect(buttons.find((button) => button.text().trim() === "检测服务")?.attributes("disabled"))
      .toBeUndefined();
    expect(buttons.find((button) => button.text().trim() === "启动服务")?.attributes("disabled"))
      .toBeDefined();
    expect(buttons.find((button) => button.text().trim() === "关闭服务")?.attributes("disabled"))
      .toBeDefined();
  });
});
