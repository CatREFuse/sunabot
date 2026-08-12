import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parentBoundAtomicReplace } from "./parentBoundFs.js";
import {
  isEmojiFileName,
  isValidEmojiKey,
  normalizeEmojiKey
} from "../../services/emojis/emojiCatalog.js";
import type {
  EmojiRecord,
  EmojiVersionRecord
} from "../sqlite/emojiStore.js";

const CATALOG_SCHEMA_VERSION = 1;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_EMOJI_KEYS = 64;
const MAX_VERSIONS_PER_KEY = 20;
const CATALOG_KEYS = new Set([
  "schemaVersion",
  "key",
  "createdAt",
  "updatedAt",
  "currentFileName",
  "versions"
]);
const VERSION_KEYS = new Set([
  "fileName",
  "source",
  "sizeBytes",
  "width",
  "height",
  "createdAt"
]);

interface EmojiCatalogVersion {
  fileName: string;
  source: EmojiRecord["source"];
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: string;
}

interface EmojiCatalogEntry {
  schemaVersion: 1;
  key: string;
  createdAt: string;
  updatedAt: string;
  currentFileName: string;
  versions: EmojiCatalogVersion[];
}

export interface LegacyEmojiCatalog {
  current: EmojiRecord[];
  versions: (key: string) => EmojiVersionRecord[];
}

export class EmojiJsonlStore {
  private cache?: EmojiCatalogEntry[];
  private cacheFingerprint?: string;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly catalogPath: string,
    private readonly legacy?: LegacyEmojiCatalog
  ) {}

  readAll(): EmojiRecord[] {
    return this.readEntries()
      .map((entry) => currentRecord(entry))
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key)
      ));
  }

  read(key: string): EmojiRecord | undefined {
    if (!validStoredKey(key)) return undefined;
    const entry = this.readEntries().find((candidate) => candidate.key === key);
    return entry ? currentRecord(entry) : undefined;
  }

  readVersions(key: string): EmojiVersionRecord[] {
    if (!validStoredKey(key)) return [];
    const entry = this.readEntries().find((candidate) => candidate.key === key);
    if (!entry) return [];
    return entry.versions
      .map((version) => ({
        key: entry.key,
        fileName: version.fileName,
        source: version.source,
        sizeBytes: version.sizeBytes,
        width: version.width,
        height: version.height,
        createdAt: entry.createdAt,
        updatedAt: version.createdAt,
        current: version.fileName === entry.currentFileName
      }))
      .sort((left, right) => (
        Number(right.current) - Number(left.current)
        || right.updatedAt.localeCompare(left.updatedAt)
        || left.fileName.localeCompare(right.fileName)
      ));
  }

  readVersion(key: string, fileName: string) {
    return this.readVersions(key).find((version) => version.fileName === fileName);
  }

  async upsert(record: EmojiRecord) {
    return this.mutate(async () => {
      assertRecord(record);
      const entries = this.readEntries();
      const existing = entries.find((entry) => entry.key === record.key);
      if (!existing) {
        if (entries.length >= MAX_EMOJI_KEYS) throw new Error("Emoji catalog key limit reached.");
        entries.push({
          schemaVersion: CATALOG_SCHEMA_VERSION,
          key: record.key,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          currentFileName: record.fileName,
          versions: [catalogVersion(record)]
        });
      } else {
        const version = existing.versions.find((candidate) => candidate.fileName === record.fileName);
        if (!version) {
          if (existing.versions.length >= MAX_VERSIONS_PER_KEY) {
            throw new Error("Emoji catalog version limit reached.");
          }
          existing.versions.push(catalogVersion(record));
        }
        existing.currentFileName = record.fileName;
        existing.updatedAt = record.updatedAt;
      }
      await this.writeEntriesBound(entries);
    });
  }

  async rename(
    currentKey: string,
    nextKey: string,
    updatedAt: string
  ): Promise<"renamed" | "missing" | "conflict"> {
    return this.mutate(async () => {
      if (!validStoredKey(currentKey) || !validStoredKey(nextKey) || !validTimestamp(updatedAt)) {
        throw new Error("Emoji key is invalid.");
      }
      const entries = this.readEntries();
      const current = entries.find((entry) => entry.key === currentKey);
      if (!current) return "missing";
      if (currentKey !== nextKey && entries.some((entry) => entry.key === nextKey)) return "conflict";
      current.key = nextKey;
      current.updatedAt = updatedAt;
      await this.writeEntriesBound(entries);
      return "renamed";
    });
  }

  async deleteVersion(
    key: string,
    fileName: string
  ): Promise<"deleted" | "missing" | "current"> {
    return this.mutate(async () => {
      const entries = this.readEntries();
      const entry = entries.find((candidate) => candidate.key === key);
      const version = entry?.versions.find((candidate) => candidate.fileName === fileName);
      if (!entry || !version) return "missing";
      if (entry.currentFileName === fileName) return "current";
      entry.versions = entry.versions.filter((candidate) => candidate.fileName !== fileName);
      await this.writeEntriesBound(entries);
      return "deleted";
    });
  }

  async delete(key: string) {
    return this.mutate(async () => {
      const entries = this.readEntries();
      const next = entries.filter((entry) => entry.key !== key);
      if (next.length === entries.length) return false;
      await this.writeEntriesBound(next);
      return true;
    });
  }

  private readEntries(): EmojiCatalogEntry[] {
    if (this.cache) {
      const fingerprint = catalogFingerprintIfPresent(this.catalogPath);
      if (fingerprint === this.cacheFingerprint) return cloneEntries(this.cache);
      this.cache = undefined;
      this.cacheFingerprint = undefined;
      if (!fingerprint && this.initialized) {
        this.cache = [];
        return [];
      }
    }
    if (!this.ensureCatalog()) {
      this.cache = [];
      this.initialized = true;
      return [];
    }
    const bytes = readCatalogBytes(this.catalogPath);
    if (!bytes.length) {
      this.cache = [];
      this.cacheFingerprint = catalogFingerprintIfPresent(this.catalogPath);
      this.initialized = true;
      return [];
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const entries = text.split("\n").flatMap((line, index) => {
      if (!line) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Emoji catalog line ${index + 1} is invalid JSON.`);
      }
      return [parseEntry(parsed, index + 1)];
    });
    assertCatalog(entries);
    this.cache = cloneEntries(entries);
    this.cacheFingerprint = catalogFingerprintIfPresent(this.catalogPath);
    this.initialized = true;
    return cloneEntries(entries);
  }

  private ensureCatalog() {
    const existing = lstatIfPresent(this.catalogPath);
    if (existing) {
      assertRegularCatalogFile(existing);
      return true;
    }
    const entries = legacyEntries(this.legacy);
    if (this.initialized) return false;
    if (!entries.length) return false;
    this.writeEntries(entries, true);
    return true;
  }

  private writeEntries(entries: EmojiCatalogEntry[], createOnly = false) {
    const directory = path.dirname(this.catalogPath);
    ensureRegularDirectory(directory);
    const content = serializeEntries(entries);
    if (createOnly && lstatIfPresent(this.catalogPath)) return;
    writeCatalogAtomically(this.catalogPath, content);
    this.cache = cloneEntries(entries);
    this.cacheFingerprint = catalogFingerprintIfPresent(this.catalogPath);
    this.initialized = true;
  }

  private async writeEntriesBound(entries: EmojiCatalogEntry[]) {
    const content = serializeEntries(entries);
    const directory = path.dirname(this.catalogPath);
    ensureRegularDirectory(directory);
    const realDirectory = await fsp.realpath(directory);
    const realCatalogPath = path.join(realDirectory, path.basename(this.catalogPath));
    const [parentStats, targetStats] = await Promise.all([
      fsp.lstat(realDirectory, { bigint: true }),
      lstatBigIntIfPresent(realCatalogPath)
    ]);
    if (
      !parentStats.isDirectory()
      || parentStats.isSymbolicLink()
      || (targetStats && (
        !targetStats.isFile()
        || targetStats.isSymbolicLink()
        || targetStats.nlink !== 1n
      ))
    ) {
      throw new Error("Emoji catalog path is invalid.");
    }
    await parentBoundAtomicReplace({
      filePath: realCatalogPath,
      parentIdentity: {
        realPath: realDirectory,
        dev: parentStats.dev,
        ino: parentStats.ino,
        ctimeNs: parentStats.ctimeNs
      },
      content,
      expectedTarget: targetStats ?? null
    });
    if (!readCatalogBytes(this.catalogPath).equals(content)) {
      throw new Error("Emoji catalog verification failed.");
    }
    this.cache = cloneEntries(entries);
    this.cacheFingerprint = catalogFingerprintIfPresent(this.catalogPath);
    this.initialized = true;
  }

  private mutate<T>(operation: () => Promise<T>) {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function cloneEntries(entries: readonly EmojiCatalogEntry[]): EmojiCatalogEntry[] {
  return entries.map((entry) => ({
    ...entry,
    versions: entry.versions.map((version) => ({ ...version }))
  }));
}

function serializeEntries(entries: EmojiCatalogEntry[]) {
  assertCatalog(entries);
  const content = Buffer.from(
    entries
      .slice()
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key)
      ))
      .map((entry) => JSON.stringify(entry))
      .join("\n") + (entries.length ? "\n" : ""),
    "utf8"
  );
  if (content.byteLength > MAX_CATALOG_BYTES) throw new Error("Emoji catalog is too large.");
  return content;
}

function legacyEntries(legacy?: LegacyEmojiCatalog): EmojiCatalogEntry[] {
  if (!legacy) return [];
  return legacy.current.map((record) => {
    assertRecord(record);
    const storedVersions = legacy.versions(record.key);
    const versions = storedVersions.length
      ? storedVersions.map((version) => catalogVersion({
          ...version,
          createdAt: version.updatedAt
        }))
      : [catalogVersion({ ...record, createdAt: record.updatedAt })];
    if (!versions.some((version) => version.fileName === record.fileName)) {
      versions.push(catalogVersion({ ...record, createdAt: record.updatedAt }));
    }
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      key: record.key,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      currentFileName: record.fileName,
      versions
    };
  });
}

function currentRecord(entry: EmojiCatalogEntry): EmojiRecord {
  const version = entry.versions.find((candidate) => candidate.fileName === entry.currentFileName);
  if (!version) throw new Error("Emoji catalog current version is missing.");
  return {
    key: entry.key,
    fileName: version.fileName,
    source: version.source,
    sizeBytes: version.sizeBytes,
    width: version.width,
    height: version.height,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function catalogVersion(record: EmojiRecord): EmojiCatalogVersion {
  return {
    fileName: record.fileName,
    source: record.source,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
    createdAt: record.createdAt
  };
}

function parseEntry(value: unknown, line: number): EmojiCatalogEntry {
  const object = strictObject(value, CATALOG_KEYS, `Emoji catalog line ${line}`);
  if (object.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`Emoji catalog line ${line} has an unsupported schema version.`);
  }
  if (!Array.isArray(object.versions)) throw new Error(`Emoji catalog line ${line} versions are invalid.`);
  const entry: EmojiCatalogEntry = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    key: String(object.key),
    createdAt: String(object.createdAt),
    updatedAt: String(object.updatedAt),
    currentFileName: String(object.currentFileName),
    versions: object.versions.map((version, index) => parseVersion(version, line, index))
  };
  assertEntry(entry);
  return entry;
}

function parseVersion(value: unknown, line: number, index: number): EmojiCatalogVersion {
  const object = strictObject(value, VERSION_KEYS, `Emoji catalog line ${line} version ${index + 1}`);
  const version: EmojiCatalogVersion = {
    fileName: String(object.fileName),
    source: String(object.source) as EmojiRecord["source"],
    sizeBytes: Number(object.sizeBytes),
    width: Number(object.width),
    height: Number(object.height),
    createdAt: String(object.createdAt)
  };
  assertVersion(version);
  return version;
}

function strictObject(value: unknown, keys: Set<string>, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw new Error(`${label} fields are invalid.`);
  }
  return object;
}

function assertCatalog(entries: EmojiCatalogEntry[]) {
  if (entries.length > MAX_EMOJI_KEYS) throw new Error("Emoji catalog key limit reached.");
  const keys = new Set<string>();
  for (const entry of entries) {
    assertEntry(entry);
    if (keys.has(entry.key)) throw new Error("Emoji catalog contains duplicate keys.");
    keys.add(entry.key);
  }
}

function assertEntry(entry: EmojiCatalogEntry) {
  if (
    entry.schemaVersion !== CATALOG_SCHEMA_VERSION
    || !validStoredKey(entry.key)
    || !validTimestamp(entry.createdAt)
    || !validTimestamp(entry.updatedAt)
    || !isEmojiFileName(entry.currentFileName)
    || entry.versions.length < 1
    || entry.versions.length > MAX_VERSIONS_PER_KEY
  ) {
    throw new Error("Emoji catalog entry is invalid.");
  }
  const files = new Set<string>();
  for (const version of entry.versions) {
    assertVersion(version);
    if (files.has(version.fileName)) throw new Error("Emoji catalog contains duplicate versions.");
    files.add(version.fileName);
  }
  if (!files.has(entry.currentFileName)) throw new Error("Emoji catalog current version is missing.");
}

function assertVersion(version: EmojiCatalogVersion) {
  if (
    !isEmojiFileName(version.fileName)
    || (version.source !== "upload" && version.source !== "generated")
    || !Number.isSafeInteger(version.sizeBytes)
    || version.sizeBytes <= 0
    || !Number.isSafeInteger(version.width)
    || version.width <= 0
    || !Number.isSafeInteger(version.height)
    || version.height <= 0
    || !validTimestamp(version.createdAt)
  ) {
    throw new Error("Emoji catalog version is invalid.");
  }
}

function assertRecord(record: EmojiRecord) {
  if (
    !validStoredKey(record.key)
    || !isEmojiFileName(record.fileName)
    || (record.source !== "upload" && record.source !== "generated")
    || !Number.isSafeInteger(record.sizeBytes)
    || record.sizeBytes <= 0
    || !Number.isSafeInteger(record.width)
    || record.width <= 0
    || !Number.isSafeInteger(record.height)
    || record.height <= 0
    || !validTimestamp(record.createdAt)
    || !validTimestamp(record.updatedAt)
  ) {
    throw new Error("Emoji record is invalid.");
  }
}

function validStoredKey(key: string) {
  return normalizeEmojiKey(key) === key && isValidEmojiKey(key);
}

function validTimestamp(value: string) {
  return value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function readCatalogBytes(filePath: string) {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow === 0) throw new Error("Emoji catalog no-follow reads are unavailable.");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_CATALOG_BYTES)) {
      throw new Error("Emoji catalog file is invalid.");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) throw new Error("Emoji catalog changed while reading.");
      offset += read;
    }
    const trailing = Buffer.alloc(1);
    if (fs.readSync(descriptor, trailing, 0, 1, bytes.length) !== 0) {
      throw new Error("Emoji catalog changed while reading.");
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathStats = fs.lstatSync(filePath, { bigint: true });
    if (
      pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || before.dev !== pathStats.dev
      || before.ino !== pathStats.ino
    ) {
      throw new Error("Emoji catalog changed while reading.");
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeCatalogAtomically(filePath: string, content: Buffer) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < content.length) {
      offset += fs.writeSync(descriptor, content, offset, content.length - offset, offset);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    assertRegularCatalogFile(fs.lstatSync(filePath, { bigint: true }));
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The primary write error remains authoritative.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function ensureRegularDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Emoji catalog directory is invalid.");
}

function assertRegularCatalogFile(stats: fs.Stats | fs.BigIntStats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 && stats.nlink !== 1n) {
    throw new Error("Emoji catalog file is invalid.");
  }
}

function lstatIfPresent(candidate: string) {
  try {
    return fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function lstatBigIntIfPresent(candidate: string) {
  try {
    return await fsp.lstat(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function catalogFingerprintIfPresent(candidate: string) {
  const stats = lstatIfPresent(candidate);
  if (!stats) return undefined;
  assertRegularCatalogFile(stats);
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}
