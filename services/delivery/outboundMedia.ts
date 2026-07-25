import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OutboundContentSegmentV1 } from "../../packages/contracts/messaging/messages.js";
import { MAX_EMOJI_MARKERS_PER_REPLY } from "../emojis/public.js";

export interface OutboundMediaDeliveryOptions {
  rootDir: string;
  workspaceRoot?: string;
  referenceMode?: "shared-path" | "inline-base64";
  maxInlineBytes?: number;
}

export type OutboundMediaReferenceMode = "shared-path" | "inline-base64";

export const DEFAULT_OUTBOUND_MEDIA_MAX_INLINE_BYTES = 32 * 1024 * 1024;
export const MAX_OUTBOUND_MEDIA_REFERENCE_CONCURRENCY = 2;
export const MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE = 32 * 1024 * 1024;

export interface OutboundMediaImageInput {
  url?: string;
  filePath?: string;
}

export function outboundMediaReferenceMode(
  env: { SUNABOT_MEDIA_TRANSPORT?: string } = process.env
): OutboundMediaReferenceMode {
  const value = env.SUNABOT_MEDIA_TRANSPORT?.trim().toLowerCase() || "inline-base64";
  if (value === "inline-base64") return value;
  throw new Error(
    "SUNABOT_MEDIA_TRANSPORT must be inline-base64 in the split runtime; " +
    "Core and NapCat do not share a filesystem."
  );
}

export function outboundMediaMaxInlineBytes(
  env: { SUNABOT_MEDIA_MAX_INLINE_BYTES?: string } = process.env
) {
  const raw = env.SUNABOT_MEDIA_MAX_INLINE_BYTES?.trim();
  if (!raw) return DEFAULT_OUTBOUND_MEDIA_MAX_INLINE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 256 * 1024 * 1024) {
    throw new Error("SUNABOT_MEDIA_MAX_INLINE_BYTES must be an integer between 1 and 268435456.");
  }
  return value;
}

export class OutboundMediaDelivery {
  private readonly rootDir: string;
  private readonly workspaceRoot?: string;
  private readonly referenceMode: OutboundMediaReferenceMode;
  private readonly maxInlineBytes: number;

  constructor(options: OutboundMediaDeliveryOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
    this.referenceMode = options.referenceMode ?? "inline-base64";
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_OUTBOUND_MEDIA_MAX_INLINE_BYTES;
    if (!Number.isSafeInteger(this.maxInlineBytes) || this.maxInlineBytes < 1) {
      throw new Error("Outbound media inline size limit must be a positive integer.");
    }
  }

  async createReference(filePath: string) {
    const resolvedPath = path.resolve(filePath);
    const boundary = resolveOutboundMediaBoundary(this.rootDir, this.workspaceRoot, resolvedPath);
    if (!boundary) {
      throw new Error("Outbound media file is outside the outbound media root.");
    }
    const fileName = generatedImageFileName(boundary.relativePath);
    if (!fileName) {
      throw new Error("Outbound media file must be a direct child of the outbound media root.");
    }
    if (!isSafePngFileName(fileName)) {
      throw new Error("Outbound media file must be a PNG image.");
    }
    if (boundary.emojiWorkbench && !contentAddressedEmojiDigest(fileName)) {
      throw new Error("Outbound workbench emoji must use a content-addressed PNG file name.");
    }

    const stats = await regularFileStats(resolvedPath);
    if (!stats) throw new Error("Outbound media file is not a regular file.");
    await assertUnredirectedPath(boundary.rootDir, resolvedPath, boundary.relativePath);
    if (this.referenceMode === "inline-base64") {
      if (stats.size > this.maxInlineBytes) {
        throw new Error(
          `Outbound media file exceeds the inline Base64 limit of ${this.maxInlineBytes} bytes.`
        );
      }
      const content = await fs.readFile(resolvedPath);
      if (content.byteLength > this.maxInlineBytes) {
        throw new Error(
          `Outbound media file exceeds the inline Base64 limit of ${this.maxInlineBytes} bytes.`
        );
      }
      assertContentAddressedEmoji(fileName, content);
      return `base64://${content.toString("base64")}`;
    }
    const emojiDigest = contentAddressedEmojiDigest(fileName);
    if (emojiDigest) {
      if (stats.size > this.maxInlineBytes) {
        throw new Error(
          `Outbound media file exceeds the inline Base64 limit of ${this.maxInlineBytes} bytes.`
        );
      }
      assertContentAddressedEmoji(fileName, await fs.readFile(resolvedPath));
    }
    return resolvedPath;
  }
}

function resolveOutboundMediaBoundary(
  rootDir: string,
  workspaceRoot: string | undefined,
  filePath: string
) {
  const generatedRelative = safeRelative(rootDir, filePath);
  if (generatedRelative) {
    return { rootDir, relativePath: generatedRelative, emojiWorkbench: false };
  }
  if (!workspaceRoot) return undefined;
  const relative = safeRelative(workspaceRoot, filePath);
  if (!relative) return undefined;
  const segments = relative.split(path.sep);
  if (
    segments.length !== 6
    || segments[0] !== "business"
    || segments[1] !== "agents"
    || !isSafeAgentId(segments[2] ?? "")
    || segments[3] !== "workbench"
    || segments[4] !== "emoji"
  ) return undefined;
  const emojiRoot = path.join(workspaceRoot, ...segments.slice(0, 5));
  return { rootDir: emojiRoot, relativePath: segments[5]!, emojiWorkbench: true };
}

function safeRelative(rootDir: string, filePath: string) {
  const relative = path.relative(rootDir, filePath);
  if (
    !relative
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
  ) return undefined;
  return relative;
}

export async function prepareOutboundImageSources(
  images: readonly OutboundMediaImageInput[],
  delivery?: OutboundMediaDelivery,
  contentSegments?: readonly OutboundContentSegmentV1[]
) {
  const emittedIndexes = emittedImageIndexes(images, contentSegments);
  const localOccurrences = new Map<string, number>();
  const emojiOccurrences = new Map<string, number>();
  for (const index of emittedIndexes) {
    const image = images[index]!;
    if (!image.filePath) continue;
    const identity = fileIdentity(image.filePath);
    localOccurrences.set(identity, (localOccurrences.get(identity) ?? 0) + 1);
    if (!contentAddressedEmojiDigest(pathLikeBaseName(image.filePath))) continue;
    emojiOccurrences.set(identity, (emojiOccurrences.get(identity) ?? 0) + 1);
  }
  const markerCount = [...emojiOccurrences.values()].reduce((sum, count) => sum + count, 0);
  if (markerCount > MAX_EMOJI_MARKERS_PER_REPLY) {
    throw new Error(
      `Outbound message exceeds the limit of ${MAX_EMOJI_MARKERS_PER_REPLY} emoji markers.`
    );
  }

  const sources = new Array<string>(images.length);
  const pendingByIdentity = new Map<string, { filePath: string; indexes: number[] }>();
  for (const [index, image] of images.entries()) {
    if (image.filePath && delivery) {
      const identity = fileIdentity(image.filePath);
      const pending = pendingByIdentity.get(identity);
      if (pending) pending.indexes.push(index);
      else pendingByIdentity.set(identity, { filePath: image.filePath, indexes: [index] });
      continue;
    }
    const source = image.url && /^https?:\/\//i.test(image.url) ? image.url : image.filePath;
    if (!source) throw new Error("Outbound image source is invalid.");
    sources[index] = source;
  }

  const pending = [...pendingByIdentity.entries()];
  let cursor = 0;
  let inlineBytes = 0;
  let firstError: unknown;
  const worker = async () => {
    while (!firstError) {
      const task = pending[cursor++];
      if (!task) return;
      const [identity, entry] = task;
      try {
        const source = await delivery!.createReference(entry.filePath);
        if (firstError) return;
        const occurrences = localOccurrences.get(identity) ?? 0;
        const byteLength = occurrences ? inlineBase64ByteLength(source) : undefined;
        if (byteLength != null) {
          const contribution = byteLength * occurrences;
          if (
            !Number.isSafeInteger(contribution) ||
            contribution > MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE - inlineBytes
          ) {
            throw new Error(
              `Outbound inline images exceed the per-message limit of ` +
              `${MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE} bytes.`
            );
          }
          inlineBytes += contribution;
        }
        for (const index of entry.indexes) sources[index] = source;
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_OUTBOUND_MEDIA_REFERENCE_CONCURRENCY, pending.length) },
    worker
  ));
  if (firstError) throw firstError;
  return sources;
}

function emittedImageIndexes(
  images: readonly OutboundMediaImageInput[],
  contentSegments?: readonly OutboundContentSegmentV1[]
) {
  if (!contentSegments?.length) return images.map((_, index) => index);
  const indexes: number[] = [];
  for (const segment of contentSegments) {
    if (segment.type === "text") continue;
    if (!Number.isSafeInteger(segment.imageIndex) || segment.imageIndex < 0 || segment.imageIndex >= images.length) {
      throw new Error("Outbound image segment index is invalid.");
    }
    indexes.push(segment.imageIndex);
  }
  return indexes;
}

function fileIdentity(filePath: string) {
  return `file:${path.resolve(filePath)}`;
}

function inlineBase64ByteLength(source: string) {
  if (!source.startsWith("base64://")) return undefined;
  const encoded = source.slice("base64://".length);
  if (!encoded || encoded.length % 4 !== 0) {
    throw new Error("Outbound inline image reference is invalid.");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const byteLength = (encoded.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error("Outbound inline image reference is invalid.");
  }
  return byteLength;
}

function generatedImageFileName(relativePath: string) {
  const segments = relativePath.split(path.sep);
  if (segments.length === 1) return segments[0];
  if (
    segments.length === 3 &&
    segments[0] === "agents" &&
    isSafeAgentId(segments[1] ?? "")
  ) {
    return segments[2];
  }
  return undefined;
}

function isSafeAgentId(value: string) {
  return /^[a-z][a-z0-9-]{1,31}$/.test(value);
}

function isSafePngFileName(fileName: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(fileName) &&
    path.basename(fileName) === fileName &&
    !fileName.includes("/") &&
    !fileName.includes("\\");
}

function contentAddressedEmojiDigest(fileName: string) {
  return /^emoji-([a-f0-9]{64})\.png$/u.exec(fileName)?.[1];
}

function pathLikeBaseName(value: string) {
  return value.split(/[\\/]/).at(-1) ?? "";
}

function assertContentAddressedEmoji(fileName: string, content: Buffer) {
  const expectedDigest = contentAddressedEmojiDigest(fileName);
  if (!expectedDigest) return;
  const actualDigest = crypto.createHash("sha256").update(content).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error("Outbound emoji content does not match its content-addressed file name.");
  }
}

async function regularFileStats(filePath: string) {
  try {
    const stats = await fs.lstat(filePath);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertUnredirectedPath(rootDir: string, filePath: string, relativePath: string) {
  const [realRoot, realFile] = await Promise.all([fs.realpath(rootDir), fs.realpath(filePath)]);
  if (realFile !== path.resolve(realRoot, relativePath)) {
    throw new Error("Outbound media file path must not contain symbolic links.");
  }
}
