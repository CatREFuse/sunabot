import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PreparedOutboundConversationAssetV1 } from "../../packages/contracts/messaging/messages.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../packages/platform/projectPaths.js";
import {
  AttachmentCacheError,
  type CacheStore,
  type CachedAttachment
} from "./attachments/cache.js";
import { detectAttachmentType } from "./attachments/detect.js";

const MAX_CONVERSATION_REFERENCE_BYTES = 64 * 1024 * 1024;
const CONVERSATION_REFERENCE_RETRY_DELAYS_MS = [250, 500, 1_000] as const;

export interface ArchivedConversationImageReferenceV1 {
  schemaVersion: 1;
  sha256: string;
  url: string;
}

export interface ArchiveConversationImageReferenceOptions {
  signal?: AbortSignal;
  mediaRoot?: string;
  retrySleep?: (milliseconds: number) => Promise<void>;
}

const IMAGE_EXTENSIONS_BY_MIME = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/tiff", "tiff"],
  ["image/bmp", "bmp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/flif", "flif"],
  ["image/x-flif", "flif"],
  ["image/jxl", "jxl"],
  ["image/vnd.ms-photo", "jxr"],
  ["image/vnd.adobe.photoshop", "psd"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
  ["image/x-canon-cr2", "cr2"],
  ["image/x-adobe-dng", "dng"],
  ["image/x-sony-arw", "arw"],
  ["image/ktx", "ktx"],
  ["image/ktx2", "ktx2"]
]);

export async function archiveConversationImage(
  agentId: string,
  prepared: PreparedOutboundConversationAssetV1,
  mediaRoot = getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
) {
  const normalizedAgentId = agentId.trim();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(normalizedAgentId)) {
    throw new Error("Conversation image Agent ID is invalid.");
  }
  if (prepared.kind !== "image") {
    throw new Error("Conversation image archive only accepts image assets.");
  }
  const mimeType = String(prepared.mimeType ?? "").trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS_BY_MIME.get(mimeType);
  if (!extension) {
    throw new Error("Conversation image format is unsupported.");
  }
  const expectedDigest = String(prepared.sha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("Conversation image digest is invalid.");
  }
  const bytes = decodePreparedImage(prepared.source);
  if (bytes.byteLength !== prepared.byteLength) {
    throw new Error("Conversation image byte length changed.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) {
    throw new Error("Conversation image digest changed.");
  }

  const directory = path.join(
    mediaRoot,
    "conversation-assets",
    "agents",
    normalizedAgentId
  );
  const fileName = `${digest}.${extension}`;
  const filePath = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!await matchingArchiveExists(filePath, bytes.byteLength, digest)) {
    await writeArchiveAtomically(directory, filePath, bytes, digest);
  }
  return `/generated-images/conversation-assets/agents/${encodeURIComponent(normalizedAgentId)}/${fileName}`;
}

export async function archiveConversationImageReference(
  agentId: string,
  sourceUrl: string,
  cache: CacheStore,
  options: ArchiveConversationImageReferenceOptions = {}
): Promise<ArchivedConversationImageReferenceV1> {
  const normalizedAgentId = agentId.trim();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(normalizedAgentId)) {
    throw new Error("必需参考图归档 Agent 无效，图片任务已取消。");
  }
  const normalizedSourceUrl = sourceUrl.trim();
  if (!normalizedSourceUrl) throw new Error("必需参考图地址为空，图片任务已取消。");
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("异步图片任务已取消。");
  }
  try {
    const cached = await cacheConversationImageSource(
      normalizedSourceUrl,
      cache,
      options,
      normalizedAgentId
    );
    const detected = await detectAttachmentType(cached.filePath, {
      fileName: sourceImageFileName(normalizedSourceUrl),
      maxBytes: MAX_CONVERSATION_REFERENCE_BYTES
    });
    if (detected.kind !== "image" || !detected.mimeType) {
      throw new Error("必需参考图内容不是受支持的图片，图片任务已取消。");
    }
    const bytes = await fs.readFile(cached.filePath);
    if (bytes.byteLength !== cached.sizeBytes) {
      throw new Error("必需参考图下载后发生变化，图片任务已取消。");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== cached.sha256) {
      throw new Error("必需参考图摘要校验失败，图片任务已取消。");
    }
    const url = await archiveConversationImage(normalizedAgentId, {
      kind: "image",
      name: sourceImageFileName(normalizedSourceUrl),
      source: `base64://${bytes.toString("base64")}`,
      byteLength: bytes.byteLength,
      sha256: digest,
      mimeType: detected.mimeType
    }, options.mediaRoot);
    return {
      schemaVersion: 1,
      sha256: digest,
      url
    };
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith("必需参考图") ||
      error.message === "异步图片任务已取消。"
    )) {
      throw error;
    }
    throw new Error("必需参考图归档失败，图片任务已取消。", { cause: error });
  }
}

async function cacheConversationImageSource(
  sourceUrl: string,
  cache: CacheStore,
  options: ArchiveConversationImageReferenceOptions,
  agentId: string
): Promise<CachedAttachment> {
  if (/^https?:\/\//i.test(sourceUrl)) {
    return downloadConversationImageWithRetry(sourceUrl, cache, options);
  }
  const dataImage = sourceUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/is);
  if (dataImage) {
    return cache.writeBase64(dataImage[1]!, {
      maxBytes: MAX_CONVERSATION_REFERENCE_BYTES
    });
  }
  if (sourceUrl.startsWith("/generated-images/")) {
    const localPath = await resolveGeneratedImageArchiveSource(
      sourceUrl,
      options.mediaRoot,
      agentId
    );
    return cache.importFile(localPath, {
      signal: options.signal,
      maxBytes: MAX_CONVERSATION_REFERENCE_BYTES
    });
  }
  throw new Error("必需参考图地址不受支持，图片任务已取消。");
}

async function downloadConversationImageWithRetry(
  sourceUrl: string,
  cache: CacheStore,
  options: ArchiveConversationImageReferenceOptions
) {
  const sleep = options.retrySleep ?? defaultRetrySleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await cache.downloadHttp(sourceUrl, {
        signal: options.signal,
        maxBytes: MAX_CONVERSATION_REFERENCE_BYTES
      });
    } catch (error) {
      if (!isRetryableConversationImageDownload(error) ||
          attempt >= CONVERSATION_REFERENCE_RETRY_DELAYS_MS.length) {
        throw new Error("必需参考图下载失败，图片任务已取消。", { cause: error });
      }
      await sleep(CONVERSATION_REFERENCE_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

function isRetryableConversationImageDownload(error: unknown) {
  return error instanceof AttachmentCacheError && (
    error.code === "connect_timeout" ||
    error.code === "download_failed" ||
    error.code === "http_status" ||
    error.code === "idle_timeout" ||
    error.code === "missing_response_body"
  );
}

function defaultRetrySleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveGeneratedImageArchiveSource(
  imageUrl: string,
  mediaRoot: string | undefined,
  agentId: string
) {
  if (imageUrl.includes("?") || imageUrl.includes("#")) {
    throw new Error("必需参考图归档地址无效，图片任务已取消。");
  }
  const root = path.resolve(mediaRoot ?? getWorkspacePath(WORKSPACE_LAYOUT.mediaImages));
  let segments: string[];
  try {
    segments = imageUrl.slice("/generated-images/".length)
      .split("/")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("必需参考图归档地址无效，图片任务已取消。");
  }
  if (!segments.length || segments.some((segment) => (
    !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")
  ))) {
    throw new Error("必需参考图归档地址无效，图片任务已取消。");
  }
  if (
    (segments[0] === "agents" && segments[1] !== agentId) ||
    (segments[0] === "conversation-assets" && segments[1] === "agents" && segments[2] !== agentId)
  ) {
    throw new Error("必需参考图不属于当前 Agent，图片任务已取消。");
  }
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("必需参考图归档地址越界，图片任务已取消。");
  }
  const [rootRealPath, stats] = await Promise.all([
    fs.realpath(root),
    fs.lstat(candidate)
  ]);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("必需参考图归档不可用，图片任务已取消。");
  }
  const candidateRealPath = await fs.realpath(candidate);
  const realRelative = path.relative(rootRealPath, candidateRealPath);
  if (realRelative.startsWith(`..${path.sep}`) || realRelative === ".." || path.isAbsolute(realRelative)) {
    throw new Error("必需参考图归档越界，图片任务已取消。");
  }
  return candidateRealPath;
}

function sourceImageFileName(sourceUrl: string) {
  try {
    const parsed = new URL(sourceUrl, "https://sunabot.invalid");
    const baseName = path.basename(parsed.pathname);
    if (baseName && baseName !== "/") return baseName;
  } catch {
    // Detection uses content magic when the source has no usable name.
  }
  return "reference-image";
}

function decodePreparedImage(source: string) {
  if (!source.startsWith("base64://")) {
    throw new Error("Conversation image source is invalid.");
  }
  const encoded = source.slice("base64://".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Conversation image source is invalid.");
  }
  return Buffer.from(encoded, "base64");
}

async function matchingArchiveExists(filePath: string, byteLength: number, digest: string) {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size !== byteLength) {
      throw new Error("Conversation image archive is unsafe.");
    }
    const bytes = await fs.readFile(filePath);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("Conversation image archive digest mismatch.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeArchiveAtomically(
  directory: string,
  filePath: string,
  bytes: Buffer,
  digest: string
) {
  const temporaryPath = path.join(directory, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporaryPath, filePath);
    await fs.unlink(temporaryPath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await matchingArchiveExists(filePath, bytes.byteLength, digest)) return;
    }
    throw error;
  }
}
