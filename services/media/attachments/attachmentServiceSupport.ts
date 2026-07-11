import path from "node:path";
import { AttachmentCacheError, type CacheStore } from "./cache.js";
import type { DetectedAttachmentType } from "./detect.js";
import type { ResolvedAttachmentSource } from "./resolver.js";
import type { IncomingAttachment, ParsedAttachment } from "./types.js";

export function logAttachmentProcessing(
  attachment: ParsedAttachment,
  details: {
    referenceScope?: string;
    durationMs: number;
    declaredSizeBytes?: number;
    resolvedVia?: string;
    sourceKind?: string;
    cacheHit?: boolean;
  }
) {
  console.info("[attachment]", JSON.stringify({
    event: "attachment_processed",
    referenceScope: details.referenceScope,
    attachmentId: attachment.id,
    source: attachment.source,
    fileName: attachment.name,
    declaredSizeBytes: details.declaredSizeBytes,
    actualSizeBytes: attachment.sha256 ? attachment.sizeBytes : undefined,
    resolvedVia: details.resolvedVia,
    sourceKind: details.sourceKind,
    cacheHit: details.cacheHit,
    status: attachment.status,
    format: attachment.format,
    mimeType: attachment.mimeType,
    sha256Prefix: attachment.sha256?.slice(0, 12),
    pageCount: attachment.pageCount,
    textCharacterCount: attachment.textCharacterCount,
    visualPageCount: attachment.visualPagePaths?.length ?? 0,
    durationMs: Math.max(0, Math.trunc(details.durationMs)),
    errorCode: attachment.errorCode
  }));
}

export function cacheResolvedAttachment(
  cache: CacheStore,
  source: ResolvedAttachmentSource
) {
  if (source.kind === "url") {
    return cache.downloadHttp(source.url, { retainActiveTask: true });
  }
  if (source.kind === "base64") {
    return cache.writeBase64(source.base64, { retainActiveTask: true });
  }
  return cache.importFile(source.filePath, { retainActiveTask: true });
}

export function shouldTryGetFileFallback(error: unknown) {
  return error instanceof AttachmentCacheError && [
    "connect_timeout",
    "download_failed",
    "http_status",
    "idle_timeout",
    "invalid_url",
    "missing_response_body",
    "redirect_limit",
    "unsafe_url"
  ].includes(error.code);
}

export function applyDetectionWarnings(
  attachment: ParsedAttachment,
  detected: DetectedAttachmentType
) {
  if (attachment.status !== "ready" && attachment.status !== "partial") return attachment;
  if (detected.extensionMismatch) {
    return {
      ...attachment,
      status: "partial",
      errorCode: attachment.errorCode ?? "extension_mismatch",
      errorMessage: attachment.errorMessage ?? "文件扩展名与实际格式不一致，已按检测到的格式读取。"
    } satisfies ParsedAttachment;
  }
  if (detected.kind === "text" && detected.textEncoding?.uncertain) {
    return {
      ...attachment,
      status: "partial",
      errorCode: attachment.errorCode ?? "encoding_uncertain",
      errorMessage: attachment.errorMessage ?? "文件编码识别不完全确定，读取结果可能含有少量乱码。"
    } satisfies ParsedAttachment;
  }
  return attachment;
}

export function failAttachment(
  attachment: ParsedAttachment,
  status: ParsedAttachment["status"],
  errorCode: string,
  errorMessage: string
): ParsedAttachment {
  return { ...attachment, status, errorCode, errorMessage };
}

export function userFacingAttachmentError(code: string) {
  if (code === "too_large") return "这个文件超过 256 MB，暂时无法读取。";
  if (code === "attachment_unavailable" || code === "http_status" || code.includes("timeout")) {
    return "文件下载失败，请重新发送或稍后再试。";
  }
  return "文件读取失败，请重新发送或稍后再试。";
}

export function cloneAttachment(attachment: ParsedAttachment): ParsedAttachment {
  return { ...attachment, visualPagePaths: attachment.visualPagePaths?.slice() };
}

export function attachmentSourceKey(attachment: IncomingAttachment) {
  const owner = attachment.groupId != null
    ? `group:${attachment.groupId}`
    : attachment.userId != null
      ? `user:${attachment.userId}`
      : "unknown";
  if (attachment.fileId) return `${owner}:file:${attachment.fileId}`;
  if (attachment.url) return `url:${attachment.url}`;
  return undefined;
}

export function rebindParsedAttachment(
  parsed: ParsedAttachment,
  incoming: IncomingAttachment | ParsedAttachment
): ParsedAttachment {
  return {
    ...parsed,
    ...incoming,
    status: parsed.status,
    mimeType: parsed.mimeType,
    format: parsed.format,
    sizeBytes: parsed.sizeBytes,
    sha256: parsed.sha256,
    cacheKey: parsed.cacheKey,
    textPreview: parsed.textPreview,
    chunkIndexPath: parsed.chunkIndexPath,
    visualPagePaths: parsed.visualPagePaths?.slice(),
    visualSourcePath: parsed.visualSourcePath,
    pageCount: parsed.pageCount,
    textCharacterCount: parsed.textCharacterCount,
    truncated: parsed.truncated,
    errorCode: parsed.errorCode,
    errorMessage: parsed.errorMessage
  };
}

export function parsedReuseKey(cacheKey: string, fileName: string) {
  return `${cacheKey}\u0000${attachmentDetectionHint(fileName)}`;
}

export function attachmentDetectionHint(fileName: string) {
  return path.basename(fileName).normalize("NFKC").toLocaleLowerCase().slice(0, 180);
}
