#!/usr/bin/env node
import crypto from "node:crypto";
import fsConstants from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../shared/paths.mjs";
import {
  createRecoveryPoint,
  verifyWorkspaceDatabases
} from "../workspace/sqlite-recovery.mjs";

export const FROM_VERSION = "0.2.0";
export const TARGET_VERSION = "0.3.0";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const MIGRATION_ROOT = "backups/upgrade-0.3.0";
const MANIFEST_FILE = "migration.json";
const OBSOLETE_PROJECTION = "native-workbench";
const REQUIRED_INDEXES = [
  ["index.md", "markdown"],
  ["selfie/references.jsonl", "jsonl"],
  ["emoji/emojis.jsonl", "jsonl"],
  ["skills/index.json", "json"],
  ["knowledge/index.json", "json"]
];
const root = resolveProjectRoot(import.meta.url);
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "SINGLE_WORKBENCH_MIGRATION_FAILED",
      message: error?.message ?? String(error),
      report: error?.report,
      recovery: error?.recovery
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const input = parseArguments(argv);
  if (input.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let result;
  if (input.command === "plan") result = await planSingleWorkbenchMigration(input);
  else if (input.command === "apply") result = await applySingleWorkbenchMigration(input);
  else if (input.command === "verify") result = await verifySingleWorkbenchMigration(input);
  else result = await rollbackSingleWorkbenchMigration(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function planSingleWorkbenchMigration(options) {
  const projectRoot = options.projectRoot ?? root;
  const versions = await (options.verifyTargetRelease ?? verifyTargetRelease)(projectRoot);
  const workspace = await inspectWorkspace(options.workspace);
  const agents = await inspectAgents(workspace);
  const conflicts = agents.flatMap((agent) => agent.conflicts.map((conflict) => ({
    agentId: agent.agentId,
    ...conflict
  })));
  return {
    ok: conflicts.length === 0,
    command: "plan",
    fromVersion: FROM_VERSION,
    targetVersion: TARGET_VERSION,
    workspace,
    versions,
    changesRequired: agents.some((agent) => agent.legacyExists),
    agents: agents.map(publicAgentPlan),
    conflicts
  };
}

export async function applySingleWorkbenchMigration(options) {
  (options.assertNonRoot ?? assertNonRoot)();
  assertQuiesced(options.quiesced);
  const plan = await planSingleWorkbenchMigration(options);
  if (plan.conflicts.length) {
    const report = await writeConflictReport(plan, options.now ?? new Date());
    const error = migrationError(
      "SINGLE_WORKBENCH_CONFLICT",
      `发现 ${plan.conflicts.length} 个 Workbench 内容冲突；资源和 SQLite 未修改。`
    );
    error.report = report;
    throw error;
  }
  if (!plan.changesRequired) {
    const previous = await latestCompletedRecovery(plan.workspace);
    return {
      ...plan,
      command: "apply",
      alreadyApplied: Boolean(previous),
      recovery: previous?.directory,
      sqliteUnchanged: previous?.manifest.sqliteUnchanged ?? true
    };
  }

  const now = dateFrom(options.now ?? new Date());
  const recoveryId = recoveryPointId(now);
  const recoveryDirectory = path.join(plan.workspace, MIGRATION_ROOT, recoveryId);
  const beforeRoot = path.join(recoveryDirectory, "before", "agents");
  const archivedRoot = path.join(recoveryDirectory, "archived", "agents");
  await fs.mkdir(recoveryDirectory, { recursive: false, mode: 0o700 }).catch(async (error) => {
    if (error?.code === "ENOENT") {
      await fs.mkdir(path.dirname(recoveryDirectory), { recursive: true, mode: 0o700 });
      await fs.mkdir(recoveryDirectory, { recursive: false, mode: 0o700 });
      return;
    }
    throw error;
  });

  const internalPlan = await inspectAgents(plan.workspace);
  const manifest = {
    schemaVersion: 1,
    migration: `${FROM_VERSION}-to-${TARGET_VERSION}-single-workbench`,
    recoveryId,
    state: "preparing",
    createdAt: now.toISOString(),
    workspace: plan.workspace,
    sqliteRecovery: null,
    sqliteBaseline: [],
    sqliteUnchanged: false,
    agents: internalPlan.filter((agent) => agent.legacyExists).map((agent) => ({
      agentId: agent.agentId,
      canonicalExisted: agent.canonicalExists,
      copiedFiles: agent.copies.map((entry) => entry.relativePath),
      identicalFiles: agent.identical.map((entry) => entry.relativePath),
      beforeCanonical: `before/agents/${agent.agentId}/workbench`,
      beforeLegacy: `before/agents/${agent.agentId}/docker-workbench`,
      archivedLegacy: `archived/agents/${agent.agentId}/docker-workbench`,
      canonicalAfter: null,
      archivedAfter: null
    }))
  };
  await writeJson(path.join(recoveryDirectory, MANIFEST_FILE), manifest);

  try {
    for (const agent of internalPlan.filter((entry) => entry.legacyExists)) {
      const beforeAgent = path.join(beforeRoot, agent.agentId);
      await fs.mkdir(beforeAgent, { recursive: true, mode: 0o700 });
      if (agent.canonicalExists) {
        await copyTree(agent.canonicalRoot, path.join(beforeAgent, "workbench"));
      }
      await copyTree(agent.legacyRoot, path.join(beforeAgent, "docker-workbench"));
    }

    const sqliteRecovery = await (options.createRecoveryPoint ?? createRecoveryPoint)({
      workspace: plan.workspace,
      backupsRoot: path.join(recoveryDirectory, "sqlite"),
      backupId: "before",
      quiesced: true,
      now
    });
    manifest.sqliteRecovery = {
      directory: path.relative(recoveryDirectory, sqliteRecovery.directory),
      manifest: sqliteRecovery.manifest
    };
    manifest.sqliteBaseline = await (options.snapshotSqliteFiles ?? snapshotSqliteFiles)(plan.workspace);
    manifest.state = "applying";
    await writeJson(path.join(recoveryDirectory, MANIFEST_FILE), manifest);

    for (const agent of internalPlan.filter((entry) => entry.legacyExists)) {
      for (const directory of agent.directoriesToCreate) {
        await fs.mkdir(path.join(agent.canonicalRoot, directory), { recursive: true, mode: 0o700 });
      }
      for (const entry of agent.copies) {
        await copyMissingFile(entry.source, entry.target, entry.sha256);
      }
      await verifyPlannedFiles(agent);
      await validateResourceIndexes(agent.canonicalRoot);
      const archive = path.join(archivedRoot, agent.agentId, "docker-workbench");
      await fs.mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
      await fs.rename(agent.legacyRoot, archive);
    }

    const sqliteAfter = await (options.snapshotSqliteFiles ?? snapshotSqliteFiles)(plan.workspace);
    if (stableJson(sqliteAfter) !== stableJson(manifest.sqliteBaseline)) {
      throw migrationError("SINGLE_WORKBENCH_SQLITE_CHANGED", "资源迁移期间 SQLite 文件发生变化。");
    }
    if (manifest.sqliteRecovery?.manifest) {
      await (options.verifyWorkspaceDatabases ?? verifyWorkspaceDatabases)(
        plan.workspace,
        manifest.sqliteRecovery.manifest
      );
    }
    for (const agent of manifest.agents) {
      const canonical = path.join(plan.workspace, "business", "agents", agent.agentId, "workbench");
      const archived = path.join(recoveryDirectory, agent.archivedLegacy);
      agent.canonicalAfter = await treeDigest(canonical);
      agent.archivedAfter = await treeDigest(archived);
    }
    manifest.sqliteUnchanged = true;
    manifest.state = "completed";
    manifest.completedAt = new Date().toISOString();
    await writeJson(path.join(recoveryDirectory, MANIFEST_FILE), manifest);
    return {
      ...plan,
      command: "apply",
      recovery: recoveryDirectory,
      sqliteRecovery: path.join(recoveryDirectory, manifest.sqliteRecovery.directory),
      sqliteUnchanged: true,
      archivedAgents: manifest.agents.map((agent) => agent.agentId)
    };
  } catch (error) {
    const rollback = await rollbackPreparedMigration(plan.workspace, recoveryDirectory, manifest)
      .catch((rollbackError) => ({ ok: false, error: rollbackError?.message ?? String(rollbackError) }));
    manifest.state = rollback.ok ? "failed_rolled_back" : "failed_recovery_required";
    manifest.failure = error?.message ?? String(error);
    manifest.rollback = rollback;
    await writeJson(path.join(recoveryDirectory, MANIFEST_FILE), manifest).catch(() => undefined);
    const failure = migrationError(
      "SINGLE_WORKBENCH_APPLY_FAILED",
      rollback.ok
        ? `资源迁移失败且已恢复原目录：${manifest.failure}`
        : `资源迁移失败；请使用恢复点处理：${manifest.failure}`
    );
    failure.recovery = recoveryDirectory;
    throw failure;
  }
}

export async function verifySingleWorkbenchMigration(options) {
  const workspace = await inspectWorkspace(options.workspace);
  const recoveryDirectory = await resolveRecoveryDirectory(workspace, options.recovery);
  const manifest = await readManifest(recoveryDirectory);
  if (manifest.state !== "completed") {
    throw migrationError("SINGLE_WORKBENCH_RECOVERY_INCOMPLETE", "迁移恢复点尚未完成。 ");
  }
  for (const agent of manifest.agents) {
    const canonical = path.join(workspace, "business", "agents", agent.agentId, "workbench");
    const legacy = path.join(workspace, "business", "agents", agent.agentId, "docker-workbench");
    if (await exists(legacy)) throw migrationError("SINGLE_WORKBENCH_LEGACY_PRESENT", `${agent.agentId} 旧 Workbench 仍然存在。`);
    if (stableJson(await treeDigest(canonical)) !== stableJson(agent.canonicalAfter)) {
      throw migrationError("SINGLE_WORKBENCH_CANONICAL_DRIFT", `${agent.agentId} Workbench 与迁移完成状态不一致。`);
    }
    if (stableJson(await treeDigest(path.join(recoveryDirectory, agent.archivedLegacy))) !== stableJson(agent.archivedAfter)) {
      throw migrationError("SINGLE_WORKBENCH_ARCHIVE_DRIFT", `${agent.agentId} 旧 Workbench 归档已变化。`);
    }
    await validateResourceIndexes(canonical);
  }
  return {
    ok: true,
    command: "verify",
    workspace,
    recovery: recoveryDirectory,
    sqliteUnchangedAtApply: manifest.sqliteUnchanged === true,
    agents: manifest.agents.map((agent) => agent.agentId)
  };
}

export async function rollbackSingleWorkbenchMigration(options) {
  (options.assertNonRoot ?? assertNonRoot)();
  assertQuiesced(options.quiesced);
  const workspace = await inspectWorkspace(options.workspace);
  const recoveryDirectory = await resolveRecoveryDirectory(workspace, options.recovery);
  const manifest = await readManifest(recoveryDirectory);
  if (manifest.state === "rolled_back") {
    return { ok: true, command: "rollback", alreadyRolledBack: true, recovery: recoveryDirectory };
  }
  if (manifest.state !== "completed") {
    throw migrationError("SINGLE_WORKBENCH_RECOVERY_INCOMPLETE", "只有已完成的迁移可以回滚。");
  }
  for (const agent of manifest.agents) {
    const canonical = path.join(workspace, "business", "agents", agent.agentId, "workbench");
    if (stableJson(await treeDigest(canonical)) !== stableJson(agent.canonicalAfter)) {
      throw migrationError("SINGLE_WORKBENCH_ROLLBACK_DRIFT", `${agent.agentId} Workbench 已变化，拒绝覆盖。`);
    }
  }
  const rollbackAfter = path.join(recoveryDirectory, "rollback-after", "agents");
  for (const agent of manifest.agents) {
    const agentRoot = path.join(workspace, "business", "agents", agent.agentId);
    const canonical = path.join(agentRoot, "workbench");
    const legacy = path.join(agentRoot, "docker-workbench");
    if (await exists(legacy)) throw migrationError("SINGLE_WORKBENCH_ROLLBACK_TARGET_CONFLICT", `${agent.agentId} 旧 Workbench 路径已被占用。`);
    const after = path.join(rollbackAfter, agent.agentId, "workbench");
    await fs.mkdir(path.dirname(after), { recursive: true, mode: 0o700 });
    await fs.rename(canonical, after);
    if (agent.canonicalExisted) {
      await copyTree(path.join(recoveryDirectory, agent.beforeCanonical), canonical);
    }
    await fs.rename(path.join(recoveryDirectory, agent.archivedLegacy), legacy);
  }
  manifest.state = "rolled_back";
  manifest.rolledBackAt = new Date().toISOString();
  await writeJson(path.join(recoveryDirectory, MANIFEST_FILE), manifest);
  return {
    ok: true,
    command: "rollback",
    workspace,
    recovery: recoveryDirectory,
    agents: manifest.agents.map((agent) => agent.agentId)
  };
}

export async function verifyTargetRelease(projectRoot = root) {
  const [packageManifest, packageLock] = await Promise.all([
    readJson(path.join(projectRoot, "package.json")),
    readJson(path.join(projectRoot, "package-lock.json"))
  ]);
  const versions = {
    package: packageManifest.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version
  };
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== TARGET_VERSION)
    .map(([name, version]) => `${name}=${version ?? "missing"}`);
  if (mismatches.length) {
    throw migrationError(
      "TARGET_RELEASE_MISMATCH",
      `迁移脚本需要 ${TARGET_VERSION} 代码：${mismatches.join(", ")}`
    );
  }
  return versions;
}

async function inspectWorkspace(workspaceInput) {
  if (!path.isAbsolute(workspaceInput)) throw migrationError("WORKSPACE_INVALID", "workspace 必须是绝对路径。");
  const workspace = path.normalize(workspaceInput);
  const stats = await fs.lstat(workspace);
  if (!stats.isDirectory() || stats.isSymbolicLink() || await fs.realpath(workspace) !== workspace) {
    throw migrationError("WORKSPACE_INVALID", "workspace 必须是规范普通目录。");
  }
  await assertRegularDirectory(path.join(workspace, "business", "agents"));
  return workspace;
}

async function inspectAgents(workspace) {
  const agentsRoot = path.join(workspace, "business", "agents");
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!AGENT_ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw migrationError("SINGLE_WORKBENCH_AGENT_INVALID", `Agent 目录无效：${entry.name}`);
    }
    agents.push(await inspectAgent(agentsRoot, entry.name));
  }
  return agents;
}

async function inspectAgent(agentsRoot, agentId) {
  const agentRoot = path.join(agentsRoot, agentId);
  const canonicalRoot = path.join(agentRoot, "workbench");
  const legacyRoot = path.join(agentRoot, "docker-workbench");
  const canonicalExists = await exists(canonicalRoot);
  const legacyExists = await exists(legacyRoot);
  if (canonicalExists) await assertRegularDirectory(canonicalRoot);
  if (!legacyExists) {
    return {
      agentId,
      canonicalRoot,
      legacyRoot,
      canonicalExists,
      legacyExists,
      directoriesToCreate: [],
      copies: [],
      identical: [],
      conflicts: []
    };
  }
  await assertRegularDirectory(legacyRoot);
  const sourceTree = await scanTree(legacyRoot);
  const conflicts = [];
  const copies = [];
  const identical = [];
  const directoriesToCreate = [];
  const projectionFiles = sourceTree.files.filter((entry) => (
    entry.relativePath === OBSOLETE_PROJECTION
    || entry.relativePath.startsWith(`${OBSOLETE_PROJECTION}/`)
  ));
  for (const entry of projectionFiles) {
    conflicts.push({
      relativePath: entry.relativePath,
      reason: "obsolete_projection_not_empty",
      sourceSha256: entry.sha256
    });
  }
  for (const directory of sourceTree.directories
    .filter((entry) => entry && entry !== OBSOLETE_PROJECTION && !entry.startsWith(`${OBSOLETE_PROJECTION}/`))
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
    const target = safeRelativeTarget(canonicalRoot, directory);
    const state = await pathState(target);
    if (state === "missing") directoriesToCreate.push(directory);
    else if (state !== "directory") conflicts.push({ relativePath: directory, reason: "target_not_directory" });
  }
  for (const entry of sourceTree.files.filter((file) => (
    file.relativePath !== OBSOLETE_PROJECTION
    && !file.relativePath.startsWith(`${OBSOLETE_PROJECTION}/`)
  ))) {
    const target = safeRelativeTarget(canonicalRoot, entry.relativePath);
    const state = await pathState(target);
    if (state === "missing") {
      copies.push({ ...entry, source: path.join(legacyRoot, ...entry.relativePath.split("/")), target });
      continue;
    }
    if (state !== "file") {
      conflicts.push({ relativePath: entry.relativePath, reason: "target_not_regular_file", sourceSha256: entry.sha256 });
      continue;
    }
    const targetSha256 = await sha256File(target);
    if (targetSha256 === entry.sha256) identical.push({ ...entry, targetSha256 });
    else conflicts.push({
      relativePath: entry.relativePath,
      reason: "content_mismatch",
      sourceSha256: entry.sha256,
      targetSha256
    });
  }
  return {
    agentId,
    canonicalRoot,
    legacyRoot,
    canonicalExists,
    legacyExists,
    directoriesToCreate,
    copies,
    identical,
    conflicts
  };
}

async function scanTree(rootDirectory) {
  const directories = [""];
  const files = [];
  const visit = async (directory, relativeDirectory) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) throw migrationError("SINGLE_WORKBENCH_PATH_UNSAFE", `不允许符号链接：${relativePath}`);
      if (stats.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw migrationError("SINGLE_WORKBENCH_PATH_UNSAFE", `只允许单链接普通文件：${relativePath}`);
      }
      files.push({ relativePath, bytes: stats.size, sha256: await sha256File(absolutePath) });
    }
  };
  await visit(rootDirectory, "");
  return { directories, files };
}

async function copyMissingFile(source, target, expectedSha256) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (await exists(target)) {
    if (await sha256File(target) === expectedSha256) return;
    throw migrationError("SINGLE_WORKBENCH_TARGET_CHANGED", `迁移目标已变化：${target}`);
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.part`);
  try {
    await fs.copyFile(source, temporary, fsConstants.constants.COPYFILE_EXCL);
    if (await sha256File(temporary) !== expectedSha256) {
      throw migrationError("SINGLE_WORKBENCH_COPY_INVALID", `文件复制校验失败：${source}`);
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function verifyPlannedFiles(agent) {
  for (const entry of [...agent.copies, ...agent.identical]) {
    const source = path.join(agent.legacyRoot, ...entry.relativePath.split("/"));
    const target = path.join(agent.canonicalRoot, ...entry.relativePath.split("/"));
    const [sourceSha256, targetSha256] = await Promise.all([sha256File(source), sha256File(target)]);
    if (sourceSha256 !== entry.sha256 || targetSha256 !== entry.sha256) {
      throw migrationError("SINGLE_WORKBENCH_VERIFY_FAILED", `合并后字节不一致：${entry.relativePath}`);
    }
  }
}

async function validateResourceIndexes(workbench) {
  for (const [relativePath, format] of REQUIRED_INDEXES) {
    const filePath = path.join(workbench, ...relativePath.split("/"));
    const state = await pathState(filePath);
    if (state !== "file") throw migrationError("SINGLE_WORKBENCH_INDEX_INVALID", `资源入口缺失：${relativePath}`);
    const content = await fs.readFile(filePath, "utf8");
    if (format === "markdown" && !content.trim()) {
      throw migrationError("SINGLE_WORKBENCH_INDEX_INVALID", `资源入口为空：${relativePath}`);
    }
    if (format === "json") parseJson(content, relativePath);
    if (format === "jsonl") {
      for (const [index, line] of content.split(/\r?\n/u).entries()) {
        if (line.trim()) parseJson(line, `${relativePath}:${index + 1}`);
      }
    }
  }
}

async function rollbackPreparedMigration(workspace, recoveryDirectory, manifest) {
  for (const agent of [...manifest.agents].reverse()) {
    const agentRoot = path.join(workspace, "business", "agents", agent.agentId);
    const canonical = path.join(agentRoot, "workbench");
    const legacy = path.join(agentRoot, "docker-workbench");
    const archived = path.join(recoveryDirectory, agent.archivedLegacy);
    if (await exists(archived) && !await exists(legacy)) await fs.rename(archived, legacy);
    const beforeCanonical = path.join(recoveryDirectory, agent.beforeCanonical);
    if (agent.canonicalExisted) {
      await fs.rm(canonical, { recursive: true, force: true });
      await copyTree(beforeCanonical, canonical);
    } else {
      await fs.rm(canonical, { recursive: true, force: true });
    }
  }
  return { ok: true };
}

async function snapshotSqliteFiles(workspace) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stats = await fs.lstat(candidate);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (path.relative(workspace, candidate).startsWith(`backups${path.sep}`)) continue;
        await visit(candidate);
      } else if (stats.isFile() && entry.name.endsWith(".sqlite")) {
        files.push({
          path: path.relative(workspace, candidate).split(path.sep).join("/"),
          bytes: stats.size,
          sha256: await sha256File(candidate)
        });
      }
    }
  };
  await visit(workspace);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function treeDigest(directory) {
  const tree = await scanTree(directory);
  return {
    directories: tree.directories,
    files: tree.files
  };
}

async function copyTree(source, target) {
  await assertRegularDirectory(source);
  if (await exists(target)) throw migrationError("SINGLE_WORKBENCH_RECOVERY_CONFLICT", `恢复目标已存在：${target}`);
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
}

async function writeConflictReport(plan, nowInput) {
  const now = dateFrom(nowInput);
  const directory = path.join(plan.workspace, MIGRATION_ROOT, "conflicts");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const report = path.join(directory, `conflicts-${timestamp(now)}-${crypto.randomUUID().slice(0, 8)}.json`);
  await writeJson(report, {
    schemaVersion: 1,
    fromVersion: FROM_VERSION,
    targetVersion: TARGET_VERSION,
    createdAt: now.toISOString(),
    workspace: plan.workspace,
    resourceDirectoriesModified: false,
    sqliteModified: false,
    conflicts: plan.conflicts
  });
  return report;
}

async function latestCompletedRecovery(workspace) {
  const directory = path.join(workspace, MIGRATION_ROOT);
  if (!await exists(directory)) return null;
  const candidates = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("recovery-")) continue;
    const recovery = path.join(directory, entry.name);
    try {
      const manifest = await readManifest(recovery);
      if (manifest.state === "completed") candidates.push({ directory: recovery, manifest });
    } catch {
      // Incomplete recovery points remain available for manual inspection.
    }
  }
  return candidates.sort((left, right) => right.directory.localeCompare(left.directory))[0] ?? null;
}

async function resolveRecoveryDirectory(workspace, input) {
  if (input) {
    const resolved = path.resolve(input);
    const migrationRoot = path.join(workspace, MIGRATION_ROOT);
    if (resolved !== migrationRoot && !resolved.startsWith(`${migrationRoot}${path.sep}`)) {
      throw migrationError("SINGLE_WORKBENCH_RECOVERY_INVALID", "恢复点必须位于当前 workspace 的升级目录。");
    }
    return resolved;
  }
  const latest = await latestCompletedRecovery(workspace);
  if (!latest) throw migrationError("SINGLE_WORKBENCH_RECOVERY_MISSING", "没有可用的已完成迁移恢复点。");
  return latest.directory;
}

async function readManifest(recoveryDirectory) {
  const state = await pathState(recoveryDirectory);
  if (state !== "directory") throw migrationError("SINGLE_WORKBENCH_RECOVERY_INVALID", "迁移恢复点不可用。");
  const manifest = await readJson(path.join(recoveryDirectory, MANIFEST_FILE));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.agents)) {
    throw migrationError("SINGLE_WORKBENCH_RECOVERY_INVALID", "迁移恢复点 manifest 无效。");
  }
  return manifest;
}

function publicAgentPlan(agent) {
  return {
    agentId: agent.agentId,
    legacyExists: agent.legacyExists,
    canonicalExists: agent.canonicalExists,
    copyFiles: agent.copies.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
    identicalFiles: agent.identical.map(({ relativePath, bytes, sha256 }) => ({ relativePath, bytes, sha256 })),
    conflicts: agent.conflicts
  };
}

function parseArguments(argv) {
  const [command = "help", ...tokens] = argv;
  if (!["plan", "apply", "verify", "rollback", "help"].includes(command)) {
    throw migrationError("ARGUMENT_INVALID", `未知命令：${command}`);
  }
  let workspace = process.env.SUNABOT_WORKSPACE ?? path.join(root, "workspace");
  let recovery;
  let quiesced = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--quiesced") {
      quiesced = true;
      continue;
    }
    if ((token === "--workspace" || token === "--recovery") && tokens[index + 1]) {
      if (token === "--workspace") workspace = tokens[index + 1];
      else recovery = tokens[index + 1];
      index += 1;
      continue;
    }
    throw migrationError("ARGUMENT_INVALID", `无法识别参数：${token}`);
  }
  if (!path.isAbsolute(workspace) || (recovery && !path.isAbsolute(recovery))) {
    throw migrationError("ARGUMENT_INVALID", "workspace 和 recovery 必须是绝对路径。");
  }
  return { command, workspace: path.normalize(workspace), recovery, quiesced };
}

function assertQuiesced(quiesced) {
  if (quiesced !== true) {
    throw migrationError(
      "SINGLE_WORKBENCH_QUIESCENCE_REQUIRED",
      "apply 与 rollback 只能在 Core、NapCat 和管理台全部停止后使用 --quiesced 执行。"
    );
  }
}

function assertNonRoot() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw migrationError("ROOT_EXECUTION_FORBIDDEN", "迁移必须由拥有 workspace 的非 root 用户执行。");
  }
}

async function assertRegularDirectory(directory) {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw migrationError("SINGLE_WORKBENCH_PATH_UNSAFE", `必须是普通目录：${directory}`);
  }
}

async function pathState(candidate) {
  try {
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile() && stats.nlink === 1) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function exists(candidate) {
  return await pathState(candidate) !== "missing";
}

function safeRelativeTarget(rootDirectory, relativePath) {
  const target = path.resolve(rootDirectory, ...relativePath.split("/"));
  const relative = path.relative(rootDirectory, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw migrationError("SINGLE_WORKBENCH_PATH_UNSAFE", `相对路径无效：${relativePath}`);
  }
  return target;
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.part`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function parseJson(content, label) {
  try {
    return JSON.parse(content);
  } catch {
    throw migrationError("SINGLE_WORKBENCH_INDEX_INVALID", `资源入口 JSON 无效：${label}`);
  }
}

function recoveryPointId(now) {
  return `recovery-${timestamp(now)}-${crypto.randomUUID().slice(0, 8)}`;
}

function timestamp(now) {
  return now.toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
}

function dateFrom(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw migrationError("ARGUMENT_INVALID", "迁移时间无效。");
  return date;
}

function stableJson(value) {
  return JSON.stringify(value);
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function usage() {
  return `用法：
  ./sunabot.sh upgrade-0.3.0 plan [--workspace /absolute/path]
  ./sunabot.sh upgrade-0.3.0 apply --quiesced [--workspace /absolute/path]
  ./sunabot.sh upgrade-0.3.0 verify [--workspace /absolute/path] [--recovery /absolute/path]
  ./sunabot.sh upgrade-0.3.0 rollback --quiesced [--workspace /absolute/path] [--recovery /absolute/path]

plan 逐文件检查 docker-workbench 与 canonical workbench；apply 仅合并缺失或字节相同文件，
创建全 Agent SQLite 与资源恢复点后归档旧根；verify 校验完成状态；rollback 恢复迁移前目录。`;
}
