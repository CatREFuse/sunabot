import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const RECOVERY_MANIFEST_VERSION = 2;
export const DEFAULT_HOT_RETENTION_DAYS = 7;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;

const LEGACY_RECOVERY_MANIFEST_VERSION = 1;
const RECOVERY_DIRECTORY_PREFIX = "sqlite-recovery-";
const PARTIAL_DIRECTORY_PREFIX = ".partial-sqlite-recovery-";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_CHECKSUM_FILE = "manifest.sha256";
const LOCK_FILE = ".sqlite-recovery.lock";
const DEFAULT_AGENT_ID = "plana";
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const LEGACY_APPLICATION_REQUIRED_TABLES = [
  "app_metadata",
  "conversations",
  "image_history",
  "memory_batches",
  "memory_records",
  "memory_scheduler",
  "request_logs"
];
const CURRENT_APPLICATION_REQUIRED_TABLES = [
  ...LEGACY_APPLICATION_REQUIRED_TABLES,
  "admin_sessions",
  "agent_accounts",
  "agents",
  "model_call_aggregates",
  "model_call_model_aggregates"
];
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
  const workspace = absolutePath(options.workspace, "workspace");
  if (options.quiesced !== true) {
    throw new RecoveryGateError(
      "QUIESCENCE_REQUIRED",
      "全 Agent SQLite 恢复点只能在 Sunabot 与 NapCat 已停止写入后创建；请显式确认 quiesced。"
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

    const definitions = await discoverWorkspaceDatabaseDefinitions(workspace);
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
        throw sqliteGateError(error, `无法锁定 ${sources[index].definition.id} 数据库`);
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
          agentId: source.definition.agentId,
          kind: source.definition.kind,
          schemaProfile: source.definition.schemaProfile,
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
      await invokeFault(
        faultInjector,
        `after-${source.definition.agentId}-${source.definition.kind}-backup`
      );
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
      crossDatabaseInvariants: buildCrossDatabaseInvariants(databaseEntries, RECOVERY_MANIFEST_VERSION)
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
  const definitions = databaseDefinitionsForManifest(manifest);

  const inspections = [];
  for (const definition of definitions) {
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
    inspections.push({
      id: definition.id,
      agentId: definition.agentId,
      kind: definition.kind,
      ...inspection
    });
  }
  if (manifest.schemaVersion === RECOVERY_MANIFEST_VERSION) {
    verifyV2ManifestAgentSet(backupDirectory, manifest);
  }
  const crossDatabaseInvariants = buildCrossDatabaseInvariants(inspections, manifest.schemaVersion);
  if (stableJson(crossDatabaseInvariants) !== stableJson(manifest.crossDatabaseInvariants)) {
    throw new RecoveryGateError(
      "BACKUP_CROSS_DATABASE_INVARIANT_MISMATCH",
      "Agent 数据库恢复不变量与 manifest 不一致。"
    );
  }
  return { ok: true, directory: backupDirectory, manifest, inspections };
}

export async function restoreRecoveryPoint(options) {
  const backup = await verifyRecoveryPoint(options.backupDirectory);
  const targetWorkspace = absolutePath(options.targetWorkspace, "targetWorkspace");
  const definitions = databaseDefinitionsForManifest(backup.manifest);
  await fs.mkdir(targetWorkspace, { recursive: true, mode: 0o700 });
  if (await directoryState(targetWorkspace) !== "directory") {
    throw new RecoveryGateError("RESTORE_PATH_INVALID", "恢复目标 workspace 必须是普通目录。");
  }
  const existingTargetEntries = await fs.readdir(targetWorkspace);
  if (existingTargetEntries.length > 0) {
    throw new RecoveryGateError(
      "RESTORE_TARGET_NOT_EMPTY",
      `恢复目标 workspace 必须为空；发现：${existingTargetEntries.sort().join(", ")}`
    );
  }

  const targets = definitions.map((definition) => ({
    definition,
    destination: safeWorkspaceChild(targetWorkspace, definition.source),
    source: safeManifestChild(
      backup.directory,
      backup.manifest.databases.find((entry) => entry.id === definition.id).file
    )
  }));
  for (const target of targets) {
    await ensureSafeWorkspaceDirectory(targetWorkspace, path.posix.dirname(target.definition.source));
    if (await databaseFileState(target.destination) !== "missing") {
      throw new RecoveryGateError(
        "RESTORE_TARGET_EXISTS",
        `恢复目标已存在：${target.destination}。请先停服并将旧数据库移动到独立回滚目录。`
      );
    }
  }

  const stagingDirectory = path.join(targetWorkspace, `.restore-${backup.manifest.backupId}-${process.pid}`);
  const intentPath = path.join(targetWorkspace, `.restore-${backup.manifest.backupId}.json`);
  await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  const intent = {
    schemaVersion: 1,
    backupId: backup.manifest.backupId,
    createdAt: new Date().toISOString(),
    files: targets.map((target) => ({
      source: path.basename(target.source),
      staged: path.relative(targetWorkspace, path.join(stagingDirectory, target.definition.file)),
      destination: target.definition.source
    }))
  };
  try {
    for (const target of targets) {
      const staged = path.join(stagingDirectory, target.definition.file);
      await fs.copyFile(target.source, staged, fsSync.constants.COPYFILE_EXCL);
      await syncFile(staged);
      const expected = backup.manifest.databases.find((entry) => entry.id === target.definition.id);
      verifyDatabaseFile(staged, target.definition, expected);
    }
    await writeJsonAtomic(intentPath, intent);
    for (const target of targets) {
      const staged = path.join(stagingDirectory, target.definition.file);
      await fs.rename(staged, target.destination);
    }
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    await fs.rm(intentPath, { force: true });
    for (const directory of new Set(targets.map((target) => path.dirname(target.destination)))) {
      await syncDirectory(directory);
    }
    await syncDirectory(targetWorkspace);
  } catch (error) {
    throw normalizeGateError(error, "RESTORE_FAILED");
  }

  const verification = await verifyWorkspaceDatabases(targetWorkspace, backup.manifest);
  return { ok: true, targetWorkspace, backupId: backup.manifest.backupId, verification };
}

export async function verifyWorkspaceDatabases(workspaceInput, expectedManifest) {
  const workspace = absolutePath(workspaceInput, "workspace");
  if (expectedManifest) validateManifestShape(expectedManifest);
  const definitions = expectedManifest
    ? databaseDefinitionsForManifest(expectedManifest)
    : await discoverWorkspaceDatabaseDefinitions(workspace);
  const inspections = [];
  for (const definition of definitions) {
    const databasePath = safeWorkspaceChild(workspace, definition.source);
    await assertWorkspaceDatabaseSource(workspace, definition, "RESTORED_DATABASE_MISSING");
    const expected = expectedManifest?.databases?.find((entry) => entry.id === definition.id);
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

async function discoverWorkspaceDatabaseDefinitions(workspace) {
  const defaultDefinitions = databaseDefinitionsForAgent(DEFAULT_AGENT_ID);
  for (const definition of defaultDefinitions) {
    await assertWorkspaceDatabaseSource(workspace, definition, "SOURCE_DATABASE_MISSING");
  }

  const registryInspection = readRegisteredAgents(safeWorkspaceChild(workspace, defaultDefinitions[0].source));
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

  return [...registry.keys()]
    .sort(compareAgentIds)
    .flatMap((agentId) => databaseDefinitionsForAgent(agentId, {
      legacyApplicationSchema: registryInspection.legacySingleAgent && agentId === DEFAULT_AGENT_ID
    }));
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
      source: `${dataRoot}/sunabot.sqlite`,
      file: `agent-${agentId}-application.sqlite`,
      requiredTables: options.legacyApplicationSchema
        ? LEGACY_APPLICATION_REQUIRED_TABLES
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
      legacyApplicationSchema: application?.schemaProfile === "legacy-single-agent"
    });
  });
}

function verifyV2ManifestAgentSet(backupDirectory, manifest) {
  const application = manifest.databases.find((entry) =>
    entry.agentId === DEFAULT_AGENT_ID && entry.kind === "application"
  );
  if (!application) {
    throw new RecoveryGateError("BACKUP_MANIFEST_INVALID", "v2 manifest 缺少 Plana 注册主库。");
  }
  const registryInspection = readRegisteredAgents(safeManifestChild(backupDirectory, application.file));
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
    legacyApplicationSchema: legacyApplication?.agentId === agentId
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
