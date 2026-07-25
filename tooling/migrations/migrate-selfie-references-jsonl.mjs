#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MIGRATION_ID = "selfie-references-jsonl-v1";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const REFERENCE_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REFERENCES = 9;
const MAX_NOTE_LENGTH = 120;
const MAX_MANIFEST_BYTES = 64 * 1024;
const LEGACY_FILE = "references.json";
const TARGET_FILE = "references.jsonl";
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "SELFIE_REFERENCES_MIGRATION_FAILED",
      message: error?.message ?? String(error)
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { command, values, flags } = parseArguments(argv);
  const workspace = requiredValue(values, "workspace");
  let result;
  if (command === "plan") {
    result = await planSelfieReferencesMigration({ workspace });
  } else if (command === "apply") {
    result = await applySelfieReferencesMigration({
      workspace,
      quiesced: flags.has("quiesced")
    });
  } else if (command === "verify") {
    result = await verifySelfieReferencesMigration({ workspace });
  } else if (command === "rollback") {
    result = await rollbackSelfieReferencesMigration({
      workspace,
      backup: requiredValue(values, "backup"),
      quiesced: flags.has("quiesced")
    });
  } else if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  } else {
    throw migrationError("ARGUMENT_INVALID", `未知命令：${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function planSelfieReferencesMigration(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const agents = await inspectAgents(workspace);
  const conflicts = agents.filter((agent) => agent.state === "conflict");
  if (conflicts.length) {
    throw migrationError(
      "SELFIE_REFERENCE_MANIFEST_CONFLICT",
      `新旧自拍清单内容冲突：${conflicts.map((agent) => agent.agentId).join(", ")}`
    );
  }
  return {
    ok: true,
    command: "plan",
    migrationId: MIGRATION_ID,
    workspace,
    changesRequired: agents.some((agent) => agent.state === "legacy" || agent.state === "both"),
    agents: agents.map(publicAgentState)
  };
}

export async function applySelfieReferencesMigration(options) {
  requireQuiesced(options.quiesced);
  const workspace = await resolveWorkspace(options.workspace);
  await (options.assertStopped ?? assertServiceStopped)(workspace);
  const agents = await inspectAgents(workspace);
  const conflicts = agents.filter((agent) => agent.state === "conflict");
  if (conflicts.length) {
    throw migrationError(
      "SELFIE_REFERENCE_MANIFEST_CONFLICT",
      `新旧自拍清单内容冲突：${conflicts.map((agent) => agent.agentId).join(", ")}`
    );
  }
  const changes = agents.filter((agent) => agent.state === "legacy" || agent.state === "both");
  if (!changes.length) {
    return {
      ok: true,
      command: "apply",
      migrationId: MIGRATION_ID,
      workspace,
      migrated: false,
      agents: agents.map(publicAgentState)
    };
  }

  const backup = await createBackup(workspace, changes, options.now ?? new Date());
  for (const agent of changes) {
    await writeFileAtomic(agent.targetPath, encodeJsonl(agent.legacyManifest.references));
    const targetManifest = parseJsonl(await readRegularFile(agent.targetPath));
    if (!sameManifest(agent.legacyManifest, targetManifest)) {
      throw migrationError("SELFIE_REFERENCE_VERIFY_FAILED", `自拍清单发布后校验失败：${agent.agentId}`);
    }
    await fs.rm(agent.legacyPath);
    await syncDirectory(agent.selfieDirectory);
  }

  const verified = await verifySelfieReferencesMigration({ workspace });
  return {
    ...verified,
    command: "apply",
    migrated: true,
    backup: path.relative(workspace, backup.directory).replaceAll("\\", "/"),
    backupManifestSha256: backup.manifestSha256
  };
}

export async function verifySelfieReferencesMigration(options) {
  const workspace = await resolveWorkspace(options.workspace);
  const agents = await inspectAgents(workspace);
  const incomplete = agents.filter((agent) => agent.state === "legacy"
    || agent.state === "both"
    || agent.state === "conflict");
  if (incomplete.length) {
    throw migrationError(
      "SELFIE_REFERENCE_VERIFY_FAILED",
      `仍有 Agent 未完成 JSONL 迁移：${incomplete.map((agent) => agent.agentId).join(", ")}`
    );
  }
  return {
    ok: true,
    command: "verify",
    migrationId: MIGRATION_ID,
    workspace,
    agents: agents.map(publicAgentState)
  };
}

export async function rollbackSelfieReferencesMigration(options) {
  requireQuiesced(options.quiesced);
  const workspace = await resolveWorkspace(options.workspace);
  await (options.assertStopped ?? assertServiceStopped)(workspace);
  const backupDirectory = await resolveBackupDirectory(workspace, options.backup);
  await assertPlainDirectory(backupDirectory, "SELFIE_REFERENCE_BACKUP_INVALID");
  const manifestPath = path.join(backupDirectory, "manifest.json");
  const manifestBytes = await readRegularFile(manifestPath);
  const checksum = decodeUtf8(await readRegularFile(path.join(backupDirectory, "manifest.sha256")));
  if (checksum !== `${sha256(manifestBytes)}  manifest.json\n`) {
    throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", "备份 manifest 摘要无效。");
  }
  const manifest = parseBackupManifest(manifestBytes);

  for (const entry of manifest.files) {
    const agentDirectory = path.join(workspace, "business", "agents", entry.agentId);
    const selfieDirectory = path.join(agentDirectory, "selfie");
    await assertPlainDirectory(agentDirectory, "SELFIE_REFERENCE_PATH_INVALID");
    await assertPlainDirectory(selfieDirectory, "SELFIE_REFERENCE_PATH_INVALID");
    const backupFile = path.join(backupDirectory, entry.backupPath);
    const bytes = await readRegularFile(backupFile);
    if (sha256(bytes) !== entry.sha256) {
      throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", `备份摘要不匹配：${entry.agentId}`);
    }
    if (bytes.byteLength !== entry.bytes) {
      throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", `备份大小不匹配：${entry.agentId}`);
    }
    parseLegacy(bytes);
    const legacyPath = path.join(selfieDirectory, LEGACY_FILE);
    const targetPath = path.join(selfieDirectory, TARGET_FILE);
    const targetBytes = await readOptionalRegularFile(targetPath);
    if (targetBytes && sha256(targetBytes) !== entry.targetSha256) {
      throw migrationError(
        "SELFIE_REFERENCE_ROLLBACK_CONFLICT",
        `JSONL 清单在迁移后已经变化：${entry.agentId}`
      );
    }
    if (await pathExists(legacyPath)) {
      const current = await readRegularFile(legacyPath);
      if (!current.equals(bytes)) {
        throw migrationError("SELFIE_REFERENCE_ROLLBACK_CONFLICT", `旧清单已存在且内容不同：${entry.agentId}`);
      }
    } else {
      await writeFileAtomic(legacyPath, bytes);
    }
    await assertOptionalRegularFile(targetPath);
    await fs.rm(targetPath, { force: true });
    await syncDirectory(selfieDirectory);
  }

  return {
    ok: true,
    command: "rollback",
    migrationId: MIGRATION_ID,
    workspace,
    backup: path.relative(workspace, backupDirectory).replaceAll("\\", "/"),
    restoredAgents: manifest.files.map((entry) => entry.agentId)
  };
}

async function inspectAgents(workspace) {
  const agentsRoot = path.join(workspace, "business", "agents");
  if (!(await pathExists(agentsRoot))) return [];
  await assertPlainDirectory(agentsRoot, "SELFIE_REFERENCE_PATH_INVALID");
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!AGENT_ID_PATTERN.test(entry.name)) {
      throw migrationError("SELFIE_REFERENCE_PATH_INVALID", `Agent 目录名无效：${entry.name}`);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw migrationError("SELFIE_REFERENCE_PATH_INVALID", `Agent 路径必须是普通目录：${entry.name}`);
    }
    const agentDirectory = path.join(agentsRoot, entry.name);
    await assertPlainDirectory(agentDirectory, "SELFIE_REFERENCE_PATH_INVALID");
    const selfieDirectory = path.join(agentDirectory, "selfie");
    if (!(await pathExists(selfieDirectory))) {
      agents.push({
        agentId: entry.name,
        state: "absent",
        references: 0,
        selfieDirectory,
        legacyPath: path.join(selfieDirectory, LEGACY_FILE),
        targetPath: path.join(selfieDirectory, TARGET_FILE)
      });
      continue;
    }
    await assertPlainDirectory(selfieDirectory, "SELFIE_REFERENCE_PATH_INVALID");
    agents.push(await inspectAgent(entry.name, selfieDirectory));
  }
  return agents;
}

async function inspectAgent(agentId, selfieDirectory) {
  const legacyPath = path.join(selfieDirectory, LEGACY_FILE);
  const targetPath = path.join(selfieDirectory, TARGET_FILE);
  const [legacyBytes, targetBytes] = await Promise.all([
    readOptionalRegularFile(legacyPath),
    readOptionalRegularFile(targetPath)
  ]);
  const legacyManifest = legacyBytes ? parseLegacy(legacyBytes) : undefined;
  const targetManifest = targetBytes ? parseJsonl(targetBytes) : undefined;
  const state = legacyManifest && targetManifest
    ? sameManifest(legacyManifest, targetManifest) ? "both" : "conflict"
    : legacyManifest
      ? "legacy"
      : targetManifest
        ? "jsonl"
        : "empty";
  return {
    agentId,
    state,
    references: (targetManifest ?? legacyManifest)?.references.length ?? 0,
    selfieDirectory,
    legacyPath,
    targetPath,
    legacyManifest,
    targetManifest,
    legacyBytes
  };
}

async function createBackup(workspace, agents, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupsRoot = path.join(workspace, "backups");
  await fs.mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  await assertPlainDirectory(backupsRoot, "SELFIE_REFERENCE_BACKUP_INVALID");
  const directory = path.join(backupsRoot, `${MIGRATION_ID}-${stamp}`);
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const files = [];
  for (const agent of agents) {
    const backupPath = `agents/${agent.agentId}/selfie/${LEGACY_FILE}`;
    const target = path.join(directory, backupPath);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFileAtomic(target, agent.legacyBytes);
    files.push({
      agentId: agent.agentId,
      backupPath,
      sourcePath: `business/agents/${agent.agentId}/selfie/${LEGACY_FILE}`,
      bytes: agent.legacyBytes.byteLength,
      sha256: sha256(agent.legacyBytes),
      targetSha256: sha256(encodeJsonl(agent.legacyManifest.references))
    });
  }
  const manifest = {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    createdAt: now.toISOString(),
    files
  };
  const manifestPath = path.join(directory, "manifest.json");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileAtomic(manifestPath, manifestBytes);
  const manifestSha256 = sha256(manifestBytes);
  await writeFileAtomic(
    path.join(directory, "manifest.sha256"),
    Buffer.from(`${manifestSha256}  manifest.json\n`)
  );
  await syncDirectory(directory);
  return { directory, manifestSha256 };
}

function parseLegacy(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "旧自拍清单不是有效 JSON。");
  }
  const root = exactRecord(parsed, ["schemaVersion", "references"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.references)) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "旧自拍清单结构无效。");
  }
  return validateReferences(root.references.map((value) => (
    parseReference(exactRecord(value, ["id", "fileName", "note"]))
  )));
}

function parseJsonl(bytes) {
  const content = decodeUtf8(bytes);
  if (!content || content === "\n") return { schemaVersion: 1, references: [] };
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (lines.some((line) => !line)) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍 JSONL 清单包含空行。");
  }
  const references = lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍 JSONL 清单包含无效记录。");
    }
    const record = exactRecord(parsed, ["schemaVersion", "id", "fileName", "note"]);
    if (record.schemaVersion !== 1) {
      throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍 JSONL schemaVersion 无效。");
    }
    return parseReference(record);
  });
  return validateReferences(references);
}

function parseReference(record) {
  if (typeof record.id !== "string" || !REFERENCE_ID_PATTERN.test(record.id)) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图 ID 无效。");
  }
  if (
    typeof record.fileName !== "string"
    || !record.fileName
    || record.fileName.length > 240
    || path.basename(record.fileName) !== record.fileName
    || record.fileName.includes("\\")
    || hasControlCharacter(record.fileName)
    || hasLoneSurrogate(record.fileName)
  ) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图文件名无效。");
  }
  if (
    typeof record.note !== "string"
    || hasControlCharacter(record.note)
    || hasLoneSurrogate(record.note)
  ) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注无效。");
  }
  const note = record.note.normalize("NFC").trim();
  if (!note || [...note].length > MAX_NOTE_LENGTH) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图备注无效。");
  }
  return {
    id: record.id,
    fileName: record.fileName.normalize("NFC"),
    note
  };
}

function validateReferences(references) {
  if (references.length > MAX_REFERENCES) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图数量超限。");
  }
  const ids = new Set();
  for (const reference of references) {
    if (ids.has(reference.id)) {
      throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "自拍参考图 ID 重复。");
    }
    ids.add(reference.id);
  }
  return { schemaVersion: 1, references };
}

function encodeJsonl(references) {
  if (!references.length) return Buffer.alloc(0);
  return Buffer.from(`${references.map((reference) => (
    JSON.stringify({ schemaVersion: 1, ...reference })
  )).join("\n")}\n`);
}

function sameManifest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicAgentState(agent) {
  return {
    agentId: agent.agentId,
    state: agent.state,
    references: agent.references
  };
}

async function resolveWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw migrationError("ARGUMENT_INVALID", "--workspace 必须是绝对路径。");
  }
  const requested = path.resolve(value);
  await assertPlainDirectory(requested, "SELFIE_REFERENCE_PATH_INVALID");
  return fs.realpath(requested);
}

async function resolveBackupDirectory(workspace, value) {
  if (typeof value !== "string" || !value) {
    throw migrationError("ARGUMENT_INVALID", "--backup 不能为空。");
  }
  const resolved = path.resolve(workspace, value);
  const backupsRoot = path.join(workspace, "backups");
  const relative = path.relative(backupsRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", "备份必须位于 workspace/backups 内。");
  }
  await assertPlainDirectory(backupsRoot, "SELFIE_REFERENCE_BACKUP_INVALID");
  await assertPlainDirectory(resolved, "SELFIE_REFERENCE_BACKUP_INVALID");
  const [realRoot, realBackup] = await Promise.all([
    fs.realpath(backupsRoot),
    fs.realpath(resolved)
  ]);
  const realRelative = path.relative(realRoot, realBackup);
  if (
    !realRelative
    || realRelative === ".."
    || realRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(realRelative)
  ) {
    throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", "备份路径越界。");
  }
  return realBackup;
}

async function readOptionalRegularFile(filePath) {
  try {
    return await readRegularFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRegularFile(filePath, maxBytes = MAX_MANIFEST_BYTES) {
  const noFollow = Reflect.get(fsConstants, "O_NOFOLLOW");
  if (typeof noFollow !== "number") {
    throw migrationError("SELFIE_REFERENCE_NOFOLLOW_UNAVAILABLE", "当前平台不支持安全文件读取。");
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", `清单文件无效：${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size) {
      throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", `清单读取期间发生变化：${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertOptionalRegularFile(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw migrationError("SELFIE_REFERENCE_PATH_INVALID", `迁移路径必须是普通文件：${filePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertPlainDirectory(directory, code) {
  let stats;
  try {
    stats = await fs.lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw migrationError(code, `目录不存在：${directory}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw migrationError(code, `路径必须是普通目录：${directory}`);
  }
}

async function writeFileAtomic(filePath, bytes) {
  await assertOptionalRegularFile(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertServiceStopped(workspace) {
  let port = 8787;
  const configPath = path.join(workspace, "business", "config", "sunabot.json");
  if (await pathExists(configPath)) {
    const config = JSON.parse(decodeUtf8(await readRegularFile(configPath, 512 * 1024)));
    const configured = Number(config?.server?.port);
    if (Number.isSafeInteger(configured) && configured > 0 && configured <= 65_535) {
      port = configured;
    }
  }
  if (await isListening(port)) {
    throw migrationError("WORKSPACE_SERVICE_RUNNING", `端口 ${port} 正在监听，请先停止 Sunabot。`);
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

function parseBackupManifest(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", "备份 manifest 无效。");
  }
  const root = exactRecord(parsed, ["schemaVersion", "migrationId", "createdAt", "files"]);
  if (root.schemaVersion !== 1 || root.migrationId !== MIGRATION_ID || !Array.isArray(root.files)) {
    throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", "备份 manifest 无效。");
  }
  const files = root.files.map((value) => {
    const record = exactRecord(value, [
      "agentId",
      "backupPath",
      "sourcePath",
      "bytes",
      "sha256",
      "targetSha256"
    ]);
    if (
      typeof record.agentId !== "string"
      || !AGENT_ID_PATTERN.test(record.agentId)
      || record.backupPath !== `agents/${record.agentId}/selfie/${LEGACY_FILE}`
      || record.sourcePath !== `business/agents/${record.agentId}/selfie/${LEGACY_FILE}`
      || !Number.isSafeInteger(record.bytes)
      || record.bytes < 0
      || typeof record.sha256 !== "string"
      || !REFERENCE_ID_PATTERN.test(record.sha256)
      || typeof record.targetSha256 !== "string"
      || !REFERENCE_ID_PATTERN.test(record.targetSha256)
    ) {
      throw migrationError("SELFIE_REFERENCE_BACKUP_INVALID", "备份 manifest 条目无效。");
    }
    return record;
  });
  return { ...root, files };
}

function exactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "清单记录必须是对象。");
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "清单记录字段无效。");
  }
  return value;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw migrationError("SELFIE_REFERENCE_MANIFEST_INVALID", "清单必须是有效 UTF-8。");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseArguments(argv) {
  const command = argv[0] ?? "help";
  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) {
      throw migrationError("ARGUMENT_INVALID", `无法识别参数：${argument}`);
    }
    const key = argument.slice(2);
    if (key === "quiesced") {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw migrationError("ARGUMENT_INVALID", `参数缺少值：${argument}`);
    }
    values.set(key, value);
    index += 1;
  }
  return { command, values, flags };
}

function requiredValue(values, key) {
  const value = values.get(key);
  if (!value) throw migrationError("ARGUMENT_INVALID", `缺少 --${key}。`);
  return value;
}

function requireQuiesced(value) {
  if (!value) {
    throw migrationError("QUIESCED_REQUIRED", "写入迁移必须显式提供 --quiesced。");
  }
}

function usage() {
  return [
    "自拍参考图 JSONL 迁移：",
    "  node tooling/migrations/migrate-selfie-references-jsonl.mjs plan --workspace /absolute/workspace",
    "  node tooling/migrations/migrate-selfie-references-jsonl.mjs apply --workspace /absolute/workspace --quiesced",
    "  node tooling/migrations/migrate-selfie-references-jsonl.mjs verify --workspace /absolute/workspace",
    "  node tooling/migrations/migrate-selfie-references-jsonl.mjs rollback --workspace /absolute/workspace --backup backups/<name> --quiesced"
  ].join("\n");
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
