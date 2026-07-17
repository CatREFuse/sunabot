import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import yauzl, { type Entry } from "yauzl";
import { compareBinaryText } from "../../packages/contracts/extensions/agentExtensions.js";
import {
  AgentExtensionServiceError,
  buildSkillPackageEvidence,
  parseOpenAiSkillMetadata,
  parseSkillFrontmatter,
  type SkillPackageEvidence,
  type SkillPackageFileEvidence
} from "../../services/extensions/public.js";
import {
  parentBoundExclusiveWrite,
  parentBoundMkdir,
  parentBoundRename,
  parentBoundSync
} from "./parentBoundFs.js";
import type { PinnedDirectoryIdentity } from "./agentExtensionSecureFs.js";

export const DEFAULT_SKILL_ARCHIVE_LIMITS = {
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 200
} as const;

const MAX_SKILL_DIRECTORY_DEPTH = 16;

export interface SkillArchiveLimits {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxCompressionRatio?: number;
}

export interface ExtractedSkillArchive {
  container: string;
  packageRoot: string;
  evidence: SkillPackageEvidence;
}

export interface SkillArchiveExtractionHooks {
  beforeStageOperation?: (
    operation: "mkdir" | "write" | "quarantine",
    absolute: string
  ) => void | Promise<void>;
  beforeBoundStageOperation?: (
    operation: "mkdir" | "write" | "quarantine",
    absolute: string
  ) => void | Promise<void>;
  beforeInitialRootBind?: () => void | Promise<void>;
}

export interface SkillInspectionHooks {
  beforeRootRealpath?: () => void | Promise<void>;
  beforeDirectoryRead?: (absolute: string, relative: string) => void | Promise<void>;
  beforeFileOpen?: (absolute: string, relative: string) => void | Promise<void>;
}

export async function extractSkillArchive(input: {
  archive: Buffer;
  stagingRoot: string;
  stagingRootIdentity?: PinnedDirectoryIdentity;
  limits?: SkillArchiveLimits;
  hooks?: SkillArchiveExtractionHooks;
}): Promise<ExtractedSkillArchive> {
  const limits = resolvedLimits(input.limits);
  if (!Buffer.isBuffer(input.archive) || input.archive.length < 1 || input.archive.length > limits.maxArchiveBytes) {
    throw archiveError("SKILL_ARCHIVE_SIZE_INVALID", "Skill ZIP 大小无效。");
  }
  const requestedRoot = path.resolve(input.stagingRoot);
  let rootIdentity: StagingDirectoryIdentity;
  if (input.stagingRootIdentity) {
    await input.hooks?.beforeInitialRootBind?.();
    rootIdentity = await pinStagingDirectory(requestedRoot, input.stagingRootIdentity.realPath);
    assertDirectoryLineage(input.stagingRootIdentity, rootIdentity);
  } else {
    rootIdentity = await pinStagingDirectory(requestedRoot, undefined, input.hooks?.beforeInitialRootBind);
  }
  const stagingRoot = rootIdentity.realPath;
  const stageGuard = await StagingDirectoryGuard.create(stagingRoot, rootIdentity, input.hooks);
  const container = path.join(stagingRoot, `.skill-stage-${randomUUID()}`);
  await stageGuard.createDirectory(container);

  let zipFile: yauzl.ZipFile | undefined;
  try {
    zipFile = await yauzl.fromBufferPromise(input.archive, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    });
    if (!Number.isSafeInteger(zipFile.entryCount) || zipFile.entryCount < 1 || zipFile.entryCount > limits.maxEntries) {
      throw archiveError("SKILL_ARCHIVE_ENTRY_LIMIT", "Skill ZIP 文件数量超限。");
    }

    const pathKeys = new Set<string>();
    const entries: Array<{ entry: Entry; relative: string; directory: boolean }> = [];
    for await (const entry of zipFile.eachEntry()) {
      if (entries.length >= limits.maxEntries) throw archiveError("SKILL_ARCHIVE_ENTRY_LIMIT", "Skill ZIP 文件数量超限。");
      entries.push({
        entry,
        relative: validateEntry(entry, pathKeys, limits),
        directory: entry.fileName.endsWith("/")
      });
    }
    if (entries.length !== zipFile.entryCount) throw archiveError("SKILL_ARCHIVE_INVALID", "Skill ZIP 目录不完整。");
    const wrapper = archiveWrapper(entries);
    const normalizedKeys = new Set<string>();
    let totalBytes = 0;
    for (const item of entries) {
      const entry = item.entry;
      const relative = stripArchiveWrapper(item.relative, wrapper, item.directory);
      if (!relative) continue;
      const folded = relative.normalize("NFC").toLocaleLowerCase("en-US");
      if (normalizedKeys.has(folded)) throw archiveError("SKILL_ARCHIVE_DUPLICATE_PATH", "Skill ZIP 包含重复路径。");
      normalizedKeys.add(folded);
      const directory = entry.fileName.endsWith("/");
      const destination = path.join(container, ...relative.split("/"));
      assertWithin(container, destination);
      if (directory) {
        await mkdirSafe(container, relative, stageGuard);
        continue;
      }
      if (totalBytes > limits.maxTotalBytes - entry.uncompressedSize) {
        throw archiveError("SKILL_ARCHIVE_TOTAL_LIMIT", "Skill ZIP 展开体积超限。");
      }
      totalBytes += entry.uncompressedSize;
      await mkdirSafe(container, path.posix.dirname(relative), stageGuard);
      const content = await readEntry(zipFile, entry, limits.maxFileBytes);
      if (content.length !== entry.uncompressedSize) {
        throw archiveError("SKILL_ARCHIVE_INVALID", "Skill ZIP 文件长度与目录记录不一致。");
      }
      await stageGuard.writeFile(destination, content);
    }
    await stageGuard.verifyAll();
    const packageRoot = container;
    const evidence = await inspectSkillDirectory(packageRoot, limits, {}, stageGuard.identity(packageRoot));
    if (wrapper && wrapper !== evidence.name) {
      throw archiveError("SKILL_FOLDER_NAME_MISMATCH", "Skill 包装目录必须与 frontmatter name 一致。");
    }
    await syncDirectory(packageRoot);
    await syncDirectory(container);
    await stageGuard.verifyAll();
    return { container, packageRoot, evidence };
  } catch (error) {
    await stageGuard.quarantine(container);
    if (error instanceof AgentExtensionServiceError) throw error;
    if (isSkillError(error)) throw archiveError(error.code, error.message, error);
    throw archiveError("SKILL_ARCHIVE_INVALID", "Skill ZIP 无效。", error);
  } finally {
    if (zipFile?.isOpen) zipFile.close();
  }
}

export async function inspectSkillDirectory(
  directory: string,
  limitOverrides: SkillArchiveLimits = {},
  hooks: SkillInspectionHooks = {},
  rootLineage?: PinnedDirectoryIdentity
): Promise<SkillPackageEvidence> {
  const limits = resolvedLimits(limitOverrides);
  const requestedRoot = path.resolve(directory);
  let initialRoot: StagingDirectoryIdentity;
  if (rootLineage) {
    await hooks.beforeRootRealpath?.();
    initialRoot = await pinStagingDirectory(requestedRoot, rootLineage.realPath);
    assertDirectoryLineage(rootLineage, initialRoot);
  } else {
    initialRoot = await pinStagingDirectory(requestedRoot, undefined, hooks.beforeRootRealpath);
  }
  const canonicalRoot = initialRoot.realPath;
  const root = await secureDirectoryAtPath(requestedRoot, canonicalRoot);
  assertDirectoryLineage(initialRoot, {
    realPath: root.realPath,
    dev: root.stat.dev,
    ino: root.stat.ino,
    ctimeNs: root.stat.ctimeNs
  });
  const files: SkillPackageFileEvidence[] = [];
  let totalBytes = 0;
  let skillMarkdown: string | undefined;
  let openAiMetadata: string | undefined;
  let hasExternalUrls = false;
  const externalOrigins = new Set<string>();
  const referencePaths: string[] = [];
  let entryCount = 0;

  const visit = async (current: string, relativeDirectory: string): Promise<void> => {
    const depth = relativeDirectory ? relativeDirectory.split("/").length : 0;
    if (depth > MAX_SKILL_DIRECTORY_DEPTH) {
      throw archiveError("SKILL_PACKAGE_DEPTH_LIMIT", "Skill 包目录层级超限。");
    }
    const expectedRealPath = relativeDirectory
      ? path.join(canonicalRoot, ...relativeDirectory.split("/"))
      : canonicalRoot;
    const initial = await secureDirectoryAtPath(current, expectedRealPath);
    await hooks.beforeDirectoryRead?.(current, relativeDirectory);
    const before = await secureDirectoryAtPath(current, expectedRealPath);
    assertSameIdentity(initial.stat, before.stat);
    const directoryHandle = await fs.opendir(current);
    const opened = await secureDirectoryAtPath(current, expectedRealPath);
    assertSameIdentity(before.stat, opened.stat);
    const entries = [];
    try {
      for await (const entry of directoryHandle) {
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          throw archiveError("SKILL_ARCHIVE_ENTRY_LIMIT", "Skill 包文件和目录数量超限。");
        }
        entries.push(entry);
      }
    } catch (error) {
      try { await directoryHandle.close(); } catch { /* for-await may already have closed it */ }
      throw error;
    }
    const after = await secureDirectoryAtPath(current, expectedRealPath);
    assertSameIdentity(before.stat, after.stat);
    for (const entry of entries.sort((left, right) => compareBinaryText(left.name, right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validatePortablePath(relative);
      const absolute = path.join(current, entry.name);
      const stat = await lstatPackagePath(absolute);
      if (stat.isSymbolicLink()) throw archiveError("SKILL_PACKAGE_LINK_REJECTED", "Skill 包不能包含符号链接。");
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw archiveError("SKILL_PACKAGE_SPECIAL_FILE_REJECTED", "Skill 包只能包含单链接普通文件。");
      }
      const fileBytes = boundedStatSize(stat.size, limits.maxFileBytes);
      if (totalBytes > limits.maxTotalBytes - fileBytes) {
        throw archiveError("SKILL_ARCHIVE_TOTAL_LIMIT", "Skill 包文件数量或体积超限。");
      }
      const content = await readRegularFile(
        absolute,
        path.join(canonicalRoot, ...relative.split("/")),
        stat,
        limits.maxFileBytes,
        async () => hooks.beforeFileOpen?.(absolute, relative)
      );
      try {
        totalBytes += content.length;
        files.push({ path: relative, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
        if (relative === "SKILL.md") skillMarkdown = decodeUtf8(content);
        if (relative === "agents/openai.yaml") openAiMetadata = decodeUtf8(content, "agents/openai.yaml");
        if (containsExternalUrl(content)) hasExternalUrls = true;
        for (const origin of externalUrlOrigins(content)) {
          externalOrigins.add(origin);
          if (externalOrigins.size > 32) {
            throw archiveError("SKILL_EXTERNAL_ORIGIN_LIMIT", "Skill 外部来源数量超限。");
          }
        }
      } finally {
        content.fill(0);
      }
      if (relative.startsWith("references/")) {
        if (relative.split("/").length !== 2) {
          throw archiveError("SKILL_REFERENCE_DEPTH_INVALID", "Skill reference 只允许一层目录。");
        }
        referencePaths.push(relative);
      }
    }
  };
  await visit(requestedRoot, "");
  if (skillMarkdown == null) throw archiveError("SKILL_ENTRY_MISSING", "Skill 根目录缺少 SKILL.md。");
  for (const reference of referencePaths) {
    if (!skillMarkdown.includes(reference)) {
      throw archiveError("SKILL_REFERENCE_UNDISCLOSED", "每个 reference 都必须由 SKILL.md 直接引用。");
    }
  }
  try {
    const parsedOpenAi = openAiMetadata == null
      ? { allowImplicitInvocation: null, mcpDependencies: [] }
      : parseOpenAiSkillMetadata(openAiMetadata);
    return buildSkillPackageEvidence(files, parseSkillFrontmatter(skillMarkdown), {
      hasScripts: files.some((file) => file.path.startsWith("scripts/")),
      hasExternalUrls,
      externalOrigins: [...externalOrigins].sort(compareBinaryText),
      ...parsedOpenAi
    });
  } catch (error) {
    if (error instanceof AgentExtensionServiceError) throw error;
    if (isSkillError(error)) throw archiveError(error.code, error.message, error);
    throw error;
  }
}

async function readEntry(zipFile: yauzl.ZipFile, entry: Entry, maximum: number) {
  const stream = await zipFile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes > maximum - buffer.length) {
      stream.destroy();
      throw archiveError("SKILL_ARCHIVE_FILE_LIMIT", "Skill ZIP 单文件展开体积超限。");
    }
    bytes += buffer.length;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function validateEntry(entry: Entry, pathKeys: Set<string>, limits: Required<SkillArchiveLimits>) {
  if (entry.isEncrypted() || !entry.canDecodeFileData() || ![0, 8].includes(entry.compressionMethod)) {
    throw archiveError("SKILL_ARCHIVE_UNSUPPORTED", "Skill ZIP 包含加密或不支持的压缩格式。");
  }
  const directory = entry.fileName.endsWith("/");
  const relative = directory ? entry.fileName.slice(0, -1) : entry.fileName;
  validatePortablePath(relative);
  const key = relative.normalize("NFKC").toLocaleLowerCase("en-US");
  if (pathKeys.has(key)) throw archiveError("SKILL_ARCHIVE_DUPLICATE_PATH", "Skill ZIP 包含重复或跨平台冲突路径。");
  pathKeys.add(key);
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      entry.uncompressedSize > limits.maxFileBytes || (directory && entry.uncompressedSize !== 0)) {
    throw archiveError("SKILL_ARCHIVE_FILE_LIMIT", "Skill ZIP 单文件展开体积超限。");
  }
  if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
      entry.uncompressedSize > Math.max(1, entry.compressedSize) * limits.maxCompressionRatio) {
    throw archiveError("SKILL_ARCHIVE_RATIO_LIMIT", "Skill ZIP 压缩比超限。");
  }
  assertSafeUnixType(entry, directory);
  return relative;
}

function archiveWrapper(entries: Array<{ relative: string; directory: boolean }>) {
  if (entries.some(({ relative, directory }) => !directory && relative === "SKILL.md")) return null;
  const topLevels = new Set(entries.map(({ relative }) => relative.split("/")[0]));
  if (topLevels.size !== 1) return null;
  const wrapper = [...topLevels][0];
  if (!wrapper || !entries.every(({ relative }) => relative === wrapper || relative.startsWith(`${wrapper}/`)) ||
      !entries.some(({ relative, directory }) => !directory && relative === `${wrapper}/SKILL.md`)) {
    return null;
  }
  return wrapper;
}

function stripArchiveWrapper(relative: string, wrapper: string | null, directory: boolean) {
  if (!wrapper) return relative;
  if (relative === wrapper) return directory ? "" : relative;
  return relative.slice(wrapper.length + 1);
}

function assertSafeUnixType(entry: Entry, directory: boolean) {
  const platform = entry.versionMadeBy >>> 8;
  if (platform !== 3) return;
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & 0o170000;
  if (type === 0) return;
  const expected = directory ? 0o040000 : 0o100000;
  if (type !== expected) {
    throw archiveError(
      type === 0o120000 ? "SKILL_ARCHIVE_LINK_REJECTED" : "SKILL_ARCHIVE_SPECIAL_FILE_REJECTED",
      "Skill ZIP 不能包含链接、设备或 FIFO。"
    );
  }
}

function validatePortablePath(relative: string) {
  if (!relative || relative.length > 240 || relative.startsWith("/") || relative.startsWith("\\") ||
      /^[A-Za-z]:/u.test(relative) || relative.includes("\\") || relative.includes("\0")) {
    throw archiveError("SKILL_ARCHIVE_PATH_INVALID", "Skill ZIP 路径无效。");
  }
  const segments = relative.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.length > 100 ||
        segment.endsWith(".") || segment.endsWith(" ") || /[:*?"<>|\u0001-\u001F\u007F]/u.test(segment) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment)) {
      throw archiveError("SKILL_ARCHIVE_PATH_INVALID", "Skill ZIP 路径无效。");
    }
  }
}

async function readRegularFile(
  filePath: string,
  expectedRealPath: string,
  expected: BigIntStats,
  maximum: number,
  beforeOpen: () => void | Promise<void>
) {
  await assertRegularFilePath(filePath, expectedRealPath, expected, maximum);
  await beforeOpen();
  const preOpen = await assertRegularFilePath(filePath, expectedRealPath, expected, maximum);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    assertRegularFileStat(before, maximum);
    const during = await assertRegularFilePath(filePath, expectedRealPath, before, maximum);
    assertSameIdentity(preOpen.stat, before);
    assertSameIdentity(before, during.stat);
    const content = await readExactlyBounded(handle, before.size, maximum);
    const after = await handle.stat({ bigint: true });
    assertRegularFileStat(after, maximum);
    const final = await assertRegularFilePath(filePath, expectedRealPath, after, maximum);
    assertSameIdentity(before, after);
    assertSameIdentity(after, final.stat);
    if (BigInt(content.length) !== before.size) packageChanged();
    return content;
  } finally {
    await handle.close();
  }
}

interface StagingDirectoryIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

class StagingDirectoryGuard {
  private readonly identities = new Map<string, StagingDirectoryIdentity>();

  private constructor(
    private readonly root: string,
    private readonly hooks?: SkillArchiveExtractionHooks
  ) {}

  static async create(root: string, rootIdentity: StagingDirectoryIdentity, hooks?: SkillArchiveExtractionHooks) {
    const guard = new StagingDirectoryGuard(rootIdentity.realPath, hooks);
    const verified = await pinStagingDirectory(guard.root, rootIdentity.realPath);
    assertDirectoryLineage(rootIdentity, verified);
    guard.identities.set(guard.root, rootIdentity);
    return guard;
  }

  identity(directory: string) {
    return { ...this.requiredIdentity(path.resolve(directory)) };
  }

  async verifyAll() {
    for (const [directory, identity] of this.identities) {
      await verifyStagingDirectory(directory, identity);
    }
  }

  async createDirectory(directory: string) {
    const absolute = path.resolve(directory);
    if (this.identities.has(absolute)) {
      await verifyStagingDirectory(absolute, this.requiredIdentity(absolute));
      return;
    }
    const parent = path.dirname(absolute);
    this.requiredIdentity(parent);
    await this.hooks?.beforeStageOperation?.("mkdir", absolute);
    await this.verifyAll();
    const parentIdentity = this.requiredIdentity(parent);
    const result = await parentBoundMkdir({
      parent,
      parentIdentity,
      name: path.basename(absolute),
      hook: {
        beforeCommand: () => this.hooks?.beforeBoundStageOperation?.("mkdir", absolute)
      }
    });
    const created = result.result.created === true;
    if (created) await this.refresh(parent);
    const identity = await pinStagingDirectory(absolute, absolute);
    this.identities.set(absolute, identity);
    await this.verifyAll();
  }

  async writeFile(filePath: string, content: Buffer) {
    const absolute = path.resolve(filePath);
    const parent = path.dirname(absolute);
    this.requiredIdentity(parent);
    await this.hooks?.beforeStageOperation?.("write", absolute);
    await this.verifyAll();
    await parentBoundExclusiveWrite({
      parent,
      parentIdentity: this.requiredIdentity(parent),
      name: path.basename(absolute),
      content,
      hook: {
        beforeCommand: () => this.hooks?.beforeBoundStageOperation?.("write", absolute)
      }
    });
    await this.refresh(parent);
    await this.verifyAll();
  }

  async quarantine(container: string) {
    const absolute = path.resolve(container);
    let current;
    try { current = await lstatBig(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!current.isDirectory() || current.isSymbolicLink()) packageChanged();
    const expected = this.requiredIdentity(absolute);
    await this.hooks?.beforeStageOperation?.("quarantine", absolute);
    await this.verifyAll();
    const quarantine = path.join(this.root, `.skill-quarantine-${randomUUID()}`);
    await parentBoundRename({
      source: absolute,
      destination: quarantine,
      parentIdentity: this.requiredIdentity(this.root),
      expectedSource: current,
      hook: {
        beforeCommand: () => this.hooks?.beforeBoundStageOperation?.("quarantine", absolute)
      }
    });
    await this.refresh(this.root);
    const moved = await pinStagingDirectory(quarantine, quarantine);
    if (moved.dev !== expected.dev || moved.ino !== expected.ino) {
      packageChanged();
    }
  }

  private requiredIdentity(directory: string) {
    const identity = this.identities.get(directory);
    if (!identity) throw archiveError("SKILL_STAGING_INVALID", "Skill 暂存目录身份无效。");
    return identity;
  }

  private async refresh(directory: string) {
    const expected = this.requiredIdentity(directory);
    const current = await pinStagingDirectory(directory, expected.realPath);
    if (current.dev !== expected.dev || current.ino !== expected.ino) packageChanged();
    this.identities.set(directory, current);
  }
}

async function pinStagingDirectory(
  directory: string,
  expectedRealPath?: string,
  beforeRealpath?: () => void | Promise<void>
) {
  const before = await lstatBig(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) packageChanged();
  await beforeRealpath?.();
  const realPath = await fs.realpath(directory);
  const [after, canonical] = await Promise.all([lstatBig(directory), lstatBig(realPath)]);
  if (!after.isDirectory() || after.isSymbolicLink() || !canonical.isDirectory() || canonical.isSymbolicLink()) {
    packageChanged();
  }
  assertSameDirectoryIdentity(before, after);
  assertSameDirectoryIdentity(after, canonical);
  if (expectedRealPath != null && realPath !== expectedRealPath) packageChanged();
  return { realPath, dev: after.dev, ino: after.ino, ctimeNs: after.ctimeNs };
}

function assertDirectoryLineage(left: StagingDirectoryIdentity, right: StagingDirectoryIdentity) {
  if (left.realPath !== right.realPath || left.dev !== right.dev || left.ino !== right.ino ||
      left.ctimeNs !== right.ctimeNs) packageChanged();
}

async function verifyStagingDirectory(directory: string, expected: StagingDirectoryIdentity) {
  const current = await pinStagingDirectory(directory, expected.realPath);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.ctimeNs !== expected.ctimeNs) {
    packageChanged();
  }
}

function assertSameDirectoryIdentity(left: BigIntStats, right: BigIntStats) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.ctimeNs !== right.ctimeNs) packageChanged();
}

async function readExactlyBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: bigint,
  maximum: number
) {
  if (size < 0n || size > BigInt(maximum) || size > BigInt(Number.MAX_SAFE_INTEGER)) packageChanged();
  const length = Number(size);
  const content = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(content, offset, length - offset, offset);
    if (bytesRead === 0) packageChanged();
    offset += bytesRead;
  }
  const probe = Buffer.allocUnsafe(1);
  if ((await handle.read(probe, 0, 1, length)).bytesRead !== 0) packageChanged();
  return content;
}

function boundedStatSize(size: bigint, maximum: number) {
  if (size < 0n || size > BigInt(maximum) || size > BigInt(Number.MAX_SAFE_INTEGER)) packageChanged();
  return Number(size);
}

function lstatBig(candidate: string) {
  return fs.lstat(candidate, { bigint: true });
}

async function secureDirectoryAtPath(directory: string, expectedRealPath: string) {
  let stat: BigIntStats;
  let realPath: string;
  try {
    stat = await lstatBig(directory);
    realPath = await fs.realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") packageChanged();
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realPath !== expectedRealPath) packageChanged();
  return { stat, realPath };
}

async function assertRegularFilePath(
  filePath: string,
  expectedRealPath: string,
  expected: BigIntStats,
  maximum: number
) {
  let stat: BigIntStats;
  let realPath: string;
  try {
    stat = await lstatBig(filePath);
    realPath = await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") packageChanged();
    throw error;
  }
  assertRegularFileStat(stat, maximum);
  if (realPath !== expectedRealPath) packageChanged();
  assertSameIdentity(expected, stat);
  return { stat, realPath };
}

function assertRegularFileStat(stat: BigIntStats, maximum: number) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(maximum)) packageChanged();
}

function assertSameIdentity(left: BigIntStats, right: BigIntStats) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size ||
      left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs) packageChanged();
}

function packageChanged(): never {
  throw archiveError("SKILL_PACKAGE_CHANGED", "Skill 文件在校验期间发生变化。");
}

async function lstatPackagePath(filePath: string) {
  try { return await lstatBig(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") packageChanged();
    throw error;
  }
}

async function mkdirSafe(root: string, relative: string, guard: StagingDirectoryGuard) {
  if (!relative || relative === ".") return;
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    await guard.createDirectory(current);
  }
}

function decodeUtf8(content: Buffer, label = "SKILL.md") {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw archiveError("SKILL_ENTRY_ENCODING_INVALID", `${label} 必须是有效 UTF-8。`, error);
  }
}

function containsExternalUrl(content: Buffer) {
  return /https?:\/\//iu.test(content.toString("latin1"));
}

function externalUrlOrigins(content: Buffer) {
  const source = content.toString("latin1");
  const matches = source.match(/https?:\/\/[^\s"'<>\u0000-\u001F\u007F]+/giu) ?? [];
  const origins = new Set<string>();
  for (const candidate of matches) {
    const trimmed = candidate.replace(/[),.;\]}]+$/u, "");
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") origins.add(parsed.origin);
    } catch { /* malformed links remain represented by hasExternalUrls */ }
  }
  return origins;
}

function resolvedLimits(input: SkillArchiveLimits = {}): Required<SkillArchiveLimits> {
  const resolved = { ...DEFAULT_SKILL_ARCHIVE_LIMITS, ...input };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function assertWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw archiveError("SKILL_ARCHIVE_PATH_INVALID", "Skill ZIP 路径越界。");
  }
}

function noFollowFlag() {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

async function syncDirectory(directory: string) {
  const identity = await pinStagingDirectory(directory, path.resolve(directory));
  await parentBoundSync({ directory, identity });
}

function archiveError(code: string, message: string, _cause?: unknown) {
  return new AgentExtensionServiceError(400, code, message);
}

function isSkillError(error: unknown): error is Error & { code: string } {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("SKILL_");
}
