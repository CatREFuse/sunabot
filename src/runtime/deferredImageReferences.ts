import {
  GENERATE_IMG_TOOL_NAME,
  resolveGenerateImgReferences,
  type GenerateImgReferenceContext,
  type WorkbenchImagePathResolver
} from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import {
  archiveConversationImageReference,
  type ArchivedConversationImageReferenceV1
} from "../../services/media/conversationImageArchive.js";
import type { SunaRuntime } from "../runtime.js";
import type { ParsedIncomingMessage } from "../types.js";
import { queueIncomingSnapshot, uniqueStrings } from "./messagingAttachmentHelpers.js";

export interface DeferredGenerateImgReferenceContextV1 {
  schemaVersion: 1;
  currentImageUrls: ArchivedConversationImageReferenceV1[];
  previousOutputImageUrls: ArchivedConversationImageReferenceV1[];
  historyImageUrls: ArchivedConversationImageReferenceV1[];
  explicitImageUrls: ArchivedConversationImageReferenceV1[];
  mediaByHandle: Record<string, ArchivedConversationImageReferenceV1>;
}

export function readGenerateImgReferenceContext(value: unknown): GenerateImgReferenceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mediaByHandleValue = record.mediaByHandle;
  const mediaByHandle = mediaByHandleValue && typeof mediaByHandleValue === "object" && !Array.isArray(mediaByHandleValue)
    ? Object.fromEntries(Object.entries(mediaByHandleValue)
        .map(([handle, reference]) => [handle, readArchivedReferenceUrl(reference)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1])))
    : {};
  return {
    currentImageUrls: readReferenceImageUrls(record.currentImageUrls),
    previousOutputImageUrls: readReferenceImageUrls(record.previousOutputImageUrls),
    historyImageUrls: readReferenceImageUrls(record.historyImageUrls),
    mediaByHandle
  };
}

export async function snapshotDeferredChatImages(
  runtime: SunaRuntime,
  incoming: ParsedIncomingMessage,
  toolCall: { name: string; callId: string; arguments: Record<string, unknown> },
  imageReferences: GenerateImgReferenceContext,
  isCurrent: () => boolean,
  options: {
    archive?: (sourceUrl: string) => Promise<ArchivedConversationImageReferenceV1>;
  } = {}
) {
  const referenceLimit = toolCall.name === SELFIE_TOOL_NAME ? 1 : 4;
  if (toolCall.name !== GENERATE_IMG_TOOL_NAME && toolCall.name !== SELFIE_TOOL_NAME) {
    return {
      toolCall,
      incoming: queueIncomingSnapshot(incoming),
      imageReferences
    };
  }
  const requestedHandles = readReferenceMediaHandles(
    toolCall.arguments.referenceMediaHandles,
    referenceLimit
  );
  const missingHandles = requestedHandles.filter((handle) => !imageReferences.mediaByHandle?.[handle]);
  if (missingHandles.length) {
    throw new Error(`必需参考图无法解析，图片任务已取消：${missingHandles.join(", ")}`);
  }
  const resolved = resolveGenerateImgReferences(toolCall.arguments, { imageReferences });
  const requiredSourceUrls = uniqueStrings(resolved.referenceImageUrls).slice(0, referenceLimit);
  const archive = options.archive ?? (async (sourceUrl: string) => {
    if (!isCurrent()) throw new Error("异步图片任务已取消。");
    const result = await archiveConversationImageReference(
      runtime.config.persona.defaultAgentId,
      sourceUrl,
      runtime.attachmentService.cache
    );
    if (!isCurrent()) throw new Error("异步图片任务已取消。");
    return result;
  });
  const archivedBySource = new Map<string, ArchivedConversationImageReferenceV1>();
  const archivedReferences = await Promise.all(requiredSourceUrls.map(archive));
  requiredSourceUrls.forEach((sourceUrl, index) => {
    archivedBySource.set(sourceUrl, archivedReferences[index]!);
  });
  if (archivedBySource.size !== requiredSourceUrls.length) {
    throw new Error("必需参考图归档不完整，图片任务已取消。");
  }

  const deferredReferences: DeferredGenerateImgReferenceContextV1 = {
    schemaVersion: 1,
    currentImageUrls: mapArchivedReferences(imageReferences.currentImageUrls, archivedBySource),
    previousOutputImageUrls: mapArchivedReferences(
      imageReferences.previousOutputImageUrls,
      archivedBySource
    ),
    historyImageUrls: mapArchivedReferences(imageReferences.historyImageUrls, archivedBySource),
    explicitImageUrls: mapArchivedReferences(
      readReferenceImageUrls(toolCall.arguments.referenceImageUrls),
      archivedBySource
    ),
    mediaByHandle: Object.fromEntries(requestedHandles.flatMap((handle) => {
      const sourceUrl = imageReferences.mediaByHandle?.[handle];
      const archived = sourceUrl ? archivedBySource.get(sourceUrl) : undefined;
      return archived ? [[handle, archived]] : [];
    }))
  };
  const explicitReferenceImageUrls = readReferenceImageUrls(
    toolCall.arguments.referenceImageUrls
  );
  const archivedExplicitUrls = explicitReferenceImageUrls.flatMap((sourceUrl) => {
    const archived = archivedBySource.get(sourceUrl);
    return archived ? [archived.url] : [];
  });
  return {
    toolCall: {
      ...toolCall,
      arguments: {
        ...toolCall.arguments,
        referenceImageUrls: archivedExplicitUrls
      }
    },
    incoming: queueSafeIncomingSnapshot(incoming, archivedBySource),
    imageReferences: deferredReferences
  };
}

export async function snapshotDeferredImageTask(
  runtime: SunaRuntime,
  incoming: ParsedIncomingMessage,
  toolCall: { name: string; callId: string; arguments: Record<string, unknown> },
  imageReferences: GenerateImgReferenceContext,
  isCurrent: () => boolean
) {
  const workbenchImagesByPath = await snapshotDeferredWorkbenchImages(
    runtime,
    incoming,
    toolCall,
    isCurrent
  );
  return {
    ...await snapshotDeferredChatImages(
      runtime,
      incoming,
      toolCall,
      imageReferences,
      isCurrent
    ),
    workbenchImagesByPath
  };
}

export async function snapshotDeferredWorkbenchImages(
  runtime: SunaRuntime,
  incoming: ParsedIncomingMessage,
  toolCall: { name: string; arguments: Record<string, unknown> },
  isCurrent: () => boolean
) {
  if (toolCall.name !== GENERATE_IMG_TOOL_NAME && toolCall.name !== SELFIE_TOOL_NAME) return undefined;
  const limit = toolCall.name === SELFIE_TOOL_NAME ? 1 : 4;
  const paths = readReferenceImagePaths(toolCall.arguments.referenceImagePaths, limit);
  if (!paths.length) return undefined;
  const urls = await runtime.resolveWorkbenchImageReferences(incoming, paths, isCurrent);
  if (urls.length !== paths.length) throw new Error("Workbench reference image snapshot is incomplete.");
  return Object.fromEntries(paths.map((imagePath, index) => [imagePath, urls[index]!]));
}

export function deferredWorkbenchImageResolver(value: unknown): WorkbenchImagePathResolver | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = Object.fromEntries(Object.entries(value)
    .filter(([imagePath, imageUrl]) => (
      Boolean(imagePath.trim()) &&
      typeof imageUrl === "string" &&
      imageUrl.startsWith("/generated-images/conversation-assets/agents/")
    )));
  if (!Object.keys(snapshot).length) return undefined;
  return async (paths: readonly string[]) => {
    const normalized = readReferenceImagePaths(paths, 4);
    const resolved = normalized.map((imagePath) => snapshot[imagePath]).filter(Boolean);
    if (resolved.length !== normalized.length) {
      throw new Error("Workbench reference image snapshot is unavailable.");
    }
    return resolved;
  };
}

function readReferenceImageUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .map(readArchivedReferenceUrl)
    .filter(Boolean))
    .slice(0, 4);
}

function readArchivedReferenceUrl(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      typeof record.url !== "string" ||
      !record.url.startsWith("/generated-images/conversation-assets/agents/")) {
    return "";
  }
  return record.url;
}

function readReferenceImagePaths(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))
    .slice(0, limit);
}

function readReferenceMediaHandles(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))
    .slice(0, limit);
}

function mapArchivedReferences(
  values: readonly string[] | undefined,
  archivedBySource: ReadonlyMap<string, ArchivedConversationImageReferenceV1>
) {
  return uniqueStrings([...(values ?? [])]).flatMap((sourceUrl) => {
    const archived = archivedBySource.get(sourceUrl);
    return archived ? [archived] : [];
  });
}

function queueSafeIncomingSnapshot(
  incoming: ParsedIncomingMessage,
  archivedBySource: ReadonlyMap<string, ArchivedConversationImageReferenceV1>
): ParsedIncomingMessage {
  const mapMedia = (media: ParsedIncomingMessage["media"]) => media.flatMap((asset) => {
    const archived = asset.url ? archivedBySource.get(asset.url) : undefined;
    return archived ? [{
      schemaVersion: 1 as const,
      kind: "image" as const,
      source: "remote_url" as const,
      url: archived.url,
      ...(asset.altText?.trim() ? { altText: asset.altText.trim() } : {})
    }] : [];
  });
  return {
    ...incoming,
    sender: { ...incoming.sender },
    media: mapMedia(incoming.media),
    attachments: [],
    replyMessageIds: [...incoming.replyMessageIds],
    quoteReferences: incoming.quoteReferences.map((quote) => ({
      ...quote,
      media: mapMedia(quote.media ?? []),
      imageUrls: mapArchivedReferences(quote.imageUrls, archivedBySource)
        .map((reference) => reference.url),
      attachments: []
    }))
  };
}
