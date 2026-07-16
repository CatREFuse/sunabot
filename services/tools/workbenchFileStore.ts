import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentWorkbench,
  resolveAgentWorkbenchFile
} from "../agents/public.js";
import {
  captureWorkbenchIdentity,
  prepareRestrictedPaths,
  verifyRestrictedPaths,
  type FrozenRestrictedPath
} from "./bashFilesystemGuard.js";
import type {
  ReadFileInput,
  WorkbenchFileErrorCode,
  WorkbenchFileFailure,
  WorkbenchFileResult,
  WorkbenchFileToolPort,
  WriteFileInput
} from "./workbenchFileTool.js";
import {
  WORKBENCH_FILE_MAX_BYTES,
  validateReadFileInput,
  validateWorkbenchFileText,
  validateWriteFileInput,
  workbenchFilePublicMessage
} from "./workbenchFileTool.js";

interface WorkbenchFileOperationHooks {
  afterPrepared?: () => void | Promise<void>;
  afterDescriptorOpened?: () => void | Promise<void>;
  afterContentRead?: () => void | Promise<void>;
  afterTempSynced?: () => void | Promise<void>;
  beforePublish?: () => void | Promise<void>;
  afterPublish?: () => void | Promise<void>;
}

interface FilesystemNodeIdentity {
  path: string;
  device: string;
  inode: string;
  changeTimeNs: string;
  modifiedTimeNs: string;
  size: string;
  links: string;
  mode: string;
  kind: "file" | "directory";
}

interface PreparedPath {
  root: FilesystemNodeIdentity;
  restricted: FrozenRestrictedPath;
  chain: FilesystemNodeIdentity[];
  targetPath: string;
  parentPath: string;
  existed: boolean;
}

interface FrozenFileSnapshot {
  identity: FilesystemNodeIdentity;
  digest: string;
}

class WorkbenchFilePublicError extends Error {
  constructor(readonly code: WorkbenchFileErrorCode) {
    super(workbenchFilePublicMessage(code));
  }
}

const writeLocks = new Map<string, Promise<void>>();

export function createWorkbenchFileToolPort(agentWorkspace: string): WorkbenchFileToolPort {
  return {
    read: (input) => readWorkbenchTextFile(agentWorkspace, input),
    write: (input) => writeWorkbenchTextFile(agentWorkspace, input)
  };
}

export async function readWorkbenchTextFile(
  agentWorkspace: string,
  input: unknown,
  hooks: WorkbenchFileOperationHooks = {}
): Promise<WorkbenchFileResult> {
  let parsed: ReadFileInput;
  try {
    parsed = parseReadFileInput(input);
  } catch (error) {
    return failure(error);
  }
  try {
    return await performRead(agentWorkspace, parsed, hooks);
  } catch (error) {
    return failure(error);
  }
}

export async function writeWorkbenchTextFile(
  agentWorkspace: string,
  input: unknown,
  hooks: WorkbenchFileOperationHooks = {}
): Promise<WorkbenchFileResult> {
  let parsed: WriteFileInput;
  let content: Buffer;
  try {
    parsed = parseWriteFileInput(input);
    content = encodeText(parsed.content);
  } catch (error) {
    return failure(error);
  }
  const lockKey = `${path.resolve(agentWorkspace)}\0${parsed.path}`;
  return withWriteLock(lockKey, async () => {
    try {
      return await performWrite(agentWorkspace, parsed, content, hooks);
    } catch (error) {
      return failure(error);
    }
  });
}

async function performRead(
  agentWorkspace: string,
  input: ReadFileInput,
  hooks: WorkbenchFileOperationHooks
) {
  const prepared = await preparePath(agentWorkspace, input.path, "read");
  await hooks.afterPrepared?.();
  await verifyPreparedPath(prepared, true);
  const flags = requiredOpenFlag("O_RDONLY") | requiredOpenFlag("O_NOFOLLOW");
  const handle = await fs.open(prepared.targetPath, flags);
  let operationFailed = false;
  try {
    const before = await fileHandleIdentity(handle);
    assertReadableFile(before, prepared.chain.at(-1));
    await hooks.afterDescriptorOpened?.();
    const bytes = await readBounded(handle, WORKBENCH_FILE_MAX_BYTES);
    await hooks.afterContentRead?.();
    const after = await fileHandleIdentity(handle);
    assertSameFileSnapshot(before, after, bytes.length);
    await verifyPreparedPath(prepared, true);
    const content = decodeText(bytes);
    return {
      ok: true as const,
      path: input.path,
      byteLength: bytes.length,
      content
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

async function performWrite(
  agentWorkspace: string,
  input: WriteFileInput,
  content: Buffer,
  hooks: WorkbenchFileOperationHooks
) {
  const prepared = await preparePath(agentWorkspace, input.path, "write");
  if (prepared.existed && !input.overwrite) throw new WorkbenchFilePublicError("WORKBENCH_FILE_EXISTS");
  await hooks.afterPrepared?.();
  await verifyPreparedPath(prepared, true);

  const parentHandle = await openDirectory(prepared.parentPath);
  const tempPath = path.join(prepared.parentPath, temporaryName(input.path));
  let tempPresent = false;
  let published = false;
  let operationFailed = false;
  try {
    const tempHandle = await fs.open(
      tempPath,
      requiredOpenFlag("O_RDWR")
        | requiredOpenFlag("O_CREAT")
        | requiredOpenFlag("O_EXCL")
        | requiredOpenFlag("O_NOFOLLOW"),
      0o600
    );
    tempPresent = true;
    let tempSnapshot: FrozenFileSnapshot;
    let tempWriteFailed = false;
    try {
      await writeAll(tempHandle, content);
      await tempHandle.sync();
      tempSnapshot = await captureFrozenFileSnapshot(tempHandle, tempPath, content);
    } catch (error) {
      tempWriteFailed = true;
      throw error;
    } finally {
      try {
        await tempHandle.close();
      } catch (error) {
        if (!tempWriteFailed) throw error;
      }
    }

    await hooks.afterTempSynced?.();
    const postTemp = await refreshPreparedPath(prepared);
    await verifyPreparedPath(postTemp, true);
    await assertDirectoryHandle(parentHandle, postTemp.chain.at(-1)?.kind === "directory"
      ? postTemp.chain.at(-1)
      : postTemp.chain.at(-2));
    await parentHandle.sync();
    await hooks.beforePublish?.();
    await verifyPreparedPath(postTemp, true);
    await verifyFrozenFileSnapshot(tempPath, tempSnapshot, content);

    if (prepared.existed) {
      await fs.rename(tempPath, prepared.targetPath);
      tempPresent = false;
    } else {
      try {
        await fs.link(tempPath, prepared.targetPath);
      } catch (error) {
        if (errno(error) === "EEXIST") throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
        throw error;
      }
      published = true;
      await fs.unlink(tempPath);
      tempPresent = false;
    }
    published = true;
    await hooks.afterPublish?.();
    await parentHandle.sync();
    const current = await preparePath(agentWorkspace, input.path, "read");
    await verifyPreparedPath(current, true);
    const publishedIdentity = current.chain.at(-1);
    if (!publishedIdentity || !sameObjectIdentity(publishedIdentity, tempSnapshot.identity)) {
      throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
    }
    assertPublishedIdentity(publishedIdentity, content.length);
    await verifyPublishedFileSnapshot(prepared.targetPath, tempSnapshot, content);
    return {
      ok: true as const,
      path: input.path,
      byteLength: content.length,
      created: !prepared.existed,
      overwritten: prepared.existed
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (tempPresent) await fs.unlink(tempPath).catch(() => undefined);
    try {
      await parentHandle.close();
    } catch (error) {
      if (!operationFailed && !published) throw error;
    }
  }
}

async function preparePath(
  agentWorkspace: string,
  relativePath: string,
  operation: "read" | "write"
): Promise<PreparedPath> {
  const workbenchRoot = await resolveAgentWorkbench(agentWorkspace);
  await captureWorkbenchIdentity(workbenchRoot);
  const root = await nodeIdentity(workbenchRoot, "directory");
  const targetPath = path.resolve(workbenchRoot, ...relativePath.split("/"));
  const parentPath = path.dirname(targetPath);
  const resolvedHelperPath = operation === "read"
    ? await resolveAgentWorkbenchFile(agentWorkspace, relativePath)
    : await resolveAgentWorkbenchFile(
      agentWorkspace,
      path.posix.dirname(relativePath) === "." ? "." : path.posix.dirname(relativePath)
    );
  const expectedHelperPath = operation === "read" ? targetPath : parentPath;
  if (resolvedHelperPath !== expectedHelperPath) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  const [restricted] = await prepareRestrictedPaths([{
    path: relativePath,
    role: operation === "read" ? "read-entry" : "write-file"
  }], workbenchRoot);
  if (!restricted) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  const existed = restricted.expectedMissing === false;
  if (existed && (!restricted.target || restricted.target.kind !== "file" || restricted.target.links !== "1")) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  }
  const chain = await captureRelativeChain(workbenchRoot, targetPath, operation === "write" && !existed);
  return { root, restricted, chain, targetPath, parentPath, existed };
}

async function refreshPreparedPath(prepared: PreparedPath): Promise<PreparedPath> {
  const root = await nodeIdentity(prepared.root.path, "directory");
  if (!sameObjectIdentity(root, prepared.root)) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  const chain = await captureRelativeChain(
    prepared.root.path,
    prepared.targetPath,
    prepared.restricted.expectedMissing
  );
  return { ...prepared, root, chain };
}

async function verifyPreparedPath(prepared: PreparedPath, verifyChangeTimes: boolean) {
  await captureWorkbenchIdentity(prepared.root.path);
  const currentRoot = await nodeIdentity(prepared.root.path, "directory");
  if (!sameIdentity(prepared.root, currentRoot, verifyChangeTimes)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  }
  await verifyRestrictedPaths([prepared.restricted]);
  const currentChain = await captureRelativeChain(
    prepared.root.path,
    prepared.targetPath,
    prepared.restricted.expectedMissing
  );
  if (currentChain.length !== prepared.chain.length) throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  for (let index = 0; index < currentChain.length; index += 1) {
    if (!sameIdentity(prepared.chain[index]!, currentChain[index]!, verifyChangeTimes)) {
      throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
    }
  }
}

async function captureRelativeChain(root: string, target: string, allowMissingLeaf: boolean) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_PATH_INVALID");
  }
  const segments = relative.split(path.sep);
  const result: FilesystemNodeIdentity[] = [await nodeIdentity(root, "directory")];
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const isLeaf = index === segments.length - 1;
    try {
      result.push(await nodeIdentity(current, isLeaf ? "file" : "directory"));
    } catch (error) {
      if (allowMissingLeaf && isLeaf && errno(error) === "ENOENT") return result;
      throw error;
    }
  }
  return result;
}

async function nodeIdentity(candidate: string, expectedKind: "file" | "directory") {
  const stat = await fs.lstat(candidate, { bigint: true });
  if (stat.isSymbolicLink()) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
  if (kind !== expectedKind) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  return statIdentity(candidate, stat, kind);
}

async function fileHandleIdentity(handle: fs.FileHandle) {
  const stat = await handle.stat({ bigint: true });
  const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined;
  if (!kind) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  return statIdentity("", stat, kind);
}

function statIdentity(
  identityPath: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  kind: "file" | "directory"
): FilesystemNodeIdentity {
  const bigintStat = stat as unknown as {
    dev: bigint;
    ino: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
    size: bigint;
    nlink: bigint;
    mode: bigint;
  };
  return {
    path: identityPath,
    device: String(bigintStat.dev),
    inode: String(bigintStat.ino),
    changeTimeNs: String(bigintStat.ctimeNs),
    modifiedTimeNs: String(bigintStat.mtimeNs),
    size: String(bigintStat.size),
    links: String(bigintStat.nlink),
    mode: (bigintStat.mode & 0o7777n).toString(8),
    kind
  };
}

function assertReadableFile(current: FilesystemNodeIdentity, frozen: FilesystemNodeIdentity | undefined) {
  if (!frozen || current.kind !== "file" || current.links !== "1" || !sameObjectIdentity(current, frozen)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  }
  const size = Number(current.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > WORKBENCH_FILE_MAX_BYTES) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_TOO_LARGE");
  }
}

function assertSameFileSnapshot(
  before: FilesystemNodeIdentity,
  after: FilesystemNodeIdentity,
  bytesRead: number
) {
  if (!sameIdentity(before, after, true) || before.size !== String(bytesRead)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  }
}

function assertPublishedIdentity(identity: FilesystemNodeIdentity, byteLength: number) {
  if (
    identity.kind !== "file"
    || identity.links !== "1"
    || identity.size !== String(byteLength)
    || Number.parseInt(identity.mode, 8) !== 0o600
  ) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  }
}

async function captureFrozenFileSnapshot(
  handle: fs.FileHandle,
  filePath: string,
  expectedContent: Buffer
): Promise<FrozenFileSnapshot> {
  const observed = await observeFileSnapshot(handle, filePath);
  assertPublishedIdentity(observed.identity, expectedContent.length);
  if (!observed.bytes.equals(expectedContent)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  }
  return { identity: observed.identity, digest: observed.digest };
}

async function verifyFrozenFileSnapshot(
  filePath: string,
  frozen: FrozenFileSnapshot,
  expectedContent: Buffer
) {
  const observed = await readFileSnapshot(filePath);
  assertPublishedIdentity(observed.identity, expectedContent.length);
  if (
    !sameIdentity(frozen.identity, observed.identity, true)
    || observed.digest !== frozen.digest
    || !observed.bytes.equals(expectedContent)
  ) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  }
}

async function verifyPublishedFileSnapshot(
  filePath: string,
  frozen: FrozenFileSnapshot,
  expectedContent: Buffer
) {
  const observed = await readFileSnapshot(filePath);
  assertPublishedIdentity(observed.identity, expectedContent.length);
  if (
    !sameObjectIdentity(frozen.identity, observed.identity)
    || observed.digest !== frozen.digest
    || !observed.bytes.equals(expectedContent)
  ) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  }
}

async function readFileSnapshot(filePath: string) {
  const handle = await fs.open(filePath, requiredOpenFlag("O_RDONLY") | requiredOpenFlag("O_NOFOLLOW"));
  let operationFailed = false;
  try {
    return await observeFileSnapshot(handle, filePath);
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

async function observeFileSnapshot(handle: fs.FileHandle, filePath: string) {
  const before = await fileHandleIdentity(handle);
  const pathBefore = await nodeIdentity(filePath, "file");
  if (!sameIdentity(before, pathBefore, true)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  }
  const bytes = await readBoundedAtStart(handle, WORKBENCH_FILE_MAX_BYTES);
  const after = await fileHandleIdentity(handle);
  assertSameFileSnapshot(before, after, bytes.length);
  const pathAfter = await nodeIdentity(filePath, "file");
  if (!sameIdentity(after, pathAfter, true)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_CONFLICT");
  }
  return {
    identity: after,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex")
  };
}

async function assertDirectoryHandle(handle: fs.FileHandle, frozen: FilesystemNodeIdentity | undefined) {
  if (!frozen || frozen.kind !== "directory") throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  const current = await fileHandleIdentity(handle);
  if (current.kind !== "directory" || !sameObjectIdentity(current, frozen)) {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  }
}

async function readBounded(handle: fs.FileHandle, maxBytes: number) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new WorkbenchFilePublicError("WORKBENCH_FILE_TOO_LARGE");
  return buffer.subarray(0, offset);
}

async function readBoundedAtStart(handle: fs.FileHandle, maxBytes: number) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new WorkbenchFilePublicError("WORKBENCH_FILE_TOO_LARGE");
  return buffer.subarray(0, offset);
}

async function writeAll(handle: fs.FileHandle, content: Buffer) {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
    if (!bytesWritten) throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNAVAILABLE");
    offset += bytesWritten;
  }
}

async function openDirectory(directory: string) {
  return fs.open(
    directory,
    requiredOpenFlag("O_RDONLY") | requiredOpenFlag("O_DIRECTORY") | requiredOpenFlag("O_NOFOLLOW")
  );
}

function parseReadFileInput(input: unknown): ReadFileInput {
  const result = validateReadFileInput(input);
  if (!result.ok) throw new WorkbenchFilePublicError(result.code);
  return result.input;
}

function parseWriteFileInput(input: unknown): WriteFileInput {
  const result = validateWriteFileInput(input);
  if (!result.ok) throw new WorkbenchFilePublicError(result.code);
  return result.input;
}

function encodeText(content: string) {
  const result = validateWorkbenchFileText(content);
  if (!result.ok) throw new WorkbenchFilePublicError(result.code);
  return Buffer.from(result.content, "utf8");
}

function decodeText(bytes: Buffer) {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_TEXT_INVALID");
  }
  const result = validateWorkbenchFileText(content);
  if (!result.ok || result.byteLength !== bytes.length) {
    throw new WorkbenchFilePublicError(result.ok ? "WORKBENCH_FILE_TEXT_INVALID" : result.code);
  }
  return result.content;
}

function sameIdentity(left: FilesystemNodeIdentity, right: FilesystemNodeIdentity, compareChangeTimes: boolean) {
  return sameObjectIdentity(left, right)
    && left.kind === right.kind
    && left.mode === right.mode
    && left.links === right.links
    && (!compareChangeTimes || (
      left.changeTimeNs === right.changeTimeNs
      && left.modifiedTimeNs === right.modifiedTimeNs
      && left.size === right.size
    ));
}

function sameObjectIdentity(left: FilesystemNodeIdentity, right: FilesystemNodeIdentity) {
  return left.device === right.device && left.inode === right.inode;
}

function temporaryName(relativePath: string) {
  const digest = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  return `.sunabot-write-${digest}-${randomBytes(16).toString("hex")}.tmp`;
}

function requiredOpenFlag(name: keyof typeof fsConstants) {
  const value = fsConstants[name];
  if (typeof value !== "number" || value === 0 && name === "O_NOFOLLOW") {
    throw new WorkbenchFilePublicError("WORKBENCH_FILE_UNSAFE");
  }
  return value;
}

async function withWriteLock<T>(key: string, operation: () => Promise<T>) {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  writeLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  }
}

function failure(error: unknown): WorkbenchFileFailure {
  const code = publicErrorCode(error);
  return { ok: false, code, error: workbenchFilePublicMessage(code) };
}

function publicErrorCode(error: unknown): WorkbenchFileErrorCode {
  if (error instanceof WorkbenchFilePublicError) return error.code;
  const code = errno(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "WORKBENCH_FILE_NOT_FOUND";
  if (code === "EEXIST") return "WORKBENCH_FILE_EXISTS";
  if (code === "EACCES" || code === "EPERM") return "WORKBENCH_FILE_FORBIDDEN";
  if (code === "ELOOP" || code === "EMLINK") return "WORKBENCH_FILE_UNSAFE";
  const message = error instanceof Error ? error.message : "";
  if (/identity changed|identity is missing|appeared before execution/u.test(message)) {
    return "WORKBENCH_FILE_CONFLICT";
  }
  if (
    /AGENT_WORKBENCH_|symlink|hard link|restricted|workbench path|path resolves through an alias|path type is not allowed|path parent is not a directory|path is not canonical|owner is not trusted|writable by another principal/u.test(message)
  ) {
    return "WORKBENCH_FILE_UNSAFE";
  }
  return "WORKBENCH_FILE_UNAVAILABLE";
}

function errno(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
}
