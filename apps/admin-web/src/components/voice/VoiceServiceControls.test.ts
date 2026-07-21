import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type {
  VoiceProviderSettings,
  VoiceProviderStatus,
} from "../../types/voice";
import VoiceServiceControls from "./VoiceServiceControls.vue";

const settings: VoiceProviderSettings = {
  protocol: "openai-audio",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  model: "gpt-4o-mini-tts",
  voices: { zh: null, en: null, ja: "voice_plana" },
};

const ready: VoiceProviderStatus = {
  provider: "OpenAI Audio",
  state: "ready",
  ready: true,
  checkedAt: "2026-07-20T10:00:00.000Z",
  latencyMs: 42,
};

function mountControls(provider: VoiceProviderStatus | null = ready) {
  return mount(VoiceServiceControls, { props: { provider, settings } });
}

describe("VoiceServiceControls", () => {
  it("shows online readiness and emits the connection check", async () => {
    const wrapper = mountControls();

    expect(wrapper.text()).toContain("在线语音服务");
    expect(wrapper.text()).toContain("OpenAI Audio 兼容");
    expect(wrapper.text()).toContain("响应 42 ms");
    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("check")).toEqual([[]]);
  });

  it("edits and emits a normalized provider configuration", async () => {
    const wrapper = mountControls();
    const inputs = wrapper.findAll("input");

    await inputs[0]!.setValue(" https://voice.example/v1 ");
    await inputs[2]!.setValue("tts-model");
    await inputs[3]!.setValue("voice_zh");
    const save = wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "保存设置");
    if (!save) throw new Error("保存设置按钮不存在");
    await save.trigger("click");

    expect(wrapper.emitted("save")).toEqual([
      [
        {
          protocol: "openai-audio",
          baseUrl: "https://voice.example/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          model: "tts-model",
          voices: { zh: "voice_zh", en: null, ja: "voice_plana" },
        },
      ],
    ]);
  });

  it("disables saving when required fields are empty or unchanged", async () => {
    const wrapper = mountControls();
    const save = wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "保存设置");
    if (!save) throw new Error("保存设置按钮不存在");
    expect(save.attributes("disabled")).toBeDefined();

    await wrapper.findAll("input")[0]!.setValue("");
    expect(save.attributes("disabled")).toBeDefined();
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("shows a missing API Key as unconfigured instead of unavailable", () => {
    const wrapper = mountControls({
      provider: "OpenAI Audio",
      state: "unconfigured",
      ready: false,
      checkedAt: "2026-07-20T10:00:00.000Z",
      message: "API Key 未配置",
    });

    expect(wrapper.text()).toContain("未配置");
    expect(wrapper.text()).toContain("API Key 未配置");
    expect(wrapper.find('[data-kind="error"]').exists()).toBe(false);
  });
});
