import { randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const MAX_LAUNCH_DIRECTORIES = 256;

export interface IdentityBoundSecretDirectory {
  sourcePath: string;
  quarantinePath?: string;
  directory: { dev: bigint; ino: bigint; uid: bigint };
  parent: { path: string; dev: bigint; ino: bigint; uid: bigint };
}

export async function captureIdentityBoundSecretDirectory(
  candidate: string,
  sourcePath = candidate
): Promise<IdentityBoundSecretDirectory> {
  const resolved = path.resolve(candidate);
  const resolvedSource = path.resolve(sourcePath);
  if (candidate !== resolved || sourcePath !== resolvedSource || path.dirname(resolved) !== path.dirname(resolvedSource)) {
    cleanupFailed();
  }
  const [directory, parent] = await Promise.all([
    fs.lstat(resolved, { bigint: true }),
    fs.lstat(path.dirname(resolved), { bigint: true })
  ]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() ||
      directory.uid !== parent.uid) {
    cleanupFailed();
  }
  return {
    sourcePath: resolvedSource,
    ...(resolved === resolvedSource ? {} : { quarantinePath: resolved }),
    directory: { dev: directory.dev, ino: directory.ino, uid: directory.uid },
    parent: { path: path.dirname(resolved), dev: parent.dev, ino: parent.ino, uid: parent.uid }
  };
}

export async function quarantineWipeAndRemove(
  identity: IdentityBoundSecretDirectory,
  wipe: (quarantinePath: string) => Promise<void>
) {
  try {
    await assertParentIdentity(identity);
    const source = await fs.lstat(identity.sourcePath, { bigint: true }).catch(missingOrThrow);
    const existingQuarantine = identity.quarantinePath
      ? await fs.lstat(identity.quarantinePath, { bigint: true }).catch(missingOrThrow)
      : undefined;
    if (source && existingQuarantine) cleanupFailed();
    if (!source && !existingQuarantine) return;
    if (source) {
      assertDirectoryIdentity(source, identity);
      identity.quarantinePath ??= path.join(
        identity.parent.path,
        `.${path.basename(identity.sourcePath)}.cleanup-${randomBytes(16).toString("hex")}`
      );
      if (await fs.lstat(identity.quarantinePath).catch(missingOrThrow)) cleanupFailed();
      await fs.rename(identity.sourcePath, identity.quarantinePath);
    }
    const quarantinePath = identity.quarantinePath!;
    const quarantined = await fs.lstat(quarantinePath, { bigint: true });
    assertDirectoryIdentity(quarantined, identity);
    await wipe(quarantinePath);
    await makePrivateTreeWritable(quarantinePath, identity.directory.uid);
    await fs.rm(quarantinePath, { recursive: true, force: true });
    identity.quarantinePath = undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "McpAdapterError") throw error;
    cleanupFailed();
  }
}

export async function wipeMcpLaunchSecretTree(projectionRoot: string) {
  const launchSecrets = path.join(projectionRoot, "launch-secrets");
  const root = await fs.lstat(launchSecrets).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root) return;
  if (!root.isDirectory() || root.isSymbolicLink()) cleanupFailed();
  const entries = await fs.readdir(launchSecrets, { withFileTypes: true });
  if (entries.length > MAX_LAUNCH_DIRECTORIES) cleanupFailed();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        !/^(?:launch-[a-f0-9]{32}|\.launch-[a-f0-9]{32}\.cleanup-[a-f0-9]{32})$/u.test(entry.name)) {
      cleanupFailed();
    }
    const directory = path.join(launchSecrets, entry.name);
    const files = await fs.readdir(directory, { withFileTypes: true });
    if (files.length !== 1 || !files[0]?.isFile() || files[0].isSymbolicLink() ||
        !/^[a-f0-9]{64}\.json$/u.test(files[0].name)) cleanupFailed();
    await wipeMcpSecretFile(path.join(directory, files[0].name));
  }
}

async function assertParentIdentity(identity: IdentityBoundSecretDirectory) {
  const parent = await fs.lstat(identity.parent.path, { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== identity.parent.dev ||
      parent.ino !== identity.parent.ino || parent.uid !== identity.parent.uid) {
    cleanupFailed();
  }
}

function assertDirectoryIdentity(stat: BigIntStats, identity: IdentityBoundSecretDirectory) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.directory.dev ||
      stat.ino !== identity.directory.ino || stat.uid !== identity.directory.uid) {
    cleanupFailed();
  }
}

async function makePrivateTreeWritable(root: string, expectedUid: bigint) {
  const stat = await fs.lstat(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid) cleanupFailed();
  await fs.chmod(root, 0o700);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const child = await fs.lstat(target, { bigint: true });
    if (child.isSymbolicLink() || child.uid !== expectedUid) cleanupFailed();
    if (child.isDirectory()) await makePrivateTreeWritable(target, expectedUid);
    else if (child.isFile() && child.nlink === 1n) await fs.chmod(target, 0o600);
    else cleanupFailed();
  }
}

function missingOrThrow(error: unknown) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}

export async function wipeMcpSecretFile(file: string) {
  const before = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!before) return;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_SECRET_FILE_BYTES) {
    cleanupFailed();
  }
  const handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  const zeros = Buffer.alloc(Math.min(Math.max(before.size, 1), 64 * 1024));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) cleanupFailed();
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(zeros.length, opened.size - offset);
      const written = await handle.write(zeros, 0, length, offset);
      if (written.bytesWritten !== length) cleanupFailed();
      offset += length;
    }
    await handle.sync();
    await handle.truncate(0);
    await handle.sync();
  } finally {
    zeros.fill(0);
    await handle.close();
  }
}

function cleanupFailed(): never {
  const error = new Error("MCP_STDIO_SECRET_CLEANUP_FAILED");
  error.name = "McpAdapterError";
  throw error;
}
