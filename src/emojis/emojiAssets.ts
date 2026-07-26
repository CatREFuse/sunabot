import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  type EmojiRecord
} from "../../adapters/sqlite/applicationDataStore.js";
import {
  isEmojiFileName,
  isValidEmojiKey,
  planEmojiMarkers,
  type EmojiCatalogPort,
  type EmojiMarkerPlan
} from "../../services/emojis/emojiCatalog.js";
import { getWorkspacePath } from "../config.js";
import type { AppConfig } from "../types.js";
import { emojiMediaLocation, emojiStore } from "./emojiStore.js";

export { emojiMediaLocation };

const NORMALIZED_EMOJI_SIZE = 1024;
const MAX_STORED_EMOJI_BYTES = 16 * 1024 * 1024;
const MAX_EMOJI_INPUT_PIXELS = 64_000_000;
const PNG_HEADER_BYTES = 33;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_HEADER_BYTES = 13;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_INTEGRITY_CONCURRENCY = 2;
const MAX_INTEGRITY_WAITING = 2;
const integrityCache = new Map<string, { fingerprint: string; valid: boolean }>();
const integrityInFlight = new Map<string, Promise<EmojiIntegrityResult>>();

interface EmojiFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface EmojiAssetIdentity {
  file: EmojiFileIdentity;
  directories: EmojiFileIdentity[];
}

interface EmojiIntegrityResult {
  identity: EmojiAssetIdentity;
  bytes?: Buffer;
}

export interface VerifiedPlannedEmojiAsset {
  key: string;
  record: EmojiRecord;
  image: EmojiMarkerPlan["expectedImages"][number];
  bytes: Buffer;
}

export class EmojiAssetIntegrityBusyError extends Error {
  constructor() {
    super("表情图片校验繁忙，请稍后重试。");
    this.name = "EmojiAssetIntegrityBusyError";
  }
}

export class EmojiAssetIntegrityGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < MAX_INTEGRITY_CONCURRENCY) {
      this.active += 1;
      return this.execute(task);
    }
    if (this.waiting.length >= MAX_INTEGRITY_WAITING) {
      return Promise.reject(new EmojiAssetIntegrityBusyError());
    }
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        void this.execute(task).then(resolve, reject);
      });
    });
  }

  private async execute<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const integrityGate = new EmojiAssetIntegrityGate();

export function availableEmojiRecords(config: AppConfig) {
  return emojiStore(config).readAll().filter((record) => emojiRecordFileIsCandidate(config, record));
}

export function availableEmojiKeys(config: AppConfig) {
  return availableEmojiRecords(config).map((record) => record.key);
}

export function agentEmojiCatalogPort(config: AppConfig): EmojiCatalogPort {
  return {
    listAvailable: () => availableEmojiRecords(config).map((record) => {
      const location = emojiMediaLocation(config, record.fileName);
      return { key: record.key, image: { url: location.url, filePath: location.filePath } };
    })
  };
}

export function planAgentEmojiMarkers(text: string, config: AppConfig) {
  return planEmojiMarkers(text, agentEmojiCatalogPort(config));
}

export async function assertPlannedEmojiAssetsIntegrity(config: AppConfig, plan: EmojiMarkerPlan) {
  const assets = plannedEmojiAssets(config, plan);
  const records = new Map<string, EmojiRecord>();
  for (const asset of assets) records.set(emojiIntegrityOperationKey(config, asset.record), asset.record);
  await assertEmojiRecordsInBatches(config, [...records.values()]);
}

export async function readPlannedEmojiAssets(
  config: AppConfig,
  plan: EmojiMarkerPlan
): Promise<VerifiedPlannedEmojiAsset[]> {
  const assets = plannedEmojiAssets(config, plan);
  const bytesByRecord = new Map<string, Buffer>();
  for (const asset of assets) {
    const operationKey = emojiIntegrityOperationKey(config, asset.record);
    if (!bytesByRecord.has(operationKey)) {
      bytesByRecord.set(operationKey, await readVerifiedEmojiRecordFile(config, asset.record));
    }
  }
  return assets.map((asset) => ({
    ...asset,
    bytes: bytesByRecord.get(emojiIntegrityOperationKey(config, asset.record))!
  }));
}

function plannedEmojiAssets(config: AppConfig, plan: EmojiMarkerPlan) {
  const assets: Array<Omit<VerifiedPlannedEmojiAsset, "bytes">> = [];
  const store = emojiStore(config);
  for (let index = 0; index < plan.expectedKeys.length; index += 1) {
    const key = plan.expectedKeys[index];
    const image = plan.expectedImages[index];
    if (!key) throw emojiAssetUnavailable();
    const record = store.read(key);
    if (!record || !image?.filePath) throw emojiAssetUnavailable();
    const location = emojiMediaLocation(config, record.fileName);
    if (path.resolve(image.filePath) !== path.resolve(location.filePath) || image.url !== location.url) {
      throw emojiAssetUnavailable();
    }
    assets.push({ key, record, image });
  }
  return assets;
}

export async function filterVerifiedEmojiRecords(
  config: AppConfig,
  records: readonly EmojiRecord[] = availableEmojiRecords(config)
) {
  const unique = new Map<string, EmojiRecord>();
  const candidates = records.flatMap((record) => {
    try {
      const key = emojiIntegrityOperationKey(config, record);
      unique.set(key, record);
      return [{ key, record }];
    } catch {
      return [];
    }
  });
  const verifiedKeys = new Set<string>();
  const uniqueEntries = [...unique.entries()];
  for (let index = 0; index < uniqueEntries.length; index += MAX_INTEGRITY_CONCURRENCY) {
    const batch = uniqueEntries.slice(index, index + MAX_INTEGRITY_CONCURRENCY);
    await Promise.all(batch.map(async ([key, record]) => {
      try {
        await assertEmojiRecordFileIntegrity(config, record);
        verifiedKeys.add(key);
      } catch {
        // Invalid or over-capacity records remain hidden from the API list.
      }
    }));
  }
  return candidates.flatMap(({ key, record }) => verifiedKeys.has(key) ? [record] : []);
}

export async function readVerifiedEmojiRecordFile(config: AppConfig, record: EmojiRecord) {
  try {
    const result = await runEmojiIntegrityOperation(config, record, true);
    if (!result.bytes) throw emojiAssetUnavailable();
    return result.bytes;
  } catch {
    throw emojiAssetUnavailable();
  }
}

async function assertEmojiRecordFileIntegrity(config: AppConfig, record: EmojiRecord) {
  try {
    await runEmojiIntegrityOperation(config, record, false);
  } catch {
    throw emojiAssetUnavailable();
  }
}

async function assertEmojiRecordsInBatches(config: AppConfig, records: readonly EmojiRecord[]) {
  for (let index = 0; index < records.length; index += MAX_INTEGRITY_CONCURRENCY) {
    await Promise.all(records.slice(index, index + MAX_INTEGRITY_CONCURRENCY)
      .map((record) => assertEmojiRecordFileIntegrity(config, record)));
  }
}

async function runEmojiIntegrityOperation(
  config: AppConfig,
  record: EmojiRecord,
  requireBytes: boolean
): Promise<EmojiIntegrityResult> {
  const key = emojiIntegrityOperationKey(config, record);
  const existing = integrityInFlight.get(key);
  if (existing) {
    const result = await existing;
    return requireBytes && !result.bytes
      ? runEmojiIntegrityOperation(config, record, true)
      : result;
  }
  const filePath = emojiMediaLocation(config, record.fileName).filePath;
  const rawOperation = integrityGate.run(async () => {
    const identity = await lstatEmojiAsset(filePath, record);
    const cached = integrityCache.get(filePath);
    if (cached?.fingerprint === identityFingerprint(identity)) {
      if (!cached.valid) throw emojiAssetUnavailable();
      if (!requireBytes) return { identity };
    }
    try {
      const result = await scanEmojiFile(filePath, record, identity);
      cacheIntegrity(filePath, result.identity, true);
      return result;
    } catch {
      cacheIntegrity(filePath, identity, false);
      throw emojiAssetUnavailable();
    }
  });
  let trackedOperation: Promise<EmojiIntegrityResult>;
  trackedOperation = rawOperation.finally(() => {
    if (integrityInFlight.get(key) === trackedOperation) integrityInFlight.delete(key);
  });
  integrityInFlight.set(key, trackedOperation);
  const result = await trackedOperation;
  return requireBytes && !result.bytes
    ? runEmojiIntegrityOperation(config, record, true)
    : result;
}

function emojiIntegrityOperationKey(config: AppConfig, record: EmojiRecord) {
  assertEmojiRecordMetadata(record);
  const filePath = emojiMediaLocation(config, record.fileName).filePath;
  return [path.resolve(filePath), record.fileName, record.sizeBytes, record.width, record.height].join("\0");
}

function emojiRecordFileIsCandidate(config: AppConfig, record: EmojiRecord) {
  try {
    assertEmojiRecordMetadata(record);
    const filePath = emojiMediaLocation(config, record.fileName).filePath;
    const stats = fs.lstatSync(filePath, { bigint: true });
    return stats.isFile()
      && !stats.isSymbolicLink()
      && stats.size === BigInt(record.sizeBytes);
  } catch {
    return false;
  }
}

function assertEmojiRecordMetadata(record: EmojiRecord) {
  if (
    !isValidEmojiKey(record.key)
    || !isEmojiFileName(record.fileName)
    || !Number.isSafeInteger(record.sizeBytes)
    || record.sizeBytes < (record.fileName.endsWith(".gif") ? GIF_HEADER_BYTES : PNG_HEADER_BYTES)
    || record.sizeBytes > MAX_STORED_EMOJI_BYTES
    || record.width !== NORMALIZED_EMOJI_SIZE
    || record.height !== NORMALIZED_EMOJI_SIZE
  ) {
    throw emojiAssetUnavailable();
  }
}

async function scanEmojiFile(
  filePath: string,
  record: EmojiRecord,
  pathIdentity: EmojiAssetIdentity
) {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow === 0) throw emojiAssetUnavailable();
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const openedIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameIdentity(pathIdentity.file, openedIdentity)) throw emojiAssetUnavailable();
    const totalSize = Number(openedIdentity.size);
    const output = Buffer.allocUnsafe(totalSize);
    const header = Buffer.allocUnsafe(Math.min(PNG_HEADER_BYTES, totalSize));
    const hash = crypto.createHash("sha256");
    let offset = 0;
    while (offset < totalSize) {
      const length = Math.min(READ_CHUNK_BYTES, totalSize - offset);
      const { bytesRead } = await handle.read(output, offset, length, offset);
      if (bytesRead <= 0) throw emojiAssetUnavailable();
      const chunk = output.subarray(offset, offset + bytesRead);
      hash.update(chunk);
      if (offset < header.length) {
        chunk.copy(header, offset, 0, Math.min(chunk.length, header.length - offset));
      }
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, totalSize)).bytesRead !== 0) throw emojiAssetUnavailable();
    const extension = record.fileName.endsWith(".gif") ? "gif" : "png";
    assertNormalizedImageHeader(header, extension);
    if (record.fileName !== `emoji-${hash.digest("hex")}.${extension}`) throw emojiAssetUnavailable();
    await assertDecodableNormalizedImage(output, extension);
    const afterReadIdentity = fileIdentity(await handle.stat({ bigint: true }));
    const afterPathIdentity = await lstatEmojiAsset(filePath, record);
    if (
      !sameIdentity(openedIdentity, afterReadIdentity)
      || !sameAssetIdentity(pathIdentity, afterPathIdentity)
    ) {
      throw emojiAssetUnavailable();
    }
    return { bytes: output, identity: afterPathIdentity };
  } finally {
    await handle.close();
  }
}

async function lstatEmojiAsset(filePath: string, record: EmojiRecord): Promise<EmojiAssetIdentity> {
  const directories = await lstatEmojiDirectoryChain(filePath);
  const stats = await fsp.lstat(filePath, { bigint: true });
  const identity = fileIdentity(stats);
  if (!stats.isFile() || stats.isSymbolicLink() || identity.size !== BigInt(record.sizeBytes)) {
    throw emojiAssetUnavailable();
  }
  return { file: identity, directories };
}

async function lstatEmojiDirectoryChain(filePath: string) {
  const workspaceRoot = path.resolve(getWorkspacePath());
  const directory = path.dirname(path.resolve(filePath));
  const mediaRoot = directory;
  const mediaRelative = path.relative(workspaceRoot, mediaRoot);
  const directoryRelative = path.relative(workspaceRoot, directory);
  if (
    mediaRelative === ".."
    || mediaRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(mediaRelative)
    || directoryRelative === ".."
    || directoryRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(directoryRelative)
    || (directory !== mediaRoot && !directory.startsWith(`${mediaRoot}${path.sep}`))
  ) {
    throw emojiAssetUnavailable();
  }
  const realWorkspace = await fsp.realpath(workspaceRoot);
  const realDirectory = await fsp.realpath(directory);
  if (realDirectory !== path.resolve(realWorkspace, directoryRelative)) throw emojiAssetUnavailable();
  const paths = [workspaceRoot];
  let current = workspaceRoot;
  for (const segment of directoryRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  const identities: EmojiFileIdentity[] = [];
  for (const directoryPath of paths) {
    const stats = await fsp.lstat(directoryPath, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw emojiAssetUnavailable();
    identities.push(fileIdentity(stats));
  }
  return identities;
}

function fileIdentity(stats: fs.BigIntStats): EmojiFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

function sameIdentity(left: EmojiFileIdentity, right: EmojiFileIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameAssetIdentity(left: EmojiAssetIdentity, right: EmojiAssetIdentity) {
  return sameIdentity(left.file, right.file)
    && left.directories.length === right.directories.length
    && left.directories.every((identity, index) => {
      const other = right.directories[index];
      return other !== undefined && identity.dev === other.dev && identity.ino === other.ino;
    });
}

function identityFingerprint(identity: EmojiAssetIdentity) {
  return [
    identity.file.dev,
    identity.file.ino,
    identity.file.size,
    identity.file.mtimeNs,
    identity.file.ctimeNs,
    ...identity.directories.flatMap((directory) => [directory.dev, directory.ino])
  ].join(":");
}

function cacheIntegrity(filePath: string, identity: EmojiAssetIdentity, valid: boolean) {
  integrityCache.set(filePath, { fingerprint: identityFingerprint(identity), valid });
  if (integrityCache.size > 256) integrityCache.delete(integrityCache.keys().next().value ?? "");
}

async function assertDecodableNormalizedImage(bytes: Buffer, extension: "png" | "gif") {
  try {
    const decoded = await sharp(bytes, {
      ...(extension === "gif"
        ? { animated: true }
        : { animated: false, page: 0, pages: 1 }),
      failOn: "error",
      limitInputPixels: MAX_EMOJI_INPUT_PIXELS
    }).raw().toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== NORMALIZED_EMOJI_SIZE
      || (decoded.info.pageHeight ?? decoded.info.height) !== NORMALIZED_EMOJI_SIZE
      || decoded.info.channels < 1
      || decoded.info.channels > 4
    ) {
      throw emojiAssetUnavailable();
    }
  } catch {
    throw emojiAssetUnavailable();
  }
}

function assertNormalizedImageHeader(header: Buffer, extension: "png" | "gif") {
  if (extension === "gif") {
    if (
      header.length < GIF_HEADER_BYTES
      || !["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))
      || header.readUInt16LE(6) !== NORMALIZED_EMOJI_SIZE
      || header.readUInt16LE(8) !== NORMALIZED_EMOJI_SIZE
    ) {
      throw emojiAssetUnavailable();
    }
    return;
  }
  if (
    header.length < PNG_HEADER_BYTES
    || !header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || header.readUInt32BE(8) !== 13
    || header.toString("ascii", 12, 16) !== "IHDR"
    || header.readUInt32BE(16) !== NORMALIZED_EMOJI_SIZE
    || header.readUInt32BE(20) !== NORMALIZED_EMOJI_SIZE
    || header[24] !== 8
    || ![0, 2, 4, 6].includes(header[25] ?? -1)
    || header[26] !== 0
    || header[27] !== 0
    || header[28] !== 0
  ) {
    throw emojiAssetUnavailable();
  }
}

function emojiAssetUnavailable() {
  return new Error("表情图片已损坏或不可用。");
}
