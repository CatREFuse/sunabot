#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { resolveProjectRoot } from "../shared/paths.mjs";
import {
  databasePathOverrideConfigured,
  envValue,
  workspaceIdentity
} from "../runtime/launcher-core.mjs";
import { createRecoveryPoint, verifyRecoveryPoint } from "../workspace/sqlite-recovery.mjs";
import {
  inspectMultiAgentMigrationGate,
  sha256File as sha256GateFile,
  sha256Json,
  writeCompletedMigrationMarker
} from "../../packages/platform/multiAgentMigrationGate.mjs";

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const CONFIG_RELATIVE = "business/config/sunabot.json";
const MAIN_DATABASE_RELATIVE = "business/data/sunabot.sqlite";
const QUEUE_DATABASE_RELATIVE = "business/data/session-queue.sqlite";
const AGENT_MANIFEST_RELATIVE = "business/agents/plana/agent.json";
const SYSTEM_PROMPT_ROOT_RELATIVE = "business/prompts";
const PRIMARY_RUNTIME_RELATIVE = "runtime/napcat/accounts/primary";
const REPORT_FILE = "single-agent-to-multi-agent.json";
const MUTABLE_MAIN_TABLES = new Set([
  "app_metadata",
  "agents",
  "agent_accounts",
  "model_call_aggregates",
  "model_call_model_aggregates"
]);
const LEGACY_LAYOUT_MARKERS = [
  "config/sunabot.json",
  "agents",
  "artifacts/sunabot.sqlite",
  "artifacts/session-queue.sqlite",
  "security",
  "napcat",
  ".env"
];
const LEGACY_JSON_MARKERS = [
  "business/data/legacy/conversations.json",
  "business/data/legacy/request-bodies.jsonl",
  "business/data/legacy/image-history.json",
  "business/data/legacy/memory-scheduler.json",
  "business/agents/plana/WORKING_MEMORY.jsonl",
  "business/agents/plana/LONG_TERM_MEMORY.jsonl",
  "business/agents/plana/USER_PROFILE.jsonl"
];
const RUNTIME_MAPPINGS = [
  ["runtime/napcat/config-full", `${PRIMARY_RUNTIME_RELATIVE}/config-full`],
  ["runtime/napcat/qq", `${PRIMARY_RUNTIME_RELATIVE}/qq`],
  ["runtime/napcat/plugins", `${PRIMARY_RUNTIME_RELATIVE}/plugins`],
  ["runtime/napcat/qrcode.png", `${PRIMARY_RUNTIME_RELATIVE}/qrcode.png`],
  ["runtime/napcat/manual-login-required", `${PRIMARY_RUNTIME_RELATIVE}/manual-login-required`]
];

export class SingleAgentMigrationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SingleAgentMigrationError";
    this.code = code;
    this.details = details;
  }
}

export async function inspectSingleAgentMigration(workspaceInput) {
  const migrationGate = await inspectMultiAgentMigrationGate(workspaceInput);
  const workspace = migrationGate.workspace;
  await assertWorkspaceDirectory(workspace);
  await assertStandardDatabasePath(workspace);
  const configPath = path.join(workspace, CONFIG_RELATIVE);
  const mainDatabasePath = path.join(workspace, MAIN_DATABASE_RELATIVE);
  const queueDatabasePath = path.join(workspace, QUEUE_DATABASE_RELATIVE);
  await assertMigrationPrerequisites(workspace, configPath, mainDatabasePath, queueDatabasePath);

  const config = await readJson(configPath, "CONFIG_INVALID");
  const configuredAgentId = String(config?.persona?.defaultAgentId ?? "plana").trim() || "plana";
  if (configuredAgentId !== "plana") {
    throw new SingleAgentMigrationError(
      "DEFAULT_AGENT_UNSUPPORTED",
      `单 Agent 迁移只接受默认 Agent plana；当前值为 ${configuredAgentId}。`
    );
  }
  if (String(config?.persona?.agentWorkspace ?? "").replaceAll("\\", "/") !== "workspace/business/agents/plana") {
    throw new SingleAgentMigrationError(
      "AGENT_WORKSPACE_UNSUPPORTED",
      "单 Agent 迁移要求 Plana 使用 workspace/business/agents/plana。"
    );
  }
  if (String(config?.persona?.systemPromptWorkspace ?? "workspace/business/prompts").replaceAll("\\", "/") !== "workspace/business/prompts") {
    throw new SingleAgentMigrationError(
      "SYSTEM_PROMPT_WORKSPACE_UNSUPPORTED",
      "单 Agent 迁移要求公共系统提示词使用 workspace/business/prompts。"
    );
  }
  const prompts = await inspectSystemPrompts(workspace, config);

  const main = inspectDatabase(mainDatabasePath);
  const queue = inspectDatabase(queueDatabasePath);
  const registry = inspectRegistry(mainDatabasePath, main.tables);
  validateRegistryState(registry);
  const manifest = await inspectAgentManifest(path.join(workspace, AGENT_MANIFEST_RELATIVE));
  const runtimeDirectoriesReady = await allDirectories([
    path.join(workspace, PRIMARY_RUNTIME_RELATIVE, "config-full"),
    path.join(workspace, PRIMARY_RUNTIME_RELATIVE, "qq"),
    path.join(workspace, PRIMARY_RUNTIME_RELATIVE, "plugins")
  ]);
  const registryReady = Boolean(registry.plana && registry.primary);
  const structuralReady = registryReady && manifest.exists && runtimeDirectoriesReady;
  if (!structuralReady && prompts.divergent.length > 0) {
    throw new SingleAgentMigrationError(
      "SYSTEM_PROMPT_TARGET_CONFLICT",
      "公共系统提示词目录中已有与单 Agent 提示词不同的文件。",
      { paths: prompts.divergent.map((entry) => entry.destination) }
    );
  }
  const identity = await inspectPrimaryIdentity(workspace, registry.primary, structuralReady);
  const identityReady = !identity.desiredQqId || (
    registry.primary?.qqId === identity.desiredQqId && identity.accountEnvQqId === identity.desiredQqId
  );
  const structureComplete = structuralReady && identityReady && prompts.missing.length === 0;
  const runtime = await inspectRuntimeMappings(workspace, { allowDivergence: structuralReady });
  const markerReady = migrationGate.state === "trusted";
  const plannedChanges = [];
  if (!main.tables.agents || !main.tables.agent_accounts) plannedChanges.push("创建 Agent 与 QQ 账号注册表");
  if (!registry.plana) plannedChanges.push("登记 Plana Agent");
  if (!registry.primary) plannedChanges.push("登记 primary QQ 接入");
  if (!manifest.exists) plannedChanges.push("创建 Plana agent.json");
  if (!structuralReady && (!runtimeDirectoriesReady || runtime.missing.length > 0)) {
    plannedChanges.push("复制旧 NapCat 状态到 primary 账号目录");
  }
  if (!identityReady && identity.desiredQqId) plannedChanges.push("回填 primary QQ 身份");
  if (prompts.missing.length > 0) plannedChanges.push("复制现有系统提示词到公共目录");
  if (!markerReady) plannedChanges.push("写入绑定恢复点与迁移报告的完成标记");

  return {
    workspace,
    configPath,
    mainDatabasePath,
    queueDatabasePath,
    state: structureComplete && markerReady ? "already-migrated" : "ready",
    target: {
      agentId: "plana",
      agentWorkspace: "workspace/business/agents/plana",
      accountId: "primary",
      webuiPort: 6099
    },
    checks: {
      mainDatabase: databaseSummary(main),
      queueDatabase: databaseSummary(queue),
      registryReady,
      manifestReady: manifest.exists,
      runtimeDirectoriesReady,
      primaryQqIdentityDetected: Boolean(identity.desiredQqId),
      primaryQqIdentityReady: identityReady,
      systemPromptsReady: prompts.missing.length === 0,
      migrationMarkerReady: markerReady,
      legacyRuntimeEntries: runtime.entries.length,
      runtimeEntriesToCopy: structuralReady ? 0 : runtime.missing.length,
      legacyRuntimeDivergences: runtime.divergent.length
    },
    plannedChanges,
    baseline: { main, queue },
    registry,
    runtime,
    identity,
    prompts,
    structureComplete,
    migrationGate,
    runtimeCopyRequired: !structuralReady,
    createdPaths: [
      ...(!manifest.exists ? [AGENT_MANIFEST_RELATIVE] : []),
      ...(!structuralReady ? runtime.missing.map((entry) => entry.destination) : []),
      ...prompts.missing.map((entry) => entry.destination),
      ...(identity.desiredQqId && !identity.accountEnvExists ? [`${PRIMARY_RUNTIME_RELATIVE}/account.env`] : [])
    ]
  };
}

export async function migrateSingleAgentToMultiAgent(options) {
  const inspection = await inspectSingleAgentMigration(options.workspace);
  if (options.apply !== true) return publicResult(inspection, "dry-run");
  if (inspection.state === "already-migrated") return publicResult(inspection, "already-migrated");
  if (options.quiesced !== true) {
    throw new SingleAgentMigrationError(
      "QUIESCENCE_REQUIRED",
      "执行迁移前必须停止 Sunabot 与 NapCat，并显式传入 --quiesced。"
    );
  }
  if (!options.allowRoot && typeof process.getuid === "function" && process.getuid() === 0) {
    throw new SingleAgentMigrationError("ROOT_FORBIDDEN", "迁移必须由拥有仓库和 workspace 的非 root 用户执行。");
  }
  if (!options.skipServiceCheck) {
    await assertServicesStopped(
      inspection.workspace,
      inspection.configPath,
      inspection.registry.accounts,
      options.listRunningContainers
    );
  }

  const recovery = await createRecoveryPoint({
    workspace: inspection.workspace,
    backupsRoot: options.backupsRoot,
    quiesced: true,
    now: options.now,
    busyTimeoutMs: options.busyTimeoutMs
  });
  await verifyRecoveryPoint(recovery.directory);

  try {
    await materializeMissingSystemPrompts(inspection.workspace, inspection.prompts.missing);
    const initialize = options.initialize ?? initializeWithBuiltApplication;
    await initialize({
      workspace: inspection.workspace,
      configPath: inspection.configPath,
      projectRoot: PROJECT_ROOT
    });
    await synchronizePrimaryIdentity(
      inspection.mainDatabasePath,
      path.join(inspection.workspace, PRIMARY_RUNTIME_RELATIVE, "account.env"),
      inspection.identity.desiredQqId,
      options.now ?? new Date()
    );
    const completed = await inspectSingleAgentMigration(inspection.workspace);
    if (!completed.structureComplete) {
      throw new SingleAgentMigrationError("MIGRATION_INCOMPLETE", "迁移完成后仍缺少多 Agent 注册或 primary 运行目录。");
    }
    assertPreservedCounts(inspection.baseline.main, completed.baseline.main, MUTABLE_MAIN_TABLES, "主库");
    assertPreservedCounts(inspection.baseline.queue, completed.baseline.queue, new Set(), "会话队列库");
    if (inspection.runtimeCopyRequired) {
      await verifyRuntimeCopies(inspection.workspace, inspection.runtime.entries);
    }
    await verifyPreservedRuntimeDivergences(inspection.workspace, inspection.runtime.divergent);

    const report = {
      schemaVersion: 1,
      status: "completed",
      migratedAt: (options.now ?? new Date()).toISOString(),
      workspace: inspection.workspace,
      recoveryPoint: recovery.directory,
      target: completed.target,
      createdPaths: inspection.createdPaths,
      preservedCounts: {
        before: {
          main: inspection.baseline.main.tables,
          queue: inspection.baseline.queue.tables
        },
        after: {
          main: completed.baseline.main.tables,
          queue: completed.baseline.queue.tables
        }
      },
      copiedRuntimeEntries: (inspection.runtimeCopyRequired ? inspection.runtime.missing : [])
        .map(runtimeEvidence),
      preservedRuntimeDivergences: inspection.runtime.divergent.map(runtimeDivergenceEvidence),
      copiedSystemPrompts: completed.prompts.entries.filter((entry) => (
        inspection.prompts.missing.some((missing) => missing.destination === entry.destination)
      )).map((entry) => ({
        destination: entry.destination,
        sha256: entry.destinationSha256
      })),
      preservedSystemPromptDivergences: inspection.prompts.divergent.map((entry) => ({
        destination: entry.destination,
        sourceSha256: entry.sourceSha256,
        destinationSha256: entry.destinationSha256
      })),
      verification: {
        mainIntegrity: completed.baseline.main.integrity,
        queueIntegrity: completed.baseline.queue.integrity,
        foreignKeys: "ok",
        runtimeHashes: "ok",
        systemPromptHashes: "ok"
      }
    };
    const reportPath = path.join(recovery.directory, REPORT_FILE);
    await atomicWriteJson(reportPath, report);
    await writeCompletedMigrationMarker({
      workspace: inspection.workspace,
      completedAt: options.now ?? new Date(),
      recoveryPointId: path.basename(recovery.directory),
      recoveryManifestSha256: await sha256GateFile(path.join(recovery.directory, "manifest.json")),
      reportSha256: await sha256GateFile(reportPath),
      sourceStateSha256: sha256Json({
        main: inspection.baseline.main.tables,
        queue: inspection.baseline.queue.tables,
        runtime: {
          entries: inspection.runtime.entries,
          divergences: inspection.runtime.divergent.map(runtimeDivergenceEvidence)
        },
        prompts: inspection.prompts.entries,
        identity: inspection.identity
      }),
      target: inspection.target
    });
    const sealed = {
      ...completed,
      state: "already-migrated",
      checks: { ...completed.checks, migrationMarkerReady: true }
    };
    return {
      ...publicResult(sealed, "applied"),
      recoveryPoint: recovery.directory,
      reportPath,
      createdPaths: inspection.createdPaths
    };
  } catch (error) {
    const failure = normalizeError(error);
    failure.details = { ...failure.details, recoveryPoint: recovery.directory };
    await atomicWriteJson(path.join(recovery.directory, REPORT_FILE), {
      schemaVersion: 1,
      status: "failed",
      failedAt: new Date().toISOString(),
      workspace: inspection.workspace,
      recoveryPoint: recovery.directory,
      error: { code: failure.code, message: failure.message }
    }).catch(() => undefined);
    throw failure;
  }
}

async function inspectSystemPrompts(workspace, config) {
  const fileNames = systemPromptFileNames(config);
  const entries = await Promise.all(fileNames.map(async (fileName) => {
    let source = path.posix.join("business/agents/plana", fileName);
    const destination = path.posix.join(SYSTEM_PROMPT_ROOT_RELATIVE, fileName);
    let sourcePath = path.join(workspace, source);
    const destinationPath = path.join(workspace, destination);
    await assertMigrationPathSafe(workspace, sourcePath, "file");
    await assertMigrationPathSafe(workspace, destinationPath, "file");
    let sourceSha256 = await optionalFileHash(sourcePath);
    if (!sourceSha256 && ["conversation_private_reply.json", "conversation_group_reply.json"].includes(fileName)) {
      source = "business/agents/plana/conversation_reply.json";
      sourcePath = path.join(workspace, source);
      await assertMigrationPathSafe(workspace, sourcePath, "file");
      sourceSha256 = await optionalFileHash(sourcePath);
    }
    const destinationSha256 = await optionalFileHash(destinationPath);
    return { source, destination, sourceSha256, destinationSha256 };
  }));
  return {
    entries,
    missing: entries.filter((entry) => !entry.destinationSha256),
    divergent: entries.filter((entry) => (
      entry.sourceSha256 && entry.destinationSha256 && entry.sourceSha256 !== entry.destinationSha256
    ))
  };
}

async function materializeMissingSystemPrompts(workspace, entries) {
  for (const entry of entries) {
    if (!entry.sourceSha256) continue;
    const sourcePath = path.join(workspace, entry.source);
    const destinationPath = path.join(workspace, entry.destination);
    await assertMigrationPathSafe(workspace, sourcePath, "file");
    await assertMigrationPathSafe(workspace, destinationPath, "file");
    if (await sha256File(sourcePath) !== entry.sourceSha256) {
      throw new SingleAgentMigrationError(
        "SYSTEM_PROMPT_SOURCE_CHANGED",
        `迁移预检后系统提示词发生变化：${entry.source}。`
      );
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    try {
      await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST" || await optionalFileHash(destinationPath) !== entry.sourceSha256) {
        throw new SingleAgentMigrationError(
          "SYSTEM_PROMPT_TARGET_CONFLICT",
          `系统提示词迁移目标已存在且内容不同：${entry.destination}。`
        );
      }
    }
    if (await sha256File(destinationPath) !== entry.sourceSha256) {
      throw new SingleAgentMigrationError(
        "SYSTEM_PROMPT_COPY_VERIFICATION_FAILED",
        `系统提示词复制校验失败：${entry.destination}。`
      );
    }
  }
}

async function assertMigrationPathSafe(workspace, filePath, leafKind) {
  const relative = path.relative(workspace, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SingleAgentMigrationError("MIGRATION_PATH_INVALID", `迁移路径越界：${filePath}。`);
  }
  let current = workspace;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      const expected = index === segments.length - 1 ? leafKind : "directory";
      if (stat.isSymbolicLink() || (expected === "file" ? !stat.isFile() : !stat.isDirectory())) {
        throw new SingleAgentMigrationError("MIGRATION_PATH_INVALID", `迁移路径包含无效或符号链接组件：${current}。`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

function systemPromptFileNames(config) {
  const values = [
    "conversation_reply.json",
    "conversation_private_reply.json",
    "conversation_group_reply.json",
    config?.bot?.memory?.workMemoryCompressInPrompt ?? "work_memory_compress_in.json",
    config?.bot?.memory?.workMemoryCompressOutPrompt ?? "work_memory_compress_out.json",
    config?.bot?.memory?.userProfilePrompt ?? "user_profile_prompt.json",
    config?.bot?.orchestrator?.promptFile ?? "user_groupchat_orchestrator.json",
    "group_chat_summary.json"
  ];
  return [...new Set(values.map((value) => safePromptFileName(value)))];
}

function safePromptFileName(value) {
  const fileName = String(value ?? "").trim().replaceAll("\\", "/");
  if (!fileName || fileName.startsWith("/") || fileName.split("/").includes("..")) {
    throw new SingleAgentMigrationError("SYSTEM_PROMPT_PATH_INVALID", `系统提示词路径无效：${fileName || "空路径"}。`);
  }
  return fileName;
}

async function optionalFileHash(filePath) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new SingleAgentMigrationError("SYSTEM_PROMPT_PATH_INVALID", `${filePath} 不是普通文件。`);
    }
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function initializeWithBuiltApplication({ workspace, configPath, projectRoot }) {
  const previousWorkspace = process.env.SUNABOT_WORKSPACE;
  const previousConfig = process.env.SUNABOT_CONFIG;
  process.env.SUNABOT_WORKSPACE = workspace;
  process.env.SUNABOT_CONFIG = configPath;
  try {
    const configModule = await importBuilt(projectRoot, "dist/src/config.js");
    const storeModule = await importBuilt(projectRoot, "dist/adapters/sqlite/applicationDataStore.js");
    const registryModule = await importBuilt(projectRoot, "dist/services/agents/agentRegistry.js");
    const config = await configModule.loadConfig();
    const store = storeModule.applicationDataStore(config);
    try {
      const registry = new registryModule.AgentRegistry(config, { store, allowUnmarkedMigration: true });
      await registry.initialize();
      store.checkpoint();
    } finally {
      storeModule.closeApplicationDataStores();
    }
  } finally {
    restoreEnvironment("SUNABOT_WORKSPACE", previousWorkspace);
    restoreEnvironment("SUNABOT_CONFIG", previousConfig);
  }
}

async function importBuilt(projectRoot, relativePath) {
  const filePath = path.join(projectRoot, relativePath);
  try {
    await fs.access(filePath);
  } catch {
    throw new SingleAgentMigrationError(
      "BUILD_REQUIRED",
      `缺少 ${relativePath}；请通过 npm run migrate:multi-agent 执行迁移。`
    );
  }
  return import(pathToFileURL(filePath).href);
}

async function assertMigrationPrerequisites(workspace, configPath, mainDatabasePath, queueDatabasePath) {
  const [configExists, mainExists, queueExists] = await Promise.all([
    exists(configPath),
    exists(mainDatabasePath),
    exists(queueDatabasePath)
  ]);
  if (!mainExists || !queueExists) {
    const legacyLayout = await existingRelativePaths(workspace, LEGACY_LAYOUT_MARKERS);
    if (legacyLayout.length > 0) {
      throw new SingleAgentMigrationError(
        "WORKSPACE_LAYOUT_MIGRATION_REQUIRED",
        "检测到旧 workspace 布局；请停服后先运行 npm run workspace:migrate。",
        { paths: legacyLayout }
      );
    }
    const legacyJson = await existingRelativePaths(workspace, LEGACY_JSON_MARKERS);
    if (legacyJson.length > 0) {
      throw new SingleAgentMigrationError(
        "SQLITE_MIGRATION_REQUIRED",
        "检测到旧 JSON/JSONL 业务数据；请停服后先运行 npm run migrate:sqlite。",
        { paths: legacyJson }
      );
    }
    throw new SingleAgentMigrationError(
      "SOURCE_DATABASE_MISSING",
      `缺少迁移源数据库：${!mainExists ? MAIN_DATABASE_RELATIVE : QUEUE_DATABASE_RELATIVE}。`
    );
  }
  if (!configExists) {
    throw new SingleAgentMigrationError("CONFIG_MISSING", `缺少 ${CONFIG_RELATIVE}。`);
  }
}

function inspectDatabase(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
  try {
    const integrity = String(database.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "");
    if (integrity !== "ok") {
      throw new SingleAgentMigrationError("DATABASE_INTEGRITY_FAILED", `${filePath} integrity_check 未通过。`);
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length > 0) {
      throw new SingleAgentMigrationError(
        "DATABASE_FOREIGN_KEY_FAILED",
        `${filePath} 存在 ${foreignKeyViolations.length} 条外键错误。`
      );
    }
    const tableNames = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
    const tables = Object.fromEntries(tableNames.map((name) => [name, countTable(database, name)]));
    return { filePath, integrity, foreignKeyViolations: 0, tables };
  } finally {
    database.close();
  }
}

function inspectRegistry(mainDatabasePath, tables) {
  const database = new DatabaseSync(mainDatabasePath, { readOnly: true, timeout: 5_000 });
  try {
    const agents = tables.agents == null ? [] : database.prepare(`
      SELECT id, name, workspace FROM agents ORDER BY id
    `).all().map((row) => ({ id: String(row.id), name: String(row.name), workspace: String(row.workspace) }));
    const accounts = tables.agent_accounts == null ? [] : database.prepare(`
      SELECT id, agent_id, qq_id, webui_port FROM agent_accounts ORDER BY id
    `).all().map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      qqId: row.qq_id == null ? undefined : String(row.qq_id),
      webuiPort: Number(row.webui_port)
    }));
    return {
      agents,
      accounts,
      plana: agents.find((agent) => agent.id === "plana"),
      primary: accounts.find((account) => account.id === "primary")
    };
  } finally {
    database.close();
  }
}

function validateRegistryState(registry) {
  if (registry.plana && registry.plana.workspace !== "workspace/business/agents/plana") {
    throw new SingleAgentMigrationError(
      "AGENT_REGISTRY_CONFLICT",
      `plana 已登记到其他 workspace：${registry.plana.workspace}。`
    );
  }
  if (registry.primary && (registry.primary.agentId !== "plana" || registry.primary.webuiPort !== 6099)) {
    throw new SingleAgentMigrationError(
      "ACCOUNT_REGISTRY_CONFLICT",
      "primary 账号的 Agent 或 WebUI 端口与迁移目标冲突。"
    );
  }
  const otherState = registry.agents.some((agent) => agent.id !== "plana")
    || registry.accounts.some((account) => account.id !== "primary");
  if (otherState && (!registry.plana || !registry.primary)) {
    throw new SingleAgentMigrationError(
      "MULTI_AGENT_STATE_CONFLICT",
      "注册表已包含其他 Agent 或 QQ 账号，但 Plana/primary 基线不完整。"
    );
  }
}

async function inspectAgentManifest(filePath) {
  if (!(await exists(filePath))) return { exists: false };
  const manifest = await readJson(filePath, "AGENT_MANIFEST_INVALID");
  if (manifest?.schemaVersion !== 1 || manifest?.id !== "plana" || !manifest?.bot || !manifest?.onebot) {
    throw new SingleAgentMigrationError("AGENT_MANIFEST_INVALID", `${filePath} 不是有效的 Plana manifest。`);
  }
  return { exists: true };
}

async function inspectPrimaryIdentity(workspace, primary, structuralReady) {
  const sourceQqIds = new Set();
  for (const relative of ["secrets/runtime.env", "runtime/napcat/account.env"]) {
    for (const qqId of await readNapcatAccountIds(path.join(workspace, relative))) sourceQqIds.add(qqId);
  }
  if (sourceQqIds.size > 1) {
    throw new SingleAgentMigrationError(
      "LEGACY_ACCOUNT_IDENTITY_CONFLICT",
      "旧运行配置包含多个不同的 NAPCAT_ACCOUNT，无法确定 primary QQ。"
    );
  }
  const sourceQqId = [...sourceQqIds][0];
  const accountEnvPath = path.join(workspace, PRIMARY_RUNTIME_RELATIVE, "account.env");
  const accountEnvExists = await exists(accountEnvPath);
  const accountEnvIds = await readNapcatAccountIds(accountEnvPath);
  if (accountEnvIds.length > 1) {
    throw new SingleAgentMigrationError(
      "ACCOUNT_IDENTITY_CONFLICT",
      "primary account.env 包含多个不同的 NAPCAT_ACCOUNT。"
    );
  }
  const accountEnvQqId = accountEnvIds[0];
  const registeredQqId = primary?.qqId;
  if (registeredQqId && accountEnvQqId && registeredQqId !== accountEnvQqId) {
    throw new SingleAgentMigrationError(
      "ACCOUNT_IDENTITY_CONFLICT",
      "primary 注册 QQ 与 account.env 不一致。"
    );
  }
  if (!structuralReady && registeredQqId && sourceQqId && registeredQqId !== sourceQqId) {
    throw new SingleAgentMigrationError(
      "LEGACY_ACCOUNT_IDENTITY_CONFLICT",
      "待迁移的 primary 注册 QQ 与旧 NAPCAT_ACCOUNT 不一致。"
    );
  }
  if (!registeredQqId && accountEnvQqId && sourceQqId && accountEnvQqId !== sourceQqId) {
    throw new SingleAgentMigrationError(
      "LEGACY_ACCOUNT_IDENTITY_CONFLICT",
      "primary account.env 与旧 NAPCAT_ACCOUNT 不一致。"
    );
  }
  return {
    desiredQqId: registeredQqId ?? accountEnvQqId ?? sourceQqId,
    sourceQqId,
    accountEnvQqId,
    accountEnvExists
  };
}

async function synchronizePrimaryIdentity(databasePath, accountEnvPath, legacyQqId, now) {
  const database = new DatabaseSync(databasePath, { timeout: 5_000 });
  let qqId;
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const primary = database.prepare("SELECT qq_id FROM agent_accounts WHERE id = ?").get("primary");
    if (!primary) throw new SingleAgentMigrationError("MIGRATION_INCOMPLETE", "primary QQ 接入未登记。");
    const registeredQqId = primary.qq_id == null ? undefined : String(primary.qq_id);
    if (registeredQqId && legacyQqId && registeredQqId !== legacyQqId) {
      throw new SingleAgentMigrationError(
        "LEGACY_ACCOUNT_IDENTITY_CONFLICT",
        "primary 注册 QQ 与旧 NAPCAT_ACCOUNT 不一致。"
      );
    }
    qqId = registeredQqId ?? legacyQqId;
    if (!qqId) return;
    const duplicate = database.prepare("SELECT id FROM agent_accounts WHERE qq_id = ? AND id <> ?").get(qqId, "primary");
    if (duplicate) {
      throw new SingleAgentMigrationError("ACCOUNT_IDENTITY_CONFLICT", "旧 QQ 已绑定其他接入账号。");
    }
    if (!registeredQqId) {
      database.prepare("UPDATE agent_accounts SET qq_id = ?, updated_at = ? WHERE id = ?")
        .run(qqId, now.toISOString(), "primary");
    }
  } finally {
    database.close();
  }
  await atomicWriteText(accountEnvPath, `NAPCAT_ACCOUNT=${qqId}\n`);
}

async function readNapcatAccountIds(filePath) {
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const matches = [...source.matchAll(
    /^[ \t]*(?:export[ \t]+)?NAPCAT_ACCOUNT[ \t]*=[ \t]*["']?(\d{5,20})["']?[ \t]*$/gm
  )].map((match) => match[1]);
  return [...new Set(matches)];
}

async function inspectRuntimeMappings(workspace, options = {}) {
  const entries = [];
  const missing = [];
  const divergent = [];
  for (const [sourceRelative, destinationRelative] of RUNTIME_MAPPINGS) {
    const source = path.join(workspace, sourceRelative);
    if (!(await exists(source))) continue;
    const snapshots = await snapshotTree(source);
    for (const snapshot of snapshots) {
      const destination = snapshot.relative
        ? path.join(destinationRelative, snapshot.relative).replace(/\\/g, "/")
        : destinationRelative;
      const targetPath = path.join(workspace, destination);
      const target = await snapshotEntry(targetPath);
      const entry = { ...snapshot, source: sourceRelative, destination };
      entries.push(entry);
      if (!target) {
        missing.push(entry);
        continue;
      }
      if (target.kind !== snapshot.kind || target.sha256 !== snapshot.sha256) {
        if (options.allowDivergence) {
          divergent.push({ ...entry, destinationSnapshot: target });
          continue;
        }
        throw new SingleAgentMigrationError(
          "MIGRATION_TARGET_CONFLICT",
          `迁移目标已存在且内容不同：${destination}。`
        );
      }
    }
  }
  return { entries, missing, divergent };
}

async function snapshotTree(root) {
  const output = [];
  async function visit(filePath, relative) {
    const snapshot = await snapshotEntry(filePath);
    if (!snapshot) return;
    output.push({ ...snapshot, relative: relative.replace(/\\/g, "/") });
    if (snapshot.kind !== "directory") return;
    const children = await fs.readdir(filePath);
    for (const child of children.sort()) await visit(path.join(filePath, child), path.join(relative, child));
  }
  await visit(root, "");
  return output;
}

async function snapshotEntry(filePath) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isDirectory()) return { kind: "directory" };
  if (stat.isFile()) return { kind: "file", sha256: await sha256File(filePath) };
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", sha256: sha256(`symlink:${await fs.readlink(filePath)}`) };
  }
  throw new SingleAgentMigrationError("RUNTIME_ENTRY_UNSUPPORTED", `NapCat 状态包含不支持的文件类型：${filePath}。`);
}

async function verifyRuntimeCopies(workspace, entries) {
  for (const expected of entries) {
    const actual = await snapshotEntry(path.join(workspace, expected.destination));
    if (!actual || actual.kind !== expected.kind || actual.sha256 !== expected.sha256) {
      throw new SingleAgentMigrationError(
        "RUNTIME_COPY_VERIFICATION_FAILED",
        `NapCat 状态复制校验失败：${expected.destination}。`
      );
    }
  }
}

async function verifyPreservedRuntimeDivergences(workspace, entries) {
  for (const expected of entries) {
    const actual = await snapshotEntry(path.join(workspace, expected.destination));
    if (
      !actual
      || actual.kind !== expected.destinationSnapshot.kind
      || actual.sha256 !== expected.destinationSnapshot.sha256
    ) {
      throw new SingleAgentMigrationError(
        "PRESERVED_RUNTIME_CHANGED",
        `迁移期间已保留的 primary 运行状态发生变化：${expected.destination}。`
      );
    }
  }
}

function assertPreservedCounts(before, after, excludedTables, label) {
  for (const [table, expected] of Object.entries(before.tables)) {
    if (excludedTables.has(table)) continue;
    const actual = after.tables[table];
    if (actual !== expected) {
      throw new SingleAgentMigrationError(
        "DATABASE_COUNT_MISMATCH",
        `${label} ${table} 记录数变化：迁移前 ${expected}，迁移后 ${actual ?? "缺失"}。`
      );
    }
  }
}

async function assertServicesStopped(workspace, configPath, accounts = [], listRunningContainers = runningWorkspaceContainers) {
  const pidPath = path.join(workspace, "runtime/tmp/sunabot.pid");
  try {
    const pid = Number((await fs.readFile(pidPath, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new SingleAgentMigrationError("SERVICE_RUNNING", `Sunabot 进程 ${pid} 仍在运行。`);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const config = await readJson(configPath, "CONFIG_INVALID");
  const configuredPort = Number(config?.server?.port);
  const ports = [...new Set([
    Number.isSafeInteger(configuredPort) ? configuredPort : 8787,
    8787,
    8788,
    6099,
    ...accounts.map((account) => account.webuiPort).filter((port) => Number.isSafeInteger(port) && port > 0)
  ])];
  const listening = [];
  for (const port of ports) if (await isListening(port)) listening.push(port);
  if (listening.length > 0) {
    throw new SingleAgentMigrationError(
      "SERVICE_RUNNING",
      `检测到仍在监听的运行端口：${listening.join(", ")}；请先运行 ./sunabot.sh down。`
    );
  }
  const containers = await listRunningContainers(workspace);
  if (containers.length > 0) {
    throw new SingleAgentMigrationError(
      "SERVICE_RUNNING",
      `检测到当前 workspace 仍有运行容器：${containers.join(", ")}；请先运行 ./sunabot.sh down。`
    );
  }
}

async function runningWorkspaceContainers(workspace) {
  const result = await capture("docker", workspaceContainerListArgs(workspace)).catch((error) => {
    throw new SingleAgentMigrationError(
      "RUNTIME_INSPECTION_FAILED",
      `无法核对当前 workspace 的 Docker 容器：${error.message}`
    );
  });
  if (result.code !== 0) {
    throw new SingleAgentMigrationError(
      "RUNTIME_INSPECTION_FAILED",
      `无法核对当前 workspace 的 Docker 容器：${result.stderr.trim() || `docker 退出码 ${result.code}`}`
    );
  }
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function workspaceContainerListArgs(workspace) {
  const identity = workspaceIdentity(workspace);
  return [
    "ps",
    "--filter", `label=io.sunabot.workspace-id=${identity}`,
    "--format", "{{.ID}}"
  ];
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
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

function publicResult(inspection, mode) {
  return {
    ok: true,
    mode,
    state: inspection.state,
    workspace: inspection.workspace,
    target: inspection.target,
    checks: inspection.checks,
    plannedChanges: inspection.plannedChanges
  };
}

function runtimeEvidence(entry) {
  return {
    destination: entry.destination,
    kind: entry.kind,
    ...(entry.sha256 ? { sha256: entry.sha256 } : {})
  };
}

function runtimeDivergenceEvidence(entry) {
  return {
    source: entry.relative
      ? path.posix.join(entry.source, entry.relative)
      : entry.source,
    destination: entry.destination,
    sourceKind: entry.kind,
    sourceSha256: entry.sha256 ?? null,
    destinationKind: entry.destinationSnapshot.kind,
    destinationSha256: entry.destinationSnapshot.sha256 ?? null
  };
}

function databaseSummary(database) {
  return {
    integrity: database.integrity,
    foreignKeys: database.foreignKeyViolations === 0 ? "ok" : "failed",
    tables: database.tables
  };
}

function countTable(database, table) {
  const identifier = `"${table.replaceAll('"', '""')}"`;
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${identifier}`).get()?.count ?? 0);
}

async function assertWorkspaceDirectory(workspace) {
  let stat;
  try {
    stat = await fs.lstat(workspace);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SingleAgentMigrationError("WORKSPACE_MISSING", `workspace 不存在：${workspace}。`);
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SingleAgentMigrationError("WORKSPACE_INVALID", `workspace 必须是普通目录且不能是符号链接：${workspace}。`);
  }
}

async function assertStandardDatabasePath(workspace) {
  let runtimeDatabasePath = "";
  try {
    const source = await fs.readFile(path.join(workspace, "secrets/runtime.env"), "utf8");
    runtimeDatabasePath = envValue(source, "SUNABOT_DATABASE_PATH");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!databasePathOverrideConfigured(
    process.env,
    { SUNABOT_DATABASE_PATH: runtimeDatabasePath }
  )) return;
  throw new SingleAgentMigrationError(
    "CUSTOM_DATABASE_PATH_UNSUPPORTED",
    "SUNABOT_DATABASE_PATH 已停止支持；主库固定为 workspace/business/data/sunabot.sqlite。"
  );
}

async function existingRelativePaths(workspace, candidates) {
  const output = [];
  for (const relative of candidates) if (await exists(path.join(workspace, relative))) output.push(relative);
  return output;
}

async function allDirectories(paths) {
  for (const filePath of paths) {
    try {
      if (!(await fs.stat(filePath)).isDirectory()) return false;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function readJson(filePath, code) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new SingleAgentMigrationError(code, `${filePath} 不是有效 JSON：${error.message}`);
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function atomicWriteText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new SingleAgentMigrationError("PATH_INVALID", `${label} 必须是绝对路径。`);
  }
  return path.normalize(value);
}

function normalizeError(error) {
  if (error instanceof SingleAgentMigrationError) return error;
  return new SingleAgentMigrationError(error?.code ?? "MIGRATION_FAILED", error?.message ?? String(error), error?.details);
}

function restoreEnvironment(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function parseArguments(values) {
  const allowed = new Set(["workspace", "backup-root", "apply", "quiesced", "help"]);
  const flags = new Set(["apply", "quiesced", "help"]);
  const output = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new SingleAgentMigrationError("ARGUMENT_INVALID", `无法识别参数：${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new SingleAgentMigrationError("ARGUMENT_INVALID", `无法识别参数：--${name}`);
    if (output.has(name)) throw new SingleAgentMigrationError("ARGUMENT_INVALID", `参数重复：--${name}`);
    const next = values[index + 1];
    if (flags.has(name)) {
      if (next && !next.startsWith("--")) {
        throw new SingleAgentMigrationError("ARGUMENT_INVALID", `--${name} 不接受参数值。`);
      }
      output.set(name, true);
      continue;
    }
    if (!next || next.startsWith("--")) throw new SingleAgentMigrationError("ARGUMENT_REQUIRED", `--${name} 缺少路径。`);
    output.set(name, next);
    index += 1;
  }
  return output;
}

function resolveCliPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SingleAgentMigrationError("ARGUMENT_REQUIRED", `请通过 --${label} 指定路径。`);
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

function printUsage() {
  console.log(`用法：
  npm run migrate:multi-agent -- --workspace PATH
  npm run migrate:multi-agent -- --workspace PATH --apply --quiesced [--backup-root PATH]

默认执行 dry-run。--apply 仅接受已经停止 Sunabot 与 NapCat 写入的 workspace。`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.get("help") === true) {
      printUsage();
    } else {
      const workspaceValue = args.get("workspace") ?? process.env.SUNABOT_WORKSPACE;
      const workspace = resolveCliPath(workspaceValue, "workspace");
      const backupRootValue = args.get("backup-root");
      const result = await migrateSingleAgentToMultiAgent({
        workspace,
        apply: args.get("apply") === true,
        quiesced: args.get("quiesced") === true,
        ...(typeof backupRootValue === "string" ? { backupsRoot: resolveCliPath(backupRootValue, "backup-root") } : {})
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    const failure = normalizeError(error);
    console.error(JSON.stringify({
      ok: false,
      code: failure.code,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {})
    }, null, 2));
    process.exitCode = 1;
  }
}
