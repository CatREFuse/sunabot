import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import {
  type EmojiRecord,
  type EmojiVersionRecord
} from "../../adapters/sqlite/applicationDataStore.js";
import {
  MAX_AGENT_EMOJIS,
  PRESET_EMOJI_KEYS,
  isEmojiFileName,
  isValidEmojiKey,
  normalizeEmojiKey
} from "../../services/emojis/emojiCatalog.js";
import {
  EmojiNormalizationBusyError,
  EmojiNormalizationGate
} from "../../services/emojis/emojiOperationGate.js";
import {
  filterVerifiedEmojiRecords,
  readVerifiedEmojiRecordFile
} from "../emojis/emojiAssets.js";
import { emojiMediaLocation, emojiStore } from "../emojis/emojiStore.js";
import { loadConfig } from "../config.js";
import type { AppConfig, ImageResult } from "../types.js";
import { AdminApiError, badRequest, conflict, notFound } from "./errors.js";
import {
  readGeneratedEmojiImage,
  writeContentAddressedEmojiPng,
  type EmojiLibraryOperationHooks
} from "./emojiFileIo.js";
import { adminMutationMutex, type AdminMutationMutex } from "./mutation.js";

export type { EmojiLibraryOperationHooks } from "./emojiFileIo.js";

export const MAX_EMOJI_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_EMOJI_VERSIONS_PER_KEY = 20;
const MAX_BASE64_LENGTH = Math.ceil(MAX_EMOJI_UPLOAD_BYTES / 3) * 4;
const IMAGE_INPUT_PIXEL_LIMIT = 64_000_000;
const SUPPORTED_IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
] as const);

export type EmojiImageVariant = "original" | "display" | "placeholder";

export interface EmojiEnvelope {
  presetKeys: readonly string[];
  emojis: EmojiRecord[];
}

export interface EmojiContent {
  bytes: Buffer;
  contentType: "image/png" | "image/webp";
}

export interface EmojiVersionEnvelope {
  key: string;
  versions: EmojiVersionRecord[];
}

export interface EmojiLibraryOptions {
  getConfig?: () => AppConfig | Promise<AppConfig>;
  mutex?: AdminMutationMutex;
  normalizationGate?: EmojiNormalizationGate;
  hooks?: EmojiLibraryOperationHooks;
}

const emojiNormalizationGate = new EmojiNormalizationGate();

export class EmojiLibraryRepository {
  private readonly getConfig: () => AppConfig | Promise<AppConfig>;
  private readonly mutex: AdminMutationMutex;
  private readonly normalizationGate: EmojiNormalizationGate;
  private readonly hooks: EmojiLibraryOperationHooks;

  constructor(options: EmojiLibraryOptions = {}) {
    this.getConfig = options.getConfig ?? loadConfig;
    this.mutex = options.mutex ?? adminMutationMutex;
    this.normalizationGate = options.normalizationGate ?? emojiNormalizationGate;
    this.hooks = options.hooks ?? {};
  }

  async list(): Promise<EmojiEnvelope> {
    const config = await this.getConfig();
    return envelope(await filterVerifiedEmojiRecords(config));
  }

  async upload(input: unknown): Promise<EmojiEnvelope> {
    const config = await this.getConfig();
    return this.withNormalizationAdmission(config, async () => {
      const parsed = await parseUpload(input);
      return this.saveAdmitted(parsed.key, parsed.bytes, "upload", config);
    });
  }

  async importBytes(keyInput: unknown, bytes: Buffer): Promise<EmojiEnvelope> {
    const key = requireEmojiKey(keyInput);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_EMOJI_UPLOAD_BYTES) {
      throw new AdminApiError(413, "EMOJI_IMAGE_TOO_LARGE", "表情图片超过 8 MiB 限制。");
    }
    const config = await this.getConfig();
    return this.withNormalizationAdmission(config, () => (
      this.saveAdmitted(key, Buffer.from(bytes), "upload", config)
    ));
  }

  async bindGenerated(keyInput: unknown, image: ImageResult): Promise<EmojiEnvelope> {
    const key = requireEmojiKey(keyInput);
    const config = await this.getConfig();
    return this.withNormalizationAdmission(config, async () => {
      const bytes = await readGeneratedEmojiImage(config, image, this.hooks);
      return this.saveAdmitted(key, bytes, "generated", config);
    });
  }

  async remove(keyInput: unknown) {
    const key = requireEmojiKey(keyInput);
    const config = await this.getConfig();
    return this.mutex.runExclusive(async () => {
      if (!await emojiStore(config).delete(key)) {
        notFound("EMOJI_NOT_FOUND", "表情不存在。");
      }
    });
  }

  async rename(keyInput: unknown, nextKeyInput: unknown): Promise<EmojiEnvelope> {
    const key = requireEmojiKey(keyInput);
    const nextKey = requireEmojiKey(nextKeyInput);
    const config = await this.getConfig();
    return this.mutex.runExclusive(async () => {
      const result = await emojiStore(config).rename(key, nextKey, new Date().toISOString());
      if (result === "missing") notFound("EMOJI_NOT_FOUND", "表情不存在。");
      if (result === "conflict") conflict("EMOJI_KEY_CONFLICT", "该表情 key 已存在。");
      return envelope(await filterVerifiedEmojiRecords(config));
    });
  }

  async listVersions(keyInput: unknown): Promise<EmojiVersionEnvelope> {
    const key = requireEmojiKey(keyInput);
    const config = await this.getConfig();
    const store = emojiStore(config);
    if (!store.read(key)) notFound("EMOJI_NOT_FOUND", "表情不存在。");
    const versions = await filterVerifiedEmojiRecords(config, store.readVersions(key));
    const currentFileName = store.read(key)?.fileName;
    return {
      key,
      versions: versions.map((version) => ({
        ...version,
        current: version.fileName === currentFileName
      }))
    };
  }

  async removeVersion(keyInput: unknown, fileNameInput: unknown) {
    const key = requireEmojiKey(keyInput);
    const fileName = requireEmojiFileName(fileNameInput);
    const config = await this.getConfig();
    return this.mutex.runExclusive(async () => {
      const result = await emojiStore(config).deleteVersion(key, fileName);
      if (result === "missing") notFound("EMOJI_VERSION_NOT_FOUND", "表情版本不存在。");
      if (result === "current") conflict("EMOJI_VERSION_CURRENT", "当前版本不能删除。");
    });
  }

  async content(
    keyInput: unknown,
    variant: EmojiImageVariant,
    expectedFileName?: unknown
  ): Promise<EmojiContent> {
    const key = requireEmojiKey(keyInput);
    const config = await this.getConfig();
    const record = emojiStore(config).read(key);
    if (!record) notFound("EMOJI_NOT_FOUND", "表情不存在。");
    if (expectedFileName !== undefined) {
      const version = String(expectedFileName);
      if (!isEmojiFileName(version)) {
        badRequest("EMOJI_CONTENT_VERSION_INVALID", "表情图片版本无效。", "v");
      }
      if (record.fileName !== version) {
        conflict("EMOJI_CONTENT_VERSION_MISMATCH", "表情图片版本已更新。");
      }
    }
    return this.contentFromRecord(config, record, variant);
  }

  async versionContent(
    keyInput: unknown,
    fileNameInput: unknown,
    variant: EmojiImageVariant
  ): Promise<EmojiContent> {
    const key = requireEmojiKey(keyInput);
    const fileName = requireEmojiFileName(fileNameInput);
    const config = await this.getConfig();
    const record = emojiStore(config).readVersion(key, fileName);
    if (!record) notFound("EMOJI_VERSION_NOT_FOUND", "表情版本不存在。");
    return this.contentFromRecord(config, record, variant);
  }

  private async contentFromRecord(
    config: AppConfig,
    record: EmojiRecord,
    variant: EmojiImageVariant
  ): Promise<EmojiContent> {
    let bytes: Buffer;
    try {
      bytes = await readVerifiedEmojiRecordFile(config, record);
    } catch {
      throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
    }
    await assertStoredEmojiPng(bytes, record);
    if (variant === "original") return { bytes, contentType: "image/png" };
    try {
      const resized = await sharp(bytes, sharpOptions())
        .resize({
          width: variant === "placeholder" ? 32 : 640,
          height: variant === "placeholder" ? 32 : 640,
          fit: "cover"
        })
        .webp({ quality: variant === "placeholder" ? 24 : 78, effort: 4 })
        .toBuffer();
      return { bytes: resized, contentType: "image/webp" };
    } catch {
      throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
    }
  }

  private async withNormalizationAdmission<T>(
    config: AppConfig,
    operation: () => Promise<T>
  ): Promise<T> {
    const agentId = config.persona.defaultAgentId.trim() || "plana";
    const admission = this.normalizationGate.tryAcquire(agentId);
    if (!admission.ok) throw new EmojiNormalizationBusyError();
    try {
      return await operation();
    } finally {
      admission.release();
    }
  }

  private async saveAdmitted(
    key: string,
    sourceBytes: Buffer,
    source: EmojiRecord["source"],
    config: AppConfig
  ): Promise<EmojiEnvelope> {
    const normalized = await normalizeSquarePng(sourceBytes);
    const hash = crypto.createHash("sha256").update(normalized.bytes).digest("hex");
    const fileName = `emoji-${hash}.png`;
    return this.mutex.runExclusive(async () => {
      const store = emojiStore(config);
      const existing = store.read(key);
      if (!existing && store.readAll().length >= MAX_AGENT_EMOJIS) {
        conflict("EMOJI_LIMIT_REACHED", `表情最多保留 ${MAX_AGENT_EMOJIS} 个。`);
      }
      if (
        existing
        && existing.fileName !== fileName
        && store.readVersions(key).length >= MAX_EMOJI_VERSIONS_PER_KEY
      ) {
        conflict("EMOJI_VERSION_LIMIT_REACHED", `每个表情最多保留 ${MAX_EMOJI_VERSIONS_PER_KEY} 个版本，请先删除旧版本。`);
      }
      const location = emojiMediaLocation(config, fileName);
      await writeContentAddressedEmojiPng(location.filePath, normalized.bytes, hash, this.hooks);
      const now = new Date().toISOString();
      await store.upsert({
        key,
        fileName,
        source,
        sizeBytes: normalized.bytes.byteLength,
        width: normalized.width,
        height: normalized.height,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
      return envelope(await filterVerifiedEmojiRecords(config));
    });
  }
}

function envelope(emojis: EmojiRecord[]): EmojiEnvelope {
  return { presetKeys: PRESET_EMOJI_KEYS, emojis };
}

async function parseUpload(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("EMOJI_UPLOAD_INVALID", "请求体必须是对象。");
  }
  const body = input as Record<string, unknown>;
  const extra = Object.keys(body).find((key) => !["key", "fileName", "dataBase64"].includes(key));
  if (extra) badRequest("EMOJI_UPLOAD_INVALID", "包含不支持的字段。", extra);
  const key = requireEmojiKey(body.key);
  const fileName = String(body.fileName ?? "").trim().normalize("NFC");
  if (!fileName || fileName.length > 160 || fileName.includes("\0") || path.basename(fileName) !== fileName) {
    badRequest("EMOJI_UPLOAD_INVALID", "文件名无效。", "fileName");
  }
  const expectedMime = SUPPORTED_IMAGE_TYPES.get(path.extname(fileName).toLowerCase() as ".png" | ".jpg" | ".jpeg" | ".webp");
  if (!expectedMime) {
    throw new AdminApiError(415, "EMOJI_IMAGE_UNSUPPORTED", "仅支持 PNG、JPEG 和 WebP 图片。", "fileName");
  }
  if (typeof body.dataBase64 !== "string" || !body.dataBase64 || body.dataBase64.length > MAX_BASE64_LENGTH) {
    throw new AdminApiError(413, "EMOJI_IMAGE_TOO_LARGE", "表情图片超过 8 MiB 限制。", "dataBase64");
  }
  if (!isCanonicalBase64(body.dataBase64)) {
    badRequest("EMOJI_BASE64_INVALID", "图片 Base64 数据无效。", "dataBase64");
  }
  const bytes = Buffer.from(body.dataBase64, "base64");
  if (!bytes.length || bytes.byteLength > MAX_EMOJI_UPLOAD_BYTES || bytes.toString("base64") !== body.dataBase64) {
    throw new AdminApiError(413, "EMOJI_IMAGE_TOO_LARGE", "表情图片超过 8 MiB 限制。", "dataBase64");
  }
  const detected = await fileTypeFromBuffer(bytes);
  if (detected?.mime !== expectedMime) {
    throw new AdminApiError(415, "EMOJI_IMAGE_UNSUPPORTED", "图片格式与文件名不一致。", "fileName");
  }
  return { key, bytes };
}

function requireEmojiKey(value: unknown) {
  const raw = String(value ?? "");
  const key = normalizeEmojiKey(raw);
  if (!isValidEmojiKey(raw)) {
    badRequest("EMOJI_KEY_INVALID", "表情 key 需为 1 至 24 个字符，且不能包含括号、斜杠或控制字符。", "key");
  }
  return key;
}

function requireEmojiFileName(value: unknown) {
  const fileName = String(value ?? "");
  if (!isEmojiFileName(fileName)) {
    badRequest("EMOJI_CONTENT_VERSION_INVALID", "表情图片版本无效。", "fileName");
  }
  return fileName;
}

async function normalizeSquarePng(bytes: Buffer) {
  try {
    const result = await sharp(bytes, sharpOptions())
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "cover", position: "attention" })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height };
  } catch {
    throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。", "dataBase64");
  }
}

async function assertStoredEmojiPng(bytes: Buffer, record: EmojiRecord) {
  try {
    const [detected, metadata] = await Promise.all([
      fileTypeFromBuffer(bytes),
      sharp(bytes, sharpOptions()).metadata()
    ]);
    if (detected?.mime !== "image/png"
      || metadata.format !== "png"
      || metadata.width !== record.width
      || metadata.height !== record.height
      || bytes.byteLength !== record.sizeBytes) {
      throw new Error("Stored emoji metadata mismatch.");
    }
  } catch {
    throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
  }
}

function isCanonicalBase64(value: string) {
  return value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    && Buffer.from(value, "base64").toString("base64") === value;
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
