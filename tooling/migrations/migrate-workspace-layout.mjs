#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import { migrateLegacyNapcatQrCode } from "../../packages/platform/napcatRuntimeLayout.mjs";

const LAYOUT_VERSION = 1;
const DIRECTORY_MOVES = [
  ["agents", "business/agents"],
  ["artifacts/images", "business/media/images"],
  ["artifacts/file-cache", "cache/attachments"],
  ["artifacts/codex-jobs", "runtime/tmp/codex-jobs"],
  ["security/codex", "secrets/codex"],
  ["napcat", "runtime/napcat"]
];
const FILE_MOVES = [
  ["config/sunabot.json", "business/config/sunabot.json"],
  ["artifacts/sunabot.sqlite", "business/data/sunabot.sqlite"],
  ["artifacts/sunabot.sqlite-wal", "business/data/sunabot.sqlite-wal"],
  ["artifacts/sunabot.sqlite-shm", "business/data/sunabot.sqlite-shm"],
  ["artifacts/session-queue.sqlite", "business/data/session-queue.sqlite"],
  ["artifacts/session-queue.sqlite-wal", "business/data/session-queue.sqlite-wal"],
  ["artifacts/session-queue.sqlite-shm", "business/data/session-queue.sqlite-shm"],
  ["artifacts/conversations.json", "business/data/legacy/conversations.json"],
  ["artifacts/request-bodies.jsonl", "business/data/legacy/request-bodies.jsonl"],
  ["artifacts/image-history.json", "business/data/legacy/image-history.json"],
  ["artifacts/memory-scheduler.json", "business/data/legacy/memory-scheduler.json"],
  ["security/admin-credentials.json", "secrets/admin-credentials.json"],
  ["security/ADMIN_DISABLED.json", "secrets/ADMIN_DISABLED.json"],
  [".env", "secrets/runtime.env"]
];
const REQUIRED_DIRECTORIES = [
  "business/agents/plana/selfie",
  "business/config",
  "business/data/legacy",
  "business/media/images",
  "cache/attachments",
  "backups",
  "runtime/logs",
  "runtime/napcat/config-full",
  "runtime/tmp",
  "secrets"
];
const SENSITIVE_LEGACY_PREFIXES = [".env", "security", "napcat"];

export async function migrateWorkspaceLayout(options) {
  const workspace = path.resolve(options.workspace);
  const faultInjector = options.faultInjector ?? (() => undefined);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(workspace, workspace);
  const lockPath = path.join(workspace, ".workspace-layout-v1.lock");
  const intentPath = path.join(workspace, ".workspace-layout-v1.intent.json");
  const lock = await acquireMigrationLock(lockPath);
  let databaseLocks = [];

  try {
    await recoverInterruptedLayoutMigration(workspace, intentPath);
    if (!options.skipServiceCheck) await assertConfiguredServiceStopped(workspace);
    databaseLocks = await acquireLegacyDatabaseLocks(workspace, options.databaseBusyTimeoutMs ?? 5_000);
    const legacyPaths = await existingLegacyPaths(workspace);
    for (const [source, destination] of [...DIRECTORY_MOVES, ...FILE_MOVES]) {
      await assertNoSymlinkComponents(workspace, path.join(workspace, source));
      await assertNoSymlinkComponents(workspace, path.join(workspace, destination));
      await assertMovable(path.join(workspace, source), path.join(workspace, destination));
    }
    let backup;
    if (legacyPaths.length) {
      await assertNoSymlinkComponents(workspace, path.join(workspace, "backups"));
      await fs.mkdir(path.join(workspace, "backups"), { recursive: true, mode: 0o700 });
      backup = await backupLegacyLayout(workspace, legacyPaths, options.now?.() ?? new Date());
      await atomicJson(intentPath, {
        schemaVersion: 1,
        backup: path.relative(workspace, backup.directory).replace(/\\/g, "/"),
        backupManifestSha256: backup.manifestSha256,
        legacyPaths
      });
    }

    const createdTargets = [];
    let qrMigration = { migrated: false };
    try {
      for (const relative of REQUIRED_DIRECTORIES) {
        await assertNoSymlinkComponents(workspace, path.join(workspace, relative));
      }
      await Promise.all(REQUIRED_DIRECTORIES.map((relative) => fs.mkdir(path.join(workspace, relative), {
        recursive: true,
        mode: 0o700
      })));
      for (const [source, destination] of [...DIRECTORY_MOVES, ...FILE_MOVES]) {
        await stageCopy(
          path.join(workspace, source),
          path.join(workspace, destination),
          createdTargets,
          faultInjector,
          source
        );
      }
      await verifyMoveTargets(workspace);
      await invokeFault(faultInjector, "after-staged-copy-verification");

      qrMigration = await migrateLegacyNapcatQrCode({
        workspace,
        paths: {
          napcatState: "runtime/napcat",
          napcatQrCode: "runtime/napcat/qrcode.png"
        }
      });
      if (qrMigration.migrated) {
        createdTargets.push(await targetEvidence(path.join(workspace, "runtime/napcat/qrcode.png")));
      }
      const configPath = path.join(workspace, "business/config/sunabot.json");
      if (await exists(configPath)) {
        await rewriteConfig(configPath);
        await refreshCreatedTargetEvidence(createdTargets, configPath);
      }
      await verifyDatabase(path.join(workspace, "business/data/sunabot.sqlite"));
      await verifyDatabase(path.join(workspace, "business/data/session-queue.sqlite"));

      for (const relative of legacyPaths.sort((left, right) => right.length - left.length)) {
        await fs.rm(path.join(workspace, relative), { recursive: true, force: true });
        await invokeFault(faultInjector, `after-source-remove:${relative}`);
      }
    } catch (error) {
      if (error?.preserveIntent !== true) {
        if (backup) await rollbackFailedLayoutMigration(workspace, backup.directory, legacyPaths, createdTargets);
        await fs.rm(intentPath, { force: true });
      }
      throw error;
    }

    const marker = {
      schemaVersion: 1,
      layoutVersion: LAYOUT_VERSION,
      migratedAt: new Date().toISOString(),
      backup: backup ? path.relative(workspace, backup.directory).replace(/\\/g, "/") : undefined,
      backupManifestSha256: backup?.manifestSha256,
      napcatQrMigrated: qrMigration.migrated,
      databaseIntegrity: "ok"
    };
    await atomicJson(path.join(workspace, "runtime/workspace-layout.json"), marker);
    await fs.rm(intentPath, { force: true });
    await syncDirectory(workspace);
    return { workspace, migrated: legacyPaths.length > 0 || qrMigration.migrated, backup, marker };
  } finally {
    releaseLegacyDatabaseLocks(databaseLocks);
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

async function existingLegacyPaths(workspace) {
  const candidates = [...new Set([...DIRECTORY_MOVES, ...FILE_MOVES].map(([source]) => source))];
  const result = [];
  for (const relative of candidates) if (await exists(path.join(workspace, relative))) result.push(relative);
  return result;
}

async function acquireLegacyDatabaseLocks(workspace, busyTimeoutMs) {
  const locks = [];
  const timeout = Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs > 0 ? busyTimeoutMs : 5_000;
  try {
    for (const relative of ["artifacts/sunabot.sqlite", "artifacts/session-queue.sqlite"]) {
      const filePath = path.join(workspace, relative);
      if (!(await exists(filePath))) continue;
      await assertNoSymlinkComponents(workspace, filePath);
      const database = new DatabaseSync(filePath, { timeout });
      locks.push(database);
      try {
        database.exec(`PRAGMA busy_timeout = ${timeout}`);
        const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() ?? {};
        if (Number(checkpoint.busy ?? 0) !== 0) {
          throw migrationError("WORKSPACE_DATABASE_BUSY", `${relative} checkpoint 被活动写入阻塞。`);
        }
        const result = database.prepare("PRAGMA integrity_check").get();
        if (String(result?.integrity_check ?? "") !== "ok") {
          throw migrationError("WORKSPACE_DATABASE_INVALID", `${relative} integrity_check 未通过。`);
        }
        database.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        if (error?.code === "WORKSPACE_DATABASE_BUSY") throw error;
        if (/busy|locked/i.test(String(error?.message ?? ""))) {
          throw migrationError("WORKSPACE_DATABASE_BUSY", `${relative} 仍有活动写事务。`);
        }
        throw error;
      }
    }
    return locks;
  } catch (error) {
    releaseLegacyDatabaseLocks(locks);
    throw error;
  }
}

function releaseLegacyDatabaseLocks(locks) {
  for (const database of [...locks].reverse()) {
    if (!database.isOpen) continue;
    try { database.exec("ROLLBACK"); } catch { /* BEGIN EXCLUSIVE may not have completed. */ }
    database.close();
  }
}

async function backupLegacyLayout(workspace, legacyPaths, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const directory = path.join(workspace, "backups", `workspace-layout-v1-${stamp}`);
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  for (const relative of legacyPaths) {
    const source = path.join(workspace, relative);
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await restrictRecoveryPermissions(destination);
  }
  const manifest = await manifestFor(directory);
  const moves = await movementManifest(workspace);
  const manifestPath = path.join(directory, "manifest.json");
  await atomicJson(manifestPath, {
    schemaVersion: 2,
    createdAt: now.toISOString(),
    sourceWorkspace: workspace,
    sensitivePaths: legacyPaths.filter(isSensitiveLegacyPath),
    moves,
    files: manifest
  });
  await restrictRecoveryPermissions(manifestPath);
  const manifestSha256 = await sha256File(manifestPath);
  const checksumPath = path.join(directory, "manifest.sha256");
  await fs.writeFile(checksumPath, `${manifestSha256}  manifest.json\n`, { flag: "wx", mode: 0o600 });
  await syncFile(checksumPath);
  await syncDirectory(directory);
  return { directory, files: manifest.length, sensitivePaths: legacyPaths.filter(isSensitiveLegacyPath), manifestSha256 };
}

async function assertMovable(source, destination) {
  if (!(await exists(source))) return;
  await assertRegularTree(source);
  await assertSameFileSystem(source, destination);
  if (!(await exists(destination))) return;
  const [sourceStats, destinationStats] = await Promise.all([fs.lstat(source), fs.lstat(destination)]);
  if (sourceStats.isDirectory() && destinationStats.isDirectory()) {
    for (const entry of await fs.readdir(source)) {
      await assertMovable(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (sourceStats.isFile() && destinationStats.isFile() && await sameFile(source, destination)) return;
  throw migrationError("WORKSPACE_MIGRATION_CONFLICT", `迁移目标已存在且内容不同：${destination}`);
}

async function stageCopy(source, destination, createdTargets, faultInjector, label) {
  if (!(await exists(source))) return;
  const sourceStats = await fs.lstat(source);
  if (sourceStats.isDirectory()) {
    if (!(await exists(destination))) await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const destinationStats = await fs.lstat(destination);
    if (!destinationStats.isDirectory()) {
      throw migrationError("WORKSPACE_MIGRATION_CONFLICT", `迁移目标类型冲突：${destination}`);
    }
    for (const entry of await fs.readdir(source)) {
      await stageCopy(
        path.join(source, entry),
        path.join(destination, entry),
        createdTargets,
        faultInjector,
        `${label}/${entry}`
      );
    }
    return;
  }
  if (!sourceStats.isFile()) throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `迁移源不是普通文件：${source}`);
  if (await exists(destination)) {
    const destinationStats = await fs.lstat(destination);
    if (destinationStats.isFile() && await sameFile(source, destination)) return;
    throw migrationError("WORKSPACE_MIGRATION_CONFLICT", `迁移目标已存在且内容不同：${destination}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.workspace-layout-stage-${process.pid}`;
  try {
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporary, isSensitiveDestination(destination) ? 0o600 : sourceStats.mode & 0o777);
    await syncFile(temporary);
    if (!(await sameFile(source, temporary))) {
      throw migrationError("WORKSPACE_MIGRATION_COPY_INVALID", `迁移暂存校验失败：${source}`);
    }
    await invokeFault(faultInjector, `before-target-publish:${label}`);
    await fs.rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
    createdTargets.push(await targetEvidence(destination));
    await invokeFault(faultInjector, `after-target-publish:${label}`);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function verifyMoveTargets(workspace) {
  for (const [sourceRelative, destinationRelative] of [...DIRECTORY_MOVES, ...FILE_MOVES]) {
    const source = path.join(workspace, sourceRelative);
    const destination = path.join(workspace, destinationRelative);
    if (!(await exists(source))) continue;
    await verifyTreeCopy(source, destination);
  }
}

async function verifyTreeCopy(source, destination) {
  const sourceStats = await fs.lstat(source);
  const destinationStats = await fs.lstat(destination).catch(() => null);
  if (sourceStats.isDirectory()) {
    if (!destinationStats?.isDirectory()) throw migrationError("WORKSPACE_MIGRATION_COPY_INVALID", `迁移目录缺失：${destination}`);
    for (const entry of await fs.readdir(source)) await verifyTreeCopy(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!destinationStats?.isFile() || !(await sameFile(source, destination))) {
    throw migrationError("WORKSPACE_MIGRATION_COPY_INVALID", `迁移文件校验失败：${destination}`);
  }
}

async function rollbackFailedLayoutMigration(workspace, backupDirectory, legacyPaths, createdTargets) {
  const removableTargets = [];
  for (const target of [...createdTargets].reverse()) {
    const stats = await fs.lstat(target.path).catch(() => null);
    if (!stats) continue;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== target.bytes
      || await sha256File(target.path) !== target.sha256) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚不会删除未知目标：${target.path}`);
    }
    removableTargets.push(target.path);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(backupDirectory, "manifest.json"), "utf8"));
  const existingTargets = [];
  for (const move of [...manifest.moves].reverse()) {
    if (move?.type !== "file" || move.targetExisted !== true) continue;
    const sourceBackup = safeLayoutChild(backupDirectory, move.source);
    const target = safeLayoutChild(workspace, move.target);
    if (!(await exists(target))) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚缺少原有目标：${target}`);
    }
    const stats = await fs.lstat(target);
    const allowedHashes = new Set([move.sha256]);
    if (move.source === "config/sunabot.json") allowedHashes.add(await rewrittenConfigSha256(sourceBackup));
    if (!stats.isFile() || stats.isSymbolicLink() || !allowedHashes.has(await sha256File(target))) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚不会覆盖未知文件：${target}`);
    }
    existingTargets.push({ sourceBackup, target });
  }
  for (const target of removableTargets) await fs.rm(target);
  for (const entry of existingTargets) await replaceFileDurable(entry.sourceBackup, entry.target);
  for (const relative of legacyPaths) {
    const backupSource = path.join(backupDirectory, relative);
    if (!(await exists(backupSource))) {
      throw migrationError("WORKSPACE_MIGRATION_BACKUP_INVALID", `恢复包缺少迁移源：${relative}`);
    }
    await restoreTreeWithoutOverwrite(backupSource, path.join(workspace, relative));
  }
}

async function targetEvidence(filePath) {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `迁移目标不是普通文件：${filePath}`);
  }
  return { path: filePath, bytes: stats.size, sha256: await sha256File(filePath) };
}

async function refreshCreatedTargetEvidence(createdTargets, filePath) {
  const index = createdTargets.findIndex((entry) => entry.path === filePath);
  if (index >= 0) createdTargets[index] = await targetEvidence(filePath);
}

async function recoverInterruptedLayoutMigration(workspace, intentPath) {
  let intent;
  try {
    const stats = await fs.lstat(intentPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw migrationError("WORKSPACE_MIGRATION_INTENT_INVALID", "workspace 布局迁移 journal 必须是普通文件。");
    }
    intent = JSON.parse(await fs.readFile(intentPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code === "WORKSPACE_MIGRATION_INTENT_INVALID") throw error;
    throw migrationError("WORKSPACE_MIGRATION_INTENT_INVALID", `workspace 布局迁移 journal 无效：${error.message}`);
  }
  if (intent?.schemaVersion !== 1 || !Array.isArray(intent.legacyPaths)
    || typeof intent.backup !== "string" || !/^backups\/workspace-layout-v1-[^/]+$/.test(intent.backup)
    || !/^[a-f0-9]{64}$/.test(intent.backupManifestSha256)) {
    throw migrationError("WORKSPACE_MIGRATION_INTENT_INVALID", "workspace 布局迁移 journal 内容无效。");
  }
  const knownLegacyPaths = new Set([...DIRECTORY_MOVES, ...FILE_MOVES].map(([source]) => source));
  if (intent.legacyPaths.some((relative) => !knownLegacyPaths.has(relative))) {
    throw migrationError("WORKSPACE_MIGRATION_INTENT_INVALID", "workspace 布局迁移 journal 包含未知来源。");
  }
  const backupDirectory = safeLayoutChild(workspace, intent.backup);
  await assertNoSymlinkComponents(workspace, backupDirectory);
  await assertRegularTree(backupDirectory);
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const checksumPath = path.join(backupDirectory, "manifest.sha256");
  const manifestSha256 = await sha256File(manifestPath);
  const checksum = (await fs.readFile(checksumPath, "utf8")).trim();
  if (manifestSha256 !== intent.backupManifestSha256 || checksum !== `${manifestSha256}  manifest.json`) {
    throw migrationError("WORKSPACE_MIGRATION_BACKUP_INVALID", "workspace 布局迁移恢复包校验失败。");
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.moves)) {
    throw migrationError("WORKSPACE_MIGRATION_BACKUP_INVALID", "workspace 布局迁移恢复包 manifest 无效。");
  }

  for (const move of [...manifest.moves].reverse()) {
    if (move?.type !== "file") continue;
    const sourceBackup = safeLayoutChild(backupDirectory, move.source);
    const target = safeLayoutChild(workspace, move.target);
    const targetExists = await exists(target);
    if (!targetExists) continue;
    const targetStats = await fs.lstat(target);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚不会覆盖未知路径：${target}`);
    }
    const allowedHashes = new Set([move.sha256]);
    if (move.source === "config/sunabot.json") allowedHashes.add(await rewrittenConfigSha256(sourceBackup));
    if (!allowedHashes.has(await sha256File(target))) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚不会覆盖未知文件：${target}`);
    }
    if (move.targetExisted) await replaceFileDurable(sourceBackup, target);
    else await fs.rm(target);
  }
  const legacyQr = manifest.moves.find((move) => move.source === "napcat/cache/qrcode.png" && move.type === "file");
  const migratedQr = path.join(workspace, "runtime/napcat/qrcode.png");
  if (legacyQr && await exists(migratedQr)) {
    const stats = await fs.lstat(migratedQr);
    if (!stats.isFile() || stats.isSymbolicLink() || await sha256File(migratedQr) !== legacyQr.sha256) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚不会覆盖未知二维码：${migratedQr}`);
    }
    await fs.rm(migratedQr);
  }
  for (const relative of intent.legacyPaths) {
    await restoreTreeWithoutOverwrite(path.join(backupDirectory, relative), path.join(workspace, relative));
  }
  await fs.rm(intentPath, { force: true });
  await syncDirectory(workspace);
}

async function acquireMigrationLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!(await staleMigrationLock(lockPath))) {
        throw migrationError("WORKSPACE_MIGRATION_LOCKED", "workspace 布局迁移正在运行。");
      }
      await fs.rm(lockPath, { force: true });
    }
  }
  throw migrationError("WORKSPACE_MIGRATION_LOCKED", "无法获取 workspace 布局迁移锁。");
}

async function staleMigrationLock(lockPath) {
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const pid = Number(lock.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  } catch {
    return true;
  }
}

function safeLayoutChild(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\")) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", "workspace 布局迁移相对路径无效。");
  }
  const resolved = path.resolve(root, relative);
  const child = path.relative(path.resolve(root), resolved);
  if (!child || child === ".." || child.startsWith(`..${path.sep}`) || path.isAbsolute(child)) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", "workspace 布局迁移路径越界。");
  }
  return resolved;
}

async function rewrittenConfigSha256(source) {
  const config = JSON.parse(await fs.readFile(source, "utf8"));
  if (config.persona?.agentWorkspace === "workspace/agents/plana") {
    config.persona.agentWorkspace = "workspace/business/agents/plana";
  }
  for (const provider of config.providers?.items ?? []) {
    if (provider?.envFile === ".env" || provider?.envFile === "workspace/.env") {
      provider.envFile = "workspace/secrets/runtime.env";
    }
  }
  return createHash("sha256").update(`${JSON.stringify(config, null, 2)}\n`).digest("hex");
}

async function replaceFileDurable(source, destination) {
  const temporary = `${destination}.rollback-${process.pid}`;
  await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
  await syncFile(temporary);
  await fs.rename(temporary, destination);
  await syncDirectory(path.dirname(destination));
}

async function restoreTreeWithoutOverwrite(source, destination) {
  const sourceStats = await fs.lstat(source);
  if (sourceStats.isDirectory()) {
    if (!(await exists(destination))) await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    const destinationStats = await fs.lstat(destination);
    if (!destinationStats.isDirectory()) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚目标类型冲突：${destination}`);
    }
    for (const entry of await fs.readdir(source)) {
      await restoreTreeWithoutOverwrite(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (await exists(destination)) {
    if (!(await sameFile(source, destination))) {
      throw migrationError("WORKSPACE_MIGRATION_ROLLBACK_CONFLICT", `回滚不会覆盖未知文件：${destination}`);
    }
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await fs.chmod(destination, isSensitiveLegacyAbsolute(destination) ? 0o600 : sourceStats.mode & 0o777);
  await syncFile(destination);
}

async function movementManifest(workspace) {
  const entries = [];
  for (const [sourceRelative, destinationRelative] of [...DIRECTORY_MOVES, ...FILE_MOVES]) {
    const source = path.join(workspace, sourceRelative);
    if (!(await exists(source))) continue;
    await collectMovementEntries(workspace, source, path.join(workspace, destinationRelative), entries);
  }
  return entries.sort((left, right) => left.source.localeCompare(right.source));
}

async function collectMovementEntries(workspace, source, destination, entries) {
  const stats = await fs.lstat(source);
  const sourceRelative = path.relative(workspace, source).replace(/\\/g, "/");
  const destinationRelative = path.relative(workspace, destination).replace(/\\/g, "/");
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `迁移源包含不支持的路径：${sourceRelative}`);
  }
  entries.push({
    source: sourceRelative,
    target: destinationRelative,
    type: stats.isDirectory() ? "directory" : "file",
    bytes: stats.isFile() ? stats.size : 0,
    sha256: stats.isFile() ? await sha256File(source) : null,
    sensitive: isSensitiveLegacyPath(sourceRelative),
    targetExisted: await exists(destination)
  });
  if (stats.isDirectory()) {
    for (const child of await fs.readdir(source)) {
      await collectMovementEntries(workspace, path.join(source, child), path.join(destination, child), entries);
    }
  }
}

async function assertRegularTree(candidate) {
  const stats = await fs.lstat(candidate);
  if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `迁移源包含符号链接或特殊文件：${candidate}`);
  }
  if (stats.isDirectory()) {
    for (const entry of await fs.readdir(candidate)) await assertRegularTree(path.join(candidate, entry));
  }
}

async function assertNoSymlinkComponents(root, candidate) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `workspace 布局迁移路径越界：${candidate}`);
  }
  const rootStats = await fs.lstat(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `workspace 根目录无效：${root}`);
  }
  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `workspace 布局迁移路径包含符号链接：${current}`);
    }
  }
}

async function assertSameFileSystem(source, destination) {
  const [sourceStats, destinationParentStats] = await Promise.all([
    fs.stat(source),
    fs.stat(await nearestExistingParent(path.dirname(destination)))
  ]);
  if (sourceStats.dev !== destinationParentStats.dev) {
    throw migrationError("WORKSPACE_MIGRATION_CROSS_DEVICE", `迁移源与目标不在同一文件系统：${source}`);
  }
}

async function nearestExistingParent(candidate) {
  let current = candidate;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `迁移目标父目录不存在：${candidate}`);
    current = parent;
  }
  return current;
}

async function restrictRecoveryPermissions(candidate) {
  const stats = await fs.lstat(candidate);
  if (stats.isDirectory()) {
    await fs.chmod(candidate, 0o700);
    for (const entry of await fs.readdir(candidate)) await restrictRecoveryPermissions(path.join(candidate, entry));
    return;
  }
  if (!stats.isFile()) throw migrationError("WORKSPACE_MIGRATION_PATH_INVALID", `恢复包包含不支持的路径：${candidate}`);
  await fs.chmod(candidate, 0o600);
}

function isSensitiveDestination(candidate) {
  const normalized = candidate.replace(/\\/g, "/");
  return normalized.includes("/secrets/") || normalized.includes("/runtime/napcat/");
}

function isSensitiveLegacyAbsolute(candidate) {
  const normalized = candidate.replace(/\\/g, "/");
  return normalized.endsWith("/.env") || normalized.includes("/security/") || normalized.includes("/napcat/");
}

async function invokeFault(faultInjector, step) {
  await faultInjector(step);
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function rewriteConfig(configPath) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  let changed = false;
  if (config.persona?.agentWorkspace === "workspace/agents/plana") {
    config.persona.agentWorkspace = "workspace/business/agents/plana";
    changed = true;
  }
  for (const provider of config.providers?.items ?? []) {
    if (provider?.envFile === ".env" || provider?.envFile === "workspace/.env") {
      provider.envFile = "workspace/secrets/runtime.env";
      changed = true;
    }
  }
  if (changed) await atomicJson(configPath, config);
}

async function verifyDatabase(filePath) {
  if (!(await exists(filePath))) return;
  const database = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
  try {
    const result = database.prepare("PRAGMA integrity_check").get();
    if (String(result?.integrity_check ?? "") !== "ok") {
      throw migrationError("WORKSPACE_DATABASE_INVALID", `${filePath} integrity_check 未通过。`);
    }
  } finally {
    database.close();
  }
}

async function assertConfiguredServiceStopped(workspace) {
  const configPaths = [
    path.join(workspace, "business/config/sunabot.json"),
    path.join(workspace, "config/sunabot.json")
  ];
  let port = 8787;
  for (const configPath of configPaths) {
    if (!(await exists(configPath))) continue;
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const configured = Number(config.server?.port);
    if (Number.isSafeInteger(configured) && configured > 0 && configured <= 65_535) port = configured;
    break;
  }
  if (await isListening(port)) {
    throw migrationError("WORKSPACE_SERVICE_RUNNING", `端口 ${port} 正在监听；请先停止对应 Sunabot 服务。`);
  }
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function manifestFor(root) {
  const files = [];
  await walk(root, async (filePath) => {
    const bytes = await fs.readFile(filePath);
    files.push({
      path: path.relative(root, filePath).replace(/\\/g, "/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(directory, visit) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(filePath, visit);
    else if (entry.isFile()) await visit(filePath);
  }
}

async function sameFile(left, right) {
  const [leftBytes, rightBytes] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftBytes.equals(rightBytes);
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await syncFile(temporary);
  await fs.rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function migrationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isSensitiveLegacyPath(relative) {
  const normalized = relative.replace(/\\/g, "/");
  return SENSITIVE_LEGACY_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = resolveProjectRoot(import.meta.url);
  const workspace = resolveWorkspace(root, { requireExplicit: process.env.NODE_ENV === "production" });
  const result = await migrateWorkspaceLayout({ workspace });
  console.log(result.migrated
    ? `workspace 布局迁移完成；备份：${result.backup?.directory ?? "无"}`
    : `workspace 已是 v${LAYOUT_VERSION} 布局：${workspace}`);
}
