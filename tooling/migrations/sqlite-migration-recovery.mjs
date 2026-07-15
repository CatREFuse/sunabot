import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AbsolutePathSafetyError,
  ensureSafeAbsoluteDirectory
} from "../shared/safe-absolute-path.mjs";

const MANIFEST_NAME = "manifest.json";
const CHECKSUM_NAME = "manifest.sha256";

export class SqliteMigrationRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SqliteMigrationRecoveryError";
    this.code = code;
  }
}

export async function createSqliteMigrationRecoveryPoint(options) {
  const workspace = absolute(options.workspace, "workspace");
  const backupId = options.backupId ?? `sqlite-migration-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (!/^sqlite-migration-[A-Za-z0-9T_.-]{8,96}$/.test(backupId)) fail("SQLITE_MIGRATION_BACKUP_ID_INVALID", "SQLite 迁移恢复点 ID 无效。");
  const backupsRoot = path.join(workspace, "backups");
  const finalDirectory = safeChild(workspace, path.posix.join("backups", backupId));
  const directory = safeChild(workspace, path.posix.join("backups", `.partial-${backupId}-${process.pid}`));
  const faultInjector = options.faultInjector ?? (() => undefined);
  await safeMigrationDirectory(workspace);
  await safeMigrationDirectory(backupsRoot, { create: true });
  const releaseLock = await acquireMigrationRecoveryLock(backupsRoot);
  try {
    await removeStalePartials(backupsRoot);
    if (await exists(finalDirectory)) fail("SQLITE_MIGRATION_BACKUP_EXISTS", `SQLite 迁移恢复点已存在：${backupId}`);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    const sourceEntries = [];
    for (const source of options.sources ?? []) {
      const sourcePath = safeInputPath(workspace, source.path);
      await assertNoSymlinkComponents(workspace, sourcePath);
      await assertRegularFile(sourcePath, "SQLITE_MIGRATION_SOURCE_INVALID");
      const relative = relativeWorkspacePath(workspace, sourcePath);
      const backupFile = path.posix.join("sources", relative);
      const destination = safeChild(directory, backupFile);
      await copyDurable(sourcePath, destination);
      const stat = await fs.stat(destination);
      const idempotencyKeys = [...new Set(source.idempotencyKeys ?? [])].map(String).sort();
      sourceEntries.push({
        id: source.id,
        kind: source.kind ?? "legacy-source",
        source: relative,
        file: backupFile,
        bytes: stat.size,
        sha256: await sha256File(destination),
        recordCount: source.recordCount,
        idempotencyKeyCount: idempotencyKeys.length,
        idempotencyKeysSha256: sha256(JSON.stringify(idempotencyKeys))
      });
      await faultInjector(`after-source:${source.id}`);
    }

    const databaseSources = [];
    for (const database of options.databases ?? []) {
      const sourcePath = safeInputPath(workspace, database.path);
      await assertNoSymlinkComponents(workspace, sourcePath);
      await assertRegularFile(sourcePath, "SQLITE_MIGRATION_DATABASE_INVALID");
      const relative = relativeWorkspacePath(workspace, sourcePath);
      const backupFile = path.posix.join("databases", relative);
      const destination = safeChild(directory, backupFile);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      databaseSources.push({ database, sourcePath, relative, backupFile, destination });
    }

    const databaseLocks = [];
    try {
      for (const source of databaseSources) {
        const writer = new DatabaseSync(source.sourcePath, { timeout: 5_000 });
        try {
          writer.exec("PRAGMA busy_timeout=5000");
          const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (Number(checkpoint?.busy ?? 0) !== 0) {
            fail("SQLITE_MIGRATION_DATABASE_BUSY", `数据库仍在写入：${source.relative}`);
          }
          writer.exec("BEGIN EXCLUSIVE");
          databaseLocks.push(writer);
        } catch (error) {
          writer.close();
          if (/busy|locked/i.test(error?.message ?? "")) {
            fail("SQLITE_MIGRATION_DATABASE_BUSY", `数据库仍在写入：${source.relative}`);
          }
          throw error;
        }
      }

      const databaseEntries = [];
      for (const source of databaseSources) {
        await copyDurable(source.sourcePath, source.destination);
        const inspection = inspectDatabase(source.destination);
        const stat = await fs.stat(source.destination);
        databaseEntries.push({
          id: source.database.id,
          kind: source.database.kind ?? "sqlite",
          source: source.relative,
          file: source.backupFile,
          bytes: stat.size,
          sha256: await sha256File(source.destination),
          ...inspection
        });
        await faultInjector(`after-database:${source.database.id}`);
      }

      const manifest = {
        schemaVersion: 2,
        kind: "sqlite-migration-recovery",
        backupId,
        createdAt: new Date().toISOString(),
        workspaceBoundary: ".",
        sources: sourceEntries,
        databases: databaseEntries,
        postMigration: null
      };
      await faultInjector("before-manifest");
      await writeManifest(directory, manifest);
      await verifySqliteMigrationRecoveryPoint(directory);
      await syncDirectory(directory);
      await fs.rename(directory, finalDirectory);
      await syncDirectory(backupsRoot);
      return { directory: finalDirectory, manifest };
    } finally {
      for (const writer of databaseLocks.reverse()) {
        if (!writer.isOpen) continue;
        try {
          writer.exec("ROLLBACK");
        } catch {
          // BEGIN EXCLUSIVE may have failed before the connection was recorded.
        }
        writer.close();
      }
    }
  } catch (error) {
    await removeSafeMigrationDirectory(directory);
    throw error;
  } finally {
    await releaseLock();
  }
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function acquireMigrationRecoveryLock(backupsRoot) {
  const lockPath = path.join(backupsRoot, ".sqlite-migration-recovery.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
      await handle.close();
      return async () => removeMigrationRecoveryLock(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await migrationRestoreFileState(lockPath) !== "file") {
        fail("SQLITE_MIGRATION_PATH_INVALID", `SQLite 迁移恢复锁路径不安全：${lockPath}`);
      }
      let stale = true;
      try {
        const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
        const pid = Number(lock.pid);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            stale = false;
          } catch (killError) {
            stale = killError?.code === "ESRCH";
          }
        }
      } catch {
        stale = true;
      }
      if (!stale) fail("SQLITE_MIGRATION_BACKUP_LOCKED", "另一个 SQLite 迁移恢复点正在创建。");
      await removeMigrationRecoveryLock(lockPath);
    }
  }
  fail("SQLITE_MIGRATION_BACKUP_LOCKED", "无法获取 SQLite 迁移恢复点锁。");
}

async function removeStalePartials(backupsRoot) {
  for (const name of await fs.readdir(backupsRoot)) {
    if (!name.startsWith(".partial-sqlite-migration-")) continue;
    const candidate = path.join(backupsRoot, name);
    if (path.dirname(candidate) !== backupsRoot) continue;
    await safeMigrationDirectory(candidate);
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

async function removeMigrationRecoveryLock(lockPath) {
  const state = await migrationRestoreFileState(lockPath);
  if (state === "missing") return;
  if (state !== "file") fail("SQLITE_MIGRATION_PATH_INVALID", `SQLite 迁移恢复锁路径不安全：${lockPath}`);
  await fs.rm(lockPath);
}

export async function finalizeSqliteMigrationRecoveryPoint(options) {
  const directory = absolute(options.directory, "directory");
  const verified = await verifySqliteMigrationRecoveryPoint(directory);
  const workspace = absolute(options.workspace, "workspace");
  await safeMigrationDirectory(workspace);
  const targets = [];
  for (const target of options.targets ?? []) {
    const targetPath = safeInputPath(workspace, target.path);
    await assertNoSymlinkComponents(workspace, targetPath);
    await assertRegularFile(targetPath, "SQLITE_MIGRATION_TARGET_INVALID");
    const writable = new DatabaseSync(targetPath, { timeout: 5_000 });
    try {
      writable.exec("PRAGMA busy_timeout=5000");
      const checkpoint = writable.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(checkpoint?.busy ?? 0) !== 0) fail("SQLITE_MIGRATION_DATABASE_BUSY", `数据库仍在写入：${targetPath}`);
    } finally {
      writable.close();
    }
    const stat = await fs.stat(targetPath);
    targets.push({
      id: target.id,
      kind: target.kind ?? "sqlite",
      path: relativeWorkspacePath(workspace, targetPath),
      bytes: stat.size,
      sha256: await sha256File(targetPath),
      ...inspectDatabase(targetPath)
    });
  }
  const manifest = {
    ...verified.manifest,
    postMigration: {
      verifiedAt: new Date().toISOString(),
      sourceCounts: options.sourceCounts,
      databaseCounts: options.databaseCounts,
      imports: options.imports ?? {},
      targets
    }
  };
  await writeManifest(directory, manifest, true);
  await verifySqliteMigrationRecoveryPoint(directory);
  return { directory, manifest };
}

export async function verifySqliteMigrationRecoveryPoint(directoryInput) {
  const directory = absolute(directoryInput, "directory");
  await safeMigrationDirectory(directory);
  const manifestPath = path.join(directory, MANIFEST_NAME);
  const checksumPath = path.join(directory, CHECKSUM_NAME);
  await assertRegularFile(manifestPath, "SQLITE_MIGRATION_MANIFEST_MISSING");
  await assertRegularFile(checksumPath, "SQLITE_MIGRATION_MANIFEST_MISSING");
  const bytes = await fs.readFile(manifestPath);
  const checksum = (await fs.readFile(checksumPath, "utf8")).trim();
  if (checksum !== `${sha256(bytes)}  ${MANIFEST_NAME}`) fail("SQLITE_MIGRATION_MANIFEST_CHECKSUM", "SQLite 迁移恢复点 manifest 校验失败。");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.schemaVersion !== 2 || manifest.kind !== "sqlite-migration-recovery"
    || !Array.isArray(manifest.sources) || !Array.isArray(manifest.databases)) {
    fail("SQLITE_MIGRATION_MANIFEST_INVALID", "SQLite 迁移恢复点 manifest 无效。");
  }
  const seenSources = new Set();
  const seenIds = new Set();
  const seenFiles = new Set();
  for (const entry of [...manifest.sources, ...manifest.databases]) {
    if (!entry || typeof entry.id !== "string" || !entry.id
      || typeof entry.source !== "string" || seenSources.has(entry.source)
      || typeof entry.file !== "string" || seenFiles.has(entry.file)
      || seenIds.has(entry.id)) {
      fail("SQLITE_MIGRATION_MANIFEST_INVALID", "SQLite 迁移恢复点包含重复或无效来源。");
    }
    seenSources.add(entry.source);
    seenIds.add(entry.id);
    seenFiles.add(entry.file);
    safeChild("/sqlite-migration-workspace-boundary", entry.source);
    if (manifest.sources.includes(entry)
      && (!Number.isSafeInteger(entry.recordCount) || entry.recordCount < 0
        || !Number.isSafeInteger(entry.idempotencyKeyCount) || entry.idempotencyKeyCount < 0
        || !/^[a-f0-9]{64}$/.test(entry.idempotencyKeysSha256))) {
      fail("SQLITE_MIGRATION_MANIFEST_INVALID", `SQLite 迁移来源计数或幂等摘要无效：${entry.id}`);
    }
    const filePath = safeChild(directory, entry.file);
    await assertNoSymlinkComponents(directory, filePath);
    await assertRegularFile(filePath, "SQLITE_MIGRATION_BACKUP_FILE_MISSING");
    const stat = await fs.stat(filePath);
    if (stat.size !== entry.bytes || await sha256File(filePath) !== entry.sha256) {
      fail("SQLITE_MIGRATION_BACKUP_CHECKSUM", `SQLite 迁移恢复文件校验失败：${entry.source}`);
    }
    if (manifest.databases.includes(entry)) inspectDatabase(filePath, entry);
  }
  return { ok: true, directory, manifest };
}

export async function restoreSqliteMigrationRecoveryPoint(options) {
  const recovery = await verifySqliteMigrationRecoveryPoint(options.directory);
  const targetWorkspace = absolute(options.targetWorkspace, "targetWorkspace");
  const faultInjector = options.faultInjector ?? (() => undefined);
  const stagingRelative = `.sqlite-migration-restore-${recovery.manifest.backupId}.staging`;
  const stagingDirectory = safeChild(targetWorkspace, stagingRelative);
  const intentPath = safeChild(targetWorkspace, `.sqlite-migration-restore-${recovery.manifest.backupId}.json`);
  await safeMigrationDirectory(targetWorkspace, { create: true });
  const targets = [...recovery.manifest.sources, ...recovery.manifest.databases].map((entry, index) => ({
    entry,
    source: safeChild(recovery.directory, entry.file),
    destination: safeChild(targetWorkspace, entry.source),
    staged: safeChild(targetWorkspace, path.posix.join(stagingRelative, `${index}.restore`)),
    isDatabase: recovery.manifest.databases.includes(entry)
  }));
  let intent = await readMigrationRestoreIntent(intentPath, recovery, targetWorkspace, targets, stagingRelative);
  if (!intent) {
    if ((await fs.readdir(targetWorkspace)).length > 0) {
      fail("SQLITE_MIGRATION_RESTORE_TARGET_NOT_EMPTY", "SQLite 迁移恢复目标必须为空。");
    }
    intent = buildMigrationRestoreIntent(recovery, targets, stagingRelative);
    await writeJsonAtomic(intentPath, intent);
    await faultInjector("after-restore-intent");
  }

  await ensureSafeRestoreDirectory(targetWorkspace, stagingRelative);
  for (const target of targets) {
    const journalEntry = migrationRestoreIntentEntry(intent, target.entry.id);
    const destinationState = await migrationRestoreFileState(target.destination);
    const stagedState = await migrationRestoreFileState(target.staged);
    if (destinationState === "file") {
      await assertMigrationRestoreFile(target.destination, journalEntry, target);
      if (!intent.copied.includes(target.entry.id)) {
        intent.copied.push(target.entry.id);
        await writeJsonAtomic(intentPath, intent);
      }
      continue;
    }
    if (destinationState !== "missing") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复目标路径冲突：${target.destination}`);
    }
    if (stagedState === "invalid") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复暂存路径冲突：${target.staged}`);
    }
    if (stagedState === "missing") await copyDurable(target.source, target.staged);
    await assertMigrationRestoreFile(target.staged, journalEntry, target);
    if (target.isDatabase) await removeMigrationRestoreSidecars(target.staged);
    if (!intent.copied.includes(target.entry.id)) {
      intent.copied.push(target.entry.id);
      await writeJsonAtomic(intentPath, intent);
      await faultInjector(`after-restore-copy-${target.entry.id}`);
    }
  }

  for (const target of targets) {
    const journalEntry = migrationRestoreIntentEntry(intent, target.entry.id);
    await ensureSafeRestoreDirectory(targetWorkspace, path.posix.dirname(target.entry.source));
    const destinationState = await migrationRestoreFileState(target.destination);
    const stagedState = await migrationRestoreFileState(target.staged);
    if (destinationState === "file") {
      await assertMigrationRestoreFile(target.destination, journalEntry, target);
      if (stagedState === "file") {
        await assertMigrationRestoreFile(target.staged, journalEntry, target);
        await fs.rm(target.staged);
      } else if (stagedState !== "missing") {
        fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复暂存路径冲突：${target.staged}`);
      }
      if (!intent.completed.includes(target.entry.id)) {
        intent.completed.push(target.entry.id);
        await writeJsonAtomic(intentPath, intent);
      }
      continue;
    }
    if (destinationState !== "missing" || stagedState !== "file") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复发布状态冲突：${target.entry.id}`);
    }
    await assertMigrationRestoreFile(target.staged, journalEntry, target);
    await fs.rename(target.staged, target.destination);
    await syncDirectory(path.dirname(target.destination));
    if (!intent.completed.includes(target.entry.id)) intent.completed.push(target.entry.id);
    await writeJsonAtomic(intentPath, intent);
  }

  for (const target of targets) {
    const journalEntry = migrationRestoreIntentEntry(intent, target.entry.id);
    await assertMigrationRestoreFile(target.destination, journalEntry, target);
    if (target.isDatabase) await removeMigrationRestoreSidecars(target.destination);
  }
  await fs.rmdir(stagingDirectory).catch((error) => {
    if (error?.code === "ENOENT") return;
    if (error?.code === "ENOTEMPTY") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复暂存目录包含未知文件：${stagingDirectory}`);
    }
    throw error;
  });
  await fs.rm(intentPath);
  await syncDirectory(targetWorkspace);
  return { ok: true, targetWorkspace, backupId: recovery.manifest.backupId };
}

export async function rollbackSqliteMigrationRecoveryPointRestore(options) {
  const recovery = await verifySqliteMigrationRecoveryPoint(options.directory);
  const targetWorkspace = absolute(options.targetWorkspace, "targetWorkspace");
  await safeMigrationDirectory(targetWorkspace);
  const stagingRelative = `.sqlite-migration-restore-${recovery.manifest.backupId}.staging`;
  const stagingDirectory = safeChild(targetWorkspace, stagingRelative);
  const intentPath = safeChild(targetWorkspace, `.sqlite-migration-restore-${recovery.manifest.backupId}.json`);
  const targets = [...recovery.manifest.sources, ...recovery.manifest.databases].map((entry, index) => ({
    entry,
    source: safeChild(recovery.directory, entry.file),
    destination: safeChild(targetWorkspace, entry.source),
    staged: safeChild(targetWorkspace, path.posix.join(stagingRelative, `${index}.restore`)),
    isDatabase: recovery.manifest.databases.includes(entry)
  }));
  const intent = await readMigrationRestoreIntent(intentPath, recovery, targetWorkspace, targets, stagingRelative);
  if (!intent) fail("SQLITE_MIGRATION_RESTORE_INTENT_MISSING", "没有可回滚的 SQLite 迁移恢复事务。");
  for (const target of [...targets].reverse()) {
    const journalEntry = migrationRestoreIntentEntry(intent, target.entry.id);
    const destinationState = await migrationRestoreFileState(target.destination);
    if (destinationState === "file") {
      await assertMigrationRestoreFile(target.destination, journalEntry, target);
      if (target.isDatabase) await removeMigrationRestoreSidecars(target.destination);
      await fs.rm(target.destination);
      await syncDirectory(path.dirname(target.destination));
    } else if (destinationState !== "missing") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复目标路径冲突：${target.destination}`);
    }
    const stagedState = await migrationRestoreFileState(target.staged);
    if (stagedState === "file") {
      await assertMigrationRestoreFile(target.staged, journalEntry, target);
      if (target.isDatabase) await removeMigrationRestoreSidecars(target.staged);
      await fs.rm(target.staged);
    } else if (stagedState !== "missing") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复暂存路径冲突：${target.staged}`);
    }
  }
  await fs.rmdir(stagingDirectory).catch((error) => {
    if (error?.code === "ENOENT") return;
    if (error?.code === "ENOTEMPTY") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复暂存目录包含未知文件：${stagingDirectory}`);
    }
    throw error;
  });
  await fs.rm(intentPath);
  await removeEmptyMigrationRestoreDirectories(targetWorkspace, targets);
  await syncDirectory(targetWorkspace);
  return { ok: true, rolledBack: true, targetWorkspace, backupId: recovery.manifest.backupId };
}

function buildMigrationRestoreIntent(recovery, targets, stagingRelative) {
  return {
    schemaVersion: 1,
    backupId: recovery.manifest.backupId,
    createdAt: new Date().toISOString(),
    stagingDirectory: stagingRelative,
    copied: [],
    completed: [],
    files: targets.map((target, index) => ({
      id: target.entry.id,
      source: target.entry.file,
      staged: path.posix.join(stagingRelative, `${index}.restore`),
      destination: target.entry.source,
      bytes: target.entry.bytes,
      sha256: target.entry.sha256,
      isDatabase: target.isDatabase
    }))
  };
}

async function readMigrationRestoreIntent(intentPath, recovery, targetWorkspace, targets, stagingRelative) {
  const state = await migrationRestoreFileState(intentPath);
  if (state === "missing") return null;
  if (state !== "file") fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", "SQLite 迁移恢复 journal 不是普通文件。");
  let intent;
  try {
    intent = JSON.parse(await fs.readFile(intentPath, "utf8"));
  } catch (error) {
    fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", `SQLite 迁移恢复 journal 无效：${error.message}`);
  }
  const expectedIds = targets.map((target) => target.entry.id).sort();
  const ids = Array.isArray(intent?.files) ? intent.files.map((entry) => entry?.id).sort() : [];
  if (intent?.schemaVersion !== 1
    || intent.backupId !== recovery.manifest.backupId
    || intent.stagingDirectory !== stagingRelative
    || JSON.stringify(ids) !== JSON.stringify(expectedIds)
    || !Array.isArray(intent.copied)
    || !Array.isArray(intent.completed)
    || intent.copied.some((id) => !expectedIds.includes(id))
    || intent.completed.some((id) => !expectedIds.includes(id))) {
    fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", "SQLite 迁移恢复 journal 与恢复点不匹配。");
  }
  for (const [index, target] of targets.entries()) {
    const entry = migrationRestoreIntentEntry(intent, target.entry.id);
    if (entry.source !== target.entry.file
      || entry.staged !== path.posix.join(stagingRelative, `${index}.restore`)
      || entry.destination !== target.entry.source
      || entry.bytes !== target.entry.bytes
      || entry.sha256 !== target.entry.sha256
      || entry.isDatabase !== target.isDatabase) {
      fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", `SQLite 迁移恢复 journal 条目不匹配：${target.entry.id}`);
    }
    safeChild(targetWorkspace, entry.staged);
    safeChild(targetWorkspace, entry.destination);
  }
  const stagingState = await migrationRestoreDirectoryState(safeChild(targetWorkspace, stagingRelative));
  if (stagingState === "invalid") {
    fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", "SQLite 迁移恢复暂存目录无效。");
  }
  if (stagingState === "missing" && (intent.copied.length > 0 || intent.completed.length > 0)) {
    for (const target of targets) {
      const destinationState = await migrationRestoreFileState(target.destination);
      if (destinationState !== "file") {
        fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", "SQLite 迁移恢复暂存目录缺失且目标尚未完成。");
      }
      await assertMigrationRestoreFile(
        target.destination,
        migrationRestoreIntentEntry(intent, target.entry.id),
        target
      );
    }
  }
  return intent;
}

function migrationRestoreIntentEntry(intent, id) {
  const entry = intent.files.find((candidate) => candidate?.id === id);
  if (!entry) fail("SQLITE_MIGRATION_RESTORE_INTENT_INVALID", `SQLite 迁移恢复 journal 缺少条目：${id}`);
  return entry;
}

async function assertMigrationRestoreFile(filePath, journalEntry, target) {
  const state = await migrationRestoreFileState(filePath);
  if (state !== "file") fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复文件缺失或类型异常：${filePath}`);
  const stat = await fs.stat(filePath);
  if (stat.size !== journalEntry.bytes || await sha256File(filePath) !== journalEntry.sha256) {
    fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复文件与 journal 不匹配：${filePath}`);
  }
  if (target.isDatabase) inspectDatabase(filePath, target.entry);
}

async function ensureSafeRestoreDirectory(root, relativeDirectory) {
  if (relativeDirectory === ".") return;
  safeChild(root, relativeDirectory);
  let current = path.resolve(root);
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    let state = await migrationRestoreDirectoryState(current);
    if (state === "missing") {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      state = await migrationRestoreDirectoryState(current);
    }
    if (state !== "directory") {
      fail("SQLITE_MIGRATION_RESTORE_PATH_INVALID", `SQLite 迁移恢复目录不安全：${current}`);
    }
  }
}

async function safeMigrationDirectory(directory, options = {}) {
  try {
    return await ensureSafeAbsoluteDirectory(directory, options);
  } catch (error) {
    if (error instanceof AbsolutePathSafetyError) {
      fail("SQLITE_MIGRATION_PATH_INVALID", error.message);
    }
    throw error;
  }
}

async function removeSafeMigrationDirectory(directory) {
  const state = await migrationRestoreDirectoryState(directory);
  if (state === "missing") return;
  await safeMigrationDirectory(directory);
  await fs.rm(directory, { recursive: true, force: true });
}

async function migrationRestoreFileState(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? "file" : "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function migrationRestoreDirectoryState(directory) {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function removeMigrationRestoreSidecars(databasePath) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    const state = await migrationRestoreFileState(sidecar);
    if (state === "file") await fs.rm(sidecar);
    else if (state !== "missing") {
      fail("SQLITE_MIGRATION_RESTORE_CONFLICT", `SQLite 迁移恢复 sidecar 类型异常：${sidecar}`);
    }
  }
}

async function removeEmptyMigrationRestoreDirectories(targetWorkspace, targets) {
  const candidates = new Set();
  for (const target of targets) {
    let current = path.dirname(target.destination);
    while (current !== targetWorkspace && current.startsWith(`${targetWorkspace}${path.sep}`)) {
      candidates.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...candidates].sort((left, right) => right.length - left.length)) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error;
    }
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await syncFile(temporary);
  await fs.rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
}

export async function drillSqliteMigrationRecoveryPoint(options) {
  const targetWorkspace = options.targetWorkspace
    ? absolute(options.targetWorkspace, "targetWorkspace")
    : await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "sunabot-sqlite-migration-drill-"));
  const cleanup = !options.targetWorkspace;
  await safeMigrationDirectory(targetWorkspace, { create: true });
  try {
    const restored = await restoreSqliteMigrationRecoveryPoint({ directory: options.directory, targetWorkspace });
    return { ok: true, backupId: restored.backupId, restored: true };
  } finally {
    if (cleanup) await removeSafeMigrationDirectory(targetWorkspace);
  }
}

function inspectDatabase(filePath, expected) {
  const database = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
  try {
    const integrity = String(database.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "");
    if (integrity !== "ok") fail("SQLITE_MIGRATION_DATABASE_INVALID", `SQLite integrity_check 未通过：${filePath}`);
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    if (foreignKeyViolations !== 0) fail("SQLITE_MIGRATION_DATABASE_INVALID", `SQLite foreign_key_check 未通过：${filePath}`);
    const tables = Object.fromEntries(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all().map((row) => {
      const name = String(row.name);
      return [name, Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get()?.count ?? 0)];
    }));
    if (expected && (expected.integrity !== integrity
      || expected.foreignKeyViolations !== foreignKeyViolations
      || JSON.stringify(expected.tables) !== JSON.stringify(tables))) {
      fail("SQLITE_MIGRATION_DATABASE_INVARIANT", `SQLite 恢复库不变量不匹配：${filePath}`);
    }
    return { integrity, foreignKeyViolations, tables };
  } finally {
    database.close();
  }
}

async function copyDurable(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
  await fs.chmod(destination, 0o600);
  await syncFile(destination);
}

async function writeManifest(directory, manifest, replace = false) {
  const manifestPath = path.join(directory, MANIFEST_NAME);
  const checksumPath = path.join(directory, CHECKSUM_NAME);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const temporary = path.join(directory, `.manifest-${process.pid}-${Date.now()}`);
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await syncFile(temporary);
  if (replace) await fs.rename(temporary, manifestPath);
  else await fs.rename(temporary, manifestPath);
  const checksumTemporary = `${checksumPath}.${process.pid}.tmp`;
  await fs.writeFile(checksumTemporary, `${sha256(bytes)}  ${MANIFEST_NAME}\n`, { flag: "wx", mode: 0o600 });
  await syncFile(checksumTemporary);
  await fs.rename(checksumTemporary, checksumPath);
  await syncDirectory(directory);
}

function safeInputPath(workspace, candidate) {
  const absoluteCandidate = path.resolve(candidate);
  relativeWorkspacePath(workspace, absoluteCandidate);
  return absoluteCandidate;
}

function relativeWorkspacePath(workspace, candidate) {
  const relative = path.relative(workspace, candidate);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("SQLITE_MIGRATION_PATH_ESCAPE", `SQLite 迁移路径越过 workspace：${candidate}`);
  }
  return relative.replace(/\\/g, "/");
}

function safeChild(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) fail("SQLITE_MIGRATION_PATH_ESCAPE", "SQLite 迁移相对路径无效。");
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) fail("SQLITE_MIGRATION_PATH_ESCAPE", "SQLite 迁移路径越界。");
  return candidate;
}

function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("SQLITE_MIGRATION_PATH_INVALID", `${name} 必须是绝对路径。`);
  return path.normalize(value);
}

async function assertRegularFile(filePath, code) {
  const stats = await fs.lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) fail(code, `路径不是普通文件：${filePath}`);
}

async function assertNoSymlinkComponents(root, candidate) {
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("SQLITE_MIGRATION_PATH_ESCAPE", `SQLite 迁移路径越界：${candidate}`);
  }
  let current = rootPath;
  const rootStats = await fs.lstat(current);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail("SQLITE_MIGRATION_PATH_INVALID", `SQLite 迁移根目录无效：${root}`);
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) fail("SQLITE_MIGRATION_PATH_INVALID", `SQLite 迁移路径包含符号链接：${current}`);
  }
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
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
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fail(code, message) {
  throw new SqliteMigrationRecoveryError(code, message);
}
