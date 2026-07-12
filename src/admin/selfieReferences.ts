import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadConfig, resolveProjectPath } from "../config.js";
import type { AppConfig } from "../types.js";
import { AdminApiError, badRequest, conflict, notFound } from "./errors.js";
import { adminMutationMutex, type AdminMutationMutex } from "./mutation.js";

export const MAX_SELFIE_STORED_REFERENCE_IMAGES = 3;
export const MAX_SELFIE_REFERENCE_BYTES = 8 * 1024 * 1024;

const MAX_BASE64_LENGTH = Math.ceil(MAX_SELFIE_REFERENCE_BYTES / 3) * 4;
const IMAGE_INPUT_PIXEL_LIMIT = 64_000_000;
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface SelfieReferenceImage {
  id: string;
  fileName: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: string;
}

export interface SelfieReferenceEnvelope {
  images: SelfieReferenceImage[];
  maxImages: number;
}

export type SelfieReferenceVariant = "original" | "display" | "placeholder";

export interface SelfieReferenceContent {
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
}

export interface SelfieReferenceRepositoryOptions {
  getConfig?: () => AppConfig | Promise<AppConfig>;
  mutex?: AdminMutationMutex;
}

interface StoredSelfieReference extends SelfieReferenceImage {
  bytes: Buffer;
  contentType: SelfieReferenceContent["contentType"];
  filePath: string;
}

interface SelfieDirectory {
  directoryPath: string;
  exists: boolean;
}

interface ParsedUpload {
  bytes: Buffer;
  extension: ".png" | ".jpg" | ".webp";
  id: string;
  safeStem: string;
}

interface DecodedImage {
  format: "png" | "jpeg" | "webp";
  contentType: SelfieReferenceContent["contentType"];
  width: number;
  height: number;
}

export class SelfieReferenceRepository {
  private readonly getConfig: () => AppConfig | Promise<AppConfig>;
  private readonly mutex: AdminMutationMutex;

  constructor(options: SelfieReferenceRepositoryOptions = {}) {
    this.getConfig = options.getConfig ?? loadConfig;
    this.mutex = options.mutex ?? adminMutationMutex;
  }

  async list(): Promise<SelfieReferenceEnvelope> {
    const directory = await this.resolveDirectory(false);
    const images = directory.exists
      ? (await readStoredReferences(directory.directoryPath)).map(publicMetadata)
      : [];
    return { images, maxImages: MAX_SELFIE_STORED_REFERENCE_IMAGES };
  }

  async create(input: unknown): Promise<SelfieReferenceEnvelope> {
    const upload = await parseUpload(input);
    return this.mutex.runExclusive(async () => {
      const directory = await this.resolveDirectory(true);
      const current = await readStoredReferences(directory.directoryPath);
      if (current.some((image) => image.id === upload.id)) {
        return { images: current.map(publicMetadata), maxImages: MAX_SELFIE_STORED_REFERENCE_IMAGES };
      }
      if (current.length >= MAX_SELFIE_STORED_REFERENCE_IMAGES) {
        conflict("SELFIE_REFERENCE_LIMIT", `自拍参考图最多保留 ${MAX_SELFIE_STORED_REFERENCE_IMAGES} 张。`);
      }

      const fileName = `${upload.safeStem}-${upload.id}${upload.extension}`;
      const filePath = path.join(directory.directoryPath, fileName);
      assertInside(directory.directoryPath, filePath);
      await assertPathIsNotSymlink(filePath, true);
      await atomicWrite(filePath, upload.bytes);

      return {
        images: (await readStoredReferences(directory.directoryPath)).map(publicMetadata),
        maxImages: MAX_SELFIE_STORED_REFERENCE_IMAGES
      };
    });
  }

  async remove(id: string): Promise<void> {
    assertReferenceId(id);
    await this.mutex.runExclusive(async () => {
      const directory = await this.resolveDirectory(false);
      if (!directory.exists) notFound("SELFIE_REFERENCE_NOT_FOUND", "自拍参考图不存在。");
      const current = await readStoredReferences(directory.directoryPath);
      const target = current.find((image) => image.id === id);
      if (!target) notFound("SELFIE_REFERENCE_NOT_FOUND", "自拍参考图不存在。");
      await assertPathIsNotSymlink(target.filePath);
      await fs.rm(target.filePath);
    });
  }

  async content(id: string, variant: SelfieReferenceVariant): Promise<SelfieReferenceContent> {
    assertReferenceId(id);
    const directory = await this.resolveDirectory(false);
    if (!directory.exists) notFound("SELFIE_REFERENCE_NOT_FOUND", "自拍参考图不存在。");
    const target = (await readStoredReferences(directory.directoryPath)).find((image) => image.id === id);
    if (!target) notFound("SELFIE_REFERENCE_NOT_FOUND", "自拍参考图不存在。");
    if (variant === "original") return { bytes: target.bytes, contentType: target.contentType };

    try {
      const pipeline = sharp(target.bytes, sharpOptions()).rotate();
      const bytes = variant === "placeholder"
        ? await pipeline
            .resize({ width: 32, height: 32, fit: "cover" })
            .webp({ quality: 24, effort: 4 })
            .toBuffer()
        : await pipeline
            .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 76, effort: 4 })
            .toBuffer();
      return { bytes, contentType: "image/webp" };
    } catch {
      throw new AdminApiError(415, "SELFIE_REFERENCE_INVALID_IMAGE", "自拍参考图无法解码。");
    }
  }

  private async resolveDirectory(create: boolean): Promise<SelfieDirectory> {
    const config = await this.getConfig();
    const configuredWorkspace = resolveProjectPath(config.persona.agentWorkspace);
    if (!configuredWorkspace) {
      badRequest("AGENT_WORKSPACE_INVALID", "Agent workspace 未配置。", "persona.agentWorkspace");
    }

    const workspacePath = path.resolve(configuredWorkspace);
    let workspaceExists = await pathExists(workspacePath);
    if (!workspaceExists && create) {
      await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 });
      workspaceExists = true;
    }
    if (!workspaceExists) return { directoryPath: path.join(workspacePath, "selfie"), exists: false };

    const workspaceStats = await fs.lstat(workspacePath);
    if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()) {
      badRequest("AGENT_WORKSPACE_INVALID", "Agent workspace 必须是普通目录。", "persona.agentWorkspace");
    }
    const realWorkspace = await fs.realpath(workspacePath);
    const directoryPath = path.join(realWorkspace, "selfie");
    let directoryExists = await pathExists(directoryPath);
    if (!directoryExists && create) {
      await fs.mkdir(directoryPath, { mode: 0o700 });
      directoryExists = true;
    }
    if (!directoryExists) return { directoryPath, exists: false };

    const directoryStats = await fs.lstat(directoryPath);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      badRequest("SELFIE_REFERENCE_PATH_INVALID", "自拍参考图目录必须是普通目录。");
    }
    assertInside(realWorkspace, await fs.realpath(directoryPath));
    return { directoryPath, exists: true };
  }
}

async function parseUpload(input: unknown): Promise<ParsedUpload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("SELFIE_REFERENCE_INVALID", "请求体必须是对象。");
  }
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => key !== "fileName" && key !== "dataBase64");
  if (extra) badRequest("SELFIE_REFERENCE_INVALID", "包含不支持的字段。", extra);
  if (typeof body.fileName !== "string") {
    badRequest("SELFIE_REFERENCE_INVALID", "文件名无效。", "fileName");
  }
  if (typeof body.dataBase64 !== "string") {
    badRequest("SELFIE_REFERENCE_INVALID", "图片数据无效。", "dataBase64");
  }

  const fileName = body.fileName.trim().normalize("NFC");
  if (!fileName || fileName.length > 160 || fileName.includes("\0") || path.basename(fileName) !== fileName) {
    badRequest("SELFIE_REFERENCE_INVALID", "文件名无效。", "fileName");
  }
  const requestedExtension = path.extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(requestedExtension)) {
    throw new AdminApiError(415, "SELFIE_REFERENCE_TYPE_UNSUPPORTED", "仅支持 PNG、JPEG 和 WebP 图片。", "fileName");
  }

  const dataBase64 = body.dataBase64;
  if (!dataBase64) {
    badRequest("SELFIE_REFERENCE_BASE64_INVALID", "图片 Base64 数据无效。", "dataBase64");
  }
  if (dataBase64.length > MAX_BASE64_LENGTH) {
    throw new AdminApiError(413, "SELFIE_REFERENCE_TOO_LARGE", "自拍参考图超过 8 MiB 限制。", "dataBase64");
  }
  if (dataBase64.length % 4 !== 0) {
    badRequest("SELFIE_REFERENCE_BASE64_INVALID", "图片 Base64 数据无效。", "dataBase64");
  }
  if (decodedBase64Size(dataBase64) > MAX_SELFIE_REFERENCE_BYTES) {
    throw new AdminApiError(413, "SELFIE_REFERENCE_TOO_LARGE", "自拍参考图超过 8 MiB 限制。", "dataBase64");
  }
  if (!isStrictBase64(dataBase64)) {
    badRequest("SELFIE_REFERENCE_BASE64_INVALID", "图片 Base64 数据无效。", "dataBase64");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (!bytes.length || bytes.toString("base64") !== dataBase64) {
    badRequest("SELFIE_REFERENCE_BASE64_INVALID", "图片 Base64 数据无效。", "dataBase64");
  }
  if (bytes.byteLength > MAX_SELFIE_REFERENCE_BYTES) {
    throw new AdminApiError(413, "SELFIE_REFERENCE_TOO_LARGE", "自拍参考图超过 8 MiB 限制。", "dataBase64");
  }

  const decoded = await decodeImage(bytes);
  if (!extensionMatchesFormat(requestedExtension, decoded.format)) {
    throw new AdminApiError(415, "SELFIE_REFERENCE_TYPE_MISMATCH", "文件扩展名与图片格式不一致。", "fileName");
  }
  return {
    bytes,
    extension: decoded.format === "jpeg" ? ".jpg" : `.${decoded.format}`,
    id: sha256(bytes),
    safeStem: safeFileStem(path.basename(fileName, requestedExtension))
  };
}

async function readStoredReferences(directoryPath: string): Promise<StoredSelfieReference[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const images: StoredSelfieReference[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (entry.isSymbolicLink()) {
      badRequest("SELFIE_REFERENCE_PATH_INVALID", "自拍参考图不能使用符号链接。");
    }
    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const filePath = path.join(directoryPath, entry.name);
    assertInside(directoryPath, filePath);
    await assertPathIsNotSymlink(filePath);
    const [stats, realPath] = await Promise.all([fs.stat(filePath), fs.realpath(filePath)]);
    assertInside(directoryPath, realPath);
    if (!stats.isFile()) badRequest("SELFIE_REFERENCE_PATH_INVALID", "自拍参考图必须是普通文件。");
    if (stats.size <= 0) badRequest("SELFIE_REFERENCE_INVALID_IMAGE", "自拍参考图无法解码。");
    if (stats.size > MAX_SELFIE_REFERENCE_BYTES) {
      throw new AdminApiError(413, "SELFIE_REFERENCE_TOO_LARGE", "自拍参考图超过 8 MiB 限制。");
    }
    const bytes = await fs.readFile(realPath);
    if (bytes.byteLength > MAX_SELFIE_REFERENCE_BYTES) {
      throw new AdminApiError(413, "SELFIE_REFERENCE_TOO_LARGE", "自拍参考图超过 8 MiB 限制。");
    }
    const decoded = await decodeImage(bytes);
    const requestedExtension = path.extname(entry.name).toLowerCase();
    if (!extensionMatchesFormat(requestedExtension, decoded.format)) {
      throw new AdminApiError(415, "SELFIE_REFERENCE_TYPE_MISMATCH", "文件扩展名与图片格式不一致。");
    }
    images.push({
      id: sha256(bytes),
      fileName: entry.name,
      sizeBytes: bytes.byteLength,
      width: decoded.width,
      height: decoded.height,
      updatedAt: stats.mtime.toISOString(),
      bytes,
      contentType: decoded.contentType,
      filePath: realPath
    });
  }
  return images;
}

async function decodeImage(bytes: Buffer): Promise<DecodedImage> {
  try {
    const metadata = await sharp(bytes, sharpOptions()).metadata();
    if (!metadata.width || !metadata.height || (metadata.format !== "png" && metadata.format !== "jpeg" && metadata.format !== "webp")) {
      throw new Error("unsupported image");
    }
    await sharp(bytes, sharpOptions())
      .resize({ width: 1, height: 1, fit: "fill" })
      .png()
      .toBuffer();
    const contentType: SelfieReferenceContent["contentType"] = metadata.format === "jpeg"
      ? "image/jpeg"
      : metadata.format === "png"
        ? "image/png"
        : "image/webp";
    return {
      format: metadata.format,
      contentType,
      width: metadata.width,
      height: metadata.height
    };
  } catch {
    throw new AdminApiError(415, "SELFIE_REFERENCE_INVALID_IMAGE", "自拍参考图无法解码。", "dataBase64");
  }
}

function sharpOptions() {
  return {
    animated: false,
    page: 0,
    pages: 1,
    failOn: "error" as const,
    limitInputPixels: IMAGE_INPUT_PIXEL_LIMIT
  };
}

function extensionMatchesFormat(extension: string, format: "png" | "jpeg" | "webp") {
  if (format === "jpeg") return extension === ".jpg" || extension === ".jpeg";
  return extension === `.${format}`;
}

function safeFileStem(value: string) {
  const normalized = value
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return [...normalized].slice(0, 48).join("") || "reference";
}

function decodedBase64Size(value: string) {
  if (value.length % 4 !== 0) return Number.POSITIVE_INFINITY;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isStrictBase64(value: string) {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 || code === 47;
    if (!valid) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function publicMetadata(image: StoredSelfieReference): SelfieReferenceImage {
  return {
    id: image.id,
    fileName: image.fileName,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    updatedAt: image.updatedAt
  };
}

function assertReferenceId(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    badRequest("SELFIE_REFERENCE_ID_INVALID", "自拍参考图 ID 无效。", "id");
  }
}

async function assertPathIsNotSymlink(filePath: string, allowMissing = false) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) badRequest("SELFIE_REFERENCE_PATH_INVALID", "自拍参考图不能使用符号链接。");
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function assertInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return;
  badRequest("SELFIE_REFERENCE_PATH_INVALID", "自拍参考图路径无效。");
}

async function atomicWrite(filePath: string, bytes: Buffer) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sha256(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
