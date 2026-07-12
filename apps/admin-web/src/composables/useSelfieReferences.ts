import { readonly, shallowRef } from "vue";
import type { SelfieReferenceImage, SelfieReferencePayload } from "../types";
import { apiRequest } from "./useAdminApi";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface SelfieReferenceStatus {
  kind: "idle" | "success" | "error";
  message: string;
}

export function useSelfieReferences() {
  const images = shallowRef<SelfieReferenceImage[]>([]);
  const maxImages = shallowRef(3);
  const loading = shallowRef(false);
  const uploading = shallowRef(false);
  const deletingId = shallowRef("");
  const status = shallowRef<SelfieReferenceStatus>({ kind: "idle", message: "" });
  let controller: AbortController | undefined;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    try {
      applyPayload(await apiRequest<SelfieReferencePayload>("/api/selfie-references", { signal: controller.signal }));
      status.value = { kind: "idle", message: "" };
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      status.value = { kind: "error", message: errorMessage(caught, "参考图读取失败") };
    } finally {
      loading.value = false;
    }
  }

  async function upload(files: readonly File[]) {
    if (!files.length || uploading.value) return false;
    const available = Math.max(0, maxImages.value - images.value.length);
    if (files.length > available) {
      status.value = { kind: "error", message: `还可添加 ${available} 张` };
      return false;
    }
    const invalid = files.find((file) => !ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_UPLOAD_BYTES);
    if (invalid) {
      status.value = {
        kind: "error",
        message: !ALLOWED_IMAGE_TYPES.has(invalid.type) ? "仅支持 PNG、JPEG、WebP" : "单张图片不能超过 8 MB"
      };
      return false;
    }

    uploading.value = true;
    status.value = { kind: "idle", message: "" };
    try {
      for (const file of files) {
        const payload = await apiRequest<SelfieReferencePayload>("/api/selfie-references", {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, dataBase64: await fileToBase64(file) })
        });
        applyPayload(payload);
      }
      status.value = { kind: "success", message: `${files.length} 张已保存` };
      return true;
    } catch (caught) {
      status.value = { kind: "error", message: errorMessage(caught, "上传失败") };
      return false;
    } finally {
      uploading.value = false;
    }
  }

  async function remove(id: string) {
    if (!id || deletingId.value) return false;
    deletingId.value = id;
    status.value = { kind: "idle", message: "" };
    try {
      await apiRequest<void>(`/api/selfie-references/${encodeURIComponent(id)}`, { method: "DELETE" });
      images.value = images.value.filter((image) => image.id !== id);
      status.value = { kind: "success", message: "参考图已删除" };
      return true;
    } catch (caught) {
      status.value = { kind: "error", message: errorMessage(caught, "删除失败") };
      return false;
    } finally {
      deletingId.value = "";
    }
  }

  function dispose() {
    controller?.abort();
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
    deletingId: readonly(deletingId),
    status: readonly(status),
    load,
    upload,
    remove,
    dispose
  };
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
