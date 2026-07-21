import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VoiceProfile,
  VoiceProfileGetResponse,
  VoiceProviderSettings,
  VoiceProviderStatus,
} from "../types/voice";
import {
  MAX_VOICE_REFERENCE_TEXT_LENGTH,
  normalizeVoiceReferenceText,
  useVoiceProfile,
} from "./useVoiceProfile";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

const provider: VoiceProviderStatus = {
  provider: "OpenAI Audio",
  state: "ready",
  ready: true,
  checkedAt: "2026-07-20T10:00:00.000Z",
  latencyMs: 38,
};

const providerSettings: VoiceProviderSettings = {
  protocol: "openai-audio",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  model: "gpt-4o-mini-tts",
  voices: { zh: null, en: null, ja: "voice_plana" },
};

const japaneseReference = {
  language: "ja" as const,
  fileName: "plana-ja.wav",
  relativePath: "voice/references/plana-ja.wav",
  mimeType: "audio/wav",
  sizeBytes: 420_000,
  sha256: "a".repeat(64),
  referenceText: "先生、おはようございます。",
  sourceUrl: "https://kivo.wiki/plana",
  characterUrl: "https://kivo.wiki/Plana",
  updatedAt: "2026-07-20T09:00:00.000Z",
};

function voiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schemaVersion: 1,
    enabled: false,
    defaultLanguage: "ja",
    languages: { zh: null, en: null, ja: japaneseReference },
    provider: providerSettings,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useVoiceProfile", () => {
  beforeEach(() => apiRequest.mockReset());

  it("loads and saves online provider, profile and reference settings", async () => {
    const initial = voiceProfile();
    const customProvider = {
      ...providerSettings,
      baseUrl: "https://voice.example/v1",
      model: "voice-model",
    };
    const configured = voiceProfile({ provider: customProvider });
    const enabled = voiceProfile({ enabled: true, provider: customProvider });
    const replacedReference = {
      ...japaneseReference,
      fileName: "new-ja.wav",
      referenceText: "おやすみなさい、先生。",
    };
    const replaced = voiceProfile({
      enabled: true,
      provider: customProvider,
      languages: { zh: null, en: null, ja: replacedReference },
    });
    const removed = voiceProfile({
      enabled: true,
      provider: customProvider,
      languages: { zh: null, en: null, ja: null },
    });
    const unavailable: VoiceProviderStatus = {
      provider: "OpenAI Audio",
      state: "unavailable",
      ready: false,
      checkedAt: "2026-07-20T10:05:00.000Z",
      message: "在线语音服务不可用",
    };
    apiRequest
      .mockResolvedValueOnce({ profile: initial, provider })
      .mockResolvedValueOnce({ profile: configured })
      .mockResolvedValueOnce({ profile: enabled })
      .mockResolvedValueOnce({ profile: replaced })
      .mockResolvedValueOnce({ profile: removed })
      .mockResolvedValueOnce({ provider: unavailable });
    const voice = useVoiceProfile();

    await expect(voice.load("plana")).resolves.toBe(true);
    expect(voice.profile.value).toEqual(initial);

    await expect(voice.saveProvider("plana", customProvider)).resolves.toBe(true);
    expect(apiRequest.mock.calls[1]?.[0]).toBe(
      "/api/voice-provider?agentId=plana",
    );
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body))).toEqual(
      customProvider,
    );

    await expect(
      voice.saveSettings("plana", { enabled: true, defaultLanguage: "ja" }),
    ).resolves.toBe(true);
    expect(apiRequest.mock.calls[2]?.[0]).toBe(
      "/api/voice-profile?agentId=plana",
    );

    const file = new File(["wav"], "new-ja.wav", { type: "audio/wav" });
    await expect(
      voice.putReference("plana", "ja", {
        file,
        referenceText: " おやすみなさい、先生。 ",
      }),
    ).resolves.toBe(true);
    expect(apiRequest.mock.calls[3]?.[0]).toBe(
      "/api/voice-profile/ja?agentId=plana",
    );
    expect(voice.profile.value).toEqual(replaced);

    await expect(voice.deleteReference("plana", "ja")).resolves.toBe(true);
    expect(apiRequest.mock.calls[4]?.[1]?.method).toBe("DELETE");
    expect(voice.profile.value).toEqual(removed);

    await expect(voice.checkService("plana")).resolves.toBe(true);
    expect(apiRequest.mock.calls[5]?.[0]).toBe(
      "/api/voice-service/check?agentId=plana",
    );
    expect(voice.provider.value).toEqual(unavailable);
  });

  it("clears the old Agent and ignores its late GET response", async () => {
    const planaResponse = deferred<VoiceProfileGetResponse>();
    const aronaResponse = deferred<VoiceProfileGetResponse>();
    const aronaProfile = voiceProfile({
      provider: {
        ...providerSettings,
        voices: { zh: null, en: null, ja: "voice_arona" },
      },
    });
    apiRequest
      .mockReturnValueOnce(planaResponse.promise)
      .mockReturnValueOnce(aronaResponse.promise);
    const voice = useVoiceProfile();

    const planaLoad = voice.load("plana");
    const planaSignal = apiRequest.mock.calls[0]?.[1]?.signal as AbortSignal;
    const aronaLoad = voice.load("arona");

    expect(planaSignal.aborted).toBe(true);
    expect(voice.profile.value).toBeNull();
    expect(apiRequest.mock.calls.map(([requestPath]) => requestPath)).toEqual([
      "/api/voice-profile?agentId=plana",
      "/api/voice-profile?agentId=arona",
    ]);

    aronaResponse.resolve({ profile: aronaProfile, provider });
    await expect(aronaLoad).resolves.toBe(true);
    planaResponse.resolve({ profile: voiceProfile(), provider });
    await expect(planaLoad).resolves.toBe(false);
    expect(voice.profile.value).toEqual(aronaProfile);
  });

  it("does not let a late provider mutation overwrite the selected Agent", async () => {
    const savedPlana = deferred<{ profile: VoiceProfile }>();
    const aronaProfile = voiceProfile({
      provider: {
        ...providerSettings,
        voices: { zh: null, en: null, ja: "voice_arona" },
      },
    });
    apiRequest
      .mockResolvedValueOnce({ profile: voiceProfile(), provider })
      .mockReturnValueOnce(savedPlana.promise)
      .mockResolvedValueOnce({ profile: aronaProfile, provider });
    const voice = useVoiceProfile();
    await voice.load("plana");

    const mutation = voice.saveProvider("plana", providerSettings);
    await expect(voice.load("arona")).resolves.toBe(true);
    savedPlana.resolve({ profile: voiceProfile() });
    await expect(mutation).resolves.toBe(false);

    expect(voice.profile.value).toEqual(aronaProfile);
    expect(voice.saving.value).toBe(false);
  });

  it("validates reference audio before sending", async () => {
    const voice = useVoiceProfile();
    const audio = new File(["wav"], "voice.wav", { type: "audio/wav" });
    const image = new File(["png"], "voice.png", { type: "image/png" });

    await expect(
      voice.putReference("plana", "ja", { file: audio, referenceText: "   " }),
    ).resolves.toBe(false);
    expect(voice.error.value).toBe("请填写与音频一致的参考台词");
    await expect(
      voice.putReference("plana", "ja", { file: image, referenceText: "先生" }),
    ).resolves.toBe(false);
    expect(voice.error.value).toBe("请选择音频文件");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("normalizes reference text and rejects controls or oversized content", () => {
    expect(normalizeVoiceReferenceText(" e\u0301 ")).toBe("é");
    expect(normalizeVoiceReferenceText("先生\nおはよう")).toBeNull();
    expect(
      normalizeVoiceReferenceText("声".repeat(MAX_VOICE_REFERENCE_TEXT_LENGTH)),
    ).toBe("声".repeat(MAX_VOICE_REFERENCE_TEXT_LENGTH));
    expect(
      normalizeVoiceReferenceText(
        "声".repeat(MAX_VOICE_REFERENCE_TEXT_LENGTH + 1),
      ),
    ).toBeNull();
  });
});
