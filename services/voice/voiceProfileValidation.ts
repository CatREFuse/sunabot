import path from "node:path";
import { detectVoiceAudio, type DetectedVoiceAudio } from "./audio.js";
import { decodeStrictBase64, StrictBase64Error } from "./strictBase64.js";
import {
  MAX_VOICE_REFERENCE_BYTES,
  MAX_VOICE_REFERENCE_TEXT_CHARS,
  MAX_VOICE_SOURCE_URL_CHARS,
  VOICE_LANGUAGES,
  VoiceProfileError,
  type VoiceLanguage,
  type VoiceProfileSettingsInput,
  type VoiceProfileV1,
  type VoiceReferenceMetadata,
  type VoiceReferenceUpload,
} from "./types.js";

export const VOICE_DIRECTORY = "voice";
export const REFERENCE_DIRECTORY = "references";
export const PROFILE_FILE = "profile.json";
export const MAX_PROFILE_BYTES = 64 * 1024;

const MAX_FILE_NAME_BYTES = 240;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MIME_PATTERN = /^audio\/[a-z0-9][a-z0-9.+-]{0,63}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface ParsedVoiceReferenceUpload {
  language: VoiceLanguage;
  fileName: string;
  referenceText: string;
  sourceUrl?: string;
  characterUrl?: string;
  bytes: Buffer;
  detected: DetectedVoiceAudio;
  updatedAt: string;
}

export async function parseVoiceReferenceUpload(
  input: VoiceReferenceUpload,
  now: () => Date,
): Promise<ParsedVoiceReferenceUpload> {
  const value = exactObject(
    input,
    ["language", "fileName", "dataBase64", "referenceText"],
    ["sourceUrl", "characterUrl"],
    "VOICE_REFERENCE_INVALID",
    "参考音频请求无效。",
  );
  const language = parseVoiceLanguage(value.language);
  const fileName = parseFileName(value.fileName);
  const referenceText = parseReferenceText(value.referenceText);
  const sourceUrl = parseOptionalHttpsUrl(value.sourceUrl);
  const characterUrl = parseOptionalHttpsUrl(value.characterUrl);
  let bytes: Buffer;
  try {
    bytes = decodeStrictBase64(value.dataBase64, MAX_VOICE_REFERENCE_BYTES);
  } catch (error) {
    if (error instanceof StrictBase64Error) {
      if (error.reason === "too_large") {
        throw new VoiceProfileError(
          "VOICE_REFERENCE_TOO_LARGE",
          "参考音频不能超过 8 MiB。",
          413,
        );
      }
      throw new VoiceProfileError(
        "VOICE_REFERENCE_BASE64_INVALID",
        "参考音频数据无效。",
        400,
      );
    }
    throw error;
  }
  const detected = await detectVoiceAudio(bytes);
  if (!detected) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_TYPE_UNSUPPORTED",
      "参考音频格式不受支持。",
      415,
    );
  }
  const timestamp = now();
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
    throw new VoiceProfileError(
      "VOICE_PROFILE_INVALID",
      "语音配置时间无效。",
      500,
    );
  }
  return {
    language,
    fileName,
    referenceText,
    sourceUrl,
    characterUrl,
    bytes,
    detected,
    updatedAt: timestamp.toISOString(),
  };
}

export function parseVoiceProfile(input: unknown): VoiceProfileV1 {
  const value = exactObject(
    input,
    ["schemaVersion", "enabled", "defaultLanguage", "languages"],
    [],
    "VOICE_PROFILE_INVALID",
    "语音配置文件无效。",
  );
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") {
    throw new VoiceProfileError(
      "VOICE_PROFILE_INVALID",
      "语音配置文件无效。",
      500,
    );
  }
  const defaultLanguage = parseStoredLanguage(value.defaultLanguage);
  const languagesObject = exactObject(
    value.languages,
    [...VOICE_LANGUAGES],
    [],
    "VOICE_PROFILE_INVALID",
    "语音配置文件无效。",
  );
  const languages = Object.fromEntries(
    VOICE_LANGUAGES.map((language) => {
      const metadata = languagesObject[language];
      return [
        language,
        metadata === null ? null : parseMetadata(metadata, language),
      ];
    }),
  ) as Record<VoiceLanguage, VoiceReferenceMetadata | null>;
  if (value.enabled && !languages[defaultLanguage]) {
    throw new VoiceProfileError(
      "VOICE_PROFILE_INVALID",
      "已启用的默认语言缺少参考音频。",
      500,
    );
  }
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    defaultLanguage,
    languages,
  };
}

export function parseVoiceProfileSettings(
  input: VoiceProfileSettingsInput,
): VoiceProfileSettingsInput {
  const value = exactObject(
    input,
    ["enabled", "defaultLanguage"],
    [],
    "VOICE_PROFILE_INVALID",
    "语音设置无效。",
    400,
  );
  if (typeof value.enabled !== "boolean") {
    throw new VoiceProfileError("VOICE_PROFILE_INVALID", "语音设置无效。", 400);
  }
  return {
    enabled: value.enabled,
    defaultLanguage: parseVoiceLanguage(value.defaultLanguage),
  };
}

export function parseVoiceLanguage(value: unknown): VoiceLanguage {
  if (
    typeof value === "string" &&
    (VOICE_LANGUAGES as readonly string[]).includes(value)
  ) {
    return value as VoiceLanguage;
  }
  throw new VoiceProfileError("VOICE_LANGUAGE_INVALID", "语音语言无效。", 400);
}

export function parseStoredRelativePath(value: unknown, sha256: string) {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) {
    return storedProfileFailure();
  }
  const segments = value.split("/");
  const fileName = segments[2];
  if (
    segments.length !== 3 ||
    segments[0] !== VOICE_DIRECTORY ||
    segments[1] !== REFERENCE_DIRECTORY ||
    !fileName ||
    !new RegExp(
      `^[a-z0-9][a-z0-9._-]{0,79}-${sha256}\\.[a-z0-9]{1,10}$`,
      "u",
    ).test(fileName)
  ) {
    return storedProfileFailure();
  }
  return value;
}

export function profileUsesRelativePath(
  profile: VoiceProfileV1,
  relativePath: string,
) {
  return VOICE_LANGUAGES.some(
    (language) => profile.languages[language]?.relativePath === relativePath,
  );
}

export function safeVoiceReferenceStem(fileName: string) {
  const extension = path.extname(fileName);
  const base = fileName.slice(0, extension ? -extension.length : undefined);
  const stem = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return stem || "reference";
}

function parseMetadata(
  input: unknown,
  expectedLanguage: VoiceLanguage,
): VoiceReferenceMetadata {
  const value = exactObject(
    input,
    [
      "language",
      "fileName",
      "relativePath",
      "mimeType",
      "sizeBytes",
      "sha256",
      "referenceText",
      "updatedAt",
    ],
    ["sourceUrl", "characterUrl"],
    "VOICE_PROFILE_INVALID",
    "语音配置文件无效。",
  );
  const language = parseStoredLanguage(value.language);
  if (language !== expectedLanguage) {
    throw new VoiceProfileError(
      "VOICE_PROFILE_INVALID",
      "语音配置文件无效。",
      500,
    );
  }
  const fileName = parseFileName(value.fileName, true);
  const sha256 =
    typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
      ? value.sha256
      : storedProfileFailure();
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) <= 0 ||
    (value.sizeBytes as number) > MAX_VOICE_REFERENCE_BYTES
  ) {
    storedProfileFailure();
  }
  if (typeof value.mimeType !== "string" || !MIME_PATTERN.test(value.mimeType))
    storedProfileFailure();
  const relativePath = parseStoredRelativePath(value.relativePath, sha256);
  const referenceText = parseReferenceText(value.referenceText, true);
  const sourceUrl = parseOptionalHttpsUrl(value.sourceUrl, true);
  const characterUrl = parseOptionalHttpsUrl(value.characterUrl, true);
  if (
    typeof value.updatedAt !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value.updatedAt) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt
  ) {
    storedProfileFailure();
  }
  return {
    language,
    fileName,
    relativePath,
    mimeType: value.mimeType as string,
    sizeBytes: value.sizeBytes as number,
    sha256,
    referenceText,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(characterUrl ? { characterUrl } : {}),
    updatedAt: value.updatedAt,
  };
}

function parseStoredLanguage(value: unknown): VoiceLanguage {
  try {
    return parseVoiceLanguage(value);
  } catch {
    return storedProfileFailure();
  }
}

function parseFileName(value: unknown, stored = false) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") > MAX_FILE_NAME_BYTES ||
    value === "." ||
    value === ".." ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF/\\]/u.test(value)
  ) {
    if (stored) storedProfileFailure();
    throw new VoiceProfileError(
      "VOICE_REFERENCE_FILE_NAME_INVALID",
      "参考音频文件名无效。",
      400,
    );
  }
  return value;
}

function parseReferenceText(value: unknown, stored = false) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.normalize("NFC") !== value ||
    [...value].length > MAX_VOICE_REFERENCE_TEXT_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
  ) {
    if (stored) storedProfileFailure();
    throw new VoiceProfileError(
      "VOICE_REFERENCE_TEXT_INVALID",
      "参考音频文本无效。",
      400,
    );
  }
  return value;
}

function parseOptionalHttpsUrl(
  value: unknown,
  stored = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > MAX_VOICE_SOURCE_URL_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
  ) {
    if (stored) storedProfileFailure();
    throw new VoiceProfileError(
      "VOICE_REFERENCE_URL_INVALID",
      "参考音频来源链接无效。",
      400,
    );
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    )
      throw new Error();
  } catch {
    if (stored) storedProfileFailure();
    throw new VoiceProfileError(
      "VOICE_REFERENCE_URL_INVALID",
      "参考音频来源链接无效。",
      400,
    );
  }
  return value;
}

function storedProfileFailure(): never {
  throw new VoiceProfileError(
    "VOICE_PROFILE_INVALID",
    "语音配置文件无效。",
    500,
  );
}

function exactObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: "VOICE_PROFILE_INVALID" | "VOICE_REFERENCE_INVALID",
  message: string,
  status?: 400 | 500,
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new VoiceProfileError(
      code,
      message,
      status ?? (code === "VOICE_PROFILE_INVALID" ? 500 : 400),
    );
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new VoiceProfileError(
      code,
      message,
      status ?? (code === "VOICE_PROFILE_INVALID" ? 500 : 400),
    );
  }
  return value;
}
