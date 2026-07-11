import { readonly, shallowRef } from "vue";
import { apiBlob, apiRequest, authenticatedMediaPath } from "./useAdminApi";
import type { ImageHistoryRecord } from "../types";

export function useImageStudio() {
  const images = shallowRef<ImageHistoryRecord[]>([]);
  const loading = shallowRef(false);
  const downloadingId = shallowRef("");
  const error = shallowRef("");
  let controller: AbortController | undefined;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    try {
      const history = await apiRequest<{ images: ImageHistoryRecord[] }>("/api/images", { signal: controller.signal });
      images.value = history.images;
      error.value = "";
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      error.value = caught instanceof Error ? caught.message : "图像工作区读取失败";
    } finally {
      loading.value = false;
    }
  }

  async function download(image: ImageHistoryRecord) {
    downloadingId.value = image.id;
    error.value = "";
    let objectUrl = "";
    try {
      const blob = image.url.startsWith("data:") || image.url.startsWith("blob:")
        ? await fetch(image.url).then((response) => response.blob())
        : await apiBlob(authenticatedMediaPath(image.url));
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = imageDownloadName(image, blob.type);
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "下载失败";
      throw caught;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      downloadingId.value = "";
    }
  }

  function dispose() { controller?.abort(); }
  return { images: readonly(images), loading: readonly(loading), downloadingId: readonly(downloadingId), error: readonly(error), load, download, dispose };
}

export function imageDownloadName(image: ImageHistoryRecord, mimeType = "") {
  const fromPath = String(image.filePath ?? "").split(/[\\/]/).pop() ?? "";
  let fromUrl = "";
  try {
    fromUrl = new URL(image.url, window.location.origin).pathname.split("/").pop() ?? "";
  } catch {
    fromUrl = "";
  }
  const cleaned = (fromPath || fromUrl)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  const base = cleaned || `sunabot-image-${String(image.id).replace(/[^a-zA-Z0-9_-]+/g, "-") || "download"}`;
  if (/\.[a-zA-Z0-9]{2,5}$/.test(base)) return base;
  return `${base}.${extensionForMime(mimeType)}`;
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("avif")) return "avif";
  return "png";
}
