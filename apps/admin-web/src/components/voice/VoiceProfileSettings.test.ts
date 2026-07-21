import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import type { VoiceProfile } from "../../types/voice";
import VoiceProfileSettings from "./VoiceProfileSettings.vue";

const japaneseReference = {
  language: "ja" as const,
  fileName: "plana-ja.wav",
  relativePath: "voice/ja/plana-ja.wav",
  mimeType: "audio/wav",
  sizeBytes: 420_000,
  sha256: "a".repeat(64),
  referenceText: "先生、おはようございます。",
  updatedAt: "2026-07-19T09:00:00.000Z",
};

const profile: VoiceProfile = {
  schemaVersion: 1,
  enabled: false,
  defaultLanguage: "ja",
  languages: { zh: null, en: null, ja: japaneseReference },
  provider: {
    protocol: "openai-audio",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-4o-mini-tts",
    voices: { zh: null, en: null, ja: "voice_plana" },
  },
};

const DialogOverlayStub = defineComponent({
  name: "DialogOverlay",
  inheritAttrs: false,
  props: { open: Boolean },
  emits: ["close"],
  template: '<div v-if="open" role="dialog"><slot /></div>',
});

function mountSettings(overrides: Record<string, unknown> = {}) {
  return mount(VoiceProfileSettings, {
    props: { profile, ...overrides },
    global: { stubs: { DialogOverlay: DialogOverlayStub } },
  });
}

function findButton(wrapper: VueWrapper, label: string, occurrence = 0) {
  const matches = wrapper
    .findAll("button")
    .filter((button) => button.text().trim() === label);
  const match = matches[occurrence];
  if (!match) throw new Error(`Button not found: ${label} (${occurrence})`);
  return match;
}

describe("VoiceProfileSettings", () => {
  it("shows the three language labels and current reference", () => {
    const wrapper = mountSettings();

    expect(wrapper.text()).toContain("中文");
    expect(wrapper.text()).toContain("English");
    expect(wrapper.text()).toContain("日本語");
    expect(wrapper.text()).toContain("plana-ja.wav");
    expect(wrapper.text()).toContain("先生、おはようございます。");
    expect(
      wrapper
        .get('[role="group"][aria-label="音色资料语言"]')
        .attributes("role"),
    ).toBe("group");
    expect(findButton(wrapper, "日本語").attributes("aria-pressed")).toBe(
      "true",
    );
  });

  it("emits settings changes", async () => {
    const wrapper = mountSettings();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await findButton(wrapper, "保存设置").trigger("click");

    expect(wrapper.emitted("saveSettings")).toEqual([
      [{ enabled: true, defaultLanguage: "ja" }],
    ]);
  });

  it("requires an online voice for the enabled default language", async () => {
    const withoutVoice: VoiceProfile = {
      ...profile,
      defaultLanguage: "zh",
      languages: { zh: null, en: null, ja: null },
      provider: {
        ...profile.provider,
        voices: { zh: null, en: null, ja: "voice_plana" },
      },
    };
    const wrapper = mountSettings({ profile: withoutVoice });
    await wrapper.get('input[type="checkbox"]').setValue(true);

    expect(wrapper.text()).toContain("请先设置默认语言的在线音色");
    expect(
      findButton(wrapper, "保存设置").attributes("disabled"),
    ).toBeDefined();
  });

  it("preserves unsaved settings when a reference mutation returns a new profile", async () => {
    const wrapper = mountSettings();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    const updatedProfile: VoiceProfile = {
      ...profile,
      languages: {
        ...profile.languages,
        ja: { ...japaneseReference, fileName: "replacement.wav" },
      },
    };

    await wrapper.setProps({ profile: updatedProfile });

    expect(
      (wrapper.get('input[type="checkbox"]').element as HTMLInputElement)
        .checked,
    ).toBe(true);
    await findButton(wrapper, "保存设置").trigger("click");
    expect(wrapper.emitted("saveSettings")).toEqual([
      [{ enabled: true, defaultLanguage: "ja" }],
    ]);
  });

  it("locks settings while a reference mutation is running", async () => {
    const wrapper = mountSettings({ busyLanguage: "ja" });

    expect(
      wrapper.get('input[type="checkbox"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
  });

  it("uploads a file together with the required reference text", async () => {
    const wrapper = mountSettings();
    await findButton(wrapper, "中文").trigger("click");
    await findButton(wrapper, "添加音频").trigger("click");

    const file = new File(["wav"], "plana-zh.wav", { type: "audio/wav" });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await wrapper.get('input[type="file"]').trigger("change");
    await wrapper.get("textarea").setValue("  老师，早上好。 ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("putReference")).toEqual([
      [
        {
          language: "zh",
          file,
          referenceText: "老师，早上好。",
        },
      ],
    ]);

    await wrapper.setProps({ busyLanguage: "zh" });
    await wrapper.setProps({ busyLanguage: "", message: "参考音频已保存" });
    await nextTick();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("keeps the upload dialog open when the mutation fails", async () => {
    const wrapper = mountSettings();
    await findButton(wrapper, "替换音频").trigger("click");
    const file = new File(["wav"], "new-ja.wav", { type: "audio/wav" });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await wrapper.get('input[type="file"]').trigger("change");
    await wrapper.get("textarea").setValue("おやすみなさい、先生。");
    await wrapper.get("form").trigger("submit");

    await wrapper.setProps({ busyLanguage: "ja" });
    await wrapper.setProps({ busyLanguage: "", error: "语音服务未启动" });
    await nextTick();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("语音服务未启动");
  });

  it("clears an open reference dialog when the Agent profile is cleared", async () => {
    const wrapper = mountSettings();
    await findButton(wrapper, "替换音频").trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    await wrapper.setProps({ profile: null });

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("does not emit an upload without reference text", async () => {
    const wrapper = mountSettings();
    await findButton(wrapper, "替换音频").trigger("click");
    const file = new File(["wav"], "new-ja.wav", { type: "audio/wav" });
    const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await wrapper.get('input[type="file"]').trigger("change");
    await wrapper.get("textarea").setValue("   ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("putReference")).toBeUndefined();
    expect(wrapper.text()).toContain("请填写参考台词");
  });

  it("confirms reference deletion for the selected language", async () => {
    const wrapper = mountSettings();
    await findButton(wrapper, "删除").trigger("click");
    expect(wrapper.text()).toContain("删除日本語参考音频？");
    await findButton(wrapper, "删除", 1).trigger("click");

    expect(wrapper.emitted("deleteReference")).toEqual([["ja"]]);
  });
});
