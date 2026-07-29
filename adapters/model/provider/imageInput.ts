import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../../../packages/contracts/model/modelGateway.js";
import { getWorkspacePath } from "../../../packages/platform/projectPaths.js";
import { appendRequestLog } from "../../observability/requestLog.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { MAX_ATTACHMENT_VISUAL_PAGES } from "../../../services/media/attachments/context.js";
import { normalizeAttachmentImage } from "../../../services/media/attachments/image.js";
import {
  IMAGE_GENERATION_REFERENCE_MAX_BYTES,
  normalizeImageGenerationReference
} from "../../../services/media/imageGenerationReference.js";
import { errorMessage, uniqueStrings } from "./valueUtils.js";

const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_FETCH_BYTES = 64 * 1024 * 1024;

export interface ImageGenerationContentOptions {
  generatedImageRoot?: string;
}

export async function buildImageGenerationContent(
  prompt: string,
  referenceImageUrls: string[],
  options: ImageGenerationContentOptions = {}
) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: prompt
    }
  ];

  for (const imageUrl of uniqueStrings(referenceImageUrls).slice(0, 4)) {
    const resolvedImageUrl = await resolveInputImageUrl(imageUrl, {
      source: "image_generation.reference",
      logFailures: true,
      generatedImageRoot: options.generatedImageRoot,
      purpose: "image_generation_reference"
    });
    if (!resolvedImageUrl) continue;
    content.push({
      type: "input_image",
      image_url: resolvedImageUrl
    });
  }

  return content;
}

export function countInputImages(content: Array<Record<string, unknown>>) {
  return content.filter((item) => item.type === "input_image").length;
}

export function parseDataImage(value: string) {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined;
}

export interface ResponsesInputMessageOptions {
  promptCacheBreakpoint?: boolean;
}

export async function toResponsesInputMessage(
  message: ChatMessage,
  options: ResponsesInputMessageOptions = {}
) {
  const textType = message.role === "assistant" ? "output_text" : "input_text";
  const content: Array<Record<string, unknown>> = [
    {
      type: textType,
      text: message.content,
      ...(options.promptCacheBreakpoint && textType === "input_text"
        ? { prompt_cache_breakpoint: { mode: "explicit" } }
        : {})
    }
  ];

  if (message.role === "user") {
    for (const imageUrl of message.imageUrls ?? []) {
      const resolvedImageUrl = await resolveInputImageUrl(imageUrl);
      if (!resolvedImageUrl) continue;
      content.push({
        type: "input_image",
        image_url: resolvedImageUrl
      });
    }
    for (const localImagePath of (message.localImagePaths ?? []).slice(0, MAX_ATTACHMENT_VISUAL_PAGES)) {
      const resolvedImageUrl = await resolveLocalInputImage(localImagePath);
      if (!resolvedImageUrl) continue;
      content.push({
        type: "input_image",
        image_url: resolvedImageUrl
      });
    }
  }

  return {
    role: message.role,
    content
  };
}

export async function toChatCompletionMessage(message: ChatMessage) {
  if (message.role !== "user" || (!(message.imageUrls?.length) && !(message.localImagePaths?.length))) {
    return { role: message.role, content: message.content };
  }
  const content: Array<Record<string, unknown>> = [{ type: "text", text: message.content }];
  for (const imageUrl of message.imageUrls ?? []) {
    const resolved = await resolveInputImageUrl(imageUrl);
    if (resolved) content.push({ type: "image_url", image_url: { url: resolved } });
  }
  for (const localPath of (message.localImagePaths ?? []).slice(0, MAX_ATTACHMENT_VISUAL_PAGES)) {
    const resolved = await resolveLocalInputImage(localPath);
    if (resolved) content.push({ type: "image_url", image_url: { url: resolved } });
  }
  return { role: message.role, content };
}

export async function resolveLocalInputImage(filePath: string) {
  const cacheRoot = getWorkspacePath(WORKSPACE_LAYOUT.attachmentCache);
  return resolveBoundedLocalInputImage(filePath, cacheRoot);
}

async function resolveGeneratedInputImage(
  imageUrl: string,
  generatedImageRoot?: string,
  purpose: ResolveInputImagePurpose = "model_vision"
) {
  const relativePath = generatedImageRelativePath(imageUrl);
  if (!relativePath) return null;
  const root = generatedImageRoot ?? getWorkspacePath(WORKSPACE_LAYOUT.mediaImages);
  return resolveBoundedLocalInputImage(path.resolve(root, relativePath), root, purpose);
}

async function resolveBoundedLocalInputImage(
  filePath: string,
  rootPath: string,
  purpose: ResolveInputImagePurpose = "model_vision"
) {
  try {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedFile = path.resolve(filePath);
    if (!isPathInside(resolvedRoot, resolvedFile)) return null;
    const sourceStats = await fs.promises.lstat(filePath);
    if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) return null;
    const [realRoot, realFile] = await Promise.all([
      fs.promises.realpath(resolvedRoot),
      fs.promises.realpath(filePath)
    ]);
    if (!isPathInside(realRoot, realFile)) return null;
    const relativePath = path.relative(resolvedRoot, resolvedFile);
    if (realFile !== path.resolve(realRoot, relativePath)) return null;
    if (purpose === "image_generation_reference" && sourceStats.size > MAX_IMAGE_FETCH_BYTES) return null;
    const normalized = purpose === "image_generation_reference"
      ? await normalizeImageGenerationReference(realFile)
      : await normalizeAttachmentImage(realFile, {
        maxBytes: MAX_INPUT_IMAGE_BYTES
      });
    return `data:${normalized.contentType};base64,${normalized.bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function isPathInside(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export interface ResolveInputImageOptions {
  source?: string;
  logFailures?: boolean;
  generatedImageRoot?: string;
  purpose?: ResolveInputImagePurpose;
}

export type ResolveInputImagePurpose = "model_vision" | "image_generation_reference";

export async function resolveInputImageUrl(imageUrl: string, options: ResolveInputImageOptions = {}) {
  const dataImage = parseDataImage(imageUrl);
  if (dataImage) {
    if (options.purpose !== "image_generation_reference") return imageUrl;
    try {
      const bytes = Buffer.from(dataImage.data, "base64");
      if (bytes.byteLength > MAX_IMAGE_FETCH_BYTES) return null;
      const normalized = await normalizeImageGenerationReference(bytes);
      return `data:${normalized.contentType};base64,${normalized.bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }
  if (imageUrl.startsWith("/generated-images/")) {
    const resolved = await resolveGeneratedInputImage(
      imageUrl,
      options.generatedImageRoot,
      options.purpose
    );
    if (!resolved) await logInputImageResolveFailure(imageUrl, "generated_image_unavailable", options);
    return resolved;
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    await logInputImageResolveFailure(imageUrl, "unsupported_url", options);
    return null;
  }

  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      await logInputImageResolveFailure(imageUrl, "http_status", options, {
        status: response.status
      });
      return null;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
    if (!contentType.startsWith("image/")) {
      await logInputImageResolveFailure(imageUrl, "non_image_content_type", options, {
        contentType
      });
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_FETCH_BYTES) {
      await logInputImageResolveFailure(imageUrl, "content_length_too_large", options, {
        contentLength,
        maxFetchBytes: MAX_IMAGE_FETCH_BYTES
      });
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_FETCH_BYTES) {
      await logInputImageResolveFailure(imageUrl, "image_too_large", options, {
        byteLength: bytes.length,
        maxFetchBytes: MAX_IMAGE_FETCH_BYTES
      });
      return null;
    }

    let normalized;
    const maxBytes = options.purpose === "image_generation_reference"
      ? IMAGE_GENERATION_REFERENCE_MAX_BYTES
      : MAX_INPUT_IMAGE_BYTES;
    try {
      normalized = options.purpose === "image_generation_reference"
        ? await normalizeImageGenerationReference(bytes)
        : await normalizeAttachmentImage(bytes, {
          maxBytes
        });
    } catch (error) {
      await logInputImageResolveFailure(imageUrl, "normalization_failed", options, {
        byteLength: bytes.length,
        maxBytes,
        error: errorMessage(error)
      });
      return null;
    }

    await logInputImageResolveSuccess(imageUrl, options, {
      normalized: true,
      originalContentType: contentType,
      contentType: normalized.contentType,
      originalBytes: bytes.length,
      byteLength: normalized.bytes.length,
      maxBytes,
      width: normalized.width,
      height: normalized.height,
      resized: normalized.resized,
      pipeline: options.purpose ?? "model_vision"
    });
    return `data:${normalized.contentType};base64,${normalized.bytes.toString("base64")}`;
  } catch (error) {
    await logInputImageResolveFailure(imageUrl, "fetch_error", options, {
      error: errorMessage(error)
    });
    return null;
  }
}

function generatedImageRelativePath(imageUrl: string) {
  const prefix = "/generated-images/";
  if (!imageUrl.startsWith(prefix) || imageUrl.includes("?") || imageUrl.includes("#")) return undefined;
  const encodedSegments = imageUrl.slice(prefix.length).split("/");
  let segments: string[];
  try {
    segments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
  if (segments.length === 1 && isSafeGeneratedImageFileName(segments[0] ?? "")) {
    return segments[0];
  }
  if (
    segments.length === 3 &&
    segments[0] === "agents" &&
    isSafeAgentId(segments[1] ?? "") &&
    isSafeGeneratedImageFileName(segments[2] ?? "")
  ) {
    return path.join("agents", segments[1]!, segments[2]!);
  }
  if (
    segments.length === 4 &&
    segments[0] === "conversation-assets" &&
    segments[1] === "agents" &&
    isSafeAgentId(segments[2] ?? "") &&
    isSafeConversationImageFileName(segments[3] ?? "")
  ) {
    return path.join("conversation-assets", "agents", segments[2]!, segments[3]!);
  }
  return undefined;
}

function isSafeAgentId(value: string) {
  return /^[a-z][a-z0-9-]{1,31}$/.test(value);
}

function isSafeGeneratedImageFileName(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(value) &&
    path.basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\");
}

function isSafeConversationImageFileName(value: string) {
  return /^[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|avif|tiff?|bmp|heic|heif|flif|jxl|jxr|psd|ico|cr2|dng|arw|ktx2?)$/i.test(value) &&
    path.basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\");
}

async function logInputImageResolveFailure(
  imageUrl: string,
  reason: string,
  options: ResolveInputImageOptions,
  details: Record<string, unknown> = {}
) {
  if (!options.logFailures) return;
  await appendRequestLog({
    category: "image.resolve",
    action: "input_image",
    request: {
      url: imageUrl
    },
    response: {
      ok: false,
      reason,
      ...details
    },
    metadata: {
      source: options.source
    }
  });
}

async function logInputImageResolveSuccess(
  imageUrl: string,
  options: ResolveInputImageOptions,
  details: Record<string, unknown>
) {
  if (!options.logFailures) return;
  await appendRequestLog({
    category: "image.resolve",
    action: "input_image",
    request: {
      url: imageUrl
    },
    response: {
      ok: true,
      ...details
    },
    metadata: {
      source: options.source
    }
  });
}
