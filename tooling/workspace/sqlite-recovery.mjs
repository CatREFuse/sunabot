import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  AbsolutePathSafetyError,
  ensureSafeAbsoluteDirectory,
  ensureSafeAbsoluteParent
} from "../shared/safe-absolute-path.mjs";

export const RECOVERY_MANIFEST_VERSION = 2;
export const DEFAULT_HOT_RETENTION_DAYS = 7;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;

const LEGACY_RECOVERY_MANIFEST_VERSION = 1;
const RECOVERY_DIRECTORY_PREFIX = "sqlite-recovery-";
const PARTIAL_DIRECTORY_PREFIX = ".partial-sqlite-recovery-";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_CHECKSUM_FILE = "manifest.sha256";
const RECOVERY_OWNER_FILE = ".recovery-owner.json";
const PARTIAL_OWNER_FILE = ".recovery-owner.json";
const LOCK_FILE = ".sqlite-recovery.lock";
const DEFAULT_AGENT_ID = "plana";
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const APPLICATION_REQUIRED_TABLES = [
  "app_metadata",
  "conversations",
  "image_history",
  "memory_records",
  "request_logs"
];
const LEGACY_APPLICATION_REQUIRED_TABLES = [
  ...APPLICATION_REQUIRED_TABLES
];
const CURRENT_APPLICATION_REQUIRED_TABLES = [
  ...APPLICATION_REQUIRED_TABLES,
  "admin_sessions",
  "agent_accounts",
  "agents",
  "director_daily_schedule_revisions",
  "director_daily_schedules",
  "director_schedule_task_links",
  "dream_memory_archive",
  "dream_runs",
  "emojis",
  "emoji_versions",
  "memory_recall_receipts",
  "memory_recall_stats",
  "memory_source_revisions",
  "model_call_aggregates",
  "model_call_model_aggregates",
  "outbox_local_effects",
  "scheduled_task_runs",
  "scheduled_tasks"
];
const CURRENT_APPLICATION_STORAGE_SCHEMA_VERSION = 17;
const LEGACY_CURRENT_APPLICATION_STORAGE_SCHEMA_VERSION = 9;
const PRE_EMOJI_APPLICATION_STORAGE_SCHEMA_VERSION = 10;
const PRE_EMOJI_APPLICATION_REQUIRED_TABLES = CURRENT_APPLICATION_REQUIRED_TABLES.filter(
  (table) => table !== "emojis"
);
const QUEUE_REQUIRED_TABLES = ["outbox", "schema_migrations", "session_events", "sessions", "tool_jobs", "turns"];
const LEGACY_DATABASE_DEFINITIONS = [
  {
    id: "application",
    agentId: DEFAULT_AGENT_ID,
    kind: "application",
    source: "business/data/sunabot.sqlite",
    file: "application.sqlite",
    requiredTables: LEGACY_APPLICATION_REQUIRED_TABLES
  },
  {
    id: "session_queue",
    agentId: DEFAULT_AGENT_ID,
    kind: "session_queue",
    source: "business/data/session-queue.sqlite",
    file: "session-queue.sqlite",
    requiredTables: QUEUE_REQUIRED_TABLES
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
  let workspace = absolutePath(options.workspace, "workspace");
  if (options.quiesced !== true) {
    throw new RecoveryGateError(
      "QUIESCENCE_REQUIRED",
      "全 Agent SQLite 恢复点只能在 Sunabot 与 NapCat 已停止写入后创建；请显式确认 quiesced。"
    );
  }
  const now = dateFrom(options.now ?? new Date());
  const backupId = options.backupId ?? recoveryPointId(now);
  assertBackupId(backupId);
  const busyTimeoutMs = positiveInteger(options.busyTimeoutMs ?? 5_000, "busyTimeoutMs");
  const faultInjector = options.faultInjector ?? (() => undefined);

  workspace = await safeRecoveryDirectory(workspace);
  let backupsRoot = absolutePath(
    options.backupsRoot ?? path.join(workspace, "backups", "sqlite-recovery"),
    "backupsRoot"
  );
  backupsRoot = await safeRecoveryDirectory(backupsRoot, { create: true });
  const finalDirectory = path.join(backupsRoot, backupId);
  const partialDirectory = path.join(backupsRoot, `${PARTIAL_DIRECTORY_PREFIX}${backupId}`);
  const backupsRootIdentityChain = captureDirectoryIdentityChainSync(backupsRoot);
  const releaseLock = await acquireRecoveryLock(backupsRoot, now);
  const locks = [];
  let preservePartial = false;
  let ownedPartialIdentity = null;
  let ownerRecord = null;
  const ownedPartialArtifacts = new Map();
  try {
    await removeInterruptedPartials(backupsRoot);
    await assertMissing(finalDirectory, "BACKUP_ALREADY_EXISTS");
    await fs.mkdir(partialDirectory, { recursive: false, mode: 0o700 });
    const partialStat = fsSync.lstatSync(partialDirectory);
    if (!partialStat.isDirectory() || partialStat.isSymbolicLink()) {
      throw new RecoveryGateError("RECOVERY_PATH_UNSAFE", "恢复点暂存路径必须是普通目录。");
    }
    ownedPartialIdentity = fileIdentity(partialStat);
    ownerRecord = {
      schemaVersion: 1,
      backupId,
      token: crypto.randomUUID(),
      directoryIdentity: ownedPartialIdentity
    };
    await writeRecoveryOwnerFile(partialDirectory, ownerRecord);
    ownedPartialArtifacts.set(RECOVERY_OWNER_FILE, fileIdentity(fsSync.lstatSync(
      path.join(partialDirectory, RECOVERY_OWNER_FILE)
    )));

    const sourceIdentitySnapshot = captureWorkspaceDatabaseIdentitySnapshot(workspace);
    const definitions = await discoverWorkspaceDatabaseDefinitions(workspace, {
      databaseOpenObserver: options.databaseOpenObserver,
      databaseIdentitySnapshot: sourceIdentitySnapshot
    });
    assertWorkspaceDatabaseDefinitionsMatchSnapshot(definitions, sourceIdentitySnapshot);
    const sources = definitions.map((definition) => ({
      definition,
      sourcePath: safeWorkspaceChild(workspace, definition.source)
    }));
    for (const source of sources) {
      await assertWorkspaceDatabaseSource(workspace, source.definition, "SOURCE_DATABASE_MISSING");
    }

    const checkpointResults = [];
    for (const source of sources) {
      const walPath = `${source.sourcePath}-wal`;
      const walBytesBefore = await fileSizeOrZero(walPath);
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      options.databaseOpenObserver?.({
        databasePath: source.sourcePath,
        id: source.definition.id,
        phase: "source-checkpoint"
      });
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      const lock = new DatabaseSync(source.sourcePath, { timeout: busyTimeoutMs });
      locks.push(lock);
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      lock.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
      const checkpoint = checkpointDatabase(lock, source.definition.id);
      checkpointResults.push({ id: source.definition.id, walBytesBefore, ...checkpoint });
    }

    for (const [index, lock] of locks.entries()) {
      try {
        lock.exec("BEGIN EXCLUSIVE");
      } catch (error) {
        throw sqliteGateError(error, `无法锁定 ${sources[index].definition.id} 数据库`);
      }
    }
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    await invokeFault(faultInjector, "after-locks");
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);

    const databaseEntries = [];
    for (const [index, source] of sources.entries()) {
      const destination = path.join(partialDirectory, source.definition.file);
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      options.databaseOpenObserver?.({
        databasePath: source.sourcePath,
        id: source.definition.id,
        phase: "source-backup"
      });
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      const sourceDatabase = new DatabaseSync(source.sourcePath, { readOnly: true, timeout: busyTimeoutMs });
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      try {
        const sourceInspection = inspectDatabase(sourceDatabase, source.definition);
        await backup(sourceDatabase, destination, { rate: 128 });
        const fileStat = await fs.stat(destination);
        const entry = {
          id: source.definition.id,
          agentId: source.definition.agentId,
          kind: source.definition.kind,
          schemaProfile: source.definition.schemaProfile,
          ...(source.definition.kind === "application"
            ? { storageSchemaVersion: source.definition.expectedStorageSchemaVersion }
            : {}),
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
        ownedPartialArtifacts.set(source.definition.file, fileIdentity(fsSync.lstatSync(destination)));
        options.databaseOpenObserver?.({
          databasePath: destination,
          id: source.definition.id,
          phase: "backup-copy-verify"
        });
        verifyDatabaseFile(destination, source.definition, entry);
        databaseEntries.push(entry);
      } finally {
        sourceDatabase.close();
      }
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
      await invokeFault(
        faultInjector,
        `after-${source.definition.agentId}-${source.definition.kind}-backup`
      );
      assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    }
    for (const entry of databaseEntries) {
      await removeTransientRestoreSidecars(path.join(partialDirectory, entry.file));
    }
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);

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
      crossDatabaseInvariants: buildCrossDatabaseInvariants(databaseEntries, RECOVERY_MANIFEST_VERSION)
    };
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    await invokeFault(faultInjector, "before-manifest");
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    await writeManifest(partialDirectory, manifest);
    for (const name of [MANIFEST_FILE, MANIFEST_CHECKSUM_FILE]) {
      ownedPartialArtifacts.set(name, fileIdentity(fsSync.lstatSync(path.join(partialDirectory, name))));
    }
    const publicationSnapshot = captureRecoveryPublicationSnapshot(
      partialDirectory,
      manifest,
      ownerRecord
    );
    const verified = await verifyRecoveryPoint(partialDirectory, {
      databaseOpenObserver: options.databaseOpenObserver
    });
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    for (const entry of verified.manifest.databases) {
      await removeTransientRestoreSidecars(path.join(partialDirectory, entry.file));
    }
    await syncDirectory(partialDirectory);
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    assertRecoveryPublicationSnapshot(
      partialDirectory,
      publicationSnapshot,
      finalDirectory,
      manifest,
      ownerRecord
    );
    await invokeFault(faultInjector, "before-publish");
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    assertRecoveryPublicationSnapshot(
      partialDirectory,
      publicationSnapshot,
      finalDirectory,
      manifest,
      ownerRecord
    );
    fsSync.renameSync(partialDirectory, finalDirectory);
    await invokeFault(faultInjector, "after-publish-rename");
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    assertRecoveryPublicationSnapshot(
      finalDirectory,
      publicationSnapshot,
      null,
      manifest,
      ownerRecord
    );
    await syncDirectory(backupsRoot);
    await invokeFault(faultInjector, "after-publish-fsync");
    assertRecoveryPublicationSnapshot(
      finalDirectory,
      publicationSnapshot,
      null,
      manifest,
      ownerRecord
    );
    assertWorkspaceDatabaseIdentitySnapshot(workspace, sourceIdentitySnapshot);
    return { directory: finalDirectory, manifest };
  } catch (error) {
    preservePartial = error?.preservePartial === true;
    if (!preservePartial && ownedPartialIdentity) {
      const cleanup = await quarantineOwnedRecoveryDirectory({
        directories: [partialDirectory, finalDirectory],
        backupsRoot,
        backupsRootIdentityChain,
        expectedIdentity: ownedPartialIdentity,
        backupId,
        ownedArtifacts: ownedPartialArtifacts
      });
      if (cleanup.status === "ownership-conflict" && error && typeof error === "object") {
        error.details = {
          ...(error.details && typeof error.details === "object" ? error.details : {}),
          partialCleanup: cleanup
        };
      }
    }
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

export async function verifyRecoveryPoint(backupDirectoryInput, options = {}) {
  const backupDirectory = absolutePath(backupDirectoryInput, "backupDirectory");
  await safeRecoveryDirectory(backupDirectory);
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
  const definitions = databaseDefinitionsForManifest(manifest);
  const forbiddenFileIdentities = normalizeForbiddenFileIdentities(
    options.forbiddenDatabaseFileIdentities
  );
  const recoveryFileIdentities = new Map();
  const databaseFiles = [];

  for (const definition of definitions) {
    const expected = manifest.databases.find((entry) => entry.id === definition.id);
    if (!expected) throw new RecoveryGateError("BACKUP_DATABASE_MISSING", `manifest 缺少 ${definition.id} 数据库。`);
    const databasePath = safeManifestChild(backupDirectory, expected.file);
    await assertRegularFile(databasePath, "BACKUP_FILE_MISSING");
    const stat = await fs.lstat(databasePath);
    if (stat.nlink !== 1) {
      throw new RecoveryGateError(
        "BACKUP_FILE_HARDLINK_UNSAFE",
        `${definition.id} 恢复数据库必须是独立文件。`
      );
    }
    const identity = fileIdentity(stat);
    if (recoveryFileIdentities.has(identity) || forbiddenFileIdentities.has(identity)) {
      throw new RecoveryGateError(
        "BACKUP_FILE_IDENTITY_CONFLICT",
        `${definition.id} 恢复数据库与其他数据库共用文件身份。`
      );
    }
    recoveryFileIdentities.set(identity, definition.id);
    databaseFiles.push({ definition, expected, databasePath, identity });
  }

  const inspections = [];
  for (const { definition, expected, databasePath, identity } of databaseFiles) {
    const stat = await fs.lstat(databasePath);
    assertRecoveryFileIdentity(stat, identity, definition.id);
    if (stat.size !== expected.bytes) {
      throw new RecoveryGateError("BACKUP_SIZE_MISMATCH", `${definition.id} 数据库大小不匹配。`);
    }
    const digest = await sha256File(databasePath);
    if (digest !== expected.sha256) {
      throw new RecoveryGateError("BACKUP_CHECKSUM_MISMATCH", `${definition.id} 数据库校验和不匹配。`);
    }
    const beforeOpen = await fs.lstat(databasePath);
    assertRecoveryFileIdentity(beforeOpen, identity, definition.id);
    options.databaseOpenObserver?.({ databasePath, id: definition.id });
    const inspection = verifyDatabaseFile(databasePath, definition, expected, {
      databaseInspectionExtension: options.databaseInspectionExtension
    });
    await options.databaseClosedObserver?.({ databasePath, id: definition.id });
    const afterOpen = await fs.lstat(databasePath);
    assertRecoveryFileIdentity(afterOpen, identity, definition.id);
    inspections.push({
      id: definition.id,
      agentId: definition.agentId,
      kind: definition.kind,
      ...inspection
    });
  }
  await assertRecoveryIdentitySnapshot(databaseFiles);
  if (manifest.schemaVersion === RECOVERY_MANIFEST_VERSION) {
    verifyV2ManifestAgentSet(backupDirectory, manifest, options, databaseFiles);
  }
  await assertRecoveryIdentitySnapshot(databaseFiles);
  const crossDatabaseInvariants = buildCrossDatabaseInvariants(inspections, manifest.schemaVersion);
  if (stableJson(crossDatabaseInvariants) !== stableJson(manifest.crossDatabaseInvariants)) {
    throw new RecoveryGateError(
      "BACKUP_CROSS_DATABASE_INVARIANT_MISMATCH",
      "Agent 数据库恢复不变量与 manifest 不一致。"
    );
  }
  return { ok: true, directory: backupDirectory, manifest, inspections };
}

function normalizeForbiddenFileIdentities(input) {
  if (input == null) return new Set();
  if (!Array.isArray(input) || input.some((identity) => !/^\d+:\d+$/.test(String(identity)))) {
    throw new RecoveryGateError(
      "BACKUP_VERIFY_OPTION_INVALID",
      "forbiddenDatabaseFileIdentities 必须是 dev:ino 字符串数组。"
    );
  }
  return new Set(input.map(String));
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function assertRecoveryFileIdentity(stat, expectedIdentity, id) {
  if (!stat.isFile() || stat.nlink !== 1 || fileIdentity(stat) !== expectedIdentity) {
    throw new RecoveryGateError(
      "BACKUP_FILE_IDENTITY_CHANGED",
      `${id} 恢复数据库在校验期间发生文件身份变化。`
    );
  }
}

async function assertRecoveryIdentitySnapshot(databaseFiles) {
  for (const { definition, databasePath, identity } of databaseFiles) {
    const stat = await fs.lstat(databasePath);
    assertRecoveryFileIdentity(stat, identity, definition.id);
  }
}

function captureRecoveryPublicationSnapshot(directory, manifest, ownerRecord = null) {
  const parentDirectory = path.dirname(directory);
  const parentDirectoryChain = captureDirectoryIdentityChainSync(parentDirectory);
  let directoryStat;
  try {
    directoryStat = fsSync.lstatSync(directory);
  } catch (error) {
    throw new RecoveryGateError(
      "BACKUP_PUBLICATION_CHANGED",
      `恢复点暂存目录不可读：${directory}（${error.message}）`
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new RecoveryGateError("BACKUP_PUBLICATION_CHANGED", "恢复点暂存路径必须是普通目录。");
  }
  const expectedNames = [
    MANIFEST_FILE,
    MANIFEST_CHECKSUM_FILE,
    ...manifest.databases.map((entry) => entry.file),
    ...(ownerRecord ? [RECOVERY_OWNER_FILE] : [])
  ].sort();
  const actualEntries = fsSync.readdirSync(directory, { withFileTypes: true });
  const actualNames = actualEntries.map((entry) => entry.name).sort();
  if (stableJson(actualNames) !== stableJson(expectedNames)
    || actualEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new RecoveryGateError(
      "BACKUP_PUBLICATION_CHANGED",
      "恢复点暂存目录文件集合与已验证 manifest 不一致。"
    );
  }

  const identities = new Set();
  const files = [];
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestChecksumBytes = Buffer.from(
    `${sha256(manifestBytes)}  ${MANIFEST_FILE}\n`,
    "utf8"
  );
  const fixedFileExpectations = new Map([
    [MANIFEST_FILE, { bytes: manifestBytes.length, sha256: sha256(manifestBytes) }],
    [MANIFEST_CHECKSUM_FILE, {
      bytes: manifestChecksumBytes.length,
      sha256: sha256(manifestChecksumBytes)
    }]
  ]);
  if (ownerRecord) {
    const ownerBytes = Buffer.from(`${JSON.stringify(ownerRecord, null, 2)}\n`, "utf8");
    fixedFileExpectations.set(RECOVERY_OWNER_FILE, {
      bytes: ownerBytes.length,
      sha256: sha256(ownerBytes)
    });
  }
  for (const name of expectedNames) {
    const filePath = path.join(directory, name);
    const before = fsSync.lstatSync(filePath);
    const identity = fileIdentity(before);
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || identities.has(identity)) {
      throw new RecoveryGateError(
        "BACKUP_PUBLICATION_CHANGED",
        `恢复点发布文件不是独立普通文件：${name}`
      );
    }
    identities.add(identity);
    const digest = sha256FileSync(filePath);
    const after = fsSync.lstatSync(filePath);
    if (!after.isFile()
      || after.isSymbolicLink()
      || after.nlink !== 1
      || fileIdentity(after) !== identity
      || after.size !== before.size) {
      throw new RecoveryGateError(
        "BACKUP_PUBLICATION_CHANGED",
        `恢复点发布文件在摘要期间发生变化：${name}`
      );
    }
    const expectedDatabase = manifest.databases.find((entry) => entry.file === name);
    const expectedFile = expectedDatabase ?? fixedFileExpectations.get(name);
    if (!expectedFile
      || before.size !== expectedFile.bytes
      || digest !== expectedFile.sha256) {
      throw new RecoveryGateError(
        "BACKUP_PUBLICATION_CHANGED",
        `恢复点发布文件与已验证内容不一致：${name}`
      );
    }
    files.push({ name, identity, bytes: before.size, sha256: digest });
  }
  return {
    parentDirectoryChain,
    directoryIdentity: fileIdentity(directoryStat),
    files
  };
}

function assertRecoveryPublicationSnapshot(directory, expected, finalDirectory, manifest, ownerRecord = null) {
  let current;
  try {
    assertDirectoryIdentityChainSync(path.dirname(directory), expected.parentDirectoryChain);
    current = captureRecoveryPublicationSnapshot(directory, manifest, ownerRecord);
  } catch (error) {
    if (error instanceof RecoveryGateError && error.code === "BACKUP_PUBLICATION_CHANGED") throw error;
    throw new RecoveryGateError(
      "BACKUP_PUBLICATION_CHANGED",
      `恢复点发布前复验失败：${error.message}`
    );
  }
  if (stableJson(current) !== stableJson(expected)) {
    throw new RecoveryGateError(
      "BACKUP_PUBLICATION_CHANGED",
      "恢复点在验证与发布之间发生身份或内容变化。"
    );
  }
  if (finalDirectory && pathStateSync(finalDirectory) !== "missing") {
    throw new RecoveryGateError("BACKUP_ALREADY_EXISTS", `路径已存在：${finalDirectory}`);
  }
}

function revertRecoveryPublicationRename(finalDirectory, partialDirectory, expected) {
  if (pathStateSync(partialDirectory) !== "missing") return;
  try {
    assertDirectoryIdentityChainSync(path.dirname(finalDirectory), expected.parentDirectoryChain);
  } catch {
    return;
  }
  let stat;
  try {
    stat = fsSync.lstatSync(finalDirectory);
  } catch {
    return;
  }
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || fileIdentity(stat) !== expected.directoryIdentity) return;
  fsSync.renameSync(finalDirectory, partialDirectory);
}

export async function restoreRecoveryPoint(options) {
  const forbiddenDatabaseFileIdentities = normalizeForbiddenFileIdentities(
    options.forbiddenDatabaseFileIdentities
  );
  const backup = await verifyRecoveryPoint(options.backupDirectory, {
    forbiddenDatabaseFileIdentities: options.forbiddenDatabaseFileIdentities,
    databaseOpenObserver: options.databaseOpenObserver
  });
  const targetWorkspace = absolutePath(options.targetWorkspace, "targetWorkspace");
  const definitions = databaseDefinitionsForManifest(backup.manifest);
  const stagingDirectory = path.join(targetWorkspace, `.restore-${backup.manifest.backupId}.staging`);
  const intentPath = path.join(targetWorkspace, `.restore-${backup.manifest.backupId}.json`);
  const faultInjector = options.faultInjector ?? (() => undefined);
  await safeRecoveryDirectory(targetWorkspace, { create: true });
  const targets = definitions.map((definition) => ({
    definition,
    destination: safeWorkspaceChild(targetWorkspace, definition.source),
    source: safeManifestChild(
      backup.directory,
      backup.manifest.databases.find((entry) => entry.id === definition.id).file
    )
  }));
  let intent = await readRestoreIntent(intentPath, backup, targetWorkspace, targets);
  try {
    if (!intent) {
      const existingTargetEntries = await fs.readdir(targetWorkspace);
      if (existingTargetEntries.length > 0) {
        throw new RecoveryGateError(
          "RESTORE_TARGET_NOT_EMPTY",
          `恢复目标 workspace 必须为空；发现：${existingTargetEntries.sort().join(", ")}`
        );
      }
      intent = buildRestoreIntent(backup, targetWorkspace, targets, stagingDirectory);
      await writeJsonAtomic(intentPath, intent);
      await invokeFault(faultInjector, "after-restore-intent");
    }

    const stagingState = await directoryState(stagingDirectory);
    if (stagingState === "missing") {
      await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      await syncDirectory(targetWorkspace);
    } else if (stagingState !== "directory") {
      throw new RecoveryGateError("RESTORE_STAGING_CONFLICT", `恢复暂存路径类型异常：${stagingDirectory}`);
    }

    for (const target of targets) {
      const entry = restoreIntentEntry(intent, target.definition.id);
      const staged = safeWorkspaceChild(targetWorkspace, entry.staged);
      const destinationState = await databaseFileState(target.destination);
      const stagedState = await databaseFileState(staged);
      if (destinationState === "file") {
        await assertRestoreFileMatches(target.destination, entry, "RESTORE_DESTINATION_CONFLICT");
        if (!intent.copied.includes(target.definition.id)) {
          intent.copied.push(target.definition.id);
          await writeJsonAtomic(intentPath, intent);
        }
        continue;
      }
      if (destinationState !== "missing") {
        throw new RecoveryGateError("RESTORE_DESTINATION_CONFLICT", `恢复目标路径类型异常：${target.destination}`);
      }
      if (stagedState === "invalid") {
        throw new RecoveryGateError("RESTORE_STAGING_CONFLICT", `恢复暂存路径类型异常：${staged}`);
      }
      if (stagedState === "missing") {
        await fs.copyFile(target.source, staged, fsSync.constants.COPYFILE_EXCL);
        await syncFile(staged);
      }
      await assertRestoreFileMatches(staged, entry, "RESTORE_STAGING_CONFLICT");
      const expected = backup.manifest.databases.find((candidate) => candidate.id === target.definition.id);
      options.databaseOpenObserver?.({
        databasePath: staged,
        id: target.definition.id,
        phase: "restore-staging-verify"
      });
      verifyDatabaseFile(staged, target.definition, expected);
      await removeTransientRestoreSidecars(staged);
      if (!intent.copied.includes(target.definition.id)) {
        intent.copied.push(target.definition.id);
        await writeJsonAtomic(intentPath, intent);
        await invokeFault(faultInjector, `after-restore-copy-${target.definition.agentId}-${target.definition.kind}`);
      }
    }
    await syncDirectory(stagingDirectory);

    for (const target of targets) {
      const entry = restoreIntentEntry(intent, target.definition.id);
      const staged = safeWorkspaceChild(targetWorkspace, entry.staged);
      await ensureSafeWorkspaceDirectory(targetWorkspace, path.posix.dirname(target.definition.source));
      const destinationState = await databaseFileState(target.destination);
      const stagedState = await databaseFileState(staged);
      if (destinationState === "file") {
        await assertRestoreFileMatches(target.destination, entry, "RESTORE_DESTINATION_CONFLICT");
        if (stagedState === "file") {
          await assertRestoreFileMatches(staged, entry, "RESTORE_STAGING_CONFLICT");
          await fs.rm(staged);
        } else if (stagedState !== "missing") {
          throw new RecoveryGateError("RESTORE_STAGING_CONFLICT", `恢复暂存路径类型异常：${staged}`);
        }
        if (!intent.completed.includes(target.definition.id)) {
          intent.completed.push(target.definition.id);
          await writeJsonAtomic(intentPath, intent);
        }
        continue;
      }
      if (destinationState !== "missing") {
        throw new RecoveryGateError("RESTORE_DESTINATION_CONFLICT", `恢复目标路径类型异常：${target.destination}`);
      }
      if (stagedState !== "file") {
        throw new RecoveryGateError("RESTORE_STAGING_MISSING", `恢复暂存文件缺失：${staged}`);
      }
      await assertRestoreFileMatches(staged, entry, "RESTORE_STAGING_CONFLICT");
      const stagedIdentity = await captureRestoreFileIdentity(
        staged,
        forbiddenDatabaseFileIdentities
      );
      await invokeFault(faultInjector, `before-restore-rename-${target.definition.agentId}-${target.definition.kind}`);
      await assertRestoreFileMatches(staged, entry, "RESTORE_STAGING_CONFLICT");
      await assertRestoreFileIdentity(
        staged,
        stagedIdentity,
        forbiddenDatabaseFileIdentities
      );
      if (await databaseFileState(target.destination) !== "missing") {
        throw new RecoveryGateError(
          "RESTORE_DESTINATION_CONFLICT",
          `恢复目标在最终 rename 前发生变化：${target.destination}`
        );
      }
      await fs.rename(staged, target.destination);
      await assertRestoreFileIdentity(
        target.destination,
        stagedIdentity,
        forbiddenDatabaseFileIdentities
      );
      await syncDirectory(path.dirname(target.destination));
      await invokeFault(faultInjector, `after-restore-rename-${target.definition.agentId}-${target.definition.kind}`);
      if (!intent.completed.includes(target.definition.id)) intent.completed.push(target.definition.id);
      await writeJsonAtomic(intentPath, intent);
    }
  } catch (error) {
    throw normalizeGateError(error, "RESTORE_FAILED");
  }

  const verification = await verifyWorkspaceDatabases(targetWorkspace, backup.manifest, {
    databaseOpenObserver: options.databaseOpenObserver
  });
  await fs.rmdir(stagingDirectory).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await fs.rm(intentPath, { force: true });
  await syncDirectory(targetWorkspace);
  return { ok: true, targetWorkspace, backupId: backup.manifest.backupId, verification };
}

export async function rollbackRecoveryPointRestore(options) {
  const backup = await verifyRecoveryPoint(options.backupDirectory, {
    databaseOpenObserver: options.databaseOpenObserver
  });
  const targetWorkspace = absolutePath(options.targetWorkspace, "targetWorkspace");
  await safeRecoveryDirectory(targetWorkspace);
  const definitions = databaseDefinitionsForManifest(backup.manifest);
  const targets = definitions.map((definition) => ({
    definition,
    destination: safeWorkspaceChild(targetWorkspace, definition.source),
    source: safeManifestChild(
      backup.directory,
      backup.manifest.databases.find((entry) => entry.id === definition.id).file
    )
  }));
  const intentPath = path.join(targetWorkspace, `.restore-${backup.manifest.backupId}.json`);
  const intent = await readRestoreIntent(intentPath, backup, targetWorkspace, targets);
  if (!intent) {
    throw new RecoveryGateError("RESTORE_INTENT_MISSING", "没有可回滚的恢复事务。");
  }
  for (const target of [...targets].reverse()) {
    const entry = restoreIntentEntry(intent, target.definition.id);
    const destinationState = await databaseFileState(target.destination);
    if (destinationState === "file") {
      await assertRestoreFileMatches(target.destination, entry, "RESTORE_DESTINATION_CONFLICT");
      await fs.rm(target.destination);
      await syncDirectory(path.dirname(target.destination));
    } else if (destinationState !== "missing") {
      throw new RecoveryGateError("RESTORE_DESTINATION_CONFLICT", `恢复目标路径类型异常：${target.destination}`);
    }
  }
  const stagingDirectory = safeWorkspaceChild(targetWorkspace, intent.stagingDirectory);
  for (const entry of [...intent.files].reverse()) {
    const staged = safeWorkspaceChild(targetWorkspace, entry.staged);
    const stagedState = await databaseFileState(staged);
    if (stagedState === "file") {
      await assertRestoreFileMatches(staged, entry, "RESTORE_STAGING_CONFLICT");
      await fs.rm(staged);
    } else if (stagedState !== "missing") {
      throw new RecoveryGateError("RESTORE_STAGING_CONFLICT", `恢复暂存路径类型异常：${staged}`);
    }
  }
  await fs.rmdir(stagingDirectory).catch((error) => {
    if (error?.code === "ENOENT") return;
    if (error?.code === "ENOTEMPTY") {
      throw new RecoveryGateError("RESTORE_STAGING_CONFLICT", `恢复暂存目录包含未知文件：${stagingDirectory}`);
    }
    throw error;
  });
  await fs.rm(intentPath, { force: true });
  await removeEmptyRestoreDirectories(targetWorkspace, targets);
  await syncDirectory(targetWorkspace);
  return { ok: true, rolledBack: true, targetWorkspace, backupId: backup.manifest.backupId };
}

function buildRestoreIntent(backup, targetWorkspace, targets, stagingDirectory) {
  return {
    schemaVersion: 2,
    backupId: backup.manifest.backupId,
    recoveryPointId: backup.manifest.recoveryPointId ?? null,
    createdAt: new Date().toISOString(),
    stagingDirectory: path.relative(targetWorkspace, stagingDirectory).replace(/\\/g, "/"),
    copied: [],
    completed: [],
    files: targets.map((target) => {
      const expected = backup.manifest.databases.find((entry) => entry.id === target.definition.id);
      return {
        id: target.definition.id,
        source: path.basename(target.source),
        staged: path.posix.join(path.relative(targetWorkspace, stagingDirectory).replace(/\\/g, "/"), target.definition.file),
        destination: target.definition.source,
        bytes: expected.bytes,
        sha256: expected.sha256
      };
    })
  };
}

async function readRestoreIntent(intentPath, backup, targetWorkspace, targets) {
  let intent;
  try {
    const intentStats = await fs.lstat(intentPath);
    if (!intentStats.isFile() || intentStats.isSymbolicLink()) {
      throw new RecoveryGateError("RESTORE_INTENT_INVALID", "恢复事务 journal 必须是普通文件。");
    }
    intent = JSON.parse(await fs.readFile(intentPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new RecoveryGateError("RESTORE_INTENT_INVALID", `恢复事务 journal 无效：${error.message}`);
  }
  if (intent?.schemaVersion !== 2
    || intent.backupId !== backup.manifest.backupId
    || intent.recoveryPointId !== (backup.manifest.recoveryPointId ?? null)
    || !Array.isArray(intent.files)
    || !Array.isArray(intent.copied)
    || !Array.isArray(intent.completed)
    || typeof intent.stagingDirectory !== "string") {
    throw new RecoveryGateError("RESTORE_INTENT_INVALID", "恢复事务 journal 与恢复点不匹配。");
  }
  const expectedIds = targets.map((target) => target.definition.id).sort();
  const intentIds = intent.files.map((entry) => entry?.id).sort();
  if (stableJson(expectedIds) !== stableJson(intentIds)
    || intent.copied.some((id) => !expectedIds.includes(id))
    || intent.completed.some((id) => !expectedIds.includes(id))) {
    throw new RecoveryGateError("RESTORE_INTENT_INVALID", "恢复事务 journal 文件集合不匹配。");
  }
  const expectedStagingDirectory = `.restore-${backup.manifest.backupId}.staging`;
  const stagingState = intent.stagingDirectory === expectedStagingDirectory
    ? await directoryState(safeWorkspaceChild(targetWorkspace, intent.stagingDirectory))
    : "invalid";
  if (stagingState === "missing") {
    if (intent.copied.length === 0 && intent.completed.length === 0) return intent;
    for (const target of targets) {
      const entry = restoreIntentEntry(intent, target.definition.id);
      if (await databaseFileState(target.destination) !== "file") {
        throw new RecoveryGateError("RESTORE_INTENT_INVALID", "恢复事务暂存目录缺失且目标尚未完成。");
      }
      await assertRestoreFileMatches(target.destination, entry, "RESTORE_DESTINATION_CONFLICT");
    }
  } else if (stagingState !== "directory") {
    throw new RecoveryGateError("RESTORE_INTENT_INVALID", "恢复事务暂存目录无效。");
  }
  for (const target of targets) {
    const entry = restoreIntentEntry(intent, target.definition.id);
    const expected = backup.manifest.databases.find((candidate) => candidate.id === target.definition.id);
    if (entry.source !== path.basename(target.source)
      || entry.destination !== target.definition.source
      || entry.bytes !== expected.bytes
      || entry.sha256 !== expected.sha256) {
      throw new RecoveryGateError("RESTORE_INTENT_INVALID", `恢复事务 journal 条目不匹配：${target.definition.id}`);
    }
    safeWorkspaceChild(targetWorkspace, entry.staged);
    safeWorkspaceChild(targetWorkspace, entry.destination);
  }
  return intent;
}

function restoreIntentEntry(intent, id) {
  const entry = intent.files.find((candidate) => candidate?.id === id);
  if (!entry) throw new RecoveryGateError("RESTORE_INTENT_INVALID", `恢复事务 journal 缺少 ${id}。`);
  return entry;
}

async function assertRestoreFileMatches(filePath, entry, code) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size !== entry.bytes || await sha256File(filePath) !== entry.sha256) {
    throw new RecoveryGateError(code, `恢复事务文件与 journal 不匹配：${filePath}`);
  }
}

async function captureRestoreFileIdentity(filePath, forbiddenIdentities) {
  const stat = await fs.lstat(filePath);
  const identity = fileIdentity(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || forbiddenIdentities.has(identity)) {
    throw new RecoveryGateError(
      "RESTORE_FILE_IDENTITY_UNSAFE",
      `恢复暂存数据库必须是独立普通文件：${filePath}`
    );
  }
  return identity;
}

async function assertRestoreFileIdentity(filePath, expectedIdentity, forbiddenIdentities) {
  const stat = await fs.lstat(filePath);
  const identity = fileIdentity(stat);
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || identity !== expectedIdentity
    || forbiddenIdentities.has(identity)) {
    throw new RecoveryGateError(
      "RESTORE_FILE_IDENTITY_CHANGED",
      `恢复暂存数据库在最终 rename 前发生文件身份变化：${filePath}`
    );
  }
}

async function removeTransientRestoreSidecars(databasePath) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    const state = await databaseFileState(sidecar);
    if (state === "file") await fs.rm(sidecar);
    else if (state !== "missing") {
      throw new RecoveryGateError("RESTORE_STAGING_CONFLICT", `恢复暂存 SQLite sidecar 类型异常：${sidecar}`);
    }
  }
}

async function removeEmptyRestoreDirectories(targetWorkspace, targets) {
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

export async function verifyWorkspaceDatabases(workspaceInput, expectedManifest, options = {}) {
  const workspace = absolutePath(workspaceInput, "workspace");
  await safeRecoveryDirectory(workspace);
  if (expectedManifest) validateManifestShape(expectedManifest);
  const definitions = expectedManifest
    ? databaseDefinitionsForManifest(expectedManifest)
    : await discoverWorkspaceDatabaseDefinitions(workspace, options);
  const inspections = [];
  for (const definition of definitions) {
    const databasePath = safeWorkspaceChild(workspace, definition.source);
    await assertWorkspaceDatabaseSource(workspace, definition, "RESTORED_DATABASE_MISSING");
    const expected = expectedManifest?.databases?.find((entry) => entry.id === definition.id);
    options.databaseOpenObserver?.({
      databasePath,
      id: definition.id,
      phase: "restored-workspace-verify"
    });
    inspections.push({
      id: definition.id,
      agentId: definition.agentId,
      kind: definition.kind,
      ...verifyDatabaseFile(databasePath, definition, expected)
    });
  }
  const manifestVersion = expectedManifest?.schemaVersion ?? RECOVERY_MANIFEST_VERSION;
  const crossDatabaseInvariants = buildCrossDatabaseInvariants(inspections, manifestVersion);
  if (expectedManifest
    && stableJson(crossDatabaseInvariants) !== stableJson(expectedManifest.crossDatabaseInvariants)) {
    throw new RecoveryGateError("RESTORE_INVARIANT_MISMATCH", "恢复后的 Agent 数据库不变量与恢复点不一致。");
  }
  return { ok: true, inspections, crossDatabaseInvariants };
}

export async function drillRecoveryPoint(options) {
  const startedAt = Date.now();
  const backup = await verifyRecoveryPoint(options.backupDirectory);
  const drillRoot = options.targetWorkspace
    ? absolutePath(options.targetWorkspace, "targetWorkspace")
    : await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "sunabot-recovery-drill-"));
  const cleanup = !options.targetWorkspace;
  await safeRecoveryDirectory(drillRoot, { create: true });
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
    if (options.reportPath) {
      const reportPath = absolutePath(options.reportPath, "reportPath");
      await safeRecoveryParent(reportPath, { create: true });
      await writeJsonAtomic(reportPath, report);
    }
    return report;
  } finally {
    if (cleanup) await removeSafeRecoveryDirectory(drillRoot);
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
  await safeRecoveryDirectory(backupsRoot);
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
      await safeRecoveryDirectory(entry.directory);
      await fs.rm(entry.directory, { recursive: true, force: false });
    }
  }
  return { applied: options.apply === true, plan };
}

function captureWorkspaceDatabaseIdentitySnapshot(workspace) {
  const entries = [];
  const identities = new Map();
  const addDefinition = (definition) => {
    assertWorkspaceDatabaseDirectoriesSync(workspace, definition);
    const databasePath = safeWorkspaceChild(workspace, definition.source);
    let stat;
    try {
      stat = fsSync.lstatSync(databasePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new RecoveryGateError(
          "SOURCE_DATABASE_MISSING",
          `数据库文件不存在：${databasePath}`
        );
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new RecoveryGateError(
        "SOURCE_DATABASE_IDENTITY_UNSAFE",
        `源数据库必须是独立普通文件：${databasePath}`
      );
    }
    const identity = fileIdentity(stat);
    if (identities.has(identity)) {
      throw new RecoveryGateError(
        "SOURCE_DATABASE_IDENTITY_CONFLICT",
        `源数据库共用文件身份：${identities.get(identity)} 与 ${definition.source}`
      );
    }
    identities.set(identity, definition.source);
    entries.push({ source: definition.source, databasePath, identity });
  };

  for (const definition of databaseDefinitionsForAgent(DEFAULT_AGENT_ID)) addDefinition(definition);

  const agentsRoot = safeWorkspaceChild(workspace, "business/agents");
  const agentsRootState = pathStateSync(agentsRoot);
  if (agentsRootState !== "missing" && agentsRootState !== "directory") {
    throw new RecoveryGateError("AGENT_DATABASE_PATH_INVALID", "business/agents 必须是普通目录。");
  }
  if (agentsRootState === "directory") {
    for (const entry of fsSync.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new RecoveryGateError(
          "AGENT_DATABASE_PATH_INVALID",
          `Agent 根目录不能包含符号链接：business/agents/${entry.name}`
        );
      }
      if (!entry.isDirectory()) continue;
      const agentRoot = path.join(agentsRoot, entry.name);
      if (pathStateSync(agentRoot) !== "directory") {
        throw new RecoveryGateError(
          "AGENT_DATABASE_PATH_INVALID",
          `Agent 根目录必须是普通目录：business/agents/${entry.name}`
        );
      }
      const dataDirectory = path.join(agentRoot, "data");
      const dataDirectoryState = pathStateSync(dataDirectory);
      if (dataDirectoryState === "missing") continue;
      if (dataDirectoryState !== "directory") {
        throw new RecoveryGateError(
          "AGENT_DATABASE_PATH_INVALID",
          `Agent ${entry.name} 的 data 路径必须是普通目录。`
        );
      }
      const applicationState = pathStateSync(path.join(dataDirectory, "sunabot.sqlite"));
      const queueState = pathStateSync(path.join(dataDirectory, "session-queue.sqlite"));
      if (applicationState === "missing" && queueState === "missing") continue;
      if (!AGENT_ID_PATTERN.test(entry.name)) {
        throw new RecoveryGateError(
          "AGENT_DATABASE_PATH_INVALID",
          `Agent 数据库目录无效：business/agents/${entry.name}`
        );
      }
      if (applicationState !== "file" || queueState !== "file") {
        const code = applicationState === "missing" || queueState === "missing"
          ? "AGENT_DATABASE_PAIR_INCOMPLETE"
          : "AGENT_DATABASE_PATH_INVALID";
        throw new RecoveryGateError(
          code,
          `Agent ${entry.name} 的业务库与 session queue 必须是同时存在的普通文件。`
        );
      }
      for (const definition of databaseDefinitionsForAgent(entry.name)) addDefinition(definition);
    }
  }

  entries.sort((left, right) => left.source.localeCompare(right.source));
  return {
    workspaceDirectoryChain: captureDirectoryIdentityChainSync(workspace),
    entries
  };
}

function assertWorkspaceDatabaseDirectoriesSync(workspace, definition) {
  let current = path.resolve(workspace);
  if (pathStateSync(current) !== "directory") {
    throw new RecoveryGateError("SOURCE_DATABASE_MISSING", `workspace 不是普通目录：${workspace}`);
  }
  for (const segment of definition.source.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    if (pathStateSync(current) !== "directory") {
      throw new RecoveryGateError(
        "SOURCE_DATABASE_MISSING",
        `数据库目录不存在或不安全：${current}`
      );
    }
  }
}

function pathStateSync(candidate) {
  try {
    const stat = fsSync.lstatSync(candidate);
    if (stat.isFile() && !stat.isSymbolicLink()) return "file";
    if (stat.isDirectory() && !stat.isSymbolicLink()) return "directory";
    return "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function captureDirectoryIdentityChainSync(directory) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const chain = [];
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    const stat = fsSync.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RecoveryGateError(
        "RECOVERY_PATH_UNSAFE",
        `目录身份链包含非普通目录：${current}`
      );
    }
    chain.push({ path: current, identity: fileIdentity(stat) });
  }
  return chain;
}

function assertDirectoryIdentityChainSync(directory, expected) {
  const current = captureDirectoryIdentityChainSync(directory);
  if (stableJson(current) !== stableJson(expected)) {
    throw new RecoveryGateError(
      "RECOVERY_PATH_IDENTITY_CHANGED",
      `目录身份链发生变化：${directory}`
    );
  }
}

function assertWorkspaceDatabaseIdentitySnapshot(workspace, expected) {
  let current;
  try {
    assertDirectoryIdentityChainSync(workspace, expected.workspaceDirectoryChain);
    current = captureWorkspaceDatabaseIdentitySnapshot(workspace);
  } catch (error) {
    throw new RecoveryGateError(
      "SOURCE_DATABASE_IDENTITY_CHANGED",
      `源数据库身份集合发生变化：${error.message}`,
      { causeCode: error.code }
    );
  }
  const project = (entries) => entries.map(({ source, identity }) => ({ source, identity }));
  if (stableJson(current.workspaceDirectoryChain) !== stableJson(expected.workspaceDirectoryChain)
    || stableJson(project(current.entries)) !== stableJson(project(expected.entries))) {
    throw new RecoveryGateError(
      "SOURCE_DATABASE_IDENTITY_CHANGED",
      "源数据库身份集合在恢复点创建期间发生变化。"
    );
  }
}

function assertWorkspaceDatabaseDefinitionsMatchSnapshot(definitions, snapshot) {
  const definitionSources = definitions.map((definition) => definition.source).sort();
  const snapshotSources = snapshot.entries.map((entry) => entry.source).sort();
  if (stableJson(definitionSources) !== stableJson(snapshotSources)) {
    throw new RecoveryGateError(
      "SOURCE_DATABASE_IDENTITY_CHANGED",
      "数据库注册表、文件系统与固定身份集合不一致。"
    );
  }
}

async function discoverWorkspaceDatabaseDefinitions(workspace, options = {}) {
  const identitySnapshot = options.databaseIdentitySnapshot
    ?? captureWorkspaceDatabaseIdentitySnapshot(workspace);
  const defaultDefinitions = databaseDefinitionsForAgent(DEFAULT_AGENT_ID);
  for (const definition of defaultDefinitions) {
    await assertWorkspaceDatabaseSource(workspace, definition, "SOURCE_DATABASE_MISSING");
  }

  const registryDatabasePath = safeWorkspaceChild(workspace, defaultDefinitions[0].source);
  assertWorkspaceDatabaseIdentitySnapshot(workspace, identitySnapshot);
  options.databaseOpenObserver?.({
    databasePath: registryDatabasePath,
    id: defaultDefinitions[0].id,
    phase: "source-agent-registry"
  });
  assertWorkspaceDatabaseIdentitySnapshot(workspace, identitySnapshot);
  let registryInspection;
  try {
    registryInspection = readRegisteredAgents(registryDatabasePath);
  } finally {
    assertWorkspaceDatabaseIdentitySnapshot(workspace, identitySnapshot);
  }
  const registry = registryInspection.agents;
  if (!registry.has(DEFAULT_AGENT_ID)) registry.set(DEFAULT_AGENT_ID, true);
  const filesystemAgents = await readFilesystemAgentDatabasePairs(workspace);
  if (registryInspection.legacySingleAgent) {
    const agentManifest = safeWorkspaceChild(
      workspace,
      `business/agents/${DEFAULT_AGENT_ID}/agent.json`
    );
    if (await databaseFileState(agentManifest) !== "missing") {
      throw new RecoveryGateError(
        "AGENT_REGISTRY_INVALID",
        "当前 Agent workspace 缺少注册表 schema，不能按旧单 Agent 数据库处理。"
      );
    }
  }

  if (filesystemAgents.has(DEFAULT_AGENT_ID)) {
    throw new RecoveryGateError(
      "AGENT_DATABASE_ORPHAN",
      `默认 Agent ${DEFAULT_AGENT_ID} 的数据库只能位于 business/data，拒绝重复的 Agent 数据目录。`
    );
  }
  for (const agentId of filesystemAgents) {
    if (!registry.has(agentId)) {
      throw new RecoveryGateError(
        "AGENT_DATABASE_ORPHAN",
        `文件系统存在未注册 Agent ${agentId} 的数据库。`
      );
    }
  }
  for (const agentId of registry.keys()) {
    if (agentId !== DEFAULT_AGENT_ID && !filesystemAgents.has(agentId)) {
      throw new RecoveryGateError(
        "AGENT_DATABASE_PAIR_MISSING",
        `已注册 Agent ${agentId} 缺少业务库与 session queue 数据库。`
      );
    }
  }

  const definitions = [...registry.keys()]
    .sort(compareAgentIds)
    .flatMap((agentId) => {
      const legacyApplicationSchema = registryInspection.legacySingleAgent && agentId === DEFAULT_AGENT_ID;
      const applicationSource = databaseDefinitionsForAgent(agentId)[0].source;
      const applicationPath = safeWorkspaceChild(workspace, applicationSource);
      if (!legacyApplicationSchema) {
        assertWorkspaceDatabaseIdentitySnapshot(workspace, identitySnapshot);
        options.databaseOpenObserver?.({
          databasePath: applicationPath,
          id: `agent:${agentId}:application`,
          phase: "source-storage-schema"
        });
        assertWorkspaceDatabaseIdentitySnapshot(workspace, identitySnapshot);
      }
      let storageSchemaVersion;
      if (!legacyApplicationSchema) {
        try {
          storageSchemaVersion = readApplicationStorageSchemaVersion(applicationPath);
        } finally {
          assertWorkspaceDatabaseIdentitySnapshot(workspace, identitySnapshot);
        }
      }
      return databaseDefinitionsForAgent(agentId, {
        legacyApplicationSchema,
        applicationStorageSchemaVersion: storageSchemaVersion
      });
    });
  assertWorkspaceDatabaseDefinitionsMatchSnapshot(definitions, identitySnapshot);
  return definitions;
}

function readApplicationStorageSchemaVersion(databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const hasMetadata = database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'app_metadata'
    `).get();
    if (Number(hasMetadata?.count ?? 0) !== 1) return undefined;
    const row = database.prepare(`
      SELECT value FROM app_metadata WHERE key = 'storage-schema-version'
    `).get();
    const version = Number(row?.value);
    return Number.isInteger(version) ? version : undefined;
  } catch {
    return undefined;
  } finally {
    if (database?.isOpen) database.close();
  }
}

function readRegisteredAgents(databasePath) {
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const registryTables = new Set(database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN ('agents', 'agent_accounts')
    `).all().map((row) => String(row.name)));
    if (registryTables.size === 0) return { agents: new Map(), legacySingleAgent: true };
    if (!registryTables.has("agents") || !registryTables.has("agent_accounts")) {
      throw new RecoveryGateError("AGENT_REGISTRY_INVALID", "Agent 注册表 schema 不完整。");
    }
    const rows = database.prepare("SELECT id, enabled FROM agents ORDER BY id").all();
    const agents = new Map();
    for (const row of rows) {
      const agentId = String(row.id ?? "");
      if (!AGENT_ID_PATTERN.test(agentId)) {
        throw new RecoveryGateError("AGENT_ID_INVALID", `注册表包含非法 Agent ID：${agentId || "<empty>"}`);
      }
      agents.set(agentId, Number(row.enabled) !== 0);
    }
    return { agents, legacySingleAgent: false };
  } catch (error) {
    if (error instanceof RecoveryGateError) throw error;
    throw normalizeGateError(
      new RecoveryGateError("AGENT_REGISTRY_INVALID", `无法读取 Agent 注册表：${error.message}`)
    );
  } finally {
    if (database?.isOpen) database.close();
  }
}

async function readFilesystemAgentDatabasePairs(workspace) {
  const agentsRoot = safeWorkspaceChild(workspace, "business/agents");
  const agentsRootState = await directoryState(agentsRoot);
  if (agentsRootState === "missing") return new Set();
  if (agentsRootState !== "directory") {
    throw new RecoveryGateError("AGENT_DATABASE_PATH_INVALID", "business/agents 必须是普通目录。");
  }
  let entries;
  try {
    entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }

  const agents = new Set();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new RecoveryGateError(
        "AGENT_DATABASE_PATH_INVALID",
        `Agent 根目录不能包含符号链接：business/agents/${entry.name}`
      );
    }
    if (!entry.isDirectory()) continue;

    const dataDirectory = path.join(agentsRoot, entry.name, "data");
    const dataDirectoryState = await directoryState(dataDirectory);
    if (dataDirectoryState === "missing") continue;
    if (dataDirectoryState !== "directory") {
      throw new RecoveryGateError(
        "AGENT_DATABASE_PATH_INVALID",
        `Agent ${entry.name} 的 data 路径必须是普通目录。`
      );
    }
    const applicationPath = path.join(dataDirectory, "sunabot.sqlite");
    const queuePath = path.join(dataDirectory, "session-queue.sqlite");
    const applicationState = await databaseFileState(applicationPath);
    const queueState = await databaseFileState(queuePath);
    const hasDatabasePath = applicationState !== "missing" || queueState !== "missing";
    if (!hasDatabasePath) continue;

    if (!AGENT_ID_PATTERN.test(entry.name)) {
      throw new RecoveryGateError(
        "AGENT_DATABASE_PATH_INVALID",
        `Agent 数据库目录无效：business/agents/${entry.name}`
      );
    }
    if (applicationState === "invalid" || queueState === "invalid") {
      throw new RecoveryGateError(
        "AGENT_DATABASE_PATH_INVALID",
        `Agent ${entry.name} 的数据库路径必须是普通目录中的普通文件。`
      );
    }
    if (applicationState !== queueState) {
      throw new RecoveryGateError(
        "AGENT_DATABASE_PAIR_INCOMPLETE",
        `Agent ${entry.name} 的业务库与 session queue 必须同时存在。`
      );
    }
    agents.add(entry.name);
  }
  return agents;
}

async function databaseFileState(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? "file" : "invalid";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function directoryState(directory) {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() ? "directory" : "invalid";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

function databaseDefinitionsForAgent(agentId, options = {}) {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new RecoveryGateError("AGENT_ID_INVALID", `Agent ID 无效：${agentId}`);
  }
  const dataRoot = agentId === DEFAULT_AGENT_ID
    ? "business/data"
    : `business/agents/${agentId}/data`;
  return [
    {
      id: `agent:${agentId}:application`,
      agentId,
      kind: "application",
      schemaProfile: options.legacyApplicationSchema ? "legacy-single-agent" : "current",
      expectedStorageSchemaVersion: options.applicationStorageSchemaVersion
        ?? CURRENT_APPLICATION_STORAGE_SCHEMA_VERSION,
      source: `${dataRoot}/sunabot.sqlite`,
      file: `agent-${agentId}-application.sqlite`,
      requiredTables: options.legacyApplicationSchema
        ? LEGACY_APPLICATION_REQUIRED_TABLES
        : options.applicationStorageSchemaVersion === LEGACY_CURRENT_APPLICATION_STORAGE_SCHEMA_VERSION
          || options.applicationStorageSchemaVersion === PRE_EMOJI_APPLICATION_STORAGE_SCHEMA_VERSION
            ? PRE_EMOJI_APPLICATION_REQUIRED_TABLES
          : CURRENT_APPLICATION_REQUIRED_TABLES
    },
    {
      id: `agent:${agentId}:session_queue`,
      agentId,
      kind: "session_queue",
      schemaProfile: "current",
      source: `${dataRoot}/session-queue.sqlite`,
      file: `agent-${agentId}-session-queue.sqlite`,
      requiredTables: QUEUE_REQUIRED_TABLES
    }
  ];
}

function databaseDefinitionsForManifest(manifest) {
  if (manifest.schemaVersion === LEGACY_RECOVERY_MANIFEST_VERSION) {
    return LEGACY_DATABASE_DEFINITIONS;
  }
  const agentIds = [...new Set(manifest.databases.map((entry) => entry.agentId))].sort(compareAgentIds);
  return agentIds.flatMap((agentId) => {
    const application = manifest.databases.find((entry) =>
      entry.agentId === agentId && entry.kind === "application"
    );
    return databaseDefinitionsForAgent(agentId, {
      legacyApplicationSchema: application?.schemaProfile === "legacy-single-agent",
      applicationStorageSchemaVersion: applicationStorageSchemaVersion(application)
    });
  });
}

function applicationStorageSchemaVersion(entry) {
  if (Number.isInteger(entry?.storageSchemaVersion)) return entry.storageSchemaVersion;
  if (entry?.schemaProfile !== "current" || !Number.isInteger(entry.userVersion)) return undefined;
  return [
    LEGACY_CURRENT_APPLICATION_STORAGE_SCHEMA_VERSION,
    PRE_EMOJI_APPLICATION_STORAGE_SCHEMA_VERSION,
    CURRENT_APPLICATION_STORAGE_SCHEMA_VERSION
  ].includes(entry.userVersion)
    ? entry.userVersion
    : undefined;
}

function verifyV2ManifestAgentSet(backupDirectory, manifest, options = {}, databaseFiles = []) {
  const application = manifest.databases.find((entry) =>
    entry.agentId === DEFAULT_AGENT_ID && entry.kind === "application"
  );
  if (!application) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "v2 manifest 缺少 Plana 注册主库。");
  }
  const databasePath = safeManifestChild(backupDirectory, application.file);
  const pinned = databaseFiles.find((entry) => entry.definition.id === application.id);
  if (!pinned) {
    throw new RecoveryGateError("BACKUP_FILE_MISSING", "Plana 注册主库未进入恢复点身份快照。");
  }
  assertRecoveryFileIdentity(
    fsSync.lstatSync(databasePath),
    pinned.identity,
    application.id
  );
  options.databaseOpenObserver?.({
    databasePath,
    id: application.id,
    phase: "agent-registry"
  });
  assertRecoveryFileIdentity(
    fsSync.lstatSync(databasePath),
    pinned.identity,
    application.id
  );
  let registryInspection;
  try {
    registryInspection = readRegisteredAgents(databasePath);
  } finally {
    assertRecoveryFileIdentity(
      fsSync.lstatSync(databasePath),
      pinned.identity,
      application.id
    );
  }
  const registeredAgentIds = new Set(registryInspection.agents.keys());
  registeredAgentIds.add(DEFAULT_AGENT_ID);
  const manifestAgentIds = new Set(manifest.databases.map((entry) => entry.agentId));
  const registered = [...registeredAgentIds].sort(compareAgentIds);
  const listed = [...manifestAgentIds].sort(compareAgentIds);
  if (stableJson(registered) !== stableJson(listed)) {
    throw new RecoveryGateError(
      "BACKUP_AGENT_SET_MISMATCH",
      `manifest Agent 集合与 Plana 注册表不一致：registered=${registered.join(",")} manifest=${listed.join(",")}`
    );
  }
  const expectedProfile = registryInspection.legacySingleAgent ? "legacy-single-agent" : "current";
  if (application.schemaProfile !== expectedProfile) {
    throw new RecoveryGateError(
      "BACKUP_MANIFEST_INVALID",
      `Plana schema profile 与注册主库不一致：${application.schemaProfile}`
    );
  }
}

function compareAgentIds(left, right) {
  if (left === DEFAULT_AGENT_ID) return right === DEFAULT_AGENT_ID ? 0 : -1;
  if (right === DEFAULT_AGENT_ID) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
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

function verifyDatabaseFile(databasePath, definition, expected, options = {}) {
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
    const extension = typeof options.databaseInspectionExtension === "function"
      ? options.databaseInspectionExtension({ database, databasePath, definition, expected })
      : undefined;
    return extension === undefined ? inspection : { ...inspection, extension };
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
  if (definition.expectedStorageSchemaVersion !== undefined) {
    const row = database.prepare(`
      SELECT value FROM app_metadata WHERE key = 'storage-schema-version'
    `).get();
    if (Number(row?.value) !== definition.expectedStorageSchemaVersion) {
      throw new RecoveryGateError(
        "SQLITE_SCHEMA_INCOMPLETE",
        `${definition.id} 的表集合要求 storage-schema-version 为 ${definition.expectedStorageSchemaVersion}。`
      );
    }
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
    invariants: definition.kind === "session_queue"
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

function buildCrossDatabaseInvariants(entries, manifestVersion) {
  if (manifestVersion === LEGACY_RECOVERY_MANIFEST_VERSION) {
    const queue = entries.find((entry) => entry.id === "session_queue")?.invariants;
    if (!queue) throw new RecoveryGateError("QUEUE_INVARIANT_MISSING", "恢复点缺少 session queue 不变量。");
    return {
      queueAuthoritativeForDelivery: true,
      mainProjectionMayLagAfterExternalSend: true,
      outboxStatusCounts: queue.outboxStatusCounts,
      terminalOutboxDigest: queue.terminalOutboxDigest
    };
  }

  const agentIds = [...new Set(entries.map((entry) => entry.agentId))].sort(compareAgentIds);
  const agents = {};
  for (const agentId of agentIds) {
    const application = entries.find((entry) => entry.agentId === agentId && entry.kind === "application");
    const queue = entries.find((entry) => entry.agentId === agentId && entry.kind === "session_queue");
    if (!application || !queue?.invariants) {
      throw new RecoveryGateError(
        "QUEUE_INVARIANT_MISSING",
        `${agentId} 恢复点缺少完整业务库或 session queue 不变量。`
      );
    }
    agents[agentId] = {
      applicationDatabaseId: application.id,
      sessionQueueDatabaseId: queue.id,
      outboxStatusCounts: queue.invariants.outboxStatusCounts,
      terminalOutboxDigest: queue.invariants.terminalOutboxDigest
    };
  }
  return {
    queueAuthoritativeForDelivery: true,
    mainProjectionMayLagAfterExternalSend: true,
    agents
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

async function writeRecoveryOwnerFile(directory, ownerRecord) {
  const ownerPath = path.join(directory, RECOVERY_OWNER_FILE);
  const bytes = Buffer.from(`${JSON.stringify(ownerRecord, null, 2)}\n`, "utf8");
  await fs.writeFile(ownerPath, bytes, { flag: "wx", mode: 0o600 });
  await syncFile(ownerPath);
}

async function acquireRecoveryLock(backupsRoot, now) {
  const lockPath = path.join(backupsRoot, LOCK_FILE);
  const rootIdentityChain = captureDirectoryIdentityChainSync(backupsRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = crypto.randomUUID();
      const handle = await fs.open(lockPath, "wx", 0o600);
      const bytes = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        token,
        pid: process.pid,
        startedAt: now.toISOString()
      })}\n`, "utf8");
      await handle.write(bytes);
      await handle.sync();
      await handle.close();
      const identity = fileIdentity(fsSync.lstatSync(lockPath));
      return async () => removeRecoveryLock({
        lockPath,
        rootIdentityChain,
        expectedIdentity: identity,
        expectedContentHash: sha256(bytes)
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await databaseFileState(lockPath) !== "file") {
        throw new RecoveryGateError("RECOVERY_PATH_UNSAFE", `SQLite 恢复锁路径不安全：${lockPath}`);
      }
      const existingStat = await fs.lstat(lockPath);
      const existingBytes = await fs.readFile(lockPath);
      const stale = await lockIsStale(lockPath, existingStat, existingBytes);
      if (!stale) throw new RecoveryGateError("BACKUP_LOCKED", "另一个备份/恢复进程持有 SQLite 恢复锁。");
      await removeRecoveryLock({
        lockPath,
        rootIdentityChain,
        expectedIdentity: fileIdentity(existingStat),
        expectedContentHash: sha256(existingBytes)
      });
    }
  }
  throw new RecoveryGateError("BACKUP_LOCKED", "无法获取 SQLite 恢复锁。");
}

async function removeRecoveryLock(options) {
  const { lockPath, rootIdentityChain, expectedIdentity, expectedContentHash } = options;
  try {
    assertDirectoryIdentityChainSync(path.dirname(lockPath), rootIdentityChain);
  } catch {
    return { status: "ownership-conflict", lockPath };
  }
  const state = await databaseFileState(lockPath);
  if (state === "missing") return { status: "missing", lockPath };
  if (state !== "file") return { status: "ownership-conflict", lockPath };
  const stat = await fs.lstat(lockPath);
  const bytes = await fs.readFile(lockPath);
  if (stat.nlink !== 1
    || fileIdentity(stat) !== expectedIdentity
    || sha256(bytes) !== expectedContentHash) {
    return { status: "ownership-conflict", lockPath };
  }
  await fs.rm(lockPath);
  return { status: "removed", lockPath };
}

async function lockIsStale(lockPath, expectedStat = null, expectedBytes = null) {
  try {
    const bytes = expectedBytes ?? await fs.readFile(lockPath);
    if (expectedStat && (expectedStat.nlink !== 1 || fileIdentity(expectedStat) !== fileIdentity(await fs.lstat(lockPath)))) {
      return false;
    }
    const lock = JSON.parse(bytes.toString("utf8"));
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
  const rootIdentityChain = captureDirectoryIdentityChainSync(backupsRoot);
  for (const entry of await fs.readdir(backupsRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(PARTIAL_DIRECTORY_PREFIX)) continue;
    const candidate = path.join(backupsRoot, entry.name);
    if (path.dirname(candidate) !== backupsRoot) continue;
    await safeRecoveryDirectory(candidate);
    assertDirectoryIdentityChainSync(backupsRoot, rootIdentityChain);
    const candidateStat = fsSync.lstatSync(candidate);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new RecoveryGateError(
        "RECOVERY_PATH_UNSAFE",
        `中断恢复点暂存路径必须是普通目录：${candidate}`
      );
    }
    let owner;
    try {
      owner = JSON.parse(fsSync.readFileSync(path.join(candidate, RECOVERY_OWNER_FILE), "utf8"));
    } catch {
      throw new RecoveryGateError(
        "RECOVERY_PATH_UNSAFE",
        `中断恢复点缺少所有权凭据，保留原路径供人工处置：${candidate}`
      );
    }
    const expectedBackupId = entry.name.slice(PARTIAL_DIRECTORY_PREFIX.length);
    if (owner?.schemaVersion !== 1
      || owner.backupId !== expectedBackupId
      || owner.directoryIdentity !== fileIdentity(candidateStat)
      || typeof owner.token !== "string"
      || owner.token.length < 16) {
      throw new RecoveryGateError(
        "RECOVERY_PATH_UNSAFE",
        `中断恢复点所有权凭据不匹配，保留原路径供人工处置：${candidate}`
      );
    }
    const quarantine = path.join(
      backupsRoot,
      `.interrupted-${entry.name.slice(1)}-${crypto.randomUUID().slice(0, 8)}`
    );
    if (pathStateSync(quarantine) !== "missing") {
      throw new RecoveryGateError("RECOVERY_PATH_UNSAFE", `中断恢复点隔离路径已存在：${quarantine}`);
    }
    assertDirectoryIdentityChainSync(backupsRoot, rootIdentityChain);
    fsSync.renameSync(candidate, quarantine);
    await syncDirectory(backupsRoot);
  }
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "备份 manifest 必须是对象。");
  }
  if (![LEGACY_RECOVERY_MANIFEST_VERSION, RECOVERY_MANIFEST_VERSION].includes(manifest.schemaVersion)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_VERSION", `不支持 manifest 版本 ${manifest.schemaVersion}。`);
  }
  assertBackupId(manifest.backupId);
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "manifest.createdAt 无效。");
  }
  if (!Array.isArray(manifest.databases)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "manifest.databases 不完整。");
  }
  if (!manifest.crossDatabaseInvariants
    || typeof manifest.crossDatabaseInvariants !== "object"
    || Array.isArray(manifest.crossDatabaseInvariants)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "manifest.crossDatabaseInvariants 无效。");
  }

  const definitions = manifest.schemaVersion === LEGACY_RECOVERY_MANIFEST_VERSION
    ? LEGACY_DATABASE_DEFINITIONS
    : validateV2AgentDatabaseEntries(manifest.databases);
  if (manifest.databases.length !== definitions.length) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "manifest.databases 不完整。");
  }
  const ids = new Set();
  const sources = new Set();
  const files = new Set();
  for (const definition of definitions) {
    const entry = manifest.databases.find((candidate) => candidate?.id === definition.id);
    if (!entry) {
      throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `manifest 缺少 ${definition.id} 数据库。`);
    }
    validateManifestDatabaseEntry(entry, definition);
    for (const [values, value, field] of [
      [ids, entry.id, "id"],
      [sources, entry.source, "source"],
      [files, entry.file, "file"]
    ]) {
      if (values.has(value)) {
        throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `manifest 数据库 ${field} 重复：${value}`);
      }
      values.add(value);
    }
  }
}

function validateV2AgentDatabaseEntries(entries) {
  if (entries.length < 2 || entries.length % 2 !== 0) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "v2 manifest 必须包含完整的 Agent 数据库对。");
  }
  const agentIds = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !AGENT_ID_PATTERN.test(entry.agentId ?? "")) {
      throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "v2 manifest 包含非法 Agent ID。");
    }
    if (entry.kind !== "application" && entry.kind !== "session_queue") {
      throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `v2 manifest 数据库类型无效：${entry.kind}`);
    }
    if (entry.schemaProfile !== "current" && entry.schemaProfile !== "legacy-single-agent") {
      throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `v2 manifest schema profile 无效：${entry.schemaProfile}`);
    }
    if (entry.kind === "session_queue" && entry.schemaProfile !== "current") {
      throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "session queue 不能使用旧业务库 schema profile。");
    }
    agentIds.add(entry.agentId);
  }
  if (!agentIds.has(DEFAULT_AGENT_ID)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `v2 manifest 缺少默认 Agent ${DEFAULT_AGENT_ID}。`);
  }
  const legacyApplication = entries.find((entry) => entry.schemaProfile === "legacy-single-agent");
  if (legacyApplication
    && (legacyApplication.agentId !== DEFAULT_AGENT_ID
      || legacyApplication.kind !== "application"
      || agentIds.size !== 1)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "旧单 Agent schema profile 只能用于 Plana 单 Agent 恢复点。");
  }
  return [...agentIds].sort(compareAgentIds).flatMap((agentId) => databaseDefinitionsForAgent(agentId, {
    legacyApplicationSchema: legacyApplication?.agentId === agentId,
    applicationStorageSchemaVersion: applicationStorageSchemaVersion(entries.find((entry) =>
      entry.agentId === agentId && entry.kind === "application"
    ))
  }));
}

function validateManifestDatabaseEntry(entry, definition) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 数据库条目无效。`);
  }
  if (entry.id !== definition.id || entry.source !== definition.source || entry.file !== definition.file) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 数据库路径或标识无效。`);
  }
  if (definition.agentId !== entry.agentId && entry.agentId !== undefined) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 的 Agent 标识无效。`);
  }
  if (definition.kind !== entry.kind && entry.kind !== undefined) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 的数据库类型无效。`);
  }
  if (definition.schemaProfile !== entry.schemaProfile && entry.schemaProfile !== undefined) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 的 schema profile 无效。`);
  }
  if (definition.kind === "application" && definition.expectedStorageSchemaVersion !== undefined
    && entry.storageSchemaVersion !== undefined
    && entry.storageSchemaVersion !== definition.expectedStorageSchemaVersion) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 的 storage schema version 无效。`);
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 的文件校验信息无效。`);
  }
  if (!Number.isInteger(entry.pageSize) || entry.pageSize <= 0
    || !Number.isInteger(entry.pageCount) || entry.pageCount <= 0
    || !entry.tables || typeof entry.tables !== "object" || Array.isArray(entry.tables)
    || !entry.invariants || typeof entry.invariants !== "object" || Array.isArray(entry.invariants)) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", `${definition.id} 的 SQLite 检查信息无效。`);
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

function safeWorkspaceChild(workspace, relativePath) {
  if (typeof relativePath !== "string"
    || !relativePath
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)) {
    throw new RecoveryGateError("BACKUP_PATH_INVALID", "workspace 数据库路径无效。");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RecoveryGateError("BACKUP_PATH_INVALID", "workspace 数据库路径越界。");
  }
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new RecoveryGateError("BACKUP_PATH_INVALID", "workspace 数据库路径越界。");
  }
  return resolved;
}

async function assertWorkspaceDatabaseSource(workspace, definition, code) {
  if (await directoryState(workspace) !== "directory") {
    throw new RecoveryGateError(code, `workspace 不是普通目录：${workspace}`);
  }
  const directorySegments = definition.source.split("/").slice(0, -1);
  let current = path.resolve(workspace);
  for (const segment of directorySegments) {
    current = path.join(current, segment);
    if (await directoryState(current) !== "directory") {
      throw new RecoveryGateError(code, `数据库目录不存在或不安全：${current}`);
    }
  }
  const databasePath = safeWorkspaceChild(workspace, definition.source);
  if (await databaseFileState(databasePath) !== "file") {
    throw new RecoveryGateError(code, `数据库文件不存在或不安全：${databasePath}`);
  }
}

async function ensureSafeWorkspaceDirectory(workspace, relativeDirectory) {
  const target = safeWorkspaceChild(workspace, relativeDirectory);
  let current = path.resolve(workspace);
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    let state = await directoryState(current);
    if (state === "missing") {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      state = await directoryState(current);
    }
    if (state !== "directory") {
      throw new RecoveryGateError("RESTORE_PATH_INVALID", `恢复目录不是普通目录：${current}`);
    }
  }
  if (path.resolve(current) !== target) {
    throw new RecoveryGateError("RESTORE_PATH_INVALID", "恢复目录路径无效。");
  }
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

async function safeRecoveryDirectory(directory, options = {}) {
  try {
    return await ensureSafeAbsoluteDirectory(directory, options);
  } catch (error) {
    if (error instanceof AbsolutePathSafetyError) {
      throw new RecoveryGateError("RECOVERY_PATH_UNSAFE", error.message, { path: error.candidate });
    }
    throw error;
  }
}

async function safeRecoveryParent(candidate, options = {}) {
  try {
    return await ensureSafeAbsoluteParent(candidate, options);
  } catch (error) {
    if (error instanceof AbsolutePathSafetyError) {
      throw new RecoveryGateError("RECOVERY_PATH_UNSAFE", error.message, { path: error.candidate });
    }
    throw error;
  }
}

async function removeSafeRecoveryDirectory(directory) {
  const state = await directoryState(directory);
  if (state === "missing") return;
  await safeRecoveryDirectory(directory);
  await fs.rm(directory, { recursive: true, force: true });
}

async function quarantineOwnedRecoveryDirectory(options) {
  const {
    directories,
    backupsRoot,
    backupsRootIdentityChain,
    expectedIdentity,
    backupId,
    ownedArtifacts
  } = options;
  try {
    assertDirectoryIdentityChainSync(backupsRoot, backupsRootIdentityChain);
  } catch (error) {
    return {
      status: "ownership-conflict",
      path: directories[0],
      reason: `recovery-root:${error.code ?? error.message}`
    };
  }
  let directory = null;
  let stat = null;
  let sawExisting = false;
  for (const candidate of directories) {
    const state = pathStateSync(candidate);
    if (state === "missing") continue;
    sawExisting = true;
    if (state !== "directory") {
      return { status: "ownership-conflict", path: candidate, reason: "path-type" };
    }
    const candidateStat = fsSync.lstatSync(candidate);
    if (candidateStat.isSymbolicLink()) {
      return { status: "ownership-conflict", path: candidate, reason: "directory-symlink" };
    }
    if (fileIdentity(candidateStat) === expectedIdentity) {
      if (directory) return { status: "ownership-conflict", path: candidate, reason: "duplicate-owned-directory" };
      directory = candidate;
      stat = candidateStat;
    }
  }
  if (!directory || !stat) {
    return sawExisting
      ? { status: "ownership-conflict", path: directories[0], reason: "directory-identity" }
      : { status: "missing", path: directories[0] };
  }
  const ownerPath = path.join(directory, RECOVERY_OWNER_FILE);
  let owner;
  try {
    owner = JSON.parse(fsSync.readFileSync(ownerPath, "utf8"));
  } catch {
    return { status: "ownership-conflict", path: directory, reason: "owner-evidence-missing" };
  }
  if (owner?.schemaVersion !== 1
    || owner.backupId !== backupId
    || owner.directoryIdentity !== expectedIdentity
    || typeof owner.token !== "string"
    || owner.token.length < 16) {
    return { status: "ownership-conflict", path: directory, reason: "owner-evidence-mismatch" };
  }
  assertDirectoryIdentityChainSync(backupsRoot, backupsRootIdentityChain);
  const quarantine = path.join(
    backupsRoot,
    `.failed-${backupId}-${crypto.randomUUID().slice(0, 8)}`
  );
  if (pathStateSync(quarantine) !== "missing") {
    return { status: "ownership-conflict", path: directory, reason: "quarantine-exists" };
  }
  fsSync.renameSync(directory, quarantine);
  await syncDirectory(backupsRoot);
  for (const [name, expectedIdentity] of ownedArtifacts ?? []) {
    const artifact = path.join(quarantine, name);
    if (pathStateSync(artifact) !== "file") continue;
    const artifactStat = fsSync.lstatSync(artifact);
    if (artifactStat.isSymbolicLink() || fileIdentity(artifactStat) !== expectedIdentity) continue;
    fsSync.rmSync(artifact, { force: false });
  }
  try {
    fsSync.rmdirSync(quarantine);
    await syncDirectory(backupsRoot);
    return { status: "cleaned", path: quarantine };
  } catch (error) {
    if (error?.code === "ENOTEMPTY") return { status: "quarantined", path: quarantine };
    throw error;
  }
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

function sha256FileSync(filePath) {
  const hash = crypto.createHash("sha256");
  const pathBefore = fsSync.lstatSync(filePath);
  const expectedIdentity = fileIdentity(pathBefore);
  let handle;
  try {
    handle = fsSync.openSync(
      filePath,
      fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    throw new RecoveryGateError(
      "BACKUP_PUBLICATION_CHANGED",
      `恢复点发布文件无法安全打开：${filePath}（${error.message}）`
    );
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const descriptorBefore = fsSync.fstatSync(handle);
    if (!pathBefore.isFile()
      || pathBefore.isSymbolicLink()
      || pathBefore.nlink !== 1
      || !descriptorBefore.isFile()
      || descriptorBefore.nlink !== 1
      || fileIdentity(descriptorBefore) !== expectedIdentity
      || descriptorBefore.size !== pathBefore.size) {
      throw new RecoveryGateError(
        "BACKUP_PUBLICATION_CHANGED",
        `恢复点发布文件描述符身份不匹配：${filePath}`
      );
    }
    let bytesRead;
    do {
      bytesRead = fsSync.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    const descriptorAfter = fsSync.fstatSync(handle);
    const pathAfter = fsSync.lstatSync(filePath);
    if (!descriptorAfter.isFile()
      || descriptorAfter.nlink !== 1
      || fileIdentity(descriptorAfter) !== expectedIdentity
      || descriptorAfter.size !== pathBefore.size
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || pathAfter.nlink !== 1
      || fileIdentity(pathAfter) !== expectedIdentity
      || pathAfter.size !== pathBefore.size) {
      throw new RecoveryGateError(
        "BACKUP_PUBLICATION_CHANGED",
        `恢复点发布文件在摘要期间发生身份变化：${filePath}`
      );
    }
  } finally {
    fsSync.closeSync(handle);
  }
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
    const stat = await fs.lstat(filePath);
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
