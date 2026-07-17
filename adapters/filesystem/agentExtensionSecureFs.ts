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
  parentBoundReleaseLock,
  parentBoundRename,
  parentBoundUnlink,
  parentBoundSync,
  parseParentBoundPathIdentity,
  type ParentBoundPathIdentity,
  type ParentBoundReleaseLockFault,
  type ParentBoundReleaseLockPause,
  type ParentBoundWorkerFailureMode
} from "./parentBoundFs.js";

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_LOCK_BYTES = 128;
const LOCK_TOMBSTONE_PATTERN = /^\.extension-lock-tombstone-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCK_OWNER_TOKEN_PATTERN = /^[1-9][0-9]*(?::[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\n$/iu;
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

export async function atomicPrivateData(
  filePath: string,
  content: Buffer,
  parentIdentity?: PinnedDirectoryIdentity
) {
  return atomicFile(filePath, content, 0o600, parentIdentity);
}

export async function readPrivateData(
  filePath: string,
  maximum: number,
  beforeOpen?: AgentExtensionBeforeFileOpen
) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw storeError(500, "AGENT_EXTENSION_LIMIT_INVALID", "扩展文件读取上限无效。");
  }
  return readBoundedFile(filePath, maximum, beforeOpen);
}

export async function terminalizePrivateDataFile(source: string, destination: string) {
  const parent = path.dirname(source);
  if (path.dirname(destination) !== parent) {
    throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "扩展事务文件必须在同一目录终结。");
  }
  const parentIdentity = await pinPrivateDirectoryIdentity(parent, parent);
  const sourceStat = await lstatBig(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1n) {
    throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "扩展事务文件无效。");
  }
  await parentBoundRename({ source, destination, parentIdentity, expectedSource: sourceStat });
}

export async function removePrivateDataFile(filePath: string) {
  const parent = path.dirname(filePath);
  const parentIdentity = await pinPrivateDirectoryIdentity(parent, parent);
  const target = await lstatOptional(filePath);
  if (!target) return false;
  if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1n || (target.mode & 0o777n) !== 0o600n) {
    throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "扩展事务文件无效。");
  }
  await parentBoundUnlink({ filePath, parentIdentity, expectedTarget: target });
  return true;
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
    releaseFaultAt?: ParentBoundReleaseLockFault;
    releasePauseAt?: ParentBoundReleaseLockPause;
    releaseWorkerFailureMode?: ParentBoundWorkerFailureMode;
    releaseWorkerTimeoutMs?: number;
    beforeReleaseWorker?: () => void | Promise<void>;
    beforeReleaseFallbackUnlink?: () => void | Promise<void>;
    beforeTombstoneRead?: AgentExtensionBeforeFileOpen;
  }
) {
  const lockPath = path.resolve(requestedLockPath);
  if (heldFileLocks.has(lockPath)) {
    throw storeError(409, "AGENT_EXTENSION_BUSY", "Agent 扩展正在被其他操作修改。");
  }
  await garbageCollectFileLockTombstones(lockPath, options?.beforeTombstoneRead);
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
          workerTimeoutMs: options?.workerTimeoutMs, allowParentCtimeChange: true
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
      let closeOperation: Promise<void> | undefined;
      let tombstoneIdentity: ParentBoundPathIdentity | undefined;
      let logicallyReleased = false, releasePauseAt = options?.releasePauseAt;
      const tombstone = path.join(parent, `.extension-lock-tombstone-${randomUUID()}`);
      return {
        async close() {
          if (released) return;
          closeOperation ??= (async () => {
            if (!logicallyReleased) {
              const currentParent = await pinDirectoryIdentity(parent, parentIdentity.realPath);
              if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) {
                directoryChanged();
              }
              try {
                const pauseAt = releasePauseAt;
                releasePauseAt = undefined;
                const outcome = await parentBoundReleaseLock({
                  source: lockPath,
                  tombstone,
                  parentIdentity: currentParent,
                  expectedSource: lockIdentity,
                  faultAt: options?.releaseFaultAt,
                  pauseAt,
                  workerFailureMode: options?.releaseWorkerFailureMode,
                  hook: options?.beforeReleaseWorker
                    ? { beforeCommand: options.beforeReleaseWorker }
                    : undefined,
                  workerTimeoutMs: options?.releaseWorkerTimeoutMs, allowParentCtimeChange: true
                });
                assertLockReleasedResult(outcome.result);
                logicallyReleased = true;
                if (heldFileLocks.get(lockPath) === ownerToken) heldFileLocks.delete(lockPath);
                released = true;
                return;
              } catch (error) {
                const state = await reconcileLockRelease(lockPath, tombstone, ownerToken, lockIdentity);
                if (state.status === "unreleased") {
                  lockIdentity = state.identity;
                  throw error;
                }
                logicallyReleased = true;
                if (heldFileLocks.get(lockPath) === ownerToken) heldFileLocks.delete(lockPath);
                if (state.status === "released") {
                  released = true;
                  return;
                }
                tombstoneIdentity = state.identity;
              }
            }
            if (!tombstoneIdentity) directoryChanged();
            await removeLockTombstone({
              tombstone,
              expected: tombstoneIdentity,
              parentRealPath: parentIdentity.realPath,
              beforeUnlink: options?.beforeReleaseFallbackUnlink,
              workerTimeoutMs: options?.releaseWorkerTimeoutMs
            });
            released = true;
          })().catch((error) => {
            closeOperation = undefined;
            throw error;
          });
          await closeOperation;
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
  beforeOpen?: AgentExtensionBeforeFileOpen,
  expectedNlink = 1n
) {
  const initial = await secureFileAtPath(filePath, maximum, expectedNlink);
  await beforeOpen?.(filePath);
  const preOpen = await secureFileAtPath(filePath, maximum, expectedNlink);
  assertSameFile(initial.stat, preOpen.stat);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat({ bigint: true });
    assertSecureFile(before, maximum, expectedNlink);
    const during = await secureFileAtPath(filePath, maximum, expectedNlink);
    assertSameFile(preOpen.stat, before);
    assertSameFile(before, during.stat);
    const content = await readExactlyBounded(handle, before.size, maximum);
    const after = await handle.stat({ bigint: true });
    assertSecureFile(after, maximum, expectedNlink);
    const final = await secureFileAtPath(filePath, maximum, expectedNlink);
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

async function secureFileAtPath(filePath: string, maximum: number, expectedNlink = 1n) {
  let stat: BigIntStats;
  let realPath: string;
  try {
    stat = await lstatBig(filePath);
    realPath = await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fileChanged();
    throw error;
  }
  assertSecureFile(stat, maximum, expectedNlink);
  if (realPath !== path.resolve(filePath)) fileChanged();
  return { stat, realPath };
}

function assertSecureFile(stat: BigIntStats, maximum: number, expectedNlink = 1n) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== expectedNlink || stat.size > BigInt(maximum)) {
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
    const outcome = await parentBoundReleaseLock({
      source: lockPath,
      tombstone,
      parentIdentity,
      expectedSource: after, allowParentCtimeChange: true
    });
    assertLockReleasedResult(outcome.result);
    return true;
  } catch (error) {
    const state = await reconcileLockRelease(
      lockPath,
      tombstone,
      `${raw}\n`,
      parseParentBoundPathIdentity(serializeLockIdentity(after))
    );
    if (state.status === "unreleased") throw error;
    if (state.status === "released") return true;
    await removeLockTombstone({
      tombstone,
      expected: state.identity,
      parentRealPath: parentIdentity.realPath
    });
    return true;
  }
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

async function reconcileLockRelease(
  source: string,
  tombstone: string,
  ownerToken: string,
  expected: ParentBoundPathIdentity
): Promise<
  { status: "unreleased"; identity: ParentBoundPathIdentity } |
  { status: "released" } |
  { status: "tombstone"; identity: ParentBoundPathIdentity }
> {
  const currentSource = await lstatOptional(source);
  const terminal = await lstatOptional(tombstone);
  if (currentSource && terminal) {
    const identity = await recoverLinkedLockReservation(
      source,
      tombstone,
      currentSource,
      terminal,
      ownerToken,
      expected
    );
    return { status: "unreleased", identity };
  }
  if (currentSource) {
    if (!sameLockIdentity(currentSource, expected)) directoryChanged();
    try {
      if ((await readBoundedFile(source, MAX_LOCK_BYTES)).toString("utf8") !== ownerToken) directoryChanged();
    } catch {
      directoryChanged();
    }
    return {
      status: "unreleased",
      identity: parseParentBoundPathIdentity(serializeLockIdentity(currentSource))
    };
  }
  if (!terminal) return { status: "released" };
  if (!terminal.isFile() || terminal.isSymbolicLink() || terminal.nlink !== 1n ||
      terminal.dev !== expected.dev || terminal.ino !== expected.ino || terminal.size !== expected.size ||
      terminal.mtimeNs !== expected.mtimeNs || terminal.mode !== expected.mode) directoryChanged();
  try {
    if ((await readBoundedFile(tombstone, MAX_LOCK_BYTES)).toString("utf8") !== ownerToken) directoryChanged();
    return {
      status: "tombstone",
      identity: parseParentBoundPathIdentity(serializeLockIdentity(terminal))
    };
  } catch {
    directoryChanged();
  }
}

function assertLockReleasedResult(result: Record<string, unknown>) {
  if (Object.keys(result).length !== 1 || result.released !== true) {
    throw storeError(500, "AGENT_EXTENSION_LOCK_RELEASE_INVALID", "Agent 扩展锁释放结果无效。");
  }
}

async function garbageCollectFileLockTombstones(
  lockPath: string,
  beforeRead?: AgentExtensionBeforeFileOpen
) {
  const parent = path.dirname(lockPath);
  const pinnedParent = await pinPrivateDirectoryIdentity(parent, parent);
  const entries = await fs.readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(".extension-lock-tombstone-")) continue;
    if (!LOCK_TOMBSTONE_PATTERN.test(entry.name)) invalidLockTombstone();
    const tombstone = path.join(parent, entry.name);
    const before = await lstatOptional(tombstone);
    if (!before) {
      if (!await assertLockTombstoneAbsent(tombstone, pinnedParent)) directoryChanged();
      continue;
    }
    if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1n && before.nlink !== 2n) ||
        (before.mode & 0o777n) !== 0o600n || before.size < 1n || before.size > BigInt(MAX_LOCK_BYTES) ||
        (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
      invalidLockTombstone();
    }
    let content: string;
    try {
      content = (await readBoundedFile(tombstone, MAX_LOCK_BYTES, beforeRead, before.nlink)).toString("utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "ENOENT" || code === "AGENT_EXTENSION_FILE_CHANGED") &&
          await assertLockTombstoneAbsent(tombstone, pinnedParent)) continue;
      throw error;
    }
    if (!LOCK_OWNER_TOKEN_PATTERN.test(content)) invalidLockTombstone();
    const after = await lstatOptional(tombstone);
    if (!after) {
      if (!await assertLockTombstoneAbsent(tombstone, pinnedParent)) directoryChanged();
      continue;
    }
    if (!sameLockIdentity(after, parseParentBoundPathIdentity(serializeLockIdentity(before)))) {
      directoryChanged();
    }
    if (after.nlink === 2n) {
      const source = await lstatOptional(lockPath);
      if (!source) invalidLockTombstone();
      const expected = { ...parseParentBoundPathIdentity(serializeLockIdentity(source)), nlink: 1n };
      await recoverLinkedLockReservation(lockPath, tombstone, source, after, content, expected);
      continue;
    }
    await removeLockTombstone({
      tombstone,
      expected: parseParentBoundPathIdentity(serializeLockIdentity(after)),
      parentRealPath: parent
    });
  }
}

async function assertLockTombstoneAbsent(
  tombstone: string,
  expectedParent: PinnedDirectoryIdentity
) {
  if (await lstatOptional(tombstone)) return false;
  const currentParent = await pinPrivateDirectoryIdentity(expectedParent.realPath, expectedParent.realPath);
  if (currentParent.dev !== expectedParent.dev || currentParent.ino !== expectedParent.ino) directoryChanged();
  return true;
}

async function removeLockTombstone(input: {
  tombstone: string;
  expected: ParentBoundPathIdentity;
  parentRealPath: string;
  beforeUnlink?: () => void | Promise<void>;
  workerFailureMode?: ParentBoundWorkerFailureMode;
  workerTimeoutMs?: number;
}) {
  const parent = path.dirname(input.tombstone);
  const parentIdentity = await pinDirectoryIdentity(parent, input.parentRealPath);
  try {
    await parentBoundUnlink({
      filePath: input.tombstone,
      parentIdentity,
      expectedTarget: input.expected,
      hook: input.beforeUnlink ? { beforeCommand: input.beforeUnlink } : undefined,
      workerFailureMode: input.workerFailureMode,
      workerTimeoutMs: input.workerTimeoutMs, allowParentCtimeChange: true
    });
  } catch (error) {
    const current = await lstatOptional(input.tombstone);
    if (!current) return;
    if (!sameLockIdentity(current, input.expected)) directoryChanged();
    throw error;
  }
}

function sameLockIdentity(stat: BigIntStats, expected: ParentBoundPathIdentity) {
  return expected.kind === "file" && stat.isFile() && !stat.isSymbolicLink() &&
    stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs && stat.ctimeNs === expected.ctimeNs &&
    stat.nlink === expected.nlink && stat.mode === expected.mode;
}

async function recoverLinkedLockReservation(
  sourcePath: string,
  tombstone: string,
  source: BigIntStats,
  terminal: BigIntStats,
  ownerToken: string,
  expected: ParentBoundPathIdentity
) {
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : source.uid;
  if (expected.nlink !== 1n || source.nlink !== 2n || terminal.nlink !== 2n ||
      !source.isFile() || source.isSymbolicLink() || !terminal.isFile() || terminal.isSymbolicLink() ||
      source.dev !== expected.dev || source.ino !== expected.ino || terminal.dev !== source.dev ||
      terminal.ino !== source.ino || source.size !== expected.size || terminal.size !== expected.size ||
      source.mtimeNs !== expected.mtimeNs || terminal.mtimeNs !== expected.mtimeNs ||
      source.mode !== expected.mode || terminal.mode !== expected.mode || source.ctimeNs !== terminal.ctimeNs ||
      source.uid !== uid || terminal.uid !== uid || (source.mode & 0o777n) !== 0o600n) directoryChanged();
  if ((await readBoundedFile(sourcePath, MAX_LOCK_BYTES, undefined, 2n)).toString("utf8") !== ownerToken) {
    directoryChanged();
  }
  await removeLockTombstone({
    tombstone,
    expected: parseParentBoundPathIdentity(serializeLockIdentity(terminal)),
    parentRealPath: path.dirname(sourcePath)
  });
  const restored = await lstatOptional(sourcePath);
  if (!restored || restored.dev !== expected.dev || restored.ino !== expected.ino ||
      restored.size !== expected.size || restored.mtimeNs !== expected.mtimeNs ||
      restored.mode !== expected.mode || restored.nlink !== expected.nlink ||
      (await readBoundedFile(sourcePath, MAX_LOCK_BYTES)).toString("utf8") !== ownerToken) directoryChanged();
  return parseParentBoundPathIdentity(serializeLockIdentity(restored));
}

function invalidLockTombstone(): never {
  throw storeError(409, "AGENT_EXTENSION_PATH_INVALID", "Agent 扩展锁清理证据无效。");
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
