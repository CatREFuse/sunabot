import { readonly, shallowRef } from "vue";
import { apiBlob, apiRequest, authenticatedMediaPath } from "./useAdminApi";
import { agentScopedPath } from "./agentScope";
import type { ImageHistoryRecord } from "../types";

interface HistoryCacheEntry {
  images: ImageHistoryRecord[];
  cachedAt: number;
}

const historyCache = new Map<string, HistoryCacheEntry>();
const HISTORY_CACHE_MS = 60_000;

export function useImageStudio() {
  const images = shallowRef<ImageHistoryRecord[]>([]);
  const loading = shallowRef(false);
  const downloadingId = shallowRef("");
  const error = shallowRef("");
  let activeAgentId = "";
  let contextGeneration = 0;
  let loadGeneration = 0;
  let downloadGeneration = 0;
  let loadController: AbortController | undefined;
  let downloadController: AbortController | undefined;

  async function load(agentId: string, force = false) {
    const normalizedAgentId = normalizeAgentId(agentId);
    activate(normalizedAgentId);
    const cached = freshCache(normalizedAgentId);
    if (!force && cached) {
      images.value = cached.images;
      error.value = "";
      loading.value = false;
      return true;
    }
    loadController?.abort();
    const requestController = new AbortController();
    loadController = requestController;
    const context = contextGeneration;
    const generation = ++loadGeneration;
    loading.value = true;
    try {
      const history = await apiRequest<{ images: ImageHistoryRecord[] }>(
        `/api/images?agentId=${encodeURIComponent(normalizedAgentId)}`,
        { signal: requestController.signal }
      );
      if (!isCurrent(normalizedAgentId, context) || generation !== loadGeneration) return false;
      images.value = history.images;
      historyCache.set(normalizedAgentId, { images: history.images, cachedAt: Date.now() });
      error.value = "";
      return true;
    } catch (caught) {
      if (isAbortError(caught)) return false;
      if (isCurrent(normalizedAgentId, context) && generation === loadGeneration) {
        error.value = caught instanceof Error ? caught.message : "图像工作区读取失败";
      }
      return false;
    } finally {
      if (loadController === requestController) loadController = undefined;
      if (isCurrent(normalizedAgentId, context) && generation === loadGeneration) loading.value = false;
    }
  }

  async function download(agentId: string, image: ImageHistoryRecord) {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (activeAgentId !== normalizedAgentId) return false;
    downloadController?.abort();
    const requestController = new AbortController();
    downloadController = requestController;
    const context = contextGeneration;
    const generation = ++downloadGeneration;
    downloadingId.value = image.id;
    error.value = "";
    let objectUrl = "";
    try {
      const blob = image.url.startsWith("data:") || image.url.startsWith("blob:")
        ? await fetch(image.url, { signal: requestController.signal }).then((response) => response.blob())
        : await apiBlob(scopedMediaPath(image.url, normalizedAgentId), { signal: requestController.signal });
      if (!isCurrent(normalizedAgentId, context) || generation !== downloadGeneration) return false;
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = imageDownloadName(image, blob.type);
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return true;
    } catch (caught) {
      if (isAbortError(caught) || !isCurrent(normalizedAgentId, context) || generation !== downloadGeneration) {
        return false;
      }
      error.value = caught instanceof Error ? caught.message : "下载失败";
      throw caught;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (downloadController === requestController) downloadController = undefined;
      if (isCurrent(normalizedAgentId, context) && generation === downloadGeneration) downloadingId.value = "";
    }
  }

  function cancelLoad(agentId: string) {
    if (activeAgentId !== agentId.trim()) return;
    loadController?.abort();
    loadController = undefined;
    loading.value = false;
  }

  function dispose() {
    loadController?.abort();
    downloadController?.abort();
    loadController = undefined;
    downloadController = undefined;
    contextGeneration += 1;
  }

  function activate(agentId: string) {
    if (activeAgentId === agentId) return;
    loadController?.abort();
    downloadController?.abort();
    loadController = undefined;
    downloadController = undefined;
    activeAgentId = agentId;
    contextGeneration += 1;
    const cached = freshCache(agentId);
    images.value = cached?.images ?? [];
    loading.value = false;
    downloadingId.value = "";
    error.value = "";
  }

  function isCurrent(agentId: string, context: number) {
    return activeAgentId === agentId && contextGeneration === context;
  }

  return {
    images: readonly(images),
    loading: readonly(loading),
    downloadingId: readonly(downloadingId),
    error: readonly(error),
    load,
    download,
    cancelLoad,
    dispose
  };
}

function normalizeAgentId(agentId: string) {
  const normalized = agentId.trim();
  if (!normalized) throw new Error("Agent ID 不能为空");
  return normalized;
}

function freshCache(agentId: string) {
  const cached = historyCache.get(agentId);
  if (!cached || Date.now() - cached.cachedAt >= HISTORY_CACHE_MS) return undefined;
  return cached;
}

function scopedMediaPath(source: string, agentId: string) {
  const path = authenticatedMediaPath(source);
  return path.startsWith("/api/") ? agentScopedPath(path, agentId) : path;
}

function isAbortError(caught: unknown) {
  return caught instanceof Error && caught.name === "AbortError";
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
