import {
  GENERATE_IMG_TOOL_NAME,
  type GenerateImgReferenceContext,
  type WorkbenchImagePathResolver
} from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import type { SunaRuntime } from "../runtime.js";
import type { ParsedIncomingMessage } from "../types.js";
import { uniqueStrings } from "./messagingAttachmentHelpers.js";

export function readGenerateImgReferenceContext(value: unknown): GenerateImgReferenceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mediaByHandleValue = record.mediaByHandle;
  const mediaByHandle = mediaByHandleValue && typeof mediaByHandleValue === "object" && !Array.isArray(mediaByHandleValue)
    ? Object.fromEntries(Object.entries(mediaByHandleValue)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())))
    : {};
  return {
    currentImageUrls: readReferenceImageUrls(record.currentImageUrls),
    previousOutputImageUrls: readReferenceImageUrls(record.previousOutputImageUrls),
    historyImageUrls: readReferenceImageUrls(record.historyImageUrls),
    mediaByHandle
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
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))
    .slice(0, 4);
}

function readReferenceImagePaths(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))
    .slice(0, limit);
}
