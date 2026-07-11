import {
  AttachmentCacheError,
  AttachmentTooLargeError,
  type AttachmentStatFs,
  type AttachmentStatFsSnapshot,
  type CacheCleanupResult
} from "./cacheTypes.js";
import { CacheIndexRepository } from "./cacheIndexRepository.js";

export interface CacheJanitorOptions {
  repository: CacheIndexRepository;
  maxFileBytes: number;
  minimumFreeBytes: number;
  unreferencedTtlMs: number;
  statfsImpl: AttachmentStatFs;
  now: () => Date;
}

export class CacheJanitor {
  private readonly repository: CacheIndexRepository;
  private readonly maxFileBytes: number;
  private readonly minimumFreeBytes: number;
  private readonly unreferencedTtlMs: number;
  private readonly statfsImpl: AttachmentStatFs;
  private readonly now: () => Date;
  private reservationQueue: Promise<void> = Promise.resolve();
  private reservedWriteBytes = 0;

  constructor(options: CacheJanitorOptions) {
    this.repository = options.repository;
    this.maxFileBytes = options.maxFileBytes;
    this.minimumFreeBytes = options.minimumFreeBytes;
    this.unreferencedTtlMs = options.unreferencedTtlMs;
    this.statfsImpl = options.statfsImpl;
    this.now = options.now;
  }

  async prepareForWrite(requiredBytes: number) {
    await this.cleanupForTarget(this.minimumFreeBytes + requiredBytes);
    await this.assertAvailableSpace(requiredBytes);
  }

  reserveWriteBytes(requiredBytes: number) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > this.maxFileBytes) {
      throw new AttachmentTooLargeError(this.maxFileBytes, requiredBytes);
    }
    return this.queueReservation(async () => {
      const target = this.minimumFreeBytes + this.reservedWriteBytes + requiredBytes;
      await this.cleanupForTarget(target);
      const availableBytes = await this.readAvailableBytes();
      if (availableBytes < target) {
        throw new AttachmentCacheError(
          "storage_exhausted",
          "Attachment cache does not have enough free disk space."
        );
      }
      this.reservedWriteBytes += requiredBytes;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await this.queueReservation(async () => {
          this.reservedWriteBytes = Math.max(0, this.reservedWriteBytes - requiredBytes);
        });
      };
    });
  }

  async ensureAvailableSpace(requiredBytes: number) {
    const availableBytes = await this.readAvailableBytes();
    if (hasSafeWriteSpace(availableBytes, this.minimumFreeBytes, requiredBytes)) return;
    await this.cleanupForTarget(this.minimumFreeBytes + requiredBytes);
    await this.assertAvailableSpace(requiredBytes);
  }

  async reserveArtifactBytes(requiredBytes: number) {
    await this.repository.initialize();
    return this.reserveWriteBytes(requiredBytes);
  }

  async cleanup(): Promise<CacheCleanupResult> {
    await this.repository.initialize();
    return this.repository.withMutation(() => this.cleanupUnlocked());
  }

  private async cleanupForTarget(targetFreeBytes: number) {
    await this.repository.initialize();
    return this.repository.withMutation(() => this.cleanupUnlocked(targetFreeBytes));
  }

  private async assertAvailableSpace(requiredBytes: number) {
    const availableBytes = await this.readAvailableBytes();
    if (hasSafeWriteSpace(availableBytes, this.minimumFreeBytes, requiredBytes)) return;
    throw new AttachmentCacheError(
      "storage_exhausted",
      "Attachment cache does not have enough free disk space."
    );
  }

  private async cleanupUnlocked(
    targetFreeBytes = this.minimumFreeBytes
  ): Promise<CacheCleanupResult> {
    const removedCacheKeys: string[] = [];
    let reclaimedBytes = 0;
    const now = this.now().getTime();
    const expired = this.repository.listReclaimableEntries().filter((entry) =>
      now - accessTimestamp(entry.lastAccessAt) > this.unreferencedTtlMs);

    for (const entry of expired) {
      const reclaimed = await this.repository.removeReclaimableEntry(entry.sha256);
      if (reclaimed == null) continue;
      removedCacheKeys.push(entry.sha256);
      reclaimedBytes += reclaimed;
    }

    let availableBytes = await this.readAvailableBytes();
    for (const entry of this.repository.listReclaimableEntries()) {
      if (availableBytes >= targetFreeBytes) break;
      const reclaimed = await this.repository.removeReclaimableEntry(entry.sha256);
      if (reclaimed == null) continue;
      removedCacheKeys.push(entry.sha256);
      reclaimedBytes += reclaimed;
      availableBytes = await this.readAvailableBytes();
    }

    return { removedCacheKeys, reclaimedBytes, availableBytes };
  }

  private async readAvailableBytes() {
    try {
      return availableBytesFromStatFs(await this.statfsImpl(this.repository.rootDir));
    } catch (error) {
      if (error instanceof AttachmentCacheError) throw error;
      throw new AttachmentCacheError(
        "storage_exhausted",
        "Attachment cache free space could not be inspected.",
        { cause: error }
      );
    }
  }

  private queueReservation<T>(operation: () => Promise<T>) {
    const result = this.reservationQueue.then(operation, operation);
    this.reservationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function hasSafeWriteSpace(
  availableBytes: number,
  minimumFreeBytes: number,
  requiredBytes: number
) {
  return availableBytes >= minimumFreeBytes + requiredBytes;
}

function availableBytesFromStatFs(value: AttachmentStatFsSnapshot) {
  const availableBlocks = nonNegativeBigInt(value.bavail);
  const blockSize = nonNegativeBigInt(value.bsize);
  const availableBytes = availableBlocks * blockSize;
  return availableBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(availableBytes);
}

function nonNegativeBigInt(value: number | bigint) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("Negative statfs value.");
    return value;
  }
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid statfs value.");
  return BigInt(Math.floor(value));
}

function accessTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
