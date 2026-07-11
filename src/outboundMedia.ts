import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const OUTBOUND_MEDIA_ROUTE_PREFIX = "/outbound-media/generated-images";
const DEFAULT_TTL_SECONDS = 5 * 60;
const PNG_CONTENT_TYPE = "image/png";

export interface OutboundMediaDeliveryOptions {
  rootDir: string;
  secret?: Buffer;
  ttlSeconds?: number;
  nowSeconds?: () => number;
}

export interface ResolvedOutboundMedia {
  filePath: string;
  size: number;
  contentType: typeof PNG_CONTENT_TYPE;
}

export class OutboundMediaDelivery {
  private readonly rootDir: string;
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;
  private readonly nowSeconds: () => number;

  constructor(options: OutboundMediaDeliveryOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.secret = options.secret ? Buffer.from(options.secret) : crypto.randomBytes(32);
    this.ttlSeconds = normalizeTtl(options.ttlSeconds);
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));
  }

  async createSignedPath(filePath: string) {
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

    const expires = Math.floor(this.nowSeconds()) + this.ttlSeconds;
    const signature = this.sign(relativePath, expires);
    const query = new URLSearchParams({ expires: String(expires), signature });
    return `${OUTBOUND_MEDIA_ROUTE_PREFIX}/${encodeURIComponent(relativePath)}?${query.toString()}`;
  }

  async resolveSignedPath(
    fileNameValue: unknown,
    expiresValue: unknown,
    signatureValue: unknown
  ): Promise<ResolvedOutboundMedia | null> {
    const fileName = String(fileNameValue ?? "");
    const expiresText = String(expiresValue ?? "");
    const signature = String(signatureValue ?? "").toLowerCase();
    if (!isSafePngFileName(fileName) || !/^\d+$/.test(expiresText) || !/^[a-f0-9]{64}$/.test(signature)) {
      return null;
    }

    const expires = Number(expiresText);
    const now = Math.floor(this.nowSeconds());
    if (!Number.isSafeInteger(expires) || expires <= now || expires > now + this.ttlSeconds) return null;
    if (!constantTimeHexEqual(signature, this.sign(fileName, expires))) return null;

    const filePath = path.join(this.rootDir, fileName);
    const stats = await regularFileStats(filePath);
    if (!stats) return null;
    return {
      filePath,
      size: stats.size,
      contentType: PNG_CONTENT_TYPE
    };
  }

  private sign(fileName: string, expires: number) {
    return crypto.createHmac("sha256", this.secret)
      .update(`${fileName}\n${expires}`, "utf8")
      .digest("hex");
  }
}

function normalizeTtl(value: number | undefined) {
  if (value == null) return DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Outbound media TTL must be a positive integer.");
  return value;
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

function constantTimeHexEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}
