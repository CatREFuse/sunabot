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
    acquisitionStatus: attachment.acquisition?.status,
    parseStatus: attachment.parseStatus,
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
  source: ResolvedAttachmentSource,
  signal?: AbortSignal
) {
  if (source.kind === "url") {
    return cache.downloadHttp(source.url, { retainActiveTask: true, signal });
  }
  if (source.kind === "base64") {
    return cache.writeBase64(source.base64, { retainActiveTask: true, signal });
  }
  return cache.importFile(source.filePath, { retainActiveTask: true, signal });
}

export function shouldTryGetFileFallback(error: unknown) {
  return error instanceof AttachmentCacheError && [
    "connect_timeout",
    "download_failed",
    "http_status",
    "idle_timeout",
    "invalid_url",
    "missing_response_body",
    "redirect_limit"
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

export function pendingAttachment(attachment: IncomingAttachment): ParsedAttachment {
  return {
    ...attachment,
    status: "pending",
    acquisition: { status: "pending" },
    parseStatus: "not_started"
  };
}

export function acquiredAttachment(
  attachment: ParsedAttachment,
  input: { cacheKey: string; sha256: string; sizeBytes: number; detectedMimeType?: string }
): ParsedAttachment {
  return {
    ...attachment,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    cacheKey: input.cacheKey,
    acquisition: {
      status: "acquired",
      blob: {
        schemaVersion: 1,
        cacheKey: input.cacheKey,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        ...(input.detectedMimeType ? { detectedMimeType: input.detectedMimeType } : {})
      }
    },
    parseStatus: "pending"
  };
}

export function parsedAttachmentState(
  attachment: ParsedAttachment,
  parseStatus: NonNullable<ParsedAttachment["parseStatus"]>
): ParsedAttachment {
  const acquisition = attachment.acquisition?.status === "acquired"
    ? {
        status: "acquired" as const,
        blob: {
          ...attachment.acquisition.blob,
          ...(attachment.mimeType ? { detectedMimeType: attachment.mimeType } : {})
        }
      }
    : attachment.acquisition;
  return {
    ...attachment,
    ...(acquisition ? { acquisition } : {}),
    parseStatus
  };
}

export function failedAcquisition(
  attachment: ParsedAttachment,
  errorCode: string,
  errorMessage: string,
  status: Extract<ParsedAttachment["status"], "failed" | "too_large" | "unsupported"> = "failed"
): ParsedAttachment {
  return {
    ...attachment,
    status,
    acquisition: { status: "failed", errorCode },
    parseStatus: "not_started",
    errorCode,
    errorMessage
  };
}

export function attachmentBlobRef(attachment: ParsedAttachment) {
  if (attachment.acquisition?.status === "acquired") {
    const blob = attachment.acquisition.blob;
    if (
      blob.schemaVersion === 1
      && /^[a-f0-9]{64}$/u.test(blob.cacheKey)
      && blob.cacheKey === blob.sha256
      && Number.isSafeInteger(blob.sizeBytes)
      && blob.sizeBytes > 0
      && attachment.cacheKey === blob.cacheKey
      && attachment.sha256 === blob.sha256
      && attachment.sizeBytes === blob.sizeBytes
    ) {
      return { ...blob };
    }
    return undefined;
  }
  if (
    (attachment.status === "ready" || attachment.status === "partial")
    && attachment.cacheKey
    && attachment.sha256
    && attachment.cacheKey === attachment.sha256
    && Number.isSafeInteger(attachment.sizeBytes)
    && Number(attachment.sizeBytes) > 0
  ) {
    return {
      schemaVersion: 1 as const,
      cacheKey: attachment.cacheKey,
      sha256: attachment.sha256,
      sizeBytes: Number(attachment.sizeBytes),
      ...(attachment.mimeType ? { detectedMimeType: attachment.mimeType } : {})
    };
  }
  return undefined;
}

export function userFacingAttachmentError(code: string) {
  if (code === "too_large") return "这个文件超过 256 MB，暂时无法读取。";
  if (code === "attachment_unavailable" || code === "http_status" || code.includes("timeout")) {
    return "文件下载失败，请重新发送或稍后再试。";
  }
  return "文件读取失败，请重新发送或稍后再试。";
}

export function cloneAttachment(attachment: ParsedAttachment): ParsedAttachment {
  return {
    ...attachment,
    acquisition: attachment.acquisition?.status === "acquired"
      ? { status: "acquired", blob: { ...attachment.acquisition.blob } }
      : attachment.acquisition
        ? { ...attachment.acquisition }
        : undefined,
    visualPagePaths: attachment.visualPagePaths?.slice()
  };
}

export function attachmentSourceKey(attachment: IncomingAttachment) {
  const owner = attachment.groupId != null
    ? `group:${attachment.groupId}`
    : attachment.userId != null
      ? `user:${attachment.userId}`
      : "unknown";
  if (attachment.fileId) return `${owner}:file:${attachment.fileId}`;
  if (attachment.fileToken) return `${owner}:token:${attachment.fileToken}`;
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
    acquisition: parsed.acquisition?.status === "acquired"
      ? { status: "acquired", blob: { ...parsed.acquisition.blob } }
      : parsed.acquisition
        ? { ...parsed.acquisition }
        : undefined,
    parseStatus: parsed.parseStatus,
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
