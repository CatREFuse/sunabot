import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_SELFIE_STORED_REFERENCE_IMAGES = 9;
export const MAX_SELFIE_REFERENCE_BYTES = 8 * 1024 * 1024;
export const MAX_SELFIE_REFERENCE_NOTE_LENGTH = 120;
export const SELFIE_REFERENCE_MANIFEST_FILE = "references.jsonl";
export const LEGACY_SELFIE_REFERENCE_MANIFEST_FILE = "references.json";

const MAX_MANIFEST_BYTES = 64 * 1024;
const REFERENCE_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface SelfieReferenceIdentity {
  id: string;
  fileName: string;
}

export interface SelfieReferenceCatalogEntry extends SelfieReferenceIdentity {
  note: string;
}

export interface LoadedSelfieReferenceCatalog {
  references: SelfieReferenceCatalogEntry[];
  needsWrite: boolean;
}

export interface SelfieReferenceManifest {
  schemaVersion: 1;
  references: SelfieReferenceCatalogEntry[];
}

export interface ReadSelfieReferenceFile {
  bytes: Buffer;
  stats: Stats;
}

interface LoadedManifestFile {
  manifest?: SelfieReferenceManifest;
  source: "none" | "jsonl" | "legacy" | "both";
}

export class SelfieReferenceCatalogError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SelfieReferenceCatalogError";
  }
}

export function requireSelfieReferenceNote(value: unknown) {
  if (typeof value !== "string" || hasLoneSurrogate(value) || hasControlCharacter(value)) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_NOTE_INVALID", "自拍参考图备注无效。");
  }
  const note = value.normalize("NFC").trim();
  if (!note || [...note].length > MAX_SELFIE_REFERENCE_NOTE_LENGTH) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_NOTE_INVALID", "自拍参考图备注无效。");
  }
  return note;
}

export async function loadSelfieReferenceCatalog(
  directoryPath: string,
  identities: readonly SelfieReferenceIdentity[]
): Promise<LoadedSelfieReferenceCatalog> {
  if (identities.length > MAX_SELFIE_STORED_REFERENCE_IMAGES) {
    throw new SelfieReferenceCatalogError(
      "SELFIE_REFERENCE_LIMIT",
      `自拍参考图最多保留 ${MAX_SELFIE_STORED_REFERENCE_IMAGES} 张。`
    );
  }
  const normalizedIdentities = identities.map(normalizeIdentity);
  const identityIds = new Set<string>();
  for (const identity of normalizedIdentities) {
    if (identityIds.has(identity.id)) {
      throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图 ID 重复。");
    }
    identityIds.add(identity.id);
  }

  const loadedManifest = await readManifest(directoryPath);
  const manifestById = new Map(loadedManifest.manifest?.references.map((entry) => [entry.id, entry]));
  const references = normalizedIdentities.map((identity, index) => {
    const stored = manifestById.get(identity.id);
    return {
      ...identity,
      note: stored?.note ?? deriveLegacySelfieReferenceNote(identity.fileName, index)
    };
  });
  const canonical: SelfieReferenceManifest = { schemaVersion: 1, references };
  return {
    references,
    needsWrite: loadedManifest.source !== "jsonl"
      || JSON.stringify(loadedManifest.manifest) !== JSON.stringify(canonical)
  };
}

export async function readSelfieReferenceManifest(directoryPath: string) {
  return (await readManifest(directoryPath)).manifest;
}

export async function readSelfieReferenceImageFile(filePath: string): Promise<ReadSelfieReferenceFile> {
  const result = await readRegularFileNoFollow(filePath, MAX_SELFIE_REFERENCE_BYTES, {
    invalidCode: "SELFIE_REFERENCE_PATH_INVALID",
    invalidMessage: "自拍参考图必须是普通文件。",
    tooLargeCode: "SELFIE_REFERENCE_TOO_LARGE",
    tooLargeMessage: "自拍参考图超过 8 MiB 限制。"
  });
  if (!result) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_PATH_INVALID", "自拍参考图不存在。");
  }
  return result;
}

export async function writeSelfieReferenceCatalog(
  directoryPath: string,
  references: readonly SelfieReferenceCatalogEntry[]
) {
  if (references.length > MAX_SELFIE_STORED_REFERENCE_IMAGES) {
    throw new SelfieReferenceCatalogError(
      "SELFIE_REFERENCE_LIMIT",
      `自拍参考图最多保留 ${MAX_SELFIE_STORED_REFERENCE_IMAGES} 张。`
    );
  }
  const normalized = references.map((entry) => ({
    ...normalizeIdentity(entry),
    note: requireSelfieReferenceNote(entry.note)
  }));
  const ids = new Set<string>();
  for (const entry of normalized) {
    if (ids.has(entry.id)) {
      throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图 ID 重复。");
    }
    ids.add(entry.id);
  }

  const manifestPath = path.join(directoryPath, SELFIE_REFERENCE_MANIFEST_FILE);
  const legacyManifestPath = path.join(directoryPath, LEGACY_SELFIE_REFERENCE_MANIFEST_FILE);
  await assertManifestTarget(manifestPath, true);
  await assertManifestTarget(legacyManifestPath, true);
  const temporaryPath = path.join(
    directoryPath,
    `.${SELFIE_REFERENCE_MANIFEST_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  const content = normalized.length
    ? `${normalized.map((entry) => JSON.stringify({ schemaVersion: 1, ...entry })).join("\n")}\n`
    : "";
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporaryPath, manifestPath);
    await fs.rm(legacyManifestPath, { force: true }).catch(() => undefined);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function deriveLegacySelfieReferenceNote(fileName: string, index: number) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension)
    .replace(/-[a-f0-9]{64}$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const shortened = [...stem].slice(0, MAX_SELFIE_REFERENCE_NOTE_LENGTH).join("");
  try {
    return requireSelfieReferenceNote(shortened);
  } catch {
    return `参考图 ${index + 1}`;
  }
}

async function readManifest(directoryPath: string): Promise<LoadedManifestFile> {
  const manifestPath = path.join(directoryPath, SELFIE_REFERENCE_MANIFEST_FILE);
  const legacyManifestPath = path.join(directoryPath, LEGACY_SELFIE_REFERENCE_MANIFEST_FILE);
  const readOptions = {
    allowMissing: true,
    invalidCode: "SELFIE_REFERENCE_MANIFEST_INVALID",
    invalidMessage: "自拍参考图备注文件无效。",
    tooLargeCode: "SELFIE_REFERENCE_MANIFEST_INVALID",
    tooLargeMessage: "自拍参考图备注文件过大。"
  } as const;
  const file = await readRegularFileNoFollow(manifestPath, MAX_MANIFEST_BYTES, readOptions);
  const legacyVisible = file ? await assertManifestTarget(legacyManifestPath, true) : undefined;
  const legacyFile = !file || legacyVisible
    ? await readRegularFileNoFollow(legacyManifestPath, MAX_MANIFEST_BYTES, {
      allowMissing: true,
      invalidCode: "SELFIE_REFERENCE_MANIFEST_INVALID",
      invalidMessage: "自拍参考图备注文件无效。",
      tooLargeCode: "SELFIE_REFERENCE_MANIFEST_INVALID",
      tooLargeMessage: "自拍参考图备注文件过大。"
    })
    : undefined;
  const manifest = file ? parseJsonlManifest(file.bytes) : undefined;
  const legacyManifest = legacyFile ? parseLegacyManifest(legacyFile.bytes) : undefined;
  if (
    manifest
    && legacyManifest
    && JSON.stringify(manifest) !== JSON.stringify(legacyManifest)
  ) {
    throw new SelfieReferenceCatalogError(
      "SELFIE_REFERENCE_MANIFEST_CONFLICT",
      "自拍参考图的新旧清单内容冲突。"
    );
  }
  return {
    manifest: manifest ?? legacyManifest,
    source: manifest && legacyManifest
      ? "both"
      : manifest
        ? "jsonl"
        : legacyManifest
          ? "legacy"
          : "none"
  };
}

function parseJsonlManifest(bytes: Buffer): SelfieReferenceManifest {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  if (!content || content === "\n") return { schemaVersion: 1, references: [] };
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (lines.some((line) => !line)) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  const references = lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
    }
    const entry = exactRecord(parsed, ["schemaVersion", "id", "fileName", "note"]);
    if (entry.schemaVersion !== 1) {
      throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
    }
    return parseManifestEntry(entry);
  });
  return validateManifestReferences(references);
}

function parseLegacyManifest(bytes: Buffer): SelfieReferenceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  return parseManifest(parsed);
}

function parseManifest(value: unknown): SelfieReferenceManifest {
  const root = exactRecord(value, ["schemaVersion", "references"]);
  if (
    root.schemaVersion !== 1
    || !Array.isArray(root.references)
    || root.references.length > MAX_SELFIE_STORED_REFERENCE_IMAGES
  ) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  return validateManifestReferences(root.references.map((item) => (
    parseManifestEntry(exactRecord(item, ["id", "fileName", "note"]))
  )));
}

function parseManifestEntry(entry: Record<string, unknown>): SelfieReferenceCatalogEntry {
  try {
    return {
      ...normalizeIdentity(entry),
      note: requireSelfieReferenceNote(entry.note)
    };
  } catch {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
}

function validateManifestReferences(
  references: SelfieReferenceCatalogEntry[]
): SelfieReferenceManifest {
  if (references.length > MAX_SELFIE_STORED_REFERENCE_IMAGES) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  const ids = new Set<string>();
  for (const entry of references) {
    if (ids.has(entry.id)) {
      throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
    }
    ids.add(entry.id);
  }
  return { schemaVersion: 1, references };
}

function normalizeIdentity(value: { id?: unknown; fileName?: unknown }): SelfieReferenceIdentity {
  if (typeof value.id !== "string" || !REFERENCE_ID_PATTERN.test(value.id)) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图 ID 无效。");
  }
  if (
    typeof value.fileName !== "string"
    || !value.fileName
    || value.fileName.length > 240
    || path.basename(value.fileName) !== value.fileName
    || value.fileName.includes("\\")
    || hasLoneSurrogate(value.fileName)
    || hasControlCharacter(value.fileName)
  ) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图文件名无效。");
  }
  return { id: value.id, fileName: value.fileName.normalize("NFC") };
}

function exactRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
  }
  return record;
}

async function assertManifestTarget(filePath: string, allowMissing: boolean) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new SelfieReferenceCatalogError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注文件无效。");
    }
    return stats;
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (!allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRegularFileNoFollow(
  filePath: string,
  maxBytes: number,
  options: {
    allowMissing?: boolean;
    invalidCode: string;
    invalidMessage: string;
    tooLargeCode: string;
    tooLargeMessage: string;
  }
): Promise<ReadSelfieReferenceFile | undefined> {
  const noFollowFlag: unknown = Reflect.get(fsConstants, "O_NOFOLLOW");
  if (typeof noFollowFlag !== "number" || !Number.isSafeInteger(noFollowFlag) || noFollowFlag <= 0) {
    throw new SelfieReferenceCatalogError(
      "SELFIE_REFERENCE_NOFOLLOW_UNAVAILABLE",
      "当前平台不支持安全读取自拍参考图。"
    );
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (options.allowMissing && code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EISDIR" || code === "ENOENT") {
      throw new SelfieReferenceCatalogError(options.invalidCode, options.invalidMessage);
    }
    throw error;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0) {
      throw new SelfieReferenceCatalogError(options.invalidCode, options.invalidMessage);
    }
    if (before.size > maxBytes) {
      throw new SelfieReferenceCatalogError(options.tooLargeCode, options.tooLargeMessage);
    }

    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size
      || !sameOpenFile(before, after)
      || after.size > maxBytes
    ) {
      throw new SelfieReferenceCatalogError(options.invalidCode, options.invalidMessage);
    }

    let visible: Stats;
    try {
      visible = await fs.lstat(filePath);
    } catch {
      throw new SelfieReferenceCatalogError(options.invalidCode, options.invalidMessage);
    }
    if (visible.isSymbolicLink() || !visible.isFile() || visible.dev !== before.dev || visible.ino !== before.ino) {
      throw new SelfieReferenceCatalogError(options.invalidCode, options.invalidMessage);
    }
    return { bytes: buffer.subarray(0, offset), stats: before };
  } finally {
    await handle.close();
  }
}

function sameOpenFile(before: Stats, after: Stats) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function hasLoneSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
