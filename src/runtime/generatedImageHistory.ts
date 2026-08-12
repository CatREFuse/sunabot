import type { GeneratedImageMetadata } from "../../adapters/model/provider/contracts.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import type { AppConfig, ImageResult } from "../types.js";

export function recordGeneratedImageHistory(
  config: AppConfig,
  image: ImageResult,
  metadata?: GeneratedImageMetadata
) {
  const url = String(image.url ?? "").trim();
  if (!url && !image.filePath) return;
  const id = (
    url.split(/[\\/]/).pop()
    || image.filePath?.split(/[\\/]/).pop()
    || "generated-image"
  ).trim();
  applicationDataStore(config).appendImageHistory({
    id,
    url,
    ...(image.filePath ? { filePath: image.filePath } : {}),
    ...(metadata?.prompt ? { prompt: metadata.prompt } : {}),
    ...(metadata?.size ? { size: metadata.size } : {}),
    ...(metadata?.resolution === "1K" || metadata?.resolution === "2K" || metadata?.resolution === "4K"
      ? { resolution: metadata.resolution }
      : {}),
    createdAt: new Date().toISOString()
  });
}
