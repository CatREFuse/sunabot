import crypto from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parentBoundCreateIfMissing,
  parentBoundMkdir,
  parentBoundUnlink,
  parseParentBoundPathIdentity,
  type ParentBoundMutationResult,
  type ParentBoundPathIdentity
} from "../../adapters/filesystem/parentBoundFs.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../config.js";
import type { AppConfig, ImageResult } from "../types.js";
import { AdminApiError } from "./errors.js";

const MAX_STORED_EMOJI_BYTES = 16 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF87A_SIGNATURE = Buffer.from("GIF87a", "ascii");
const GIF89A_SIGNATURE = Buffer.from("GIF89a", "ascii");

export interface EmojiLibraryOperationHooks {
  afterGeneratedSourceOpened?: (context: { filePath: string }) => void | Promise<void>;
  afterGeneratedSourceRead?: (context: { filePath: string }) => void | Promise<void>;
  beforePublishDirectoryCreate?: (context: { directory: string }) => void | Promise<void>;
  afterPublishDirectoryFrozen?: (context: EmojiPublishHookContext) => void | Promise<void>;
  beforePublish?: (context: EmojiPublishHookContext) => void | Promise<void>;
  afterPublish?: (context: EmojiPublishHookContext) => void | Promise<void>;
}

interface EmojiPublishHookContext {
  directory: string;
  filePath: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  nlink: bigint;
}

interface FrozenDirectoryChain {
  root: string;
  directory: string;
  realDirectory: string;
  paths: string[];
  identities: FileIdentity[];
}

export async function readGeneratedEmojiImage(
  config: AppConfig,
  image: ImageResult,
  hooks: EmojiLibraryOperationHooks
) {
  let sourcePath: unknown;
  try {
    sourcePath = image.filePath;
  } catch {
    throw generationUnavailable();
  }
  const filePath = typeof sourcePath === "string" && sourcePath ? path.resolve(sourcePath) : "";
  if (!filePath || path.extname(filePath).toLowerCase() !== ".png") {
    throw generationUnavailable();
  }
  const agentId = config.persona.defaultAgentId.trim() || "plana";
  const expectedDirectory = agentId === "plana"
    ? getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
    : getWorkspacePath(WORKSPACE_LAYOUT.mediaImages, "agents", agentId);
  if (path.dirname(filePath) !== expectedDirectory) {
    throw new AdminApiError(502, "EMOJI_GENERATION_UNAVAILABLE", "生图结果不属于当前 Agent。");
  }
  try {
    assertNoFollowAvailable();
    const directoryChain = await freezeDirectoryChain(path.resolve(getWorkspacePath()), expectedDirectory);
    const directoryHandle = await openDirectoryNoFollow(expectedDirectory);
    let operationFailed = false;
    try {
      await assertFrozenDirectoryChain(directoryChain);
      await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
      const pathIdentity = await lstatRegularFile(filePath, MAX_STORED_EMOJI_BYTES);
      const handle = await fs.open(filePath, requiredOpenFlags(fsConstants.O_RDONLY));
      let readFailed = false;
      try {
        const openedIdentity = fileIdentity(await handle.stat({ bigint: true }));
        if (!sameFileIdentity(pathIdentity, openedIdentity)) throw new Error("Generated image identity changed.");
        await hooks.afterGeneratedSourceOpened?.({ filePath });
        const bytes = await readBoundedFile(handle, openedIdentity.size, MAX_STORED_EMOJI_BYTES);
        assertPngSignature(bytes);
        await hooks.afterGeneratedSourceRead?.({ filePath });
        const afterReadIdentity = fileIdentity(await handle.stat({ bigint: true }));
        const afterPathIdentity = await lstatRegularFile(filePath, MAX_STORED_EMOJI_BYTES);
        if (
          !sameFileIdentity(openedIdentity, afterReadIdentity)
          || !sameFileIdentity(openedIdentity, afterPathIdentity)
        ) {
          throw new Error("Generated image identity changed.");
        }
        await assertFrozenDirectoryChain(directoryChain);
        await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
        return bytes;
      } catch (error) {
        readFailed = true;
        throw error;
      } finally {
        try {
          await handle.close();
        } catch (error) {
          if (!readFailed) throw error;
        }
      }
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await directoryHandle.close();
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
  } catch {
    throw generationUnavailable();
  }
}

export async function writeContentAddressedEmojiFile(
  filePath: string,
  bytes: Buffer,
  expectedHash: string,
  hooks: EmojiLibraryOperationHooks
) {
  const extension = path.extname(filePath).slice(1);
  if (
    !/^[0-9a-f]{64}$/u.test(expectedHash)
    || !["png", "gif"].includes(extension)
    || path.basename(filePath) !== `emoji-${expectedHash}.${extension}`
    || crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash
  ) {
    throw emojiImageConflict();
  }
  assertEmojiFileSignature(bytes, extension);
  const workspaceRoot = path.resolve(getWorkspacePath());
  const directory = path.dirname(filePath);
  const root = directory;
  const relativeDirectory = path.relative(root, directory);
  if (relativeDirectory.startsWith(`..${path.sep}`) || relativeDirectory === ".." || path.isAbsolute(relativeDirectory)) {
    throw emojiPathInvalid();
  }
  assertNoFollowAvailable();
  await ensureDirectoryChain(workspaceRoot, directory, hooks);
  const directoryChain = await freezeDirectoryChain(workspaceRoot, directory);
  await hooks.afterPublishDirectoryFrozen?.({ directory, filePath });
  await assertFrozenDirectoryChain(directoryChain);
  const directoryHandle = await openDirectoryNoFollow(directory);
  let operationFailed = false;
  let publishOutcome: ParentBoundMutationResult | undefined;
  let publishedIdentity: ParentBoundPathIdentity | undefined;
  let publishedByOperation = false;
  try {
    await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
    const existing = await readExistingContentAddressedFile(
      filePath,
      directoryChain,
      directoryHandle,
      expectedHash
    );
    if (existing) return;

    await assertFrozenDirectoryChain(directoryChain);
    await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
    const currentDirectoryIdentity = fileIdentity(await directoryHandle.stat({ bigint: true }));
    const publishContext = { directory, filePath };
    publishOutcome = await parentBoundCreateIfMissing({
      filePath: path.join(directoryChain.realDirectory, path.basename(filePath)),
      parentIdentity: {
        realPath: directoryChain.realDirectory,
        dev: currentDirectoryIdentity.dev,
        ino: currentDirectoryIdentity.ino,
        ctimeNs: currentDirectoryIdentity.ctimeNs
      },
      content: bytes,
      hook: hooks.beforePublish
        ? { beforeCommand: () => hooks.beforePublish?.(publishContext) }
        : undefined
    });
    publishedIdentity = parseParentBoundPathIdentity(publishOutcome.result.identity);
    if (typeof publishOutcome.result.created !== "boolean") throw emojiImageConflict();
    publishedByOperation = publishOutcome.result.created;
    assertBoundPublishParent(publishOutcome, directoryChain);
    await assertFrozenDirectoryChain(directoryChain);
    await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
    if (!publishedByOperation) {
      const concurrent = await readExistingContentAddressedFile(
        filePath,
        directoryChain,
        directoryHandle,
        expectedHash
      );
      if (!concurrent || !concurrent.bytes.equals(bytes)) throw emojiImageConflict();
      return;
    }
    await hooks.afterPublish?.({ directory, filePath });
    await directoryHandle.sync();
    await assertFrozenDirectoryChain(directoryChain);
    await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
    const published = await readVerifiedFile(filePath, MAX_STORED_EMOJI_BYTES);
    if (
      !sameFileIdentity(parentBoundFileIdentity(publishedIdentity), published.identity)
      || published.hash !== expectedHash
      || !published.bytes.equals(bytes)
    ) {
      throw emojiImageConflict();
    }
    publishedByOperation = false;
  } catch (error) {
    operationFailed = true;
    if (publishedByOperation && publishOutcome && publishedIdentity) {
      await removeParentBoundFile(
        publishOutcome,
        path.basename(filePath),
        publishedIdentity
      );
    }
    throw normalizePublishError(error);
  } finally {
    try {
      await directoryHandle.close();
    } catch (error) {
      if (!operationFailed) throw normalizePublishError(error);
    }
  }
}

async function readExistingContentAddressedFile(
  filePath: string,
  directoryChain: FrozenDirectoryChain,
  directoryHandle: fs.FileHandle,
  expectedHash: string
) {
  try {
    const existing = await readVerifiedFile(filePath, MAX_STORED_EMOJI_BYTES);
    await assertFrozenDirectoryChain(directoryChain);
    await assertDirectoryHandle(directoryHandle, directoryChain.identities.at(-1));
    if (existing.hash !== expectedHash) throw emojiImageConflict();
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readVerifiedFile(filePath: string, limit: number) {
  const pathIdentity = await lstatRegularFile(filePath, limit);
  const handle = await fs.open(filePath, requiredOpenFlags(fsConstants.O_RDONLY));
  let operationFailed = false;
  try {
    const openedIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(pathIdentity, openedIdentity)) throw emojiImageConflict();
    const bytes = await readBoundedFile(handle, openedIdentity.size, limit);
    const afterIdentity = fileIdentity(await handle.stat({ bigint: true }));
    const afterPathIdentity = await lstatRegularFile(filePath, limit);
    if (
      !sameFileIdentity(openedIdentity, afterIdentity)
      || !sameFileIdentity(openedIdentity, afterPathIdentity)
    ) {
      throw emojiImageConflict();
    }
    return {
      bytes,
      identity: afterIdentity,
      hash: crypto.createHash("sha256").update(bytes).digest("hex")
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

async function ensureDirectoryChain(
  root: string,
  directory: string,
  hooks: EmojiLibraryOperationHooks
) {
  const paths = directoryPaths(root, directory);
  for (const directoryPath of paths) {
    try {
      const stats = await fs.lstat(directoryPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw emojiPathInvalid();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || directoryPath === root) {
        throw normalizePublishError(error);
      }
      try {
        const parent = path.dirname(directoryPath);
        const beforeRealpath = await fs.lstat(parent, { bigint: true });
        if (beforeRealpath.isSymbolicLink() || !beforeRealpath.isDirectory()) {
          throw emojiPathInvalid();
        }
        const realParent = await fs.realpath(parent);
        const parentStats = await fs.lstat(parent, { bigint: true });
        if (
          parentStats.isSymbolicLink()
          || !parentStats.isDirectory()
          || !sameFileIdentity(fileIdentity(beforeRealpath), fileIdentity(parentStats))
        ) {
          throw emojiPathInvalid();
        }
        const outcome = await parentBoundMkdir({
          parent: realParent,
          parentIdentity: {
            realPath: realParent,
            dev: parentStats.dev,
            ino: parentStats.ino,
            ctimeNs: parentStats.ctimeNs
          },
          name: path.basename(directoryPath),
          hook: hooks.beforePublishDirectoryCreate
            ? { beforeCommand: () => hooks.beforePublishDirectoryCreate?.({ directory: directoryPath }) }
            : undefined
        });
        const createdIdentity = parseParentBoundPathIdentity(outcome.result.identity);
        if (
          typeof outcome.result.created !== "boolean"
          || createdIdentity.kind !== "directory"
          || outcome.parentRealPath !== realParent
          || outcome.parentIdentity.dev !== parentStats.dev
          || outcome.parentIdentity.ino !== parentStats.ino
        ) {
          throw emojiPathInvalid();
        }
        const created = await fs.lstat(directoryPath, { bigint: true });
        if (
          created.isSymbolicLink()
          || !created.isDirectory()
          || created.dev !== createdIdentity.dev
          || created.ino !== createdIdentity.ino
        ) {
          throw emojiPathInvalid();
        }
      } catch (createError) {
        throw normalizePublishError(createError);
      }
    }
  }
}

async function freezeDirectoryChain(root: string, directory: string): Promise<FrozenDirectoryChain> {
  const relative = requireContainedRelativePath(root, directory);
  const paths = directoryPaths(root, directory);
  const identities: FileIdentity[] = [];
  for (const directoryPath of paths) {
    const stats = await fs.lstat(directoryPath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw emojiPathInvalid();
    identities.push(fileIdentity(stats));
  }
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
  if (realDirectory !== path.resolve(realRoot, relative)) throw emojiPathInvalid();
  return { root, directory, realDirectory, paths, identities };
}

function assertBoundPublishParent(
  outcome: ParentBoundMutationResult,
  frozen: FrozenDirectoryChain
) {
  const expected = frozen.identities.at(-1);
  if (
    !expected
    || outcome.parentRealPath !== frozen.realDirectory
    || outcome.parentIdentity.dev !== expected.dev
    || outcome.parentIdentity.ino !== expected.ino
  ) {
    throw emojiPathInvalid();
  }
}

async function removeParentBoundFile(
  outcome: ParentBoundMutationResult,
  basename: string,
  expected: ParentBoundPathIdentity
) {
  try {
    const parentStats = await fs.lstat(outcome.parentRealPath, { bigint: true });
    if (
      parentStats.isSymbolicLink()
      || !parentStats.isDirectory()
      || parentStats.dev !== outcome.parentIdentity.dev
      || parentStats.ino !== outcome.parentIdentity.ino
    ) {
      return;
    }
    const filePath = path.join(outcome.parentRealPath, basename);
    const targetStats = await fs.lstat(filePath, { bigint: true });
    if (
      targetStats.isSymbolicLink()
      || !targetStats.isFile()
      || !sameObjectIdentity(expected, fileIdentity(targetStats))
    ) {
      return;
    }
    await parentBoundUnlink({
      filePath,
      parentIdentity: {
        realPath: outcome.parentRealPath,
        dev: parentStats.dev,
        ino: parentStats.ino,
        ctimeNs: parentStats.ctimeNs
      },
      expectedTarget: targetStats,
      allowParentCtimeChange: true
    });
  } catch {
    // Cleanup is only safe while the worker-bound parent and target inode still match.
  }
}

function parentBoundFileIdentity(identity: FileIdentity | ParentBoundPathIdentity): ParentBoundPathIdentity {
  return {
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
    mtimeNs: identity.mtimeNs,
    ctimeNs: identity.ctimeNs,
    nlink: identity.nlink,
    mode: identity.mode,
    kind: "file"
  };
}

async function assertFrozenDirectoryChain(frozen: FrozenDirectoryChain) {
  const [realRoot, realDirectory] = await Promise.all([
    fs.realpath(frozen.root),
    fs.realpath(frozen.directory)
  ]);
  const relative = requireContainedRelativePath(frozen.root, frozen.directory);
  if (realDirectory !== path.resolve(realRoot, relative)) throw emojiPathInvalid();
  for (let index = 0; index < frozen.paths.length; index += 1) {
    const stats = await fs.lstat(frozen.paths[index]!, { bigint: true });
    const expected = frozen.identities[index];
    if (
      !expected
      || stats.isSymbolicLink()
      || !stats.isDirectory()
      || !sameObjectIdentity(expected, fileIdentity(stats))
    ) {
      throw emojiPathInvalid();
    }
  }
}

async function assertDirectoryHandle(handle: fs.FileHandle, expected: FileIdentity | undefined) {
  const stats = await handle.stat({ bigint: true });
  if (!expected || !stats.isDirectory() || !sameObjectIdentity(expected, fileIdentity(stats))) {
    throw emojiPathInvalid();
  }
}

async function openDirectoryNoFollow(directory: string) {
  const directoryFlag = Reflect.get(fsConstants, "O_DIRECTORY");
  if (typeof directoryFlag !== "number") throw emojiPathInvalid();
  return fs.open(directory, requiredOpenFlags(fsConstants.O_RDONLY | directoryFlag));
}

function directoryPaths(root: string, directory: string) {
  const relative = requireContainedRelativePath(root, directory);
  const paths = [root];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return paths;
}

function requireContainedRelativePath(root: string, target: string) {
  const relative = path.relative(root, target);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw emojiPathInvalid();
  }
  return relative;
}

async function lstatRegularFile(filePath: string, limit: number) {
  const stats = await fs.lstat(filePath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0n || stats.size > BigInt(limit)) {
    throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
  }
  return fileIdentity(stats);
}

async function readBoundedFile(handle: fs.FileHandle, expectedSize: bigint, limit: number) {
  if (expectedSize <= 0n || expectedSize > BigInt(limit)) {
    throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
  }
  const size = Number(expectedSize);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead <= 0) throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
    offset += result.bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if ((await handle.read(trailing, 0, 1, size)).bytesRead !== 0) {
    throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
  }
  return bytes;
}

function fileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    mode: stats.mode,
    nlink: stats.nlink
  };
}

function sameObjectIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return sameObjectIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function requiredOpenFlags(base: number) {
  assertNoFollowAvailable();
  return base | fsConstants.O_NOFOLLOW;
}

function assertNoFollowAvailable() {
  const noFollow = Reflect.get(fsConstants, "O_NOFOLLOW");
  if (typeof noFollow !== "number" || noFollow === 0) throw emojiPathInvalid();
}

function assertPngSignature(bytes: Buffer) {
  if (bytes.byteLength < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new AdminApiError(415, "EMOJI_IMAGE_INVALID", "表情图片无法解码。");
  }
}

function assertEmojiFileSignature(bytes: Buffer, extension: string) {
  if (extension === "png") {
    assertPngSignature(bytes);
    return;
  }
  if (
    extension === "gif"
    && bytes.byteLength >= GIF87A_SIGNATURE.byteLength
    && (
      bytes.subarray(0, GIF87A_SIGNATURE.byteLength).equals(GIF87A_SIGNATURE)
      || bytes.subarray(0, GIF89A_SIGNATURE.byteLength).equals(GIF89A_SIGNATURE)
    )
  ) {
    return;
  }
  throw emojiImageConflict();
}

function generationUnavailable() {
  return new AdminApiError(502, "EMOJI_GENERATION_UNAVAILABLE", "生图结果不可用。");
}

function emojiImageConflict() {
  return new AdminApiError(409, "EMOJI_IMAGE_CONFLICT", "表情图片文件冲突。");
}

function emojiPathInvalid() {
  return new AdminApiError(500, "EMOJI_PATH_INVALID", "表情图片目录无效。");
}

function normalizePublishError(error: unknown) {
  if (error instanceof AdminApiError) return error;
  return emojiPathInvalid();
}
