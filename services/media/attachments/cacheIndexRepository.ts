import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  AttachmentCacheError,
  CACHE_INDEX_VERSION,
  type CacheIndex,
  type CacheIndexEntry,
  type CacheReference,
  type CachedAttachment,
  type CompletedAttachmentPart,
  type UpdateParseStateInput
} from "./cacheTypes.js";

const ORIGINAL_FILE_NAME = "original";
const TRASH_DIRECTORY_NAME = ".trash";

export class CacheIndexRepository {
  readonly rootDir: string;
  readonly indexPath: string;
  readonly temporaryDir: string;
  readonly trashDir: string;

  private readonly now: () => Date;
  private readonly index: CacheIndex = {
    version: CACHE_INDEX_VERSION,
    entries: {}
  };
  private readonly activeTaskCounts = new Map<string, number>();
  private initialization?: Promise<void>;
  private indexQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string, now: () => Date = () => new Date()) {
    this.rootDir = path.resolve(rootDir);
    this.indexPath = path.join(this.rootDir, "index.json");
    this.temporaryDir = path.join(this.rootDir, ".tmp");
    this.trashDir = path.join(this.rootDir, TRASH_DIRECTORY_NAME);
    this.now = now;
  }

  initialize() {
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }

  async getEntry(sha256: string) {
    await this.initialize();
    await this.indexQueue;
    const entry = this.index.entries[sha256];
    return entry ? cloneEntry(entry) : undefined;
  }

  async getIndex() {
    await this.initialize();
    await this.indexQueue;
    return cloneIndex(this.index);
  }

  async addReference(sha256: string, reference: string) {
    await this.initialize();
    return this.withMutation(async () => {
      const entry = this.requireEntry(sha256);
      if (!entry.activeReferences.includes(reference)) {
        entry.activeReferences.push(reference);
        entry.activeReferences.sort();
      }
      entry.lastAccessAt = this.now().toISOString();
      await this.writeIndexAtomically();
      return cloneEntry(entry);
    });
  }

  async removeReference(sha256: string, reference: string) {
    await this.initialize();
    return this.withMutation(async () => {
      const entry = this.requireEntry(sha256);
      entry.activeReferences = entry.activeReferences.filter((value) => value !== reference);
      entry.lastAccessAt = this.now().toISOString();
      await this.writeIndexAtomically();
      return cloneEntry(entry);
    });
  }

  async rebuildReferences(references: Iterable<CacheReference>) {
    await this.initialize();
    const rebuilt = new Map<string, Set<string>>();
    for (const value of references) {
      const cacheKey = value.cacheKey.trim();
      const reference = value.reference.trim();
      if (!cacheKey || !reference) continue;
      const values = rebuilt.get(cacheKey) ?? new Set<string>();
      values.add(reference);
      rebuilt.set(cacheKey, values);
    }

    await this.withMutation(async () => {
      for (const entry of Object.values(this.index.entries)) {
        entry.activeReferences = [...(rebuilt.get(entry.sha256) ?? [])].sort();
      }
      await this.writeIndexAtomically();
    });
  }

  async updateParseState(sha256: string, input: UpdateParseStateInput) {
    await this.initialize();
    if (!Number.isSafeInteger(input.artifactsSizeBytes) || input.artifactsSizeBytes < 0) {
      throw new AttachmentCacheError("write_failed", "Artifact size must be a non-negative integer.");
    }
    return this.withMutation(async () => {
      const entry = this.requireEntry(sha256);
      entry.parseStatus = input.parseStatus;
      entry.artifactsSizeBytes = input.artifactsSizeBytes;
      entry.lastAccessAt = this.now().toISOString();
      await this.writeIndexAtomically();
      return cloneEntry(entry);
    });
  }

  async beginActiveTask(sha256: string) {
    await this.initialize();
    return this.withMutation(async () => {
      this.requireEntry(sha256);
      this.incrementActiveTask(sha256);
    });
  }

  async endActiveTask(sha256: string) {
    await this.initialize();
    return this.withMutation(async () => {
      this.decrementActiveTask(sha256);
    });
  }

  async commitPart(completed: CompletedAttachmentPart): Promise<CachedAttachment> {
    await this.initialize();
    return this.withMutation(async () => {
      const entryDir = path.join(this.rootDir, completed.sha256);
      const filePath = path.join(entryDir, ORIGINAL_FILE_NAME);
      const originalFile = path.relative(this.rootDir, filePath);
      let cacheHit = false;

      await mkdir(entryDir, { recursive: true, mode: 0o700 });
      await chmod(entryDir, 0o700).catch(() => undefined);
      try {
        const existing = await stat(filePath);
        if (existing.isFile() && existing.size === completed.sizeBytes) {
          cacheHit = true;
          await rm(completed.partPath, { force: true });
        } else {
          await rename(completed.partPath, filePath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(completed.partPath, filePath);
      }

      const previous = this.index.entries[completed.sha256];
      this.index.entries[completed.sha256] = {
        sha256: completed.sha256,
        originalFile,
        originalSizeBytes: completed.sizeBytes,
        artifactsSizeBytes: previous?.artifactsSizeBytes ?? 0,
        lastAccessAt: this.now().toISOString(),
        parseStatus: previous?.parseStatus ?? "pending",
        activeReferences: previous?.activeReferences.slice().sort() ?? []
      };
      try {
        await this.writeIndexAtomically();
      } catch (error) {
        if (previous) this.index.entries[completed.sha256] = previous;
        else {
          delete this.index.entries[completed.sha256];
          await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
        }
        throw error;
      }
      this.incrementActiveTask(completed.sha256);
      return {
        cacheKey: completed.sha256,
        sha256: completed.sha256,
        sizeBytes: completed.sizeBytes,
        filePath,
        cacheHit
      };
    }).catch(async (error) => {
      await rm(completed.partPath, { force: true }).catch(() => undefined);
      if (error instanceof AttachmentCacheError) throw error;
      throw new AttachmentCacheError("write_failed", "Attachment cache write failed.", {
        cause: error
      });
    });
  }

  withMutation<T>(mutation: () => Promise<T>) {
    const result = this.indexQueue.then(mutation, mutation);
    this.indexQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  listReclaimableEntries() {
    return Object.values(this.index.entries)
      .filter((entry) => entry.activeReferences.length === 0)
      .filter((entry) => !this.activeTaskCounts.has(entry.sha256))
      .sort(compareCacheEntries)
      .map(cloneEntry);
  }

  async removeReclaimableEntry(sha256: string) {
    const entry = this.index.entries[sha256];
    if (!entry || entry.activeReferences.length || this.activeTaskCounts.has(sha256)) {
      return undefined;
    }

    const entryDir = path.join(this.rootDir, sha256);
    const trashPath = path.join(this.trashDir, `${sha256}-${randomUUID()}`);
    const snapshot = cloneEntry(entry);
    let moved = false;
    await mkdir(this.trashDir, { recursive: true, mode: 0o700 });
    try {
      await rename(entryDir, trashPath);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    delete this.index.entries[sha256];
    try {
      await this.writeIndexAtomically();
    } catch (error) {
      this.index.entries[sha256] = snapshot;
      if (moved) await rename(trashPath, entryDir).catch(() => undefined);
      throw error;
    }
    if (moved) await rm(trashPath, { recursive: true, force: true });
    return snapshot.originalSizeBytes + snapshot.artifactsSizeBytes;
  }

  private async initializeOnce() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700).catch(() => undefined);
    await mkdir(this.temporaryDir, { recursive: true, mode: 0o700 });
    await chmod(this.temporaryDir, 0o700).catch(() => undefined);
    await this.cleanupPartFiles();
    await mkdir(this.trashDir, { recursive: true, mode: 0o700 });
    await chmod(this.trashDir, 0o700).catch(() => undefined);

    try {
      const parsed = parseIndex(await readFile(this.indexPath, "utf8"));
      this.index.entries = parsed.entries;
      await chmod(this.indexPath, 0o600).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof AttachmentCacheError) throw error;
        throw new AttachmentCacheError("invalid_cache_index", "Attachment cache index is invalid.", {
          cause: error
        });
      }
    }
    await this.recoverTrashEntries();
    await this.cleanupOrphanEntryDirectories();
    await this.reconcileArtifactSizes();
  }

  private async cleanupPartFiles() {
    const entries = await readdir(this.temporaryDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
      .map((entry) => rm(path.join(this.temporaryDir, entry.name), { force: true })));
  }

  private async recoverTrashEntries() {
    const entries = await readdir(this.trashDir, { withFileTypes: true });
    for (const entry of entries) {
      const trashPath = path.join(this.trashDir, entry.name);
      const sha256 = entry.name.slice(0, 64);
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(sha256) || !this.index.entries[sha256]) {
        await rm(trashPath, { recursive: true, force: true });
        continue;
      }
      const entryDir = path.join(this.rootDir, sha256);
      try {
        await stat(entryDir);
        await rm(trashPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rename(trashPath, entryDir);
      }
    }
  }

  private async cleanupOrphanEntryDirectories() {
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    await Promise.all(entries.flatMap((entry) => {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) return [];
      if (this.index.entries[entry.name]) return [];
      return [rm(path.join(this.rootDir, entry.name), { recursive: true, force: true })];
    }));
  }

  private async reconcileArtifactSizes() {
    let changed = false;
    for (const entry of Object.values(this.index.entries)) {
      const size = await directorySizeOrZero(path.join(this.rootDir, entry.sha256, "artifacts"));
      if (entry.artifactsSizeBytes === size) continue;
      entry.artifactsSizeBytes = size;
      changed = true;
    }
    if (changed) await this.writeIndexAtomically();
  }

  private incrementActiveTask(sha256: string) {
    this.activeTaskCounts.set(sha256, (this.activeTaskCounts.get(sha256) ?? 0) + 1);
  }

  private decrementActiveTask(sha256: string) {
    const count = this.activeTaskCounts.get(sha256) ?? 0;
    if (count <= 1) this.activeTaskCounts.delete(sha256);
    else this.activeTaskCounts.set(sha256, count - 1);
  }

  private requireEntry(sha256: string) {
    const entry = this.index.entries[sha256];
    if (!entry) {
      throw new AttachmentCacheError("write_failed", `Unknown attachment cache key: ${sha256}`);
    }
    return entry;
  }

  private async writeIndexAtomically() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.rootDir, `.index-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(this.index, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await rename(temporaryPath, this.indexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function directorySizeOrZero(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySizeOrZero(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

function parseIndex(raw: string): CacheIndex {
  const parsed = JSON.parse(raw) as Partial<CacheIndex>;
  if (parsed.version !== CACHE_INDEX_VERSION || !isRecord(parsed.entries)) {
    throw new AttachmentCacheError("invalid_cache_index", "Attachment cache index is invalid.");
  }
  const entries: Record<string, CacheIndexEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!isCacheIndexEntry(value) || value.sha256 !== key) {
      throw new AttachmentCacheError("invalid_cache_index", "Attachment cache index is invalid.");
    }
    entries[key] = cloneEntry(value);
  }
  return { version: CACHE_INDEX_VERSION, entries };
}

function isCacheIndexEntry(value: unknown): value is CacheIndexEntry {
  if (!isRecord(value)) return false;
  return typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.originalFile === "string" &&
    typeof value.originalSizeBytes === "number" &&
    typeof value.artifactsSizeBytes === "number" &&
    typeof value.lastAccessAt === "string" &&
    (value.parseStatus === "pending" || value.parseStatus === "ready" ||
      value.parseStatus === "partial" || value.parseStatus === "failed") &&
    Array.isArray(value.activeReferences) &&
    value.activeReferences.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function accessTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareCacheEntries(left: CacheIndexEntry, right: CacheIndexEntry) {
  return accessTimestamp(left.lastAccessAt) - accessTimestamp(right.lastAccessAt) ||
    left.sha256.localeCompare(right.sha256);
}

function cloneEntry(entry: CacheIndexEntry): CacheIndexEntry {
  return { ...entry, activeReferences: entry.activeReferences.slice() };
}

function cloneIndex(index: CacheIndex): CacheIndex {
  return {
    version: CACHE_INDEX_VERSION,
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([key, entry]) => [key, cloneEntry(entry)])
    )
  };
}
