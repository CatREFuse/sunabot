import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const NAPCAT_WRITABLE_CACHE_DIRECTORIES = Object.freeze([
  "fontconfig",
  "mesa_shader_cache",
  "mesa_shader_cache_db"
]);

export function resolveNapcatRuntimeLayout(workspace, paths) {
  const root = path.resolve(requiredAbsolutePath(workspace, "workspace"));
  const stateRelative = requiredRelativePath(paths?.napcatState, "paths.napcatState");
  const qrRelative = requiredRelativePath(paths?.napcatQrCode, "paths.napcatQrCode");
  const manualLoginRelative = requiredRelativePath(
    paths?.napcatManualLogin ?? path.join(stateRelative, "manual-login-required"),
    "paths.napcatManualLogin"
  );
  if (path.dirname(qrRelative) !== stateRelative) {
    throw new Error("paths.napcatQrCode must be a direct child of paths.napcatState");
  }
  if (path.dirname(manualLoginRelative) !== stateRelative) {
    throw new Error("paths.napcatManualLogin must be a direct child of paths.napcatState");
  }
  const stateRoot = path.resolve(root, stateRelative);
  const qrCodePath = path.resolve(root, qrRelative);
  const manualLoginMarkerPath = path.resolve(root, manualLoginRelative);
  assertWithin(root, stateRoot, "NapCat state");
  assertWithin(stateRoot, qrCodePath, "NapCat QR code");
  assertWithin(stateRoot, manualLoginMarkerPath, "NapCat manual login marker");
  return { workspace: root, stateRoot, qrCodePath, manualLoginMarkerPath };
}

export async function migrateLegacyNapcatQrCode(options) {
  const layout = resolveNapcatRuntimeLayout(options.workspace, options.paths);
  await fs.mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
  const candidates = uniquePaths([
    path.join(layout.stateRoot, "cache", "qrcode.png"),
    ...(options.candidates ?? [])
  ]).filter((candidate) => path.resolve(candidate) !== layout.qrCodePath);
  const snapshots = [];
  const targetStats = await lstatOptional(layout.qrCodePath);
  if (targetStats?.isSymbolicLink()) {
    throw new Error(`Refusing managed NapCat QR symlink: ${layout.qrCodePath}`);
  }
  const target = await regularFileSnapshot(layout.qrCodePath);
  if (target) snapshots.push({ ...target, filePath: layout.qrCodePath, isTarget: true });
  for (const candidate of candidates) {
    const candidateStats = await lstatOptional(candidate);
    if (candidateStats?.isSymbolicLink()) {
      throw new Error(`Refusing legacy NapCat QR symlink: ${candidate}`);
    }
    const snapshot = await regularFileSnapshot(candidate);
    if (!snapshot) continue;
    if (await sameResolvedFile(candidate, layout.qrCodePath)) continue;
    snapshots.push({ ...snapshot, filePath: candidate, isTarget: false });
  }

  const newest = snapshots
    .filter((snapshot) => snapshot.size > 0)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || Number(right.isTarget) - Number(left.isTarget))[0];
  let migrated = false;
  if (newest && !newest.isTarget) {
    await atomicCopy(newest.filePath, layout.qrCodePath);
    migrated = true;
  }

  if (await regularFileSnapshot(layout.qrCodePath)) {
    for (const candidate of candidates) {
      if (await sameResolvedFile(candidate, layout.qrCodePath)) continue;
      if (await regularFileSnapshot(candidate)) {
        await fs.rm(candidate, { force: true });
        migrated = true;
      }
    }
  }
  return { ...layout, migrated, source: newest?.filePath };
}

export async function ensureNapcatCacheLink(options) {
  const layout = resolveNapcatRuntimeLayout(options.workspace, options.paths);
  const shellRoot = path.resolve(options.shellRoot);
  const cachePath = path.join(shellRoot, "cache");
  if (isWithin(cachePath, layout.stateRoot) || isWithin(layout.stateRoot, cachePath)) {
    throw new Error("NapCat component cache and workspace state must not overlap");
  }
  await fs.mkdir(shellRoot, { recursive: true });
  const cacheStats = await lstatOptional(cachePath);
  if (cacheStats?.isSymbolicLink()) {
    const linked = await fs.readlink(cachePath);
    const resolved = path.resolve(path.dirname(cachePath), linked);
    if (resolved !== layout.stateRoot) {
      throw new Error(`NapCat cache symlink points outside the runtime state: ${resolved}`);
    }
    const migration = await migrateLegacyNapcatQrCode({
      workspace: layout.workspace,
      paths: options.paths,
      candidates: options.candidates ?? []
    });
    return { ...migration, cachePath, linked: false };
  }
  if (cacheStats && !cacheStats.isDirectory()) {
    throw new Error("NapCat cache path must be a directory or the managed runtime symlink");
  }
  const migration = await migrateLegacyNapcatQrCode({
    workspace: layout.workspace,
    paths: options.paths,
    candidates: [path.join(cachePath, "qrcode.png"), ...(options.candidates ?? [])]
  });

  if (cacheStats?.isDirectory()) {
    await archiveLegacyCache(cachePath, path.join(layout.stateRoot, "legacy-cache"));
    await fs.rm(cachePath, { recursive: true, force: true });
  }

  const temporary = `${cachePath}.workspace-${process.pid}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.symlink(layout.stateRoot, temporary, process.platform === "win32" ? "junction" : "dir");
  await fs.rename(temporary, cachePath);
  return { ...migration, cachePath, linked: true };
}

export async function ensureNapcatWritableCaches(cacheRoot) {
  const root = path.resolve(requiredAbsolutePath(cacheRoot, "NapCat cache root"));
  const directories = [];
  for (const name of NAPCAT_WRITABLE_CACHE_DIRECTORIES) {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const probe = path.join(directory, `.sunabot-write-probe-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(probe, "", { flag: "wx", mode: 0o600 });
    } finally {
      await fs.rm(probe, { force: true });
    }
    directories.push(directory);
  }
  return directories;
}

async function archiveLegacyCache(source, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    if (entry.name === "qrcode.png") {
      await fs.rm(sourcePath, { force: true });
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`Refusing legacy NapCat cache symlink: ${sourcePath}`);
    const destinationPath = path.join(destination, entry.name);
    const destinationStats = await lstatOptional(destinationPath);
    if (!destinationStats) {
      await moveAcrossDevices(sourcePath, destinationPath);
      continue;
    }
    if (entry.isDirectory() && destinationStats.isDirectory()) {
      await archiveLegacyCache(sourcePath, destinationPath);
      await fs.rm(sourcePath, { recursive: true, force: true });
      continue;
    }
    if (entry.isFile() && destinationStats.isFile() && await sameBytes(sourcePath, destinationPath)) {
      await fs.rm(sourcePath, { force: true });
      continue;
    }
    throw new Error(`NapCat legacy cache migration conflict: ${destinationPath}`);
  }
}

async function moveAcrossDevices(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await fs.rm(source, { recursive: true, force: true });
  }
}

async function atomicCopy(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.copyFile(source, temporary);
  await fs.chmod(temporary, 0o600);
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM"]).has(error?.code)) throw error;
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function regularFileSnapshot(filePath) {
  const stats = await lstatOptional(filePath);
  if (!stats) return undefined;
  if (stats.isSymbolicLink()) {
    const resolved = await fs.realpath(filePath).catch(() => undefined);
    if (!resolved) return undefined;
    const targetStats = await fs.stat(resolved);
    return targetStats.isFile() ? { size: targetStats.size, mtimeMs: targetStats.mtimeMs } : undefined;
  }
  return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : undefined;
}

async function sameResolvedFile(left, right) {
  const [leftReal, rightReal] = await Promise.all([
    fs.realpath(left).catch(() => undefined),
    fs.realpath(right).catch(() => undefined)
  ]);
  return Boolean(leftReal && rightReal && leftReal === rightReal);
}

async function sameBytes(left, right) {
  const [leftBytes, rightBytes] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftBytes.equals(rightBytes);
}

async function lstatOptional(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
}

function requiredRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`${label} must be a workspace-relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must not escape the workspace`);
  }
  return normalized;
}

function assertWithin(parent, candidate, label) {
  if (!isWithin(parent, candidate)) throw new Error(`${label} must stay within ${parent}`);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniquePaths(values) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}
