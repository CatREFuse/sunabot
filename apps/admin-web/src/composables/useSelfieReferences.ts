import { readonly, shallowRef } from "vue";
import type { SelfieReferenceImage, SelfieReferencePayload } from "../types";
import { apiRequest } from "./useAdminApi";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_SELFIE_REFERENCE_NOTE_LENGTH = 120;

export interface SelfieReferenceUpload {
  file: File;
  note: string;
}

export interface SelfieReferenceStatus {
  kind: "idle" | "success" | "error";
  message: string;
}

export function useSelfieReferences() {
  const images = shallowRef<SelfieReferenceImage[]>([]);
  const maxImages = shallowRef(9);
  const loading = shallowRef(false);
  const uploading = shallowRef(false);
  const updatingId = shallowRef("");
  const deletingId = shallowRef("");
  const status = shallowRef<SelfieReferenceStatus>({ kind: "idle", message: "" });
  let activeAgentId = "";
  let contextGeneration = 0;
  let loadGeneration = 0;
  let loadController: AbortController | undefined;

  async function loadAll(agentId: string) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    const generation = ++loadGeneration;
    loadController?.abort();
    loadController = new AbortController();
    loading.value = true;
    try {
      const payload = await apiRequest<SelfieReferencePayload>(resourcePath(
        "/api/selfie-references",
        normalizedAgentId
      ), {
        signal: loadController.signal
      });
      if (!isCurrent(normalizedAgentId, context) || generation !== loadGeneration) return false;
      applyPayload(payload);
      status.value = { kind: "idle", message: "" };
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context) || generation !== loadGeneration || isAbortError(caught)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "参考图读取失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context) && generation === loadGeneration) loading.value = false;
    }
  }

  async function upload(agentId: string, entries: readonly SelfieReferenceUpload[]) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (!entries.length || uploading.value) return false;
    const available = Math.max(0, maxImages.value - images.value.length);
    if (entries.length > available) {
      status.value = { kind: "error", message: `还可添加 ${available} 张` };
      return false;
    }
    const normalizedEntries: SelfieReferenceUpload[] = [];
    for (const entry of entries) {
      const note = normalizeSelfieReferenceNote(entry.note);
      if (!note) {
        status.value = {
          kind: "error",
          message: entry.note.trim() ? "备注无效" : "请填写每张图片的备注"
        };
        return false;
      }
      normalizedEntries.push({ file: entry.file, note });
    }
    const invalid = entries.find(({ file }) => !ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_UPLOAD_BYTES)?.file;
    if (invalid) {
      status.value = {
        kind: "error",
        message: !ALLOWED_IMAGE_TYPES.has(invalid.type) ? "仅支持 PNG、JPEG、WebP" : "单张图片不能超过 8 MB"
      };
      return false;
    }

    supersedeLoad();
    uploading.value = true;
    status.value = { kind: "idle", message: "" };
    try {
      for (const { file, note } of normalizedEntries) {
        const dataBase64 = await fileToBase64(file);
        if (!isCurrent(normalizedAgentId, context)) return false;
        const payload = await apiRequest<SelfieReferencePayload>(resourcePath(
          "/api/selfie-references",
          normalizedAgentId
        ), {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, dataBase64, note })
        });
        if (!isCurrent(normalizedAgentId, context)) return false;
        applyPayload(payload);
      }
      if (!isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "success", message: `${entries.length} 张已保存` };
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "上传失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) uploading.value = false;
    }
  }

  async function updateNote(
    agentId: string,
    id: string,
    note: string
  ) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (!id || updatingId.value) return false;
    const normalized = normalizeSelfieReferenceNote(note);
    if (!normalized) {
      status.value = {
        kind: "error",
        message: note.trim() ? "备注无效" : "请填写图片备注"
      };
      return false;
    }
    supersedeLoad();
    updatingId.value = id;
    status.value = { kind: "idle", message: "" };
    try {
      const payload = await apiRequest<SelfieReferencePayload>(resourcePath(
        `/api/selfie-references/${encodeURIComponent(id)}`,
        normalizedAgentId
      ), {
        method: "PATCH",
        body: JSON.stringify({ note: normalized })
      });
      if (!isCurrent(normalizedAgentId, context)) return false;
      applyPayload(payload);
      status.value = { kind: "success", message: "备注已保存" };
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "备注保存失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) updatingId.value = "";
    }
  }

  async function remove(
    agentId: string,
    id: string
  ) {
    const normalizedAgentId = activate(agentId);
    const context = contextGeneration;
    if (!id || deletingId.value) return false;
    supersedeLoad();
    deletingId.value = id;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<void>(resourcePath(
        `/api/selfie-references/${encodeURIComponent(id)}`,
        normalizedAgentId
      ), { method: "DELETE" });
      if (!isCurrent(normalizedAgentId, context)) return false;
      images.value = images.value.filter((image) => image.id !== id);
      status.value = { kind: "success", message: "参考图已删除" };
      return true;
    } catch (caught) {
      if (!isCurrent(normalizedAgentId, context)) return false;
      status.value = { kind: "error", message: errorMessage(caught, "删除失败") };
      return false;
    } finally {
      if (isCurrent(normalizedAgentId, context)) deletingId.value = "";
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
    images.value = [];
    maxImages.value = 9;
    loading.value = false;
    uploading.value = false;
    updatingId.value = "";
    deletingId.value = "";
    status.value = { kind: "idle", message: "" };
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

  function applyPayload(payload: SelfieReferencePayload) {
    images.value = payload.images;
    maxImages.value = payload.maxImages;
  }

  return {
    images: readonly(images),
    maxImages: readonly(maxImages),
    loading: readonly(loading),
    uploading: readonly(uploading),
    updatingId: readonly(updatingId),
    deletingId: readonly(deletingId),
    status: readonly(status),
    load: loadAll,
    upload,
    updateNote,
    remove,
    dispose
  };
}

export function normalizeSelfieReferenceNote(note: string) {
  if (hasLoneSurrogate(note) || hasControlCharacter(note)) return null;
  const normalized = note.normalize("NFC").trim();
  if (!normalized || [...normalized].length > MAX_SELFIE_REFERENCE_NOTE_LENGTH) return null;
  return normalized;
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function resourcePath(
  path: string,
  agentId: string
) {
  const search = new URLSearchParams({ agentId });
  return `${path}?${search.toString()}`;
}
