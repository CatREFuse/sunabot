#!/usr/bin/env node
import { createHash } from "node:crypto";
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
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const lockPath = path.join(workspace, ".workspace-layout-v1.lock");
  const lock = await fs.open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw migrationError("WORKSPACE_MIGRATION_LOCKED", "workspace 布局迁移已在运行或遗留锁文件。");
    throw error;
  });

  try {
    if (!options.skipServiceCheck) await assertConfiguredServiceStopped(workspace);
    await checkpointLegacyDatabases(workspace);
    const legacyPaths = await existingLegacyPaths(workspace);
    for (const [source, destination] of [...DIRECTORY_MOVES, ...FILE_MOVES]) {
      await assertMovable(path.join(workspace, source), path.join(workspace, destination));
    }
    let backup;
    if (legacyPaths.length) {
      await fs.mkdir(path.join(workspace, "backups"), { recursive: true, mode: 0o700 });
      backup = await backupLegacyLayout(workspace, legacyPaths, options.now?.() ?? new Date());
    }

    await Promise.all(REQUIRED_DIRECTORIES.map((relative) => fs.mkdir(path.join(workspace, relative), {
      recursive: true,
      mode: 0o700
    })));
    for (const [source, destination] of [...DIRECTORY_MOVES, ...FILE_MOVES]) {
      await mergeMove(path.join(workspace, source), path.join(workspace, destination));
    }
    const qrMigration = await migrateLegacyNapcatQrCode({
      workspace,
      paths: {
        napcatState: "runtime/napcat",
        napcatQrCode: "runtime/napcat/qrcode.png"
      }
    });

    const configPath = path.join(workspace, "business/config/sunabot.json");
    if (await exists(configPath)) await rewriteConfig(configPath);
    await verifyDatabase(path.join(workspace, "business/data/sunabot.sqlite"));
    await verifyDatabase(path.join(workspace, "business/data/session-queue.sqlite"));

    const marker = {
      schemaVersion: 1,
      layoutVersion: LAYOUT_VERSION,
      migratedAt: new Date().toISOString(),
      backup: backup ? path.relative(workspace, backup.directory).replace(/\\/g, "/") : undefined,
      napcatQrMigrated: qrMigration.migrated,
      databaseIntegrity: "ok"
    };
    await atomicJson(path.join(workspace, "runtime/workspace-layout.json"), marker);
    return { workspace, migrated: legacyPaths.length > 0 || qrMigration.migrated, backup, marker };
  } finally {
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

async function checkpointLegacyDatabases(workspace) {
  for (const relative of ["artifacts/sunabot.sqlite", "artifacts/session-queue.sqlite"]) {
    const filePath = path.join(workspace, relative);
    if (!(await exists(filePath))) continue;
    const database = new DatabaseSync(filePath, { timeout: 5_000 });
    try {
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const result = database.prepare("PRAGMA integrity_check").get();
      if (String(result?.integrity_check ?? "") !== "ok") {
        throw migrationError("WORKSPACE_DATABASE_INVALID", `${relative} integrity_check 未通过。`);
      }
    } finally {
      database.close();
    }
  }
}

async function backupLegacyLayout(workspace, legacyPaths, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const directory = path.join(workspace, "backups", `workspace-layout-v1-${stamp}`);
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const backedUpPaths = legacyPaths.filter((relative) => !isSensitiveLegacyPath(relative));
  const excludedSensitivePaths = legacyPaths.filter(isSensitiveLegacyPath);
  for (const relative of backedUpPaths) {
    const source = path.join(workspace, relative);
    const destination = path.join(directory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  }
  const manifest = await manifestFor(directory);
  await atomicJson(path.join(directory, "manifest.json"), {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    sourceWorkspace: workspace,
    excludedSensitivePaths,
    files: manifest
  });
  return { directory, files: manifest.length, excludedSensitivePaths };
}

async function assertMovable(source, destination) {
  if (!(await exists(source)) || !(await exists(destination))) return;
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

async function mergeMove(source, destination) {
  if (!(await exists(source))) return;
  const sourceStats = await fs.lstat(source);
  if (!(await exists(destination))) {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.rename(source, destination);
    return;
  }
  const destinationStats = await fs.lstat(destination);
  if (sourceStats.isDirectory() && destinationStats.isDirectory()) {
    for (const entry of await fs.readdir(source)) {
      await mergeMove(path.join(source, entry), path.join(destination, entry));
    }
    await fs.rmdir(source);
    return;
  }
  if (sourceStats.isFile() && destinationStats.isFile() && await sameFile(source, destination)) {
    await fs.rm(source);
    return;
  }
  throw migrationError("WORKSPACE_MIGRATION_CONFLICT", `迁移目标已存在且内容不同：${destination}`);
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
  await fs.rename(temporary, filePath);
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
