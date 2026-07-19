import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VoiceProfile,
  VoiceProfileGetResponse,
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
  provider: "MOSS-TTS-Nano",
  ready: true,
  checkedAt: "2026-07-19T10:00:00.000Z",
  latencyMs: 38,
  serviceState: "running",
  controlsAvailable: true,
};

const japaneseReference = {
  language: "ja" as const,
  fileName: "plana-ja.wav",
  relativePath: "voice/ja/plana-ja.wav",
  mimeType: "audio/wav",
  sizeBytes: 420_000,
  sha256: "a".repeat(64),
  referenceText: "先生、おはようございます。",
  sourceUrl: "https://kivo.wiki/plana",
  characterUrl: "https://kivo.wiki/Plana",
  updatedAt: "2026-07-19T09:00:00.000Z",
};

function voiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    schemaVersion: 1,
    enabled: false,
    defaultLanguage: "ja",
    languages: { zh: null, en: null, ja: japaneseReference },
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

  it("loads the profile and provider, then uses the locked mutation endpoints", async () => {
    const initial = voiceProfile();
    const enabled = voiceProfile({ enabled: true });
    const replacedReference = {
      ...japaneseReference,
      fileName: "new-ja.wav",
      referenceText: "おやすみなさい、先生。",
    };
    const replaced = voiceProfile({
      enabled: true,
      languages: { zh: null, en: null, ja: replacedReference },
    });
    const removed = voiceProfile({
      enabled: false,
      languages: { zh: null, en: null, ja: null },
    });
    const unavailable: VoiceProviderStatus = {
      provider: "MOSS-TTS-Nano",
      ready: false,
      checkedAt: "2026-07-19T10:05:00.000Z",
      message: "服务未启动",
      serviceState: "stopped",
      controlsAvailable: true,
    };
    apiRequest
      .mockResolvedValueOnce({ profile: initial, provider })
      .mockResolvedValueOnce({ profile: enabled })
      .mockResolvedValueOnce({ profile: replaced })
      .mockResolvedValueOnce({ profile: removed })
      .mockResolvedValueOnce({ provider: unavailable });
    const voice = useVoiceProfile();

    await expect(voice.load("plana")).resolves.toBe(true);
    expect(voice.profile.value).toEqual(initial);
    expect(voice.provider.value).toEqual(provider);
    expect(apiRequest.mock.calls[0]?.[0]).toBe(
      "/api/voice-profile?agentId=plana",
    );

    await expect(
      voice.saveSettings("plana", { enabled: true, defaultLanguage: "ja" }),
    ).resolves.toBe(true);
    expect(apiRequest.mock.calls[1]?.[0]).toBe(
      "/api/voice-profile?agentId=plana",
    );
    expect(apiRequest.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body))).toEqual({
      enabled: true,
      defaultLanguage: "ja",
    });
    expect(voice.profile.value).toEqual(enabled);
    expect(voice.provider.value).toEqual(provider);

    const file = new File(["wav"], "new-ja.wav", { type: "audio/wav" });
    await expect(
      voice.putReference("plana", "ja", {
        file,
        referenceText: " おやすみなさい、先生。 ",
        sourceUrl: "https://kivo.wiki/plana",
        characterUrl: "https://kivo.wiki/Plana",
      }),
    ).resolves.toBe(true);
    expect(apiRequest.mock.calls[2]?.[0]).toBe(
      "/api/voice-profile/ja?agentId=plana",
    );
    expect(apiRequest.mock.calls[2]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(apiRequest.mock.calls[2]?.[1]?.body))).toEqual({
      fileName: "new-ja.wav",
      dataBase64: "d2F2",
      referenceText: "おやすみなさい、先生。",
      sourceUrl: "https://kivo.wiki/plana",
      characterUrl: "https://kivo.wiki/Plana",
    });
    expect(voice.profile.value).toEqual(replaced);

    await expect(voice.deleteReference("plana", "ja")).resolves.toBe(true);
    expect(apiRequest.mock.calls[3]?.[0]).toBe(
      "/api/voice-profile/ja?agentId=plana",
    );
    expect(apiRequest.mock.calls[3]?.[1]?.method).toBe("DELETE");
    expect(voice.profile.value).toEqual(removed);

    await expect(voice.checkService("plana")).resolves.toBe(true);
    expect(apiRequest.mock.calls[4]?.[0]).toBe(
      "/api/voice-service/check?agentId=plana",
    );
    expect(apiRequest.mock.calls[4]?.[1]?.method).toBe("POST");
    expect(voice.provider.value).toEqual(unavailable);
    expect(voice.profile.value).toEqual(removed);
  });

  it("starts and stops the managed voice service", async () => {
    const starting: VoiceProviderStatus = {
      ...provider,
      ready: false,
      latencyMs: undefined,
      message: "语音服务正在启动或暂不可用",
    };
    const stopped: VoiceProviderStatus = {
      ...provider,
      ready: false,
      latencyMs: undefined,
      serviceState: "stopped",
      message: "语音服务已关闭",
    };
    apiRequest
      .mockResolvedValueOnce({ provider: starting })
      .mockResolvedValueOnce({ provider: stopped });
    const voice = useVoiceProfile();

    await expect(voice.startService("plana")).resolves.toBe(true);
    expect(apiRequest.mock.calls[0]?.[0]).toBe(
      "/api/voice-service/start?agentId=plana",
    );
    expect(voice.serviceMessage.value).toBe("语音服务正在启动");

    await expect(voice.stopService("plana")).resolves.toBe(true);
    expect(apiRequest.mock.calls[1]?.[0]).toBe(
      "/api/voice-service/stop?agentId=plana",
    );
    expect(voice.serviceMessage.value).toBe("语音服务已关闭");
  });

  it("clears the old Agent and ignores its late GET response", async () => {
    const planaResponse = deferred<VoiceProfileGetResponse>();
    const aronaResponse = deferred<VoiceProfileGetResponse>();
    const aronaProfile = voiceProfile({
      languages: {
        zh: null,
        en: null,
        ja: { ...japaneseReference, fileName: "arona.wav" },
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
    expect(voice.provider.value).toBeNull();
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/voice-profile?agentId=plana",
      "/api/voice-profile?agentId=arona",
    ]);

    aronaResponse.resolve({ profile: aronaProfile, provider });
    await expect(aronaLoad).resolves.toBe(true);
    planaResponse.resolve({ profile: voiceProfile(), provider });
    await expect(planaLoad).resolves.toBe(false);

    expect(voice.profile.value).toEqual(aronaProfile);
    expect(voice.loading.value).toBe(false);
  });

  it("does not let a late mutation overwrite the newly selected Agent", async () => {
    const savedPlana = deferred<{ profile: VoiceProfile }>();
    const aronaProfile = voiceProfile({
      languages: {
        zh: null,
        en: null,
        ja: { ...japaneseReference, fileName: "arona.wav" },
      },
    });
    apiRequest
      .mockResolvedValueOnce({ profile: voiceProfile(), provider })
      .mockReturnValueOnce(savedPlana.promise)
      .mockResolvedValueOnce({ profile: aronaProfile, provider });
    const voice = useVoiceProfile();
    await voice.load("plana");

    const mutation = voice.saveSettings("plana", {
      enabled: true,
      defaultLanguage: "ja",
    });
    const aronaLoad = voice.load("arona");
    await expect(aronaLoad).resolves.toBe(true);
    savedPlana.resolve({ profile: voiceProfile({ enabled: true }) });
    await expect(mutation).resolves.toBe(false);

    expect(voice.profile.value).toEqual(aronaProfile);
    expect(voice.saving.value).toBe(false);
  });

  it("validates the audio and required reference text before sending", async () => {
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

  it("normalizes reference text and rejects control characters or oversized content", () => {
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
