#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveProjectRoot } from "../shared/paths.mjs";
import { createRecoveryPoint } from "../workspace/sqlite-recovery.mjs";
import {
  applySelfieReferencesMigration,
  planSelfieReferencesMigration,
  verifySelfieReferencesMigration
} from "./migrate-selfie-references-jsonl.mjs";
import {
  applyAgentResourcesMigration,
  planAgentResourcesMigration,
  verifyAgentResourcesMigration
} from "./migrate-agent-resources.mjs";

export const FROM_VERSION = "0.1.0/0.1.1";
export const TARGET_VERSION = "0.1.2";

const root = resolveProjectRoot(import.meta.url);
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const EMOJI_FILE_PATTERN = /^emoji-[a-f0-9]{64}\.png$/u;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_EMOJI_KEYS = 64;
const MAX_VERSIONS_PER_KEY = 20;
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "RELEASE_UPGRADE_FAILED",
      message: error?.message ?? String(error),
      serviceMayBeStopped: error?.serviceMayBeStopped === true
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { command, workspace } = parseArguments(argv);
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = command === "plan"
    ? await planReleaseUpgrade({ workspace })
    : await applyReleaseUpgrade({ workspace });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function planReleaseUpgrade(options) {
  const projectRoot = options.projectRoot ?? root;
  const versions = await verifyTargetRelease(projectRoot);
  const selfie = await (options.planSelfieReferencesMigration
    ?? planSelfieReferencesMigration)({ workspace: options.workspace });
  const emoji = await (options.planEmojiCatalogMigration
    ?? planEmojiCatalogMigration)({
    workspace: selfie.workspace,
    agentIds: selfie.agents.map((agent) => agent.agentId)
  });
  const resources = await (options.planAgentResourcesMigration
    ?? planAgentResourcesMigration)({ workspace: selfie.workspace });
  return {
    ok: true,
    command: "plan",
    fromVersion: FROM_VERSION,
    targetVersion: TARGET_VERSION,
    workspace: selfie.workspace,
    versions,
    changesRequired: selfie.changesRequired || emoji.changesRequired || resources.changesRequired,
    selfieReferences: selfie,
    emojiCatalog: emoji,
    agentResources: resources
  };
}

export async function applyReleaseUpgrade(options) {
  (options.assertNonRoot ?? assertNonRoot)();
  const projectRoot = options.projectRoot ?? root;
  const plan = await planReleaseUpgrade({
    ...options,
    projectRoot
  });
  const run = options.runCommand ?? runCommand;
  const environment = {
    ...process.env,
    SUNABOT_WORKSPACE: plan.workspace
  };
  const launcher = path.join(projectRoot, "sunabot.sh");
  let serviceMayBeStopped = false;
  try {
    await run(launcher, ["down"], { cwd: projectRoot, env: environment });
    serviceMayBeStopped = true;
    const recoveryPoint = await (options.createRecoveryPoint ?? createRecoveryPoint)({
      workspace: plan.workspace,
      quiesced: true
    });
    const emojiCatalog = await (options.applyEmojiCatalogMigration
      ?? applyEmojiCatalogMigration)({
      workspace: plan.workspace,
      agentIds: plan.emojiCatalog.agents.map((agent) => agent.agentId),
      quiesced: true
    });
    const selfieReferences = await (options.applySelfieReferencesMigration
      ?? applySelfieReferencesMigration)({
      workspace: plan.workspace,
      quiesced: true
    });
    await (options.verifySelfieReferencesMigration
      ?? verifySelfieReferencesMigration)({ workspace: plan.workspace });
    await (options.verifyEmojiCatalogMigration
      ?? verifyEmojiCatalogMigration)({
      workspace: plan.workspace,
      agentIds: plan.emojiCatalog.agents.map((agent) => agent.agentId)
    });
    const agentResources = await (options.applyAgentResourcesMigration
      ?? applyAgentResourcesMigration)({
      workspace: plan.workspace,
      quiesced: true
    });
    await (options.verifyAgentResourcesMigration
      ?? verifyAgentResourcesMigration)({ workspace: plan.workspace });
    await run(launcher, ["up"], { cwd: projectRoot, env: environment });
    serviceMayBeStopped = false;
    await run(launcher, ["status"], { cwd: projectRoot, env: environment });
    await run(launcher, ["doctor"], { cwd: projectRoot, env: environment });
    return {
      ok: true,
      command: "apply",
      fromVersion: FROM_VERSION,
      targetVersion: TARGET_VERSION,
      workspace: plan.workspace,
      recoveryPoint: recoveryPoint.directory,
      selfieReferences,
      emojiCatalog,
      agentResources,
      runtime: {
        started: true,
        status: "passed",
        doctor: "passed"
      }
    };
  } catch (error) {
    if (serviceMayBeStopped) {
      error.serviceMayBeStopped = true;
      error.message = `${error.message} 服务保持停止，请处理错误后重新执行 apply 或运行 ./sunabot.sh up。`;
    }
    throw error;
  }
}

export async function planEmojiCatalogMigration(options) {
  const workspace = path.resolve(options.workspace);
  const agentIds = normalizedAgentIds(options.agentIds);
  const agents = [];
  for (const agentId of agentIds) {
    agents.push(await inspectEmojiAgent(workspace, agentId));
  }
  const conflicts = agents.filter((agent) => agent.state === "conflict");
  if (conflicts.length) {
    throw upgradeError(
      "EMOJI_CATALOG_MIGRATION_CONFLICT",
      `表情 JSONL 与 SQLite 内容冲突：${conflicts.map((agent) => agent.agentId).join(", ")}`
    );
  }
  return {
    ok: true,
    migrationId: "emoji-catalog-jsonl-v1",
    target: "emojis.jsonl",
    rollbackSource: "sqlite-recovery-point",
    changesRequired: agents.some((agent) => agent.state === "legacy" || agent.state === "both"),
    agents: agents.map(publicEmojiState)
  };
}

export async function applyEmojiCatalogMigration(options) {
  if (options.quiesced !== true) {
    throw upgradeError("QUIESCED_CONFIRMATION_REQUIRED", "表情迁移需要停服并显式确认 quiesced。");
  }
  const workspace = path.resolve(options.workspace);
  const plan = await planEmojiCatalogMigration(options);
  for (const agent of plan.agents) {
    if (agent.state !== "legacy" && agent.state !== "both") continue;
    const inspected = await inspectEmojiAgent(workspace, agent.agentId);
    if (inspected.state !== "legacy" && inspected.state !== "both") {
      throw upgradeError("EMOJI_CATALOG_MIGRATION_CONFLICT", `表情迁移状态发生变化：${agent.agentId}`);
    }
    if (inspected.state === "legacy") {
      await writeEmojiCatalogAtomic(workspace, inspected.catalogPath, inspected.serialized);
      const published = await readEmojiCatalog(inspected.catalogPath);
      if (!sameEmojiEntries(published, inspected.entries)) {
        throw upgradeError("EMOJI_CATALOG_VERIFY_FAILED", `表情 JSONL 发布后校验失败：${agent.agentId}`);
      }
    }
    clearLegacyEmojiRows(inspected.databasePath);
  }
  const verified = await verifyEmojiCatalogMigration(options);
  return {
    ...verified,
    migrated: plan.changesRequired
  };
}

export async function verifyEmojiCatalogMigration(options) {
  const workspace = path.resolve(options.workspace);
  const agentIds = normalizedAgentIds(options.agentIds);
  const agents = [];
  for (const agentId of agentIds) {
    agents.push(await inspectEmojiAgent(workspace, agentId));
  }
  const incomplete = agents.filter((agent) => agent.state === "legacy"
    || agent.state === "both"
    || agent.state === "conflict");
  if (incomplete.length) {
    throw upgradeError(
      "EMOJI_CATALOG_VERIFY_FAILED",
      `仍有 Agent 未完成表情 JSONL 迁移：${incomplete.map((agent) => agent.agentId).join(", ")}`
    );
  }
  return {
    ok: true,
    migrationId: "emoji-catalog-jsonl-v1",
    target: "emojis.jsonl",
    rollbackSource: "sqlite-recovery-point",
    agents: agents.map(publicEmojiState)
  };
}

export async function verifyTargetRelease(projectRoot = root) {
  const [
    packageManifest,
    packageLock,
    runtimeContract,
    releaseCatalog
  ] = await Promise.all([
    readJson(path.join(projectRoot, "package.json")),
    readJson(path.join(projectRoot, "package-lock.json")),
    readJson(path.join(projectRoot, "deploy", "runtime-contract.json")),
    fs.readFile(path.join(projectRoot, "packages", "platform", "releaseCatalog.ts"), "utf8")
  ]);
  const currentVersions = {
    package: packageManifest.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version,
    runtimeContract: runtimeContract.releaseVersion,
    releaseCatalog: releaseCatalog.match(/CURRENT_RELEASE_VERSION = "([^"]+)"/)?.[1]
  };
  assertTargetVersions(currentVersions);
  const [dockerfile, compose] = await Promise.all([
    fs.readFile(path.join(projectRoot, "deploy", "docker", "Dockerfile"), "utf8"),
    fs.readFile(path.join(projectRoot, "deploy", "docker", "compose.yml"), "utf8")
  ]);
  const versions = {
    ...currentVersions,
    dockerfile: dockerfile.match(/ARG SUNABOT_RELEASE_VERSION=([^\s]+)/)?.[1],
    compose: compose.match(/SUNABOT_RELEASE_VERSION:-([^}]+)}/)?.[1]
  };
  assertTargetVersions(versions);
  return versions;
}

function assertTargetVersions(versions) {
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== TARGET_VERSION)
    .map(([name, version]) => `${name}=${version ?? "missing"}`);
  if (mismatches.length) {
    throw upgradeError(
      "TARGET_RELEASE_MISMATCH",
      `升级脚本需要完整的 ${TARGET_VERSION} 代码，当前版本不一致：${mismatches.join(", ")}`
    );
  }
}

async function inspectEmojiAgent(workspace, agentId) {
  const databasePath = agentId === "plana"
    ? path.join(workspace, "business", "data", "sunabot.sqlite")
    : path.join(workspace, "business", "agents", agentId, "data", "sunabot.sqlite");
  const catalogPath = agentId === "plana"
    ? path.join(workspace, "business", "media", "images", "emojis.jsonl")
    : path.join(workspace, "business", "media", "images", "agents", agentId, "emojis.jsonl");
  const databaseEntries = readLegacyEmojiEntries(databasePath);
  const catalogEntries = await readOptionalEmojiCatalog(catalogPath);
  const state = databaseEntries.length && catalogEntries
    ? sameEmojiEntries(databaseEntries, catalogEntries) ? "both" : "conflict"
    : databaseEntries.length
      ? "legacy"
      : catalogEntries
        ? "jsonl"
        : "empty";
  return {
    agentId,
    state,
    keys: (catalogEntries ?? databaseEntries).length,
    versions: (catalogEntries ?? databaseEntries)
      .reduce((total, entry) => total + entry.versions.length, 0),
    databasePath,
    catalogPath,
    entries: databaseEntries,
    serialized: serializeEmojiEntries(databaseEntries)
  };
}

function readLegacyEmojiEntries(databasePath) {
  if (!fileExists(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('emojis', 'emoji_versions')"
    ).all().map((row) => String(row.name)));
    if (!tables.has("emojis")) return [];
    const current = database.prepare(`
      SELECT emoji_key, file_name, source, size_bytes, width, height, created_at, updated_at
      FROM emojis ORDER BY updated_at DESC, emoji_key
    `).all();
    if (!current.length) {
      if (tables.has("emoji_versions")) {
        const orphanVersions = Number(database.prepare(
          "SELECT count(*) AS count FROM emoji_versions"
        ).get().count);
        if (orphanVersions) {
          throw upgradeError("EMOJI_CATALOG_MIGRATION_CONFLICT", "SQLite 存在无当前记录的表情版本。");
        }
      }
      return [];
    }
    const versionQuery = tables.has("emoji_versions")
      ? database.prepare(`
          SELECT file_name, source, size_bytes, width, height, created_at
          FROM emoji_versions
          WHERE emoji_key = ?
          ORDER BY CASE WHEN file_name = ? THEN 0 ELSE 1 END, created_at DESC, file_name
        `)
      : undefined;
    return validateEmojiEntries(current.map((row) => {
      const currentVersion = emojiVersion(row, String(row.updated_at));
      const versions = (versionQuery?.all(row.emoji_key, row.file_name) ?? [])
        .map((version) => emojiVersion(version, String(version.created_at)));
      if (!versions.some((version) => version.fileName === currentVersion.fileName)) {
        versions.push(currentVersion);
      }
      return {
        schemaVersion: 1,
        key: String(row.emoji_key),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        currentFileName: String(row.file_name),
        versions
      };
    }));
  } finally {
    database.close();
  }
}

function clearLegacyEmojiRows(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec("DELETE FROM emoji_versions; DELETE FROM emojis;");
    database.exec("COMMIT");
    const remaining = Number(database.prepare(
      "SELECT (SELECT count(*) FROM emojis) + (SELECT count(*) FROM emoji_versions) AS count"
    ).get().count);
    if (remaining !== 0) {
      throw upgradeError("EMOJI_CATALOG_VERIFY_FAILED", `SQLite 表情旧行未清空：${databasePath}`);
    }
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The primary migration error remains authoritative.
    }
    throw error;
  } finally {
    database.close();
  }
}

function emojiVersion(row, createdAt) {
  return {
    fileName: String(row.file_name),
    source: String(row.source),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    createdAt
  };
}

async function readOptionalEmojiCatalog(filePath) {
  try {
    return await readEmojiCatalog(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readEmojiCatalog(filePath) {
  const noFollow = Reflect.get(fsConstants, "O_NOFOLLOW");
  if (typeof noFollow !== "number") {
    throw upgradeError("EMOJI_CATALOG_NOFOLLOW_UNAVAILABLE", "当前平台不支持安全读取表情清单。");
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_CATALOG_BYTES) {
      throw upgradeError("EMOJI_CATALOG_INVALID", `表情清单文件无效：${filePath}`);
    }
    const bytes = await handle.readFile();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text) return [];
    if (!text.endsWith("\n") || text.slice(0, -1).split("\n").some((line) => !line)) {
      throw upgradeError("EMOJI_CATALOG_INVALID", `表情清单行结构无效：${filePath}`);
    }
    return validateEmojiEntries(text.slice(0, -1).split("\n").map((line) => JSON.parse(line)));
  } finally {
    await handle.close();
  }
}

function validateEmojiEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_EMOJI_KEYS) {
    throw upgradeError("EMOJI_CATALOG_INVALID", "表情清单 key 数量无效。");
  }
  const keys = new Set();
  return entries.map((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "createdAt,currentFileName,key,schemaVersion,updatedAt,versions"
      || entry.schemaVersion !== 1
      || !validEmojiKey(entry.key)
      || !validTimestamp(entry.createdAt)
      || !validTimestamp(entry.updatedAt)
      || !EMOJI_FILE_PATTERN.test(entry.currentFileName)
      || !Array.isArray(entry.versions)
      || entry.versions.length < 1
      || entry.versions.length > MAX_VERSIONS_PER_KEY
      || keys.has(entry.key)
    ) {
      throw upgradeError("EMOJI_CATALOG_INVALID", "表情清单条目无效。");
    }
    keys.add(entry.key);
    const files = new Set();
    const versions = entry.versions.map((version) => {
      if (
        !version
        || typeof version !== "object"
        || Array.isArray(version)
        || Object.keys(version).sort().join(",") !== "createdAt,fileName,height,sizeBytes,source,width"
        || !EMOJI_FILE_PATTERN.test(version.fileName)
        || (version.source !== "upload" && version.source !== "generated")
        || !positiveSafeInteger(version.sizeBytes)
        || !positiveSafeInteger(version.width)
        || !positiveSafeInteger(version.height)
        || !validTimestamp(version.createdAt)
        || files.has(version.fileName)
      ) {
        throw upgradeError("EMOJI_CATALOG_INVALID", "表情清单版本无效。");
      }
      files.add(version.fileName);
      return {
        fileName: version.fileName,
        source: version.source,
        sizeBytes: version.sizeBytes,
        width: version.width,
        height: version.height,
        createdAt: version.createdAt
      };
    });
    if (!files.has(entry.currentFileName)) {
      throw upgradeError("EMOJI_CATALOG_INVALID", "表情清单缺少当前版本。");
    }
    return {
      schemaVersion: 1,
      key: entry.key,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      currentFileName: entry.currentFileName,
      versions
    };
  });
}

function serializeEmojiEntries(entries) {
  const validated = validateEmojiEntries(entries);
  return Buffer.from(validated
    .slice()
    .sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key)
    ))
    .map((entry) => JSON.stringify(entry))
    .join("\n") + (validated.length ? "\n" : ""));
}

async function writeEmojiCatalogAtomic(workspace, filePath, content) {
  const directory = path.dirname(filePath);
  await assertSafeWorkspaceDirectory(workspace, directory);
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw upgradeError("EMOJI_CATALOG_PATH_INVALID", `表情清单路径无效：${filePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertSafeWorkspaceDirectory(workspace, directory) {
  const relative = path.relative(workspace, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw upgradeError("EMOJI_CATALOG_PATH_INVALID", "表情清单目录越界。");
  }
  let current = workspace;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw upgradeError("EMOJI_CATALOG_PATH_INVALID", `表情清单目录无效：${current}`);
    }
  }
}

function normalizedAgentIds(values = []) {
  const ids = [...new Set(["plana", ...values])].sort();
  if (ids.some((agentId) => typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId))) {
    throw upgradeError("EMOJI_CATALOG_PATH_INVALID", "Agent ID 无效。");
  }
  return ids;
}

function publicEmojiState(agent) {
  return {
    agentId: agent.agentId,
    state: agent.state,
    keys: agent.keys,
    versions: agent.versions
  };
}

function sameEmojiEntries(left, right) {
  return serializeEmojiEntries(left).equals(serializeEmojiEntries(right));
}

function validEmojiKey(value) {
  return typeof value === "string"
    && value === value.trim().normalize("NFC")
    && [...value].length > 0
    && [...value].length <= 24
    && Buffer.byteLength(value, "utf8") <= 64
    && !/[\u0000-\u001f\u007f-\u009f\[\]\/\\]/u.test(value);
}

function validTimestamp(value) {
  return typeof value === "string"
    && value.length >= 20
    && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fileExists(filePath) {
  return existsSync(filePath);
}

function parseArguments(argv) {
  const [command = "help", ...tokens] = argv;
  if (!["plan", "apply", "help"].includes(command)) {
    throw upgradeError("ARGUMENT_INVALID", `未知命令：${command}`);
  }
  let workspace = process.env.SUNABOT_WORKSPACE ?? path.join(root, "workspace");
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "--workspace" || !tokens[index + 1]) {
      throw upgradeError("ARGUMENT_INVALID", `无法识别参数：${tokens[index]}`);
    }
    workspace = tokens[index + 1];
    index += 1;
  }
  if (!path.isAbsolute(workspace)) {
    throw upgradeError("ARGUMENT_INVALID", "--workspace 必须是绝对路径。");
  }
  return { command, workspace: path.normalize(workspace) };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(upgradeError(
        "RELEASE_UPGRADE_COMMAND_FAILED",
        `${path.basename(command)} ${args.join(" ")} 失败（${signal ?? code}）。`
      ));
    });
  });
}

function assertNonRoot() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw upgradeError("ROOT_EXECUTION_FORBIDDEN", "升级必须由拥有仓库和 workspace 的非 root 用户执行。");
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function usage() {
  return `用法：
  npm run upgrade:0.1.2 -- plan [--workspace /absolute/path]
  npm run upgrade:0.1.2 -- apply [--workspace /absolute/path]

plan 只读检查 0.1.2 代码、JSONL 清单与双工作区布局；apply 自动停服、创建 SQLite 恢复点、
迁移并校验自拍、表情和统一资源目录，随后启动服务并运行 status 与 doctor。`;
}

function upgradeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
