import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const RECOVERY_MANIFEST_VERSION = 1;
export const DEFAULT_HOT_RETENTION_DAYS = 7;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;

const RECOVERY_DIRECTORY_PREFIX = "sqlite-recovery-";
const PARTIAL_DIRECTORY_PREFIX = ".partial-sqlite-recovery-";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_CHECKSUM_FILE = "manifest.sha256";
const LOCK_FILE = ".sqlite-recovery.lock";
const DATABASE_DEFINITIONS = [
  {
    id: "application",
    source: "business/data/sunabot.sqlite",
    file: "application.sqlite",
    requiredTables: [
      "app_metadata",
      "conversations",
      "image_history",
      "memory_batches",
      "memory_records",
      "memory_scheduler",
      "request_logs"
    ]
  },
  {
    id: "session_queue",
    source: "business/data/session-queue.sqlite",
    file: "session-queue.sqlite",
    requiredTables: ["outbox", "schema_migrations", "session_events", "sessions", "tool_jobs", "turns"]
  }
];

export class RecoveryGateError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "RecoveryGateError";
    this.code = code;
    this.details = details;
  }
}

export async function createRecoveryPoint(options) {
  const workspace = absolutePath(options.workspace, "workspace");
  if (options.quiesced !== true) {
    throw new RecoveryGateError(
      "QUIESCENCE_REQUIRED",
      "双库恢复点只能在 Sunabot 与 NapCat 已停止写入后创建；请显式确认 quiesced。"
    );
  }
  const backupsRoot = absolutePath(
    options.backupsRoot ?? path.join(workspace, "backups", "sqlite-recovery"),
    "backupsRoot"
  );
  const now = dateFrom(options.now ?? new Date());
  const backupId = options.backupId ?? recoveryPointId(now);
  assertBackupId(backupId);
  const finalDirectory = path.join(backupsRoot, backupId);
  const partialDirectory = path.join(backupsRoot, `${PARTIAL_DIRECTORY_PREFIX}${backupId}`);
  const busyTimeoutMs = positiveInteger(options.busyTimeoutMs ?? 5_000, "busyTimeoutMs");
  const faultInjector = options.faultInjector ?? (() => undefined);

  await fs.mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireRecoveryLock(backupsRoot, now);
  const locks = [];
  let preservePartial = false;
  try {
    await removeInterruptedPartials(backupsRoot);
    await assertMissing(finalDirectory, "BACKUP_ALREADY_EXISTS");
    await fs.mkdir(partialDirectory, { recursive: false, mode: 0o700 });

    const sources = DATABASE_DEFINITIONS.map((definition) => ({
      definition,
      sourcePath: path.join(workspace, ...definition.source.split("/"))
    }));
    for (const source of sources) await assertRegularFile(source.sourcePath, "SOURCE_DATABASE_MISSING");

    const checkpointResults = [];
    for (const source of sources) {
      const walPath = `${source.sourcePath}-wal`;
      const walBytesBefore = await fileSizeOrZero(walPath);
      const lock = new DatabaseSync(source.sourcePath, { timeout: busyTimeoutMs });
      locks.push(lock);
      lock.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
      const checkpoint = checkpointDatabase(lock, source.definition.id);
      checkpointResults.push({ id: source.definition.id, walBytesBefore, ...checkpoint });
    }

    for (const [index, lock] of locks.entries()) {
      try {
        lock.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        throw sqliteGateError(error, `无法锁定 ${DATABASE_DEFINITIONS[index].id} 数据库`);
      }
    }
    await invokeFault(faultInjector, "after-locks");

    const databaseEntries = [];
    for (const [index, source] of sources.entries()) {
      const destination = path.join(partialDirectory, source.definition.file);
      const sourceDatabase = new DatabaseSync(source.sourcePath, { readOnly: true, timeout: busyTimeoutMs });
      try {
        const sourceInspection = inspectDatabase(sourceDatabase, source.definition);
        await backup(sourceDatabase, destination, { rate: 128 });
        const fileStat = await fs.stat(destination);
        const entry = {
          id: source.definition.id,
          source: source.definition.source,
          file: source.definition.file,
          bytes: fileStat.size,
          sha256: await sha256File(destination),
          pageSize: sourceInspection.pageSize,
          pageCount: sourceInspection.pageCount,
          userVersion: sourceInspection.userVersion,
          tables: sourceInspection.tables,
          invariants: sourceInspection.invariants,
          checkpoint: checkpointResults[index]
        };
        verifyDatabaseFile(destination, source.definition, entry);
        databaseEntries.push(entry);
      } finally {
        sourceDatabase.close();
      }
      await invokeFault(faultInjector, `after-${source.definition.id}-backup`);
    }

    const manifest = {
      schemaVersion: RECOVERY_MANIFEST_VERSION,
      backupId,
      recoveryPointId: `sha256:${sha256(JSON.stringify(databaseEntries.map((entry) => ({
        id: entry.id,
        sha256: entry.sha256,
        tables: entry.tables,
        invariants: entry.invariants
      }))))}`,
      createdAt: now.toISOString(),
      rpoTargetHours: 24,
      consistency: {
        mode: "offline-quiesced",
        checkpoint: "wal_checkpoint(TRUNCATE)",
        lock: "BEGIN EXCLUSIVE",
        queueAuthoritativeForDelivery: true,
        mainProjectionMayLagAfterExternalSend: true
      },
      retention: {
        hotDays: DEFAULT_HOT_RETENTION_DAYS,
        archiveDays: DEFAULT_ARCHIVE_RETENTION_DAYS
      },
      databases: databaseEntries,
      crossDatabaseInvariants: buildCrossDatabaseInvariants(databaseEntries)
    };
    await invokeFault(faultInjector, "before-manifest");
    await writeManifest(partialDirectory, manifest);
    await verifyRecoveryPoint(partialDirectory);
    await syncDirectory(partialDirectory);
    await invokeFault(faultInjector, "before-publish");
    await fs.rename(partialDirectory, finalDirectory);
    await syncDirectory(backupsRoot);
    return { directory: finalDirectory, manifest };
  } catch (error) {
    preservePartial = error?.preservePartial === true;
    if (!preservePartial) await fs.rm(partialDirectory, { recursive: true, force: true });
    throw normalizeGateError(error);
  } finally {
    for (const lock of locks.reverse()) {
      if (!lock.isOpen) continue;
      try {
        lock.exec("ROLLBACK");
      } catch {
        // A failed BEGIN leaves no transaction to roll back.
      }
      lock.close();
    }
    await releaseLock();
  }
}

export async function verifyRecoveryPoint(backupDirectoryInput) {
  const backupDirectory = absolutePath(backupDirectoryInput, "backupDirectory");
  const manifestPath = path.join(backupDirectory, MANIFEST_FILE);
  const checksumPath = path.join(backupDirectory, MANIFEST_CHECKSUM_FILE);
  await assertRegularFile(manifestPath, "BACKUP_MANIFEST_MISSING");
  await assertRegularFile(checksumPath, "BACKUP_MANIFEST_CHECKSUM_MISSING");
  const manifestBytes = await fs.readFile(manifestPath);
  const checksumText = await fs.readFile(checksumPath, "utf8");
  const checksumMatch = /^([a-f0-9]{64})\s+manifest\.json\s*$/i.exec(checksumText);
  if (!checksumMatch || checksumMatch[1].toLowerCase() !== sha256(manifestBytes)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_CHECKSUM_MISMATCH", "备份 manifest 校验和不匹配。");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `备份 manifest 不是有效 JSON：${error.message}`);
  }
  validateManifestShape(manifest);

  const inspections = [];
  for (const definition of DATABASE_DEFINITIONS) {
    const expected = manifest.databases.find((entry) => entry.id === definition.id);
    if (!expected) throw new RecoveryGateError("BACKUP_DATABASE_MISSING", `manifest 缺少 ${definition.id} 数据库。`);
    const databasePath = safeManifestChild(backupDirectory, expected.file);
    await assertRegularFile(databasePath, "BACKUP_FILE_MISSING");
    const stat = await fs.stat(databasePath);
    if (stat.size !== expected.bytes) {
      throw new RecoveryGateError("BACKUP_SIZE_MISMATCH", `${definition.id} 数据库大小不匹配。`);
    }
    const digest = await sha256File(databasePath);
    if (digest !== expected.sha256) {
      throw new RecoveryGateError("BACKUP_CHECKSUM_MISMATCH", `${definition.id} 数据库校验和不匹配。`);
    }
    const inspection = verifyDatabaseFile(databasePath, definition, expected);
    inspections.push({ id: definition.id, ...inspection });
  }
  const crossDatabaseInvariants = buildCrossDatabaseInvariants(
    inspections.map((inspection) => ({ id: inspection.id, invariants: inspection.invariants }))
  );
  if (stableJson(crossDatabaseInvariants) !== stableJson(manifest.crossDatabaseInvariants)) {
    throw new RecoveryGateError("BACKUP_CROSS_DATABASE_INVARIANT_MISMATCH", "双库恢复不变量与 manifest 不一致。");
  }
  return { ok: true, directory: backupDirectory, manifest, inspections };
}

export async function restoreRecoveryPoint(options) {
  const backup = await verifyRecoveryPoint(options.backupDirectory);
  const targetWorkspace = absolutePath(options.targetWorkspace, "targetWorkspace");
  const dataDirectory = path.join(targetWorkspace, "business", "data");
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });

  const targets = DATABASE_DEFINITIONS.map((definition) => ({
    definition,
    destination: path.join(targetWorkspace, ...definition.source.split("/")),
    source: safeManifestChild(
      backup.directory,
      backup.manifest.databases.find((entry) => entry.id === definition.id).file
    )
  }));
  for (const target of targets) {
    if (fsSync.existsSync(target.destination)) {
      throw new RecoveryGateError(
        "RESTORE_TARGET_EXISTS",
        `恢复目标已存在：${target.destination}。请先停服并将旧数据库移动到独立回滚目录。`
      );
    }
  }

  const stagingDirectory = path.join(dataDirectory, `.restore-${backup.manifest.backupId}-${process.pid}`);
  const intentPath = path.join(dataDirectory, `.restore-${backup.manifest.backupId}.json`);
  await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  const intent = {
    schemaVersion: 1,
    backupId: backup.manifest.backupId,
    createdAt: new Date().toISOString(),
    files: targets.map((target) => ({
      source: path.basename(target.source),
      staged: path.relative(dataDirectory, path.join(stagingDirectory, path.basename(target.destination))),
      destination: path.basename(target.destination)
    }))
  };
  try {
    for (const target of targets) {
      const staged = path.join(stagingDirectory, path.basename(target.destination));
      await fs.copyFile(target.source, staged, fsSync.constants.COPYFILE_EXCL);
      await syncFile(staged);
      const expected = backup.manifest.databases.find((entry) => entry.id === target.definition.id);
      verifyDatabaseFile(staged, target.definition, expected);
    }
    await writeJsonAtomic(intentPath, intent);
    for (const target of targets) {
      const staged = path.join(stagingDirectory, path.basename(target.destination));
      await fs.rename(staged, target.destination);
    }
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    await fs.rm(intentPath, { force: true });
    await syncDirectory(dataDirectory);
  } catch (error) {
    throw normalizeGateError(error, "RESTORE_FAILED");
  }

  const verification = await verifyWorkspaceDatabases(targetWorkspace, backup.manifest);
  return { ok: true, targetWorkspace, backupId: backup.manifest.backupId, verification };
}

export async function verifyWorkspaceDatabases(workspaceInput, expectedManifest) {
  const workspace = absolutePath(workspaceInput, "workspace");
  const inspections = [];
  for (const definition of DATABASE_DEFINITIONS) {
    const databasePath = path.join(workspace, ...definition.source.split("/"));
    await assertRegularFile(databasePath, "RESTORED_DATABASE_MISSING");
    const expected = expectedManifest?.databases?.find((entry) => entry.id === definition.id);
    inspections.push({ id: definition.id, ...verifyDatabaseFile(databasePath, definition, expected) });
  }
  const crossDatabaseInvariants = buildCrossDatabaseInvariants(
    inspections.map((inspection) => ({ id: inspection.id, invariants: inspection.invariants }))
  );
  if (expectedManifest
    && stableJson(crossDatabaseInvariants) !== stableJson(expectedManifest.crossDatabaseInvariants)) {
    throw new RecoveryGateError("RESTORE_INVARIANT_MISMATCH", "恢复后的双库不变量与恢复点不一致。");
  }
  return { ok: true, inspections, crossDatabaseInvariants };
}

export async function drillRecoveryPoint(options) {
  const startedAt = Date.now();
  const backup = await verifyRecoveryPoint(options.backupDirectory);
  const drillRoot = options.targetWorkspace
    ? absolutePath(options.targetWorkspace, "targetWorkspace")
    : await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-recovery-drill-"));
  const cleanup = !options.targetWorkspace;
  try {
    const restore = await restoreRecoveryPoint({
      backupDirectory: backup.directory,
      targetWorkspace: drillRoot
    });
    const completedAt = Date.now();
    const report = {
      schemaVersion: 1,
      backupId: backup.manifest.backupId,
      completedAt: new Date(completedAt).toISOString(),
      rpoHours: Number((Math.max(0, startedAt - Date.parse(backup.manifest.createdAt)) / 3_600_000).toFixed(3)),
      rpoTargetHours: backup.manifest.rpoTargetHours,
      rtoMilliseconds: completedAt - startedAt,
      integrity: "ok",
      restoredCounts: Object.fromEntries(restore.verification.inspections.map((entry) => [entry.id, entry.tables])),
      queueInvariants: restore.verification.crossDatabaseInvariants
    };
    if (options.reportPath) await writeJsonAtomic(absolutePath(options.reportPath, "reportPath"), report);
    return report;
  } finally {
    if (cleanup) await fs.rm(drillRoot, { recursive: true, force: true });
  }
}

export function classifyRetention(entries, nowInput = new Date(), options = {}) {
  const now = dateFrom(nowInput);
  const hotDays = positiveInteger(options.hotDays ?? DEFAULT_HOT_RETENTION_DAYS, "hotDays");
  const archiveDays = positiveInteger(options.archiveDays ?? DEFAULT_ARCHIVE_RETENTION_DAYS, "archiveDays");
  if (archiveDays < hotDays) throw new RecoveryGateError("RETENTION_INVALID", "archiveDays 不能小于 hotDays。");
  const sorted = [...entries].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const archiveDaysKept = new Set();
  return sorted.map((entry) => {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(entry.createdAt)) / 86_400_000);
    if (ageDays <= hotDays) return { ...entry, action: "keep", tier: "hot" };
    if (ageDays <= archiveDays) {
      const day = entry.createdAt.slice(0, 10);
      if (!archiveDaysKept.has(day)) {
        archiveDaysKept.add(day);
        return { ...entry, action: "keep", tier: "daily-archive" };
      }
      return { ...entry, action: "prune", tier: "daily-archive-duplicate" };
    }
    return { ...entry, action: "prune", tier: "expired" };
  });
}

export async function applyRetention(options) {
  const backupsRoot = absolutePath(options.backupsRoot, "backupsRoot");
  const entries = [];
  for (const directoryName of await readDirectoryNames(backupsRoot)) {
    if (!directoryName.startsWith(RECOVERY_DIRECTORY_PREFIX)) continue;
    const directory = path.join(backupsRoot, directoryName);
    try {
      const verified = await verifyRecoveryPoint(directory);
      entries.push({ directory, backupId: verified.manifest.backupId, createdAt: verified.manifest.createdAt });
    } catch {
      // Invalid or partial backups are never removed automatically.
    }
  }
  const plan = classifyRetention(entries, options.now ?? new Date(), options);
  if (options.apply === true) {
    for (const entry of plan.filter((item) => item.action === "prune")) {
      assertSafePublishedBackup(backupsRoot, entry.directory);
      await fs.rm(entry.directory, { recursive: true, force: false });
    }
  }
  return { applied: options.apply === true, plan };
}

function checkpointDatabase(database, id) {
  let row;
  try {
    row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() ?? {};
  } catch (error) {
    throw sqliteGateError(error, `无法 checkpoint ${id} 数据库`);
  }
  const result = {
    busy: Number(row.busy ?? 0),
    logFrames: Number(row.log ?? 0),
    checkpointedFrames: Number(row.checkpointed ?? 0)
  };
  if (result.busy !== 0) {
    throw new RecoveryGateError("SQLITE_BUSY", `${id} 数据库 checkpoint 被活动写入阻塞。`, result);
  }
  return result;
}

function verifyDatabaseFile(databasePath, definition, expected) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const inspection = inspectDatabase(database, definition);
    if (expected) {
      if (stableJson(inspection.tables) !== stableJson(expected.tables)) {
        throw new RecoveryGateError("BACKUP_COUNT_MISMATCH", `${definition.id} 数据库记录数与 manifest 不一致。`);
      }
      if (stableJson(inspection.invariants) !== stableJson(expected.invariants)) {
        throw new RecoveryGateError("BACKUP_INVARIANT_MISMATCH", `${definition.id} 数据库不变量与 manifest 不一致。`);
      }
      if (inspection.pageSize !== expected.pageSize || inspection.pageCount !== expected.pageCount) {
        throw new RecoveryGateError("BACKUP_PAGE_LAYOUT_MISMATCH", `${definition.id} 数据库页布局与 manifest 不一致。`);
      }
    }
    return inspection;
  } catch (error) {
    throw normalizeGateError(error, "BACKUP_DATABASE_INVALID");
  } finally {
    if (database?.isOpen) database.close();
  }
}

function inspectDatabase(database, definition) {
  const integrityRows = database.prepare("PRAGMA integrity_check").all();
  const integrity = integrityRows.map((row) => String(row.integrity_check ?? ""));
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    throw new RecoveryGateError("SQLITE_INTEGRITY_FAILED", `${definition.id} integrity_check 失败。`, integrity);
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length) {
    throw new RecoveryGateError(
      "SQLITE_FOREIGN_KEY_FAILED",
      `${definition.id} 存在 ${foreignKeyViolations.length} 个外键错误。`
    );
  }
  const tableNames = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name));
  const missingTables = definition.requiredTables.filter((table) => !tableNames.includes(table));
  if (missingTables.length) {
    throw new RecoveryGateError("SQLITE_SCHEMA_INCOMPLETE", `${definition.id} 缺少表：${missingTables.join(", ")}`);
  }
  const tables = Object.fromEntries(tableNames.map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get();
    return [table, Number(row.count)];
  }));
  return {
    pageSize: Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 0),
    pageCount: Number(database.prepare("PRAGMA page_count").get()?.page_count ?? 0),
    userVersion: Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0),
    tables,
    invariants: definition.id === "session_queue"
      ? inspectQueueInvariants(database)
      : { integrityCheck: "ok", foreignKeyViolations: 0 }
  };
}

function inspectQueueInvariants(database) {
  const violations = {
    sequenceBounds: scalar(database, `
      SELECT COUNT(*) FROM sessions
      WHERE completed_event_sequence > next_event_sequence
         OR completed_outbox_sequence > next_outbox_sequence
    `),
    eventTail: scalar(database, `
      SELECT COUNT(*) FROM sessions s
      WHERE COALESCE((SELECT MAX(e.sequence) FROM session_events e WHERE e.session_id=s.session_id), 0)
            <> s.next_event_sequence
    `),
    outboxTail: scalar(database, `
      SELECT COUNT(*) FROM sessions s
      WHERE COALESCE((SELECT MAX(o.sequence) FROM outbox o WHERE o.session_id=s.session_id), 0)
            <> s.next_outbox_sequence
    `),
    terminalOutboxPrefix: scalar(database, `
      SELECT COUNT(*) FROM outbox o JOIN sessions s USING(session_id)
      WHERE (o.status IN ('sent','dead','unknown') AND o.sequence > s.completed_outbox_sequence)
         OR (o.status IN ('pending','sending') AND o.sequence <= s.completed_outbox_sequence)
    `),
    sentWithoutTimestamp: scalar(database, "SELECT COUNT(*) FROM outbox WHERE status='sent' AND sent_at IS NULL"),
    activeWithFinishedTimestamp: scalar(database, `
      SELECT COUNT(*) FROM outbox
      WHERE status IN ('pending','sending') AND finished_at IS NOT NULL
    `)
  };
  const violationCount = Object.values(violations).reduce((sum, value) => sum + value, 0);
  if (violationCount) {
    throw new RecoveryGateError("QUEUE_INVARIANT_FAILED", "session queue 状态机不变量失败。", violations);
  }
  const statusRows = database.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status ORDER BY status").all();
  const outboxStatusCounts = Object.fromEntries(statusRows.map((row) => [String(row.status), Number(row.count)]));
  const terminalRows = database.prepare(`
    SELECT id, session_id, sequence, status, sent_at
    FROM outbox WHERE status IN ('sent','dead','unknown')
    ORDER BY session_id, sequence, id
  `).all();
  return {
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    violations,
    outboxStatusCounts,
    terminalOutboxDigest: `sha256:${sha256(stableJson(terminalRows))}`
  };
}

function buildCrossDatabaseInvariants(entries) {
  const queue = entries.find((entry) => entry.id === "session_queue")?.invariants;
  if (!queue) throw new RecoveryGateError("QUEUE_INVARIANT_MISSING", "恢复点缺少 session queue 不变量。");
  return {
    queueAuthoritativeForDelivery: true,
    mainProjectionMayLagAfterExternalSend: true,
    outboxStatusCounts: queue.outboxStatusCounts,
    terminalOutboxDigest: queue.terminalOutboxDigest
  };
}

async function writeManifest(directory, manifest) {
  const manifestPath = path.join(directory, MANIFEST_FILE);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
  await syncFile(manifestPath);
  const checksum = `${sha256(bytes)}  ${MANIFEST_FILE}\n`;
  const checksumPath = path.join(directory, MANIFEST_CHECKSUM_FILE);
  await fs.writeFile(checksumPath, checksum, { flag: "wx", mode: 0o600 });
  await syncFile(checksumPath);
}

async function acquireRecoveryLock(backupsRoot, now) {
  const lockPath = path.join(backupsRoot, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`);
      await handle.sync();
      await handle.close();
      return async () => fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stale = await lockIsStale(lockPath);
      if (!stale) throw new RecoveryGateError("BACKUP_LOCKED", "另一个备份/恢复进程持有 SQLite 恢复锁。");
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new RecoveryGateError("BACKUP_LOCKED", "无法获取 SQLite 恢复锁。");
}

async function lockIsStale(lockPath) {
  try {
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const pid = Number(lock.pid);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch {
    return true;
  }
}

async function removeInterruptedPartials(backupsRoot) {
  for (const name of await readDirectoryNames(backupsRoot)) {
    if (!name.startsWith(PARTIAL_DIRECTORY_PREFIX)) continue;
    const candidate = path.join(backupsRoot, name);
    if (path.dirname(candidate) !== backupsRoot) continue;
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "备份 manifest 必须是对象。");
  }
  if (manifest.schemaVersion !== RECOVERY_MANIFEST_VERSION) {
    throw new RecoveryGateError("BACKUP_MANIFEST_VERSION", `不支持 manifest 版本 ${manifest.schemaVersion}。`);
  }
  assertBackupId(manifest.backupId);
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "manifest.createdAt 无效。");
  }
  if (!Array.isArray(manifest.databases) || manifest.databases.length !== DATABASE_DEFINITIONS.length) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "manifest.databases 不完整。");
  }
}

function safeManifestChild(directory, fileName) {
  if (typeof fileName !== "string" || path.basename(fileName) !== fileName || !fileName.endsWith(".sqlite")) {
    throw new RecoveryGateError("BACKUP_PATH_INVALID", "manifest 数据库路径无效。");
  }
  const resolved = path.resolve(directory, fileName);
  if (path.dirname(resolved) !== path.resolve(directory)) {
    throw new RecoveryGateError("BACKUP_PATH_INVALID", "manifest 数据库路径越界。");
  }
  return resolved;
}

function recoveryPointId(now) {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `${RECOVERY_DIRECTORY_PREFIX}${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function assertBackupId(value) {
  if (typeof value !== "string" || !/^sqlite-recovery-[A-Za-z0-9T_Z-]{8,96}$/.test(value)) {
    throw new RecoveryGateError("BACKUP_ID_INVALID", "恢复点 ID 无效。");
  }
}

function buildError(code, message, error) {
  return new RecoveryGateError(code, `${message}：${error instanceof Error ? error.message : String(error)}`);
}

function sqliteGateError(error, message) {
  if (error?.errcode === 5 || /(?:locked|busy)/i.test(error?.message ?? "")) {
    return new RecoveryGateError("SQLITE_BUSY", `${message}：数据库仍在写入。`);
  }
  return buildError("SQLITE_OPERATION_FAILED", message, error);
}

function normalizeGateError(error, fallbackCode = "BACKUP_FAILED") {
  if (error instanceof RecoveryGateError) return error;
  if (error?.errcode === 5 || /(?:locked|busy)/i.test(error?.message ?? "")) return sqliteGateError(error, "SQLite 操作失败");
  const normalized = buildError(error?.code || fallbackCode, "SQLite 恢复门禁失败", error);
  if (error?.preservePartial === true) normalized.preservePartial = true;
  return normalized;
}

async function invokeFault(faultInjector, step) {
  try {
    await faultInjector(step);
  } catch (error) {
    if (error?.preservePartial === true) error.preservePartial = true;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await syncFile(temporary);
  await fs.rename(temporary, filePath);
  await syncDirectory(path.dirname(filePath));
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
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scalar(database, sql) {
  const row = database.prepare(sql).get();
  return Number(Object.values(row)[0]);
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function dateFrom(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RecoveryGateError("DATE_INVALID", "日期无效。");
  return date;
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new RecoveryGateError("OPTION_INVALID", `${field} 必须为正整数。`);
  return parsed;
}

function absolutePath(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new RecoveryGateError("OPTION_REQUIRED", `${field} 不能为空。`);
  return path.resolve(value);
}

async function assertRegularFile(filePath, code) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new RecoveryGateError(code, `文件不存在或不可读：${filePath}（${error.message}）`);
  }
}

async function assertMissing(filePath, code) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new RecoveryGateError(code, `路径已存在：${filePath}`);
}

async function fileSizeOrZero(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

async function readDirectoryNames(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function assertSafePublishedBackup(root, directory) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== resolvedRoot || !path.basename(resolved).startsWith(RECOVERY_DIRECTORY_PREFIX)) {
    throw new RecoveryGateError("RETENTION_PATH_INVALID", `拒绝清理非恢复点目录：${directory}`);
  }
}
