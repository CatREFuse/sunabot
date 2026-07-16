import { randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentExtensionServiceError } from "../../services/extensions/public.js";
import {
  parentBoundAtomicReplace,
  parentBoundCreateIfMissing,
  parentBoundExclusiveWrite,
  parentBoundMkdir,
  parentBoundRename,
  parentBoundSync,
  parseParentBoundPathIdentity,
  type ParentBoundWorkerFailureMode
} from "./parentBoundFs.js";

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_LOCK_BYTES = 128;
const heldFileLocks = new Map<string, string>();

export type AgentExtensionBeforeFileOpen = (filePath: string) => void | Promise<void>;

export interface PinnedDirectoryIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

export async function pinDirectoryIdentity(
  directory: string,
  expectedRealPath?: string,
  beforeRealpath?: () => void | Promise<void>
): Promise<PinnedDirectoryIdentity> {
  const initial = await lstatBig(directory);
  assertRegularDirectory(initial);
  await beforeRealpath?.();
  const realPath = await fs.realpath(directory);
  const [after, canonical] = await Promise.all([lstatBig(directory), lstatBig(realPath)]);
  assertRegularDirectory(after);
  assertRegularDirectory(canonical);
  assertSameDirectory(initial, after);
  assertSameDirectory(after, canonical);
  if (expectedRealPath != null && realPath !== expectedRealPath) directoryChanged();
  return { realPath, dev: after.dev, ino: after.ino, ctimeNs: after.ctimeNs };
}

export async function pinPrivateDirectoryIdentity(
  directory: string,
  expectedRealPath?: string,
  beforeRealpath?: () => void | Promise<void>
) {
  const identity = await pinDirectoryIdentity(directory, expectedRealPath, beforeRealpath);
  const stat = await lstatBig(identity.realPath);
  assertPrivateDirectoryStat(stat);
  if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.ctimeNs !== identity.ctimeNs) directoryChanged();
  return identity;
}

export async function verifyPinnedDirectory(directory: string, expected: PinnedDirectoryIdentity) {
  const current = await pinDirectoryIdentity(directory, expected.realPath);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.ctimeNs !== expected.ctimeNs) {
    directoryChanged();
  }
  return current;
}

export async function refreshPinnedDirectory(directory: string, expected: PinnedDirectoryIdentity) {
  const current = await pinDirectoryIdentity(directory, expected.realPath);
  if (current.dev !== expected.dev || current.ino !== expected.ino) directoryChanged();
  return current;
}

export async function verifyPrivatePinnedDirectory(directory: string, expected: PinnedDirectoryIdentity) {
  const current = await verifyPinnedDirectory(directory, expected);
  const stat = await lstatBig(current.realPath);
  assertPrivateDirectoryStat(stat);
  if (stat.dev !== current.dev || stat.ino !== current.ino || stat.ctimeNs !== current.ctimeNs) directoryChanged();
  return current;
}

export async function refreshPrivatePinnedDirectory(directory: string, expected: PinnedDirectoryIdentity) {
  const current = await refreshPinnedDirectory(directory, expected);
  const stat = await lstatBig(current.realPath);
  assertPrivateDirectoryStat(stat);
  if (stat.dev !== current.dev || stat.ino !== current.ino || stat.ctimeNs !== current.ctimeNs) directoryChanged();
  return current;
}

export function storeError(status: number, code: string, message: string) {
  return new AgentExtensionServiceError(status, code, message);
}

export function assertWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "Agent 扩展路径越界。");
  }
}

export async function assertExistingChain(root: string, relative: string) {
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await lstatBig(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw storeError(404, "AGENT_EXTENSION_AGENT_NOT_FOUND", "Agent 不存在。");
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "Agent 扩展路径包含无效目录。");
    }
  }
}

export async function assertOptionalChain(root: string, relative: string) {
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOptional(current);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "Agent 扩展路径包含无效目录。");
    }
  }
}

export async function mkdirChain(root: string, relative: string) {
  await assertCanonicalDirectory(root);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const parent = current;
    const parentIdentity = await pinDirectoryIdentity(parent, parent);
    current = path.join(parent, segment);
    await parentBoundMkdir({ parent, parentIdentity, name: segment });
    const stat = await lstatBig(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "Agent 扩展路径包含无效目录。");
    }
  }
}

export async function readJson(filePath: string, beforeOpen?: AgentExtensionBeforeFileOpen) {
  const content = await readBoundedFile(filePath, MAX_CONFIG_BYTES, beforeOpen);
  try { return JSON.parse(content.toString("utf8")) as unknown; } catch {
    throw storeError(409, "AGENT_EXTENSION_CONFIG_INVALID", "Agent 扩展配置不是有效 JSON。");
  }
}

export async function atomicJson(
  filePath: string,
  value: unknown,
  parentIdentity?: PinnedDirectoryIdentity
) {
  return atomicFile(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    0o600,
    parentIdentity
  );
}

export async function writeJsonIfMissing(
  filePath: string,
  value: unknown,
  validate: (value: unknown) => void,
  beforeOpen?: AgentExtensionBeforeFileOpen
) {
  const created = await createFileIfMissing(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    0o600
  );
  if (!created) validate(await readJson(filePath, beforeOpen));
}

export async function acquireFileLock(
  requestedLockPath: string,
  options?: {
    faultAt?: "before_response";
    workerFailureMode?: ParentBoundWorkerFailureMode;
    workerTimeoutMs?: number;
  }
) {
  const lockPath = path.resolve(requestedLockPath);
  if (heldFileLocks.has(lockPath)) {
    throw storeError(409, "AGENT_EXTENSION_BUSY", "Agent 扩展正在被其他操作修改。");
  }
  const ownerToken = `${process.pid}:${randomUUID()}\n`;
  const attempts = 51;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const parent = path.dirname(lockPath);
      const parentIdentity = await pinDirectoryIdentity(parent, parent);
      let lockIdentity: ReturnType<typeof parseParentBoundPathIdentity>;
      try {
        const result = await parentBoundExclusiveWrite({
          parent,
          parentIdentity,
          name: path.basename(lockPath),
          content: Buffer.from(ownerToken),
          faultAt: options?.faultAt,
          workerFailureMode: options?.workerFailureMode,
          workerTimeoutMs: options?.workerTimeoutMs
        });
        lockIdentity = parseParentBoundPathIdentity(result.result.identity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
        const reconciled = await reconcileOwnedLock(lockPath, ownerToken);
        if (!reconciled) throw error;
        lockIdentity = reconciled;
      }
      heldFileLocks.set(lockPath, ownerToken);
      let released = false;
      const tombstone = path.join(parent, `.extension-lock-tombstone-${randomUUID()}`);
      return {
        async close() {
          if (released) return;
          const currentParent = await pinDirectoryIdentity(parent, parentIdentity.realPath);
          if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) directoryChanged();
          try {
            await parentBoundRename({
              source: lockPath,
              destination: tombstone,
              parentIdentity: currentParent,
              expectedSource: lockIdentity
            });
          } catch (error) {
            if (!await reconciledLockMove(lockPath, tombstone, ownerToken, lockIdentity)) throw error;
          }
          released = true;
          if (heldFileLocks.get(lockPath) === ownerToken) heldFileLocks.delete(lockPath);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && await removeDeadProcessLock(lockPath)) continue;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw storeError(409, "AGENT_EXTENSION_BUSY", "Agent 扩展正在被其他操作修改。");
    }
  }
  throw storeError(409, "AGENT_EXTENSION_BUSY", "Agent 扩展正在被其他操作修改。");
}

export async function syncDirectory(directory: string, expectedIdentity?: PinnedDirectoryIdentity) {
  const identity = expectedIdentity
    ? await verifyPrivatePinnedDirectory(directory, expectedIdentity)
    : await pinDirectoryIdentity(directory, path.resolve(directory));
  await parentBoundSync({ directory, identity });
}

export async function exists(candidate: string) {
  try { await lstatBig(candidate); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function lstatOptional(candidate: string) {
  try { return await lstatBig(candidate); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicFile(
  filePath: string,
  content: Buffer,
  mode: number,
  expectedParentIdentity?: PinnedDirectoryIdentity
) {
  if (mode !== 0o600) throw storeError(500, "AGENT_EXTENSION_MODE_INVALID", "扩展文件权限无效。");
  const parent = path.dirname(filePath);
  const parentIdentity = expectedParentIdentity
    ? await verifyPrivatePinnedDirectory(parent, expectedParentIdentity)
    : await pinDirectoryIdentity(parent, parent);
  const target = await lstatOptional(filePath);
  if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n)) {
    throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "扩展配置必须是单链接普通文件。");
  }
  const result = await parentBoundAtomicReplace({
    filePath,
    parentIdentity,
    content,
    expectedTarget: target
  });
  return {
    realPath: result.parentRealPath,
    dev: result.parentIdentity.dev,
    ino: result.parentIdentity.ino,
    ctimeNs: result.parentIdentity.ctimeNs
  } satisfies PinnedDirectoryIdentity;
}

async function createFileIfMissing(filePath: string, content: Buffer, mode: number) {
  if (mode !== 0o600) throw storeError(500, "AGENT_EXTENSION_MODE_INVALID", "扩展文件权限无效。");
  const parent = path.dirname(filePath);
  const parentIdentity = await pinDirectoryIdentity(parent, parent);
  const result = await parentBoundCreateIfMissing({ filePath, parentIdentity, content });
  return result.result.created === true;
}

async function readBoundedFile(
  filePath: string,
  maximum: number,
  beforeOpen?: AgentExtensionBeforeFileOpen
) {
  const initial = await secureFileAtPath(filePath, maximum);
  await beforeOpen?.(filePath);
  const preOpen = await secureFileAtPath(filePath, maximum);
  assertSameFile(initial.stat, preOpen.stat);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    assertSecureFile(before, maximum);
    const during = await secureFileAtPath(filePath, maximum);
    assertSameFile(preOpen.stat, before);
    assertSameFile(before, during.stat);
    const content = await readExactlyBounded(handle, before.size, maximum);
    const after = await handle.stat({ bigint: true });
    assertSecureFile(after, maximum);
    const final = await secureFileAtPath(filePath, maximum);
    assertSameFile(before, after);
    assertSameFile(after, final.stat);
    if (BigInt(content.length) !== before.size) fileChanged();
    return content;
  } finally {
    await handle.close();
  }
}

async function readExactlyBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: bigint,
  maximum: number
) {
  if (size < 0n || size > BigInt(maximum) || size > BigInt(Number.MAX_SAFE_INTEGER)) fileChanged();
  const length = Number(size);
  const content = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(content, offset, length - offset, offset);
    if (bytesRead === 0) fileChanged();
    offset += bytesRead;
  }
  const probe = Buffer.allocUnsafe(1);
  if ((await handle.read(probe, 0, 1, length)).bytesRead !== 0) fileChanged();
  return content;
}

function lstatBig(candidate: string) {
  return fs.lstat(candidate, { bigint: true });
}

async function secureFileAtPath(filePath: string, maximum: number) {
  let stat: BigIntStats;
  let realPath: string;
  try {
    stat = await lstatBig(filePath);
    realPath = await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fileChanged();
    throw error;
  }
  assertSecureFile(stat, maximum);
  if (realPath !== path.resolve(filePath)) fileChanged();
  return { stat, realPath };
}

function assertSecureFile(stat: BigIntStats, maximum: number) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(maximum)) {
    throw storeError(409, "AGENT_EXTENSION_CONFIG_INVALID", "扩展文件权限或类型无效。");
  }
}

function assertSameFile(left: BigIntStats, right: BigIntStats) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size ||
      left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs) fileChanged();
}

function fileChanged(): never {
  throw storeError(409, "AGENT_EXTENSION_FILE_CHANGED", "扩展文件在读取期间发生变化。");
}

function noFollowFlag() {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

async function assertCanonicalDirectory(directory: string) {
  await pinDirectoryIdentity(directory, path.resolve(directory));
}

function assertRegularDirectory(stat: BigIntStats) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) directoryChanged();
}

function assertPrivateDirectoryStat(stat: BigIntStats) {
  assertRegularDirectory(stat);
  const getuid = typeof process.getuid === "function" ? process.getuid() : null;
  if ((stat.mode & 0o777n) !== 0o700n || stat.nlink < 1n ||
      (getuid != null && stat.uid !== BigInt(getuid))) {
    throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "Agent 扩展目录权限或所有者无效。");
  }
}

function assertSameDirectory(left: BigIntStats, right: BigIntStats) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.ctimeNs !== right.ctimeNs) directoryChanged();
}

function directoryChanged(): never {
  throw storeError(409, "AGENT_EXTENSION_PATH_CHANGED", "Agent 扩展目录在操作期间发生变化。");
}

async function removeDeadProcessLock(lockPath: string) {
  const before = await lstatOptional(lockPath);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(MAX_LOCK_BYTES)) return false;
  let raw: string;
  try {
    raw = (await readBoundedFile(lockPath, MAX_LOCK_BYTES)).toString("utf8").trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === "AGENT_EXTENSION_FILE_CHANGED") return false;
    throw error;
  }
  const match = /^(?<pid>[1-9][0-9]*)(?::[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/iu.exec(raw);
  const pid = Number(match?.groups?.pid ?? NaN);
  if (!Number.isSafeInteger(pid) || pid < 1 || processIsAlive(pid)) return false;
  const after = await lstatOptional(lockPath);
  if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return false;
  const parent = path.dirname(lockPath);
  const parentIdentity = await pinDirectoryIdentity(parent, parent);
  const tombstone = path.join(parent, `.extension-lock-tombstone-${randomUUID()}`);
  try {
    await parentBoundRename({
      source: lockPath,
      destination: tombstone,
      parentIdentity,
      expectedSource: after
    });
  } catch (error) {
    if (!await reconciledLockMove(lockPath, tombstone, `${raw}\n`, parseParentBoundPathIdentity(serializeLockIdentity(after)))) {
      throw error;
    }
  }
  return true;
}

async function reconcileOwnedLock(lockPath: string, ownerToken: string) {
  const stat = await lstatOptional(lockPath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      stat.size !== BigInt(Buffer.byteLength(ownerToken))) return null;
  let content: string;
  try {
    content = (await readBoundedFile(lockPath, MAX_LOCK_BYTES)).toString("utf8");
  } catch {
    return null;
  }
  if (content !== ownerToken) return null;
  const after = await lstatOptional(lockPath);
  if (!after || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) return null;
  return parseParentBoundPathIdentity(serializeLockIdentity(after));
}

async function reconciledLockMove(
  source: string,
  tombstone: string,
  ownerToken: string,
  expected: ReturnType<typeof parseParentBoundPathIdentity>
) {
  if (await lstatOptional(source)) return false;
  const terminal = await lstatOptional(tombstone);
  if (!terminal || !terminal.isFile() || terminal.isSymbolicLink() || terminal.nlink !== 1n ||
      terminal.dev !== expected.dev || terminal.ino !== expected.ino) return false;
  try {
    return (await readBoundedFile(tombstone, MAX_LOCK_BYTES)).toString("utf8") === ownerToken;
  } catch {
    return false;
  }
}

function serializeLockIdentity(stat: BigIntStats) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    nlink: stat.nlink.toString(),
    mode: stat.mode.toString(),
    kind: stat.isDirectory() ? "directory" : "file"
  };
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
