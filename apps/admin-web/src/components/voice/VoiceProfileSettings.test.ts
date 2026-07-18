import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import type { VoiceProfile, VoiceProviderStatus } from "../../types/voice";
import VoiceProfileSettings from "./VoiceProfileSettings.vue";

const provider: VoiceProviderStatus = {
  provider: "MOSS-TTS-Nano",
  ready: true,
  checkedAt: "2026-07-19T10:00:00.000Z",
  latencyMs: 42,
};

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
    props: { profile, provider, ...overrides },
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
  it("shows service state and the three language labels", () => {
    const wrapper = mountSettings();

    expect(wrapper.text()).toContain("MOSS-TTS-Nano");
    expect(wrapper.text()).toContain("可用");
    expect(wrapper.text()).toContain("响应 42 ms");
    expect(wrapper.text()).toContain("中文");
    expect(wrapper.text()).toContain("English");
    expect(wrapper.text()).toContain("日本語");
    expect(wrapper.text()).toContain("plana-ja.wav");
    expect(wrapper.text()).toContain("先生、おはようございます。");
    expect(
      wrapper
        .get('[role="group"][aria-label="参考音频语言"]')
        .attributes("role"),
    ).toBe("group");
    expect(findButton(wrapper, "日本語").attributes("aria-pressed")).toBe(
      "true",
    );
  });

  it("emits settings and service probe actions", async () => {
    const wrapper = mountSettings();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await findButton(wrapper, "保存设置").trigger("click");
    await findButton(wrapper, "检测服务").trigger("click");

    expect(wrapper.emitted("saveSettings")).toEqual([
      [{ enabled: true, defaultLanguage: "ja" }],
    ]);
    expect(wrapper.emitted("probe")).toEqual([[]]);
  });

  it("requires a reference for the enabled default language", async () => {
    const withoutReferences: VoiceProfile = {
      ...profile,
      defaultLanguage: "zh",
      languages: { zh: null, en: null, ja: null },
    };
    const wrapper = mountSettings({ profile: withoutReferences });
    await wrapper.get('input[type="checkbox"]').setValue(true);

    expect(wrapper.text()).toContain("请先添加默认语言的参考音频");
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

    await wrapper.setProps({ profile: null, provider: null });

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
