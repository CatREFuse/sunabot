import { readonly, shallowRef } from "vue";
import type {
  EmojiPayload,
  EmojiRecord,
  EmojiSendSize,
  EmojiStatus,
  EmojiUploadInput,
  EmojiVersionRecord,
  EmojiVersionsPayload
} from "../types/emojis";
import { emojiKeyValidationError, normalizeEmojiKey } from "../utils/emojiKey";
import { apiRequest } from "./useAdminApi";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function useEmojis() {
  const emojis = shallowRef<EmojiRecord[]>([]);
  const presetKeys = shallowRef<string[]>([]);
  const sendSize = shallowRef<EmojiSendSize>(512);
  const sendSeparately = shallowRef(false);
  const settingsRevision = shallowRef("");
  const loading = shallowRef(false);
  const savingSettings = shallowRef(false);
  const uploading = shallowRef(false);
  const uploadingKey = shallowRef("");
  const deletingKey = shallowRef("");
  const versionKey = shallowRef("");
  const versions = shallowRef<EmojiVersionRecord[]>([]);
  const loadingVersions = shallowRef(false);
  const deletingVersion = shallowRef("");
  const generatingKeys = shallowRef<ReadonlySet<string>>(new Set());
  const status = shallowRef<EmojiStatus>({ kind: "idle", message: "" });
  let activeAgentId = "";
  let contextGeneration = 0;
  let loadGeneration = 0;
  let controller: AbortController | undefined;

  async function load(agentId: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    const context = contextGeneration;
    const generation = ++loadGeneration;
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    status.value = { kind: "idle", message: "" };
    try {
      const payload = await apiRequest<EmojiPayload>(agentPath("/api/emojis", normalizedAgentId), {
        signal: controller.signal
      });
      if (!isCurrent(normalizedAgentId, context) || generation !== loadGeneration) return false;
      applyPayload(payload);
      return true;
    } catch (caught) {
      if (isAbortError(caught)) return false;
      if (isCurrent(normalizedAgentId, context) && generation === loadGeneration) {
        status.value = { kind: "error", message: errorMessage(caught, "表情读取失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context) && generation === loadGeneration) loading.value = false;
    }
  }

  async function upload(agentId: string, input: EmojiUploadInput) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (uploading.value) return false;
    const validationError = validateUpload(input.key, input.file);
    if (validationError) {
      status.value = { kind: "error", message: validationError };
      return false;
    }
    const key = normalizeEmojiKey(input.key);
    const context = contextGeneration;
    uploading.value = true;
    uploadingKey.value = key;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<EmojiPayload>(agentPath("/api/emojis", normalizedAgentId), {
        method: "POST",
        body: JSON.stringify({
          key,
          fileName: input.file.name,
          dataBase64: await fileToBase64(input.file)
        })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await load(normalizedAgentId)) return false;
      if (versionKey.value === key) await loadVersions(normalizedAgentId, key);
      status.value = { kind: "success", message: `“${key}”已保存` };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "表情保存失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) {
        uploading.value = false;
        uploadingKey.value = "";
      }
    }
  }

  async function generate(agentId: string, emojiKey: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    const validationError = emojiKeyValidationError(emojiKey);
    if (validationError) {
      status.value = { kind: "error", message: validationError };
      return false;
    }
    const key = normalizeEmojiKey(emojiKey);
    if (generatingKeys.value.has(key)) return false;
    const context = contextGeneration;
    setGenerating(key, true);
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<EmojiPayload>(agentPath("/api/emojis/generate", normalizedAgentId), {
        method: "POST",
        body: JSON.stringify({ key })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await load(normalizedAgentId)) return false;
      status.value = { kind: "success", message: `“${key}”已生成` };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "表情生成失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) setGenerating(key, false);
    }
  }

  async function remove(agentId: string, emojiKey: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    const validationError = emojiKeyValidationError(emojiKey);
    if (validationError) {
      status.value = { kind: "error", message: validationError };
      return false;
    }
    const key = normalizeEmojiKey(emojiKey);
    if (deletingKey.value) return false;
    const context = contextGeneration;
    deletingKey.value = key;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<void>(agentPath(`/api/emojis/${encodeURIComponent(key)}`, normalizedAgentId), {
        method: "DELETE"
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await load(normalizedAgentId)) return false;
      if (versionKey.value === key) clearVersions();
      status.value = { kind: "success", message: `“${key}”已删除` };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "表情删除失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) deletingKey.value = "";
    }
  }

  async function rename(agentId: string, emojiKey: string, nextEmojiKey: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    const currentKey = normalizeEmojiKey(emojiKey);
    const validationError = emojiKeyValidationError(nextEmojiKey);
    if (validationError) {
      status.value = { kind: "error", message: validationError };
      return false;
    }
    const nextKey = normalizeEmojiKey(nextEmojiKey);
    if (currentKey === nextKey) return true;
    const context = contextGeneration;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<EmojiPayload>(agentPath(`/api/emojis/${encodeURIComponent(currentKey)}`, normalizedAgentId), {
        method: "PATCH",
        body: JSON.stringify({ key: nextKey })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await load(normalizedAgentId)) return false;
      if (versionKey.value === currentKey) {
        versionKey.value = nextKey;
        await loadVersions(normalizedAgentId, nextKey);
      }
      status.value = { kind: "success", message: `“${nextKey}”已保存` };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "表情 key 保存失败") };
      }
      return false;
    }
  }

  async function loadVersions(agentId: string, emojiKey: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    const key = normalizeEmojiKey(emojiKey);
    const context = contextGeneration;
    versionKey.value = key;
    loadingVersions.value = true;
    try {
      const payload = await apiRequest<EmojiVersionsPayload>(
        agentPath(`/api/emojis/${encodeURIComponent(key)}/versions`, normalizedAgentId)
      );
      if (!isCurrent(normalizedAgentId, context) || versionKey.value !== key) return false;
      versions.value = [...payload.versions];
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context) && versionKey.value === key) {
        status.value = { kind: "error", message: errorMessage(caught, "版本读取失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context) && versionKey.value === key) loadingVersions.value = false;
    }
  }

  async function removeVersion(agentId: string, emojiKey: string, fileName: string) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (deletingVersion.value) return false;
    const key = normalizeEmojiKey(emojiKey);
    const context = contextGeneration;
    deletingVersion.value = fileName;
    try {
      await apiRequest<void>(agentPath(
        `/api/emojis/${encodeURIComponent(key)}/versions/${encodeURIComponent(fileName)}`,
        normalizedAgentId
      ), { method: "DELETE" });
      if (!isCurrent(normalizedAgentId, context)) return false;
      if (!await loadVersions(normalizedAgentId, key)) return false;
      status.value = { kind: "success", message: "旧版本已删除" };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "版本删除失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) deletingVersion.value = "";
    }
  }

  function clearVersions() {
    versionKey.value = "";
    versions.value = [];
    loadingVersions.value = false;
    deletingVersion.value = "";
  }

  async function setSendSize(agentId: string, nextSize: EmojiSendSize) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (savingSettings.value || nextSize === sendSize.value) return false;
    const context = contextGeneration;
    savingSettings.value = true;
    status.value = { kind: "idle", message: "" };
    try {
      const payload = await apiRequest<EmojiPayload>(agentPath("/api/emojis/settings", normalizedAgentId), {
        method: "PATCH",
        body: JSON.stringify({
          sendSize: nextSize,
          sendSeparately: sendSeparately.value,
          revision: settingsRevision.value
        })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      applyPayload(payload);
      status.value = { kind: "success", message: `发送尺寸已设为 ${formatSendSize(nextSize)}` };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "发送尺寸保存失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) savingSettings.value = false;
    }
  }

  async function setSendSeparately(agentId: string, enabled: boolean) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    if (savingSettings.value || enabled === sendSeparately.value) return false;
    const context = contextGeneration;
    savingSettings.value = true;
    status.value = { kind: "idle", message: "" };
    try {
      const payload = await apiRequest<EmojiPayload>(agentPath("/api/emojis/settings", normalizedAgentId), {
        method: "PATCH",
        body: JSON.stringify({
          sendSize: sendSize.value,
          sendSeparately: enabled,
          revision: settingsRevision.value
        })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      applyPayload(payload);
      status.value = { kind: "success", message: enabled ? "表情将单独发送" : "表情将随正文发送" };
      return true;
    } catch (caught) {
      if (isCurrent(normalizedAgentId, context)) {
        status.value = { kind: "error", message: errorMessage(caught, "发送方式保存失败") };
      }
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) savingSettings.value = false;
    }
  }

  function clearStatus() {
    status.value = { kind: "idle", message: "" };
  }

  function dispose() {
    controller?.abort();
    contextGeneration += 1;
  }

  function activate(agentId: string) {
    if (activeAgentId === agentId) return;
    activeAgentId = agentId;
    contextGeneration += 1;
    loadGeneration += 1;
    controller?.abort();
    emojis.value = [];
    presetKeys.value = [];
    sendSize.value = 512;
    sendSeparately.value = false;
    settingsRevision.value = "";
    loading.value = false;
    savingSettings.value = false;
    uploading.value = false;
    uploadingKey.value = "";
    deletingKey.value = "";
    clearVersions();
    generatingKeys.value = new Set();
    status.value = { kind: "idle", message: "" };
  }

  function isCurrent(agentId: string, generation: number) {
    return activeAgentId === agentId && contextGeneration === generation;
  }

  function applyPayload(payload: EmojiPayload) {
    presetKeys.value = [...payload.presetKeys];
    emojis.value = [...payload.emojis];
    if (isEmojiSendSize(payload.sendSize)) sendSize.value = payload.sendSize;
    if (typeof payload.sendSeparately === "boolean") sendSeparately.value = payload.sendSeparately;
    if (typeof payload.revision === "string") settingsRevision.value = payload.revision;
  }

  function setGenerating(key: string, active: boolean) {
    const next = new Set(generatingKeys.value);
    if (active) next.add(key);
    else next.delete(key);
    generatingKeys.value = next;
  }

  return {
    emojis: readonly(emojis),
    presetKeys: readonly(presetKeys),
    sendSize: readonly(sendSize),
    sendSeparately: readonly(sendSeparately),
    loading: readonly(loading),
    savingSettings: readonly(savingSettings),
    uploading: readonly(uploading),
    uploadingKey: readonly(uploadingKey),
    deletingKey: readonly(deletingKey),
    versionKey: readonly(versionKey),
    versions: readonly(versions),
    loadingVersions: readonly(loadingVersions),
    deletingVersion: readonly(deletingVersion),
    generatingKeys: readonly(generatingKeys),
    status: readonly(status),
    load,
    upload,
    generate,
    remove,
    rename,
    loadVersions,
    removeVersion,
    clearVersions,
    setSendSize,
    setSendSeparately,
    clearStatus,
    dispose
  };
}

function isEmojiSendSize(value: unknown): value is EmojiSendSize {
  return value === 64 || value === 128 || value === 256 || value === 512 || value === 1024;
}

function formatSendSize(value: EmojiSendSize) {
  return value === 1024 ? "1k" : `${value}px`;
}

function normalizeAgentId(agentId: string) {
  return agentId.trim() || "plana";
}

function validateUpload(key: string, file: File) {
  const keyError = emojiKeyValidationError(key);
  if (keyError) return keyError;
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) return "仅支持 PNG、JPEG、WebP、GIF";
  if (!file.size || file.size > MAX_UPLOAD_BYTES) return "图片不能超过 8 MB";
  return "";
}

function agentPath(path: string, agentId: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}agentId=${encodeURIComponent(agentId)}`;
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("图片读取失败"));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
