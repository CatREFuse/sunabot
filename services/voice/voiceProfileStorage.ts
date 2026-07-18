import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectVoiceAudio } from "./audio.js";
import { VoiceAsyncMutex } from "./asyncMutex.js";
import {
  MAX_PROFILE_BYTES,
  PROFILE_FILE,
  REFERENCE_DIRECTORY,
  VOICE_DIRECTORY,
  parseStoredRelativePath,
  parseVoiceProfile,
} from "./voiceProfileValidation.js";
import {
  MAX_VOICE_REFERENCE_BYTES,
  VoiceProfileError,
  defaultVoiceProfile,
  type RuntimeVoiceReference,
  type VoiceLanguage,
  type VoiceProfileV1,
  type VoiceReferenceMetadata,
} from "./types.js";

export interface VoiceWorkspaceContext {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
}

export interface VoiceLayout {
  voiceDirectory: string;
  referencesDirectory: string;
  profilePath: string;
}

const repositoryMutexes = new Map<string, VoiceAsyncMutex>();

export async function runWithVoiceWorkspaceLock<T>(
  requestedWorkspace: string,
  operation: (workspace: VoiceWorkspaceContext) => Promise<T>,
): Promise<T> {
  try {
    const workspace = await resolveWorkspace(requestedWorkspace);
    const mutex = mutexFor(workspace.canonicalPath);
    return await mutex.runExclusive(async () => {
      const current = await resolveWorkspace(requestedWorkspace);
      if (
        current.canonicalPath !== workspace.canonicalPath ||
        current.dev !== workspace.dev ||
        current.ino !== workspace.ino
      ) {
        throw new VoiceProfileError(
          "VOICE_WORKSPACE_INVALID",
          "Agent 语音目录不可用。",
          500,
        );
      }
      return operation(current);
    });
  } catch (error) {
    throw normalizeRepositoryError(error);
  }
}

export async function readStoredVoiceProfile(
  workspace: VoiceWorkspaceContext,
): Promise<VoiceProfileV1> {
  const layout = await ensureVoiceLayout(workspace, false);
  if (!layout) return defaultVoiceProfile();
  const bytes = await readRegularFileNoFollow(
    layout.profilePath,
    MAX_PROFILE_BYTES,
    true,
    "profile",
  );
  if (!bytes) return defaultVoiceProfile();
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    throw new VoiceProfileError(
      "VOICE_PROFILE_INVALID",
      "语音配置文件无效。",
      500,
    );
  }
  return parseVoiceProfile(value);
}

export async function writeStoredVoiceProfile(
  workspace: VoiceWorkspaceContext,
  profile: VoiceProfileV1,
) {
  const normalized = parseVoiceProfile(profile);
  const bytes = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_PROFILE_BYTES) {
    throw new VoiceProfileError(
      "VOICE_PROFILE_TOO_LARGE",
      "语音配置文件过大。",
      413,
    );
  }
  const layout = await ensureVoiceLayout(workspace, true);
  await atomicReplaceFile(layout.profilePath, layout.voiceDirectory, bytes);
}

export async function readRuntimeVoiceReference(
  workspace: VoiceWorkspaceContext,
  profile: VoiceProfileV1,
  language: VoiceLanguage,
): Promise<RuntimeVoiceReference> {
  const metadata = profile.languages[language];
  if (!metadata) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_NOT_FOUND",
      "该语言尚未设置参考音频。",
      404,
    );
  }
  await requireReferencesDirectory(workspace);
  const filePath = absoluteReferencePath(workspace, metadata.relativePath);
  const bytes = await readRegularFileNoFollow(
    filePath,
    MAX_VOICE_REFERENCE_BYTES,
    false,
    "reference",
  );
  if (!bytes) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_NOT_FOUND",
      "参考音频不存在。",
      404,
    );
  }
  const detected = await detectVoiceAudio(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== metadata.sizeBytes ||
    sha256 !== metadata.sha256 ||
    !detected ||
    detected.mimeType !== metadata.mimeType
  ) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_CHANGED",
      "参考音频已发生变化。",
      409,
    );
  }
  return { profile, language, metadata, bytes };
}

export async function ensureVoiceLayout(
  workspace: VoiceWorkspaceContext,
  create: true,
): Promise<VoiceLayout>;
export async function ensureVoiceLayout(
  workspace: VoiceWorkspaceContext,
  create: false,
): Promise<VoiceLayout | undefined>;
export async function ensureVoiceLayout(
  workspace: VoiceWorkspaceContext,
  create: boolean,
): Promise<VoiceLayout | undefined> {
  await assertWorkspaceIdentity(workspace);
  const voiceDirectory = path.join(workspace.canonicalPath, VOICE_DIRECTORY);
  const exists = await ensureDirectDirectory(
    workspace.canonicalPath,
    VOICE_DIRECTORY,
    create,
  );
  if (!exists) return undefined;
  const referencesDirectory = path.join(voiceDirectory, REFERENCE_DIRECTORY);
  if (create)
    await ensureDirectDirectory(voiceDirectory, REFERENCE_DIRECTORY, true);
  return {
    voiceDirectory,
    referencesDirectory,
    profilePath: path.join(voiceDirectory, PROFILE_FILE),
  };
}

export async function publishVoiceReference(
  filePath: string,
  directory: string,
  bytes: Buffer,
) {
  const existing = await readRegularFileNoFollow(
    filePath,
    MAX_VOICE_REFERENCE_BYTES,
    true,
    "reference",
  );
  if (existing) {
    if (!existing.equals(bytes))
      throw new VoiceProfileError(
        "VOICE_REFERENCE_CHANGED",
        "参考音频文件冲突。",
        409,
      );
    return;
  }
  const temporaryPath = path.join(
    directory,
    `.voice-reference-${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await fs.unlink(temporaryPath);
    await syncDirectory(directory);
    const published = await readRegularFileNoFollow(
      filePath,
      MAX_VOICE_REFERENCE_BYTES,
      false,
      "reference",
    );
    if (!published?.equals(bytes))
      throw new VoiceProfileError(
        "VOICE_REFERENCE_CHANGED",
        "参考音频文件冲突。",
        409,
      );
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeVoiceReferenceBlob(
  workspace: VoiceWorkspaceContext,
  metadata: VoiceReferenceMetadata,
) {
  await requireReferencesDirectory(workspace);
  const filePath = absoluteReferencePath(workspace, metadata.relativePath);
  const bytes = await readRegularFileNoFollow(
    filePath,
    MAX_VOICE_REFERENCE_BYTES,
    true,
    "reference",
  );
  if (
    !bytes ||
    bytes.byteLength !== metadata.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  )
    return;
  await fs.unlink(filePath);
  await syncDirectory(path.dirname(filePath));
}

async function resolveWorkspace(
  requestedPath: string,
): Promise<VoiceWorkspaceContext> {
  try {
    const requested = await fs.lstat(requestedPath, { bigint: true });
    if (!requested.isDirectory() || requested.isSymbolicLink())
      throw new Error();
    const canonicalPath = await fs.realpath(requestedPath);
    const canonical = await fs.lstat(canonicalPath, { bigint: true });
    if (
      !canonical.isDirectory() ||
      canonical.isSymbolicLink() ||
      canonical.dev !== requested.dev ||
      canonical.ino !== requested.ino
    ) {
      throw new Error();
    }
    return { canonicalPath, dev: canonical.dev, ino: canonical.ino };
  } catch (error) {
    if (error instanceof VoiceProfileError) throw error;
    throw new VoiceProfileError(
      "VOICE_WORKSPACE_INVALID",
      "Agent 语音目录不可用。",
      500,
    );
  }
}

function mutexFor(canonicalPath: string) {
  let mutex = repositoryMutexes.get(canonicalPath);
  if (!mutex) {
    mutex = new VoiceAsyncMutex();
    repositoryMutexes.set(canonicalPath, mutex);
  }
  return mutex;
}

async function ensureDirectDirectory(
  parent: string,
  name: string,
  create: boolean,
) {
  const target = path.join(parent, name);
  let stats: BigIntStats;
  try {
    stats = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
        throw mkdirError;
    }
    stats = await fs.lstat(target, { bigint: true });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_PATH_INVALID",
      "语音存储目录无效。",
      500,
    );
  }
  const canonical = await fs.realpath(target);
  const canonicalStats = await fs.lstat(canonical, { bigint: true });
  if (
    canonical !== target ||
    !canonicalStats.isDirectory() ||
    canonicalStats.dev !== stats.dev ||
    canonicalStats.ino !== stats.ino
  ) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_PATH_INVALID",
      "语音存储目录无效。",
      500,
    );
  }
  return true;
}

async function assertWorkspaceIdentity(workspace: VoiceWorkspaceContext) {
  const stats = await fs.lstat(workspace.canonicalPath, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== workspace.dev ||
    stats.ino !== workspace.ino
  ) {
    throw new VoiceProfileError(
      "VOICE_WORKSPACE_INVALID",
      "Agent 语音目录不可用。",
      500,
    );
  }
}

async function readRegularFileNoFollow(
  filePath: string,
  maxBytes: number,
  allowMissing: boolean,
  kind: "profile" | "reference",
): Promise<Buffer | undefined> {
  const noFollow = Reflect.get(fsConstants, "O_NOFOLLOW");
  if (
    typeof noFollow !== "number" ||
    !Number.isSafeInteger(noFollow) ||
    noFollow <= 0
  ) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_PATH_INVALID",
      "当前平台不支持安全读取语音文件。",
      500,
    );
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (allowMissing && code === "ENOENT") return undefined;
    if (kind === "reference" && code === "ENOENT") {
      throw new VoiceProfileError(
        "VOICE_REFERENCE_NOT_FOUND",
        "参考音频不存在。",
        404,
      );
    }
    throw invalidStoredFile(kind);
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertSafeFileStats(before, maxBytes, kind);
    const visibleBefore = await fs
      .lstat(filePath, { bigint: true })
      .catch(() => undefined);
    if (!visibleBefore || !sameVisibleFile(before, visibleBefore))
      throw invalidStoredFile(kind);
    const size = Number(before.size);
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const visibleAfter = await fs
      .lstat(filePath, { bigint: true })
      .catch(() => undefined);
    if (
      offset !== size ||
      !sameFileSnapshot(before, after) ||
      !visibleAfter ||
      !sameVisibleFile(after, visibleAfter)
    ) {
      throw kind === "reference"
        ? new VoiceProfileError(
            "VOICE_REFERENCE_CHANGED",
            "参考音频已发生变化。",
            409,
          )
        : invalidStoredFile(kind);
    }
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

function assertSafeFileStats(
  stats: BigIntStats,
  maxBytes: number,
  kind: "profile" | "reference",
) {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.size < 0n
  )
    throw invalidStoredFile(kind);
  if (stats.size > BigInt(maxBytes)) {
    throw new VoiceProfileError(
      kind === "reference"
        ? "VOICE_REFERENCE_TOO_LARGE"
        : "VOICE_PROFILE_TOO_LARGE",
      kind === "reference" ? "参考音频过大。" : "语音配置文件过大。",
      413,
    );
  }
}

function invalidStoredFile(kind: "profile" | "reference") {
  return new VoiceProfileError(
    kind === "reference"
      ? "VOICE_REFERENCE_PATH_INVALID"
      : "VOICE_PROFILE_INVALID",
    kind === "reference" ? "参考音频文件无效。" : "语音配置文件无效。",
    500,
  );
}

function sameVisibleFile(opened: BigIntStats, visible: BigIntStats) {
  return (
    visible.isFile() &&
    !visible.isSymbolicLink() &&
    visible.nlink === 1n &&
    opened.dev === visible.dev &&
    opened.ino === visible.ino &&
    opened.size === visible.size
  );
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats) {
  return (
    before.isFile() &&
    after.isFile() &&
    before.nlink === 1n &&
    after.nlink === 1n &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function atomicReplaceFile(
  filePath: string,
  directory: string,
  bytes: Buffer,
) {
  await assertSafeReplaceTarget(filePath);
  const temporaryPath = path.join(
    directory,
    `.voice-profile-${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeReplaceTarget(filePath);
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
    const published = await readRegularFileNoFollow(
      filePath,
      MAX_PROFILE_BYTES,
      false,
      "profile",
    );
    if (!published?.equals(bytes)) throw invalidStoredFile("profile");
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertSafeReplaceTarget(filePath: string) {
  try {
    const stats = await fs.lstat(filePath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n)
      throw invalidStoredFile("profile");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function requireReferencesDirectory(workspace: VoiceWorkspaceContext) {
  const layout = await ensureVoiceLayout(workspace, false);
  if (
    !layout ||
    !(await ensureDirectDirectory(
      layout.voiceDirectory,
      REFERENCE_DIRECTORY,
      false,
    ))
  ) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_NOT_FOUND",
      "参考音频不存在。",
      404,
    );
  }
  return layout.referencesDirectory;
}

function absoluteReferencePath(
  workspace: VoiceWorkspaceContext,
  relativePath: string,
) {
  const parsed = parseStoredRelativePath(
    relativePath,
    extractStoredSha(relativePath),
  );
  const absolute = path.resolve(workspace.canonicalPath, ...parsed.split("/"));
  const expectedRoot = path.join(
    workspace.canonicalPath,
    VOICE_DIRECTORY,
    REFERENCE_DIRECTORY,
  );
  if (path.dirname(absolute) !== expectedRoot) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_PATH_INVALID",
      "参考音频路径无效。",
      500,
    );
  }
  return absolute;
}

function extractStoredSha(relativePath: string) {
  const match = /-([a-f0-9]{64})\.[a-z0-9]{1,10}$/u.exec(relativePath);
  if (!match?.[1]) return invalidStoredProfile();
  return match[1];
}

function invalidStoredProfile(): never {
  throw new VoiceProfileError(
    "VOICE_PROFILE_INVALID",
    "语音配置文件无效。",
    500,
  );
}

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  bytes: Buffer,
) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (!bytesWritten)
      throw new VoiceProfileError(
        "VOICE_REFERENCE_PATH_INVALID",
        "语音文件写入失败。",
        500,
      );
    offset += bytesWritten;
  }
}

async function syncDirectory(directory: string) {
  const noFollow = Reflect.get(fsConstants, "O_NOFOLLOW");
  const directoryFlag = Reflect.get(fsConstants, "O_DIRECTORY");
  if (
    typeof noFollow !== "number" ||
    noFollow <= 0 ||
    typeof directoryFlag !== "number"
  ) {
    throw new VoiceProfileError(
      "VOICE_REFERENCE_PATH_INVALID",
      "当前平台不支持安全写入语音文件。",
      500,
    );
  }
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | noFollow | directoryFlag,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeRepositoryError(error: unknown) {
  if (error instanceof VoiceProfileError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "ELOOP" ||
    code === "EMLINK"
  ) {
    return new VoiceProfileError(
      "VOICE_REFERENCE_PATH_INVALID",
      "语音存储路径无效。",
      500,
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new VoiceProfileError(
      "VOICE_WORKSPACE_INVALID",
      "Agent 语音目录不可用。",
      500,
    );
  }
  return new VoiceProfileError(
    "VOICE_PROFILE_INVALID",
    "语音配置操作失败。",
    500,
  );
}
