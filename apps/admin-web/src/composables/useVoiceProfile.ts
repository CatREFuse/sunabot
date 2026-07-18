import { readonly, shallowRef } from "vue";
import type {
  VoiceLanguage,
  VoiceProfile,
  VoiceProfileGetResponse,
  VoiceProfileMutationResponse,
  VoiceProfileSettingsInput,
  VoiceProviderProbeResponse,
  VoiceProviderStatus,
  VoiceReferenceInput,
} from "../types/voice";
import { VOICE_LANGUAGES } from "../types/voice";
import { agentScopedPath } from "./agentScope";
import { apiRequest } from "./useAdminApi";

export const MAX_VOICE_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_REFERENCE_TEXT_LENGTH = 1_000;

export function useVoiceProfile() {
  const profile = shallowRef<VoiceProfile | null>(null);
  const provider = shallowRef<VoiceProviderStatus | null>(null);
  const loading = shallowRef(false);
  const saving = shallowRef(false);
  const probing = shallowRef(false);
  const busyLanguage = shallowRef<VoiceLanguage | "">("");
  const error = shallowRef("");
  const message = shallowRef("");
  let activeAgentId = "";
  let contextGeneration = 0;
  let loadGeneration = 0;
  let loadController: AbortController | undefined;

  async function load(agentId: string) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    const generation = ++loadGeneration;
    loadController?.abort();
    loadController = new AbortController();
    loading.value = true;
    clearFeedback();
    try {
      const payload = await apiRequest<VoiceProfileGetResponse>(
        voiceProfilePath(normalizedAgentId),
        {
          signal: loadController.signal,
        },
      );
      if (
        !isCurrent(normalizedAgentId, context) ||
        generation !== loadGeneration
      )
        return false;
      profile.value = payload.profile;
      provider.value = payload.provider;
      return true;
    } catch (caught) {
      if (
        !isCurrent(normalizedAgentId, context) ||
        generation !== loadGeneration ||
        isAbortError(caught)
      )
        return false;
      error.value = errorMessage(caught, "语音设置读取失败");
      return false;
    } finally {
      if (
        isCurrent(normalizedAgentId, context) &&
        generation === loadGeneration
      )
        loading.value = false;
    }
  }

  async function saveSettings(
    agentId: string,
    input: VoiceProfileSettingsInput,
  ) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (saving.value) return false;
    supersedeLoad();
    saving.value = true;
    clearFeedback();
    try {
      const payload = await apiRequest<VoiceProfileMutationResponse>(
        voiceProfilePath(normalizedAgentId),
        {
          method: "PUT",
          body: JSON.stringify(input),
        },
      );
      if (!isCurrent(normalizedAgentId, context)) return false;
      profile.value = payload.profile;
      message.value = "语音设置已保存";
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      error.value = errorMessage(caught, "语音设置保存失败");
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) saving.value = false;
    }
  }

  async function putReference(
    agentId: string,
    language: VoiceLanguage,
    input: VoiceReferenceInput,
  ) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (busyLanguage.value || !isVoiceLanguage(language)) return false;
    const referenceText = normalizeVoiceReferenceText(input.referenceText);
    const validationError = validateReference(input.file, referenceText);
    if (validationError) {
      clearFeedback();
      error.value = validationError;
      return false;
    }

    supersedeLoad();
    busyLanguage.value = language;
    clearFeedback();
    try {
      const dataBase64 = await fileToBase64(input.file);
      if (!isCurrent(normalizedAgentId, context)) return false;
      const payload = await apiRequest<VoiceProfileMutationResponse>(
        voiceLanguagePath(normalizedAgentId, language),
        {
          method: "PUT",
          body: JSON.stringify({
            fileName: input.file.name,
            dataBase64,
            referenceText,
            ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
            ...(input.characterUrl ? { characterUrl: input.characterUrl } : {}),
          }),
        },
      );
      if (!isCurrent(normalizedAgentId, context)) return false;
      profile.value = payload.profile;
      message.value = "参考音频已保存";
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      error.value = errorMessage(caught, "参考音频保存失败");
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) busyLanguage.value = "";
    }
  }

  async function deleteReference(agentId: string, language: VoiceLanguage) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (busyLanguage.value || !isVoiceLanguage(language)) return false;
    supersedeLoad();
    busyLanguage.value = language;
    clearFeedback();
    try {
      const payload = await apiRequest<VoiceProfileMutationResponse>(
        voiceLanguagePath(normalizedAgentId, language),
        {
          method: "DELETE",
        },
      );
      if (!isCurrent(normalizedAgentId, context)) return false;
      profile.value = payload.profile;
      message.value = "参考音频已删除";
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      error.value = errorMessage(caught, "参考音频删除失败");
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) busyLanguage.value = "";
    }
  }

  async function probe(agentId: string) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (probing.value) return false;
    supersedeLoad();
    probing.value = true;
    clearFeedback();
    try {
      const payload = await apiRequest<VoiceProviderProbeResponse>(
        voiceProbePath(normalizedAgentId),
        {
          method: "POST",
        },
      );
      if (!isCurrent(normalizedAgentId, context)) return false;
      provider.value = payload.provider;
      message.value = payload.provider.ready
        ? "语音服务可用"
        : "语音服务检测完成";
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      error.value = errorMessage(caught, "语音服务检测失败");
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) probing.value = false;
    }
  }

  function dispose() {
    contextGeneration += 1;
    loadGeneration += 1;
    loadController?.abort();
  }

  function activate(agentId: string) {
    const normalizedAgentId = agentId.trim() || "plana";
    if (normalizedAgentId === activeAgentId) return normalizedAgentId;
    activeAgentId = normalizedAgentId;
    contextGeneration += 1;
    supersedeLoad();
    profile.value = null;
    provider.value = null;
    loading.value = false;
    saving.value = false;
    probing.value = false;
    busyLanguage.value = "";
    clearFeedback();
    return normalizedAgentId;
  }

  function supersedeLoad() {
    loadGeneration += 1;
    loadController?.abort();
    loading.value = false;
  }

  function isCurrent(agentId: string, generation: number) {
    return activeAgentId === agentId && contextGeneration === generation;
  }

  function clearFeedback() {
    error.value = "";
    message.value = "";
  }

  return {
    profile: readonly(profile),
    provider: readonly(provider),
    loading: readonly(loading),
    saving: readonly(saving),
    probing: readonly(probing),
    busyLanguage: readonly(busyLanguage),
    error: readonly(error),
    message: readonly(message),
    load,
    saveSettings,
    putReference,
    deleteReference,
    probe,
    dispose,
  };
}

export function normalizeVoiceReferenceText(value: string) {
  if (hasLoneSurrogate(value) || hasControlCharacter(value)) return null;
  const normalized = value.normalize("NFC").trim();
  if (!normalized || [...normalized].length > MAX_VOICE_REFERENCE_TEXT_LENGTH)
    return null;
  return normalized;
}

function validateReference(file: File, referenceText: string | null) {
  if (!referenceText) return "请填写与音频一致的参考台词";
  if (!file.size) return "音频文件为空";
  if (file.size > MAX_VOICE_REFERENCE_BYTES) return "音频文件不能超过 8 MB";
  if (file.type && !file.type.startsWith("audio/")) return "请选择音频文件";
  return "";
}

function voiceProfilePath(agentId: string) {
  return agentScopedPath("/api/voice-profile", agentId);
}

function voiceLanguagePath(agentId: string, language: VoiceLanguage) {
  return agentScopedPath(
    `/api/voice-profile/${encodeURIComponent(language)}`,
    agentId,
  );
}

function voiceProbePath(agentId: string) {
  return agentScopedPath("/api/voice-profile/probe", agentId);
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("音频读取失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("音频读取失败"));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function isVoiceLanguage(value: string): value is VoiceLanguage {
  return VOICE_LANGUAGES.some((language) => language === value);
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function hasLoneSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function isAbortError(caught: unknown) {
  return caught instanceof DOMException && caught.name === "AbortError";
}
