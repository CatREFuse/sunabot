import fs from "node:fs/promises";
import path from "node:path";

export interface OutboundMediaDeliveryOptions {
  rootDir: string;
  referenceMode?: "shared-path" | "inline-base64";
  maxInlineBytes?: number;
}

export type OutboundMediaReferenceMode = "shared-path" | "inline-base64";

export const DEFAULT_OUTBOUND_MEDIA_MAX_INLINE_BYTES = 32 * 1024 * 1024;

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
  private readonly referenceMode: OutboundMediaReferenceMode;
  private readonly maxInlineBytes: number;

  constructor(options: OutboundMediaDeliveryOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.referenceMode = options.referenceMode ?? "inline-base64";
    this.maxInlineBytes = options.maxInlineBytes ?? DEFAULT_OUTBOUND_MEDIA_MAX_INLINE_BYTES;
    if (!Number.isSafeInteger(this.maxInlineBytes) || this.maxInlineBytes < 1) {
      throw new Error("Outbound media inline size limit must be a positive integer.");
    }
  }

  async createReference(filePath: string) {
    const resolvedPath = path.resolve(filePath);
    const relativePath = path.relative(this.rootDir, resolvedPath);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || relativePath === ".." || path.isAbsolute(relativePath)) {
      throw new Error("Outbound media file is outside the outbound media root.");
    }
    if (relativePath.includes(path.sep)) {
      throw new Error("Outbound media file must be a direct child of the outbound media root.");
    }
    if (!isSafePngFileName(relativePath)) {
      throw new Error("Outbound media file must be a PNG image.");
    }

    const stats = await regularFileStats(resolvedPath);
    if (!stats) throw new Error("Outbound media file is not a regular file.");
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
      return `base64://${content.toString("base64")}`;
    }
    return resolvedPath;
  }
}

function isSafePngFileName(fileName: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(fileName) &&
    path.basename(fileName) === fileName &&
    !fileName.includes("/") &&
    !fileName.includes("\\");
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
