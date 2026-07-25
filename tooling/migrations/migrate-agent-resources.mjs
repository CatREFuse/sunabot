#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MIGRATION_ID = "agent-workbenches-v2";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const EMOJI_FILE_PATTERN = /^emoji-[a-f0-9]{64}\.png$/;
const EMPTY_EXTENSION_REVISION = createHash("sha256").update("[]").digest("hex");
const MARKER = "business/migrations/agent-workbenches-v2.json";
const WORKBENCH_INDEX = [
  "# 文件工作区",
  "",
  "本目录用于保存当前 Agent 的计划、下载、转存文件和任务产物。",
  "",
  "当前工作区的配置与资料目录：",
  "",
  "- `selfie/`：自拍参考图，入口 `references.jsonl`。",
  "- `emoji/`：表情，入口 `emojis.jsonl`。",
  "- `skills/`：Skills，入口 `index.json`。",
  "- `knowledge/`：知识库，入口 `index.json`。",
  "",
  "进入目录后先读取对应管理入口。入口缺失、损坏或引用不存在时停止猜测，并报告具体目录。",
  "",
  "Docker Bash 在 `native-workbench/` 中只读访问本目录；Native Bash 可通过 `SUNABOT_DOCKER_WORKBENCH` 寻址独立 Docker 工作区。",
  ""
].join("\n");
const DOCKER_WORKBENCH_INDEX = [
  "# Docker 文件工作区",
  "",
  "本目录用于保存 Docker Bash 的计划、下载、转存文件和任务产物。",
  "",
  "Native workbench 只读投影位于 `native-workbench/`：",
  "",
  "- `native-workbench/selfie/`：自拍参考图，入口 `references.jsonl`。",
  "- `native-workbench/emoji/`：表情，入口 `emojis.jsonl`。",
  "- `native-workbench/skills/`：Skills，入口 `index.json`。",
  "- `native-workbench/knowledge/`：知识库，入口 `index.json`。",
  "",
  "进入目录后先读取对应管理入口。只读投影不可修改；需要写入的任务产物保存在当前 Docker 工作区。",
  ""
].join("\n");
const LEGACY_WORKBENCH_INDEX = [
  "# 文件工作区",
  "",
  "本目录用于保存当前 Agent 的计划、下载、转存文件和任务产物。",
  "",
  "读取可访问的配置或资源目录时，先读取该目录的管理文件：当前目录使用 `index.md`，Skills 使用 `index.json`，MCP 使用 `servers.json`，自拍参考图使用 `references.jsonl`，表情使用 `emojis.jsonl`，知识库使用 `index.json`。",
  "",
  "管理文件缺失或损坏时停止猜测目录内容，并报告具体目录。",
  ""
].join("\n");
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "AGENT_RESOURCES_MIGRATION_FAILED",
      message: error?.message ?? String(error)
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { command, values, flags } = parseArguments(argv);
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const workspace = await resolveWorkspace(requiredValue(values, "workspace"));
  const options = { workspace, quiesced: flags.has("quiesced") };
  const result = command === "plan"
    ? await planAgentResourcesMigration(options)
    : command === "apply"
      ? await applyAgentResourcesMigration(options)
      : command === "verify"
        ? await verifyAgentResourcesMigration(options)
        : command === "rollback"
          ? await rollbackAgentResourcesMigration({
            ...options,
            backup: requiredValue(values, "backup")
          })
          : invalid(`未知命令：${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function planAgentResourcesMigration({ workspace: workspaceValue }) {
  const workspace = await resolveWorkspace(workspaceValue);
  const agents = await inspectAgents(workspace);
  return {
    ok: true,
    command: "plan",
    migrationId: MIGRATION_ID,
    workspace,
    changesRequired: agents.some((agent) => agent.changesRequired),
    agents: agents.map(publicAgent)
  };
}

export async function applyAgentResourcesMigration(options) {
  const {
    workspace: workspaceValue,
    quiesced,
    now = new Date(),
    assertStopped = assertServiceStopped
  } = options;
  requireQuiesced(quiesced);
  const workspace = await resolveWorkspace(workspaceValue);
  await assertStopped();
  const markerPath = path.join(workspace, MARKER);
  if (await exists(markerPath)) return verifyAgentResourcesMigration({ workspace });
  const agents = await inspectAgents(workspace);
  const backup = await createBackup(workspace, agents, now);

  for (const agent of agents) {
    await fs.mkdir(agent.workbench, { recursive: true, mode: 0o700 });
    await moveDirectory(agent.legacySelfie, agent.selfie);
    await moveDirectory(agent.legacySkills, agent.skills);
    await moveDirectory(agent.legacyKnowledge, agent.knowledge);
    await moveEmojiFiles(agent);
    await ensureResourceIndexes(agent, now.toISOString());
  }

  const migrated = await inspectAgents(workspace);
  const after = [];
  for (const agent of migrated) {
    after.push({
      agentId: agent.agentId,
      resourcesSha256: await agentResourceDigest(agent)
    });
  }
  for (const entry of backup.manifest.agents) {
    entry.afterResourcesSha256 = after.find((candidate) => candidate.agentId === entry.agentId)?.resourcesSha256;
  }
  const backupManifestBytes = Buffer.from(`${JSON.stringify(backup.manifest, null, 2)}\n`);
  await atomicWrite(backup.manifestPath, backupManifestBytes);
  backup.manifestSha256 = sha256(backupManifestBytes);
  await atomicWrite(
    path.join(backup.directory, "manifest.sha256"),
    Buffer.from(`${backup.manifestSha256}  manifest.json\n`)
  );
  const marker = {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    createdAt: now.toISOString(),
    backup: path.relative(workspace, backup.directory).replaceAll("\\", "/"),
    backupManifestSha256: backup.manifestSha256,
    agents: after
  };
  await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  await atomicWrite(markerPath, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`));
  return verifyAgentResourcesMigration({ workspace });
}

export async function verifyAgentResourcesMigration({ workspace: workspaceValue }) {
  const workspace = await resolveWorkspace(workspaceValue);
  const markerPath = path.join(workspace, MARKER);
  const marker = JSON.parse((await readRegularFile(markerPath, 2 * 1024 * 1024)).toString("utf8"));
  if (
    marker?.schemaVersion !== 1
    || marker?.migrationId !== MIGRATION_ID
    || !Array.isArray(marker.agents)
  ) invalid("资源迁移 marker 无效。", "AGENT_RESOURCES_MARKER_INVALID");
  const agents = await inspectAgents(workspace);
  for (const agent of agents) {
    if (agent.changesRequired) {
      invalid(`Agent 资源仍位于旧目录：${agent.agentId}`, "AGENT_RESOURCES_VERIFY_FAILED");
    }
    await verifyIndexes(agent);
  }
  return {
    ok: true,
    command: "verify",
    migrationId: MIGRATION_ID,
    workspace,
    backup: marker.backup,
    agents: agents.map(publicAgent)
  };
}

export async function rollbackAgentResourcesMigration(options) {
  const {
    workspace: workspaceValue,
    backup: backupValue,
    quiesced,
    assertStopped = assertServiceStopped
  } = options;
  requireQuiesced(quiesced);
  const workspace = await resolveWorkspace(workspaceValue);
  await assertStopped();
  const backup = await resolveBackup(workspace, backupValue);
  const manifestBytes = await readRegularFile(path.join(backup, "manifest.json"), 2 * 1024 * 1024);
  await verifyManifestChecksum(backup, manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || manifest?.migrationId !== MIGRATION_ID || !Array.isArray(manifest.agents)) {
    invalid("资源迁移备份无效。", "AGENT_RESOURCES_BACKUP_INVALID");
  }
  for (const entry of manifest.agents) {
    const agent = await inspectAgent(workspace, entry.agentId);
    const expectedAfter = entry.afterResourcesSha256;
    if (expectedAfter && expectedAfter !== await agentResourceDigest(agent)) {
      invalid(`资源在迁移后已经变化：${entry.agentId}`, "AGENT_RESOURCES_ROLLBACK_CONFLICT");
    }
    await restoreDirectory(path.join(backup, "agents", entry.agentId, "selfie"), agent.legacySelfie, agent.selfie);
    await restoreDirectory(path.join(backup, "agents", entry.agentId, "skills"), agent.legacySkills, agent.skills);
    await restoreDirectory(path.join(backup, "agents", entry.agentId, "knowledge"), agent.legacyKnowledge, agent.knowledge);
    await restoreEmojiFiles(path.join(backup, "agents", entry.agentId, "emoji"), agent);
  }
  await fs.rm(path.join(workspace, MARKER), { force: true });
  return { ok: true, command: "rollback", migrationId: MIGRATION_ID, workspace };
}

async function inspectAgents(workspace) {
  const root = path.join(workspace, "business", "agents");
  await assertDirectory(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!AGENT_ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      invalid(`Agent 目录无效：${entry.name}`, "AGENT_RESOURCES_PATH_INVALID");
    }
    agents.push(await inspectAgent(workspace, entry.name));
  }
  return agents;
}

async function inspectAgent(workspace, agentId) {
  if (!AGENT_ID_PATTERN.test(agentId)) invalid("Agent ID 无效。", "AGENT_RESOURCES_PATH_INVALID");
  const root = path.join(workspace, "business", "agents", agentId);
  await assertDirectory(root);
  const legacyEmoji = agentId === "plana"
    ? path.join(workspace, "business", "media", "images")
    : path.join(workspace, "business", "media", "images", "agents", agentId);
  const agent = {
    agentId,
    root,
    workbench: path.join(root, "workbench"),
    dockerWorkbench: path.join(root, "docker-workbench"),
    dockerWorkbenchProjection: path.join(root, "docker-workbench", "native-workbench"),
    selfie: path.join(root, "workbench", "selfie"),
    emoji: path.join(root, "workbench", "emoji"),
    skills: path.join(root, "workbench", "skills"),
    knowledge: path.join(root, "workbench", "knowledge"),
    legacySelfie: path.join(root, "selfie"),
    legacySkills: path.join(root, "extensions", "skills"),
    legacyKnowledge: path.join(root, "knowledge"),
    legacyEmoji
  };
  const oldDirectories = await Promise.all([
    exists(agent.legacySelfie),
    exists(agent.legacySkills),
    exists(agent.legacyKnowledge)
  ]);
  const legacyEmojiCatalog = path.join(agent.legacyEmoji, "emojis.jsonl");
  const emojiFiles = await emojiCatalogFiles(legacyEmojiCatalog);
  return {
    ...agent,
    legacyEmojiCatalog,
    emojiFiles,
    changesRequired: oldDirectories.some(Boolean) || emojiFiles.length > 0
  };
}

async function moveDirectory(source, target) {
  if (!(await exists(source))) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
  await assertDirectory(source);
  if (await exists(target)) invalid(`资源目标已存在：${target}`, "AGENT_RESOURCES_TARGET_CONFLICT");
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.rename(source, target);
}

async function moveEmojiFiles(agent) {
  await fs.mkdir(agent.emoji, { recursive: true, mode: 0o700 });
  for (const fileName of agent.emojiFiles) {
    const source = path.join(agent.legacyEmoji, fileName);
    const target = path.join(agent.emoji, fileName);
    if (await exists(target)) invalid(`表情资源目标已存在：${target}`, "AGENT_RESOURCES_TARGET_CONFLICT");
    await fs.rename(source, target);
  }
}

async function ensureResourceIndexes(agent, indexedAt) {
  await fs.mkdir(agent.dockerWorkbenchProjection, { recursive: true, mode: 0o700 });
  await writeWorkbenchIndex(path.join(agent.workbench, "index.md"), WORKBENCH_INDEX);
  await writeWorkbenchIndex(path.join(agent.dockerWorkbench, "index.md"), DOCKER_WORKBENCH_INDEX);
  await writeIfMissingOrEmpty(path.join(agent.selfie, "references.jsonl"), "");
  await writeIfMissingOrEmpty(path.join(agent.emoji, "emojis.jsonl"), "");
  await writeIfMissingOrEmpty(path.join(agent.skills, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    revision: EMPTY_EXTENSION_REVISION,
    skills: []
  }, null, 2)}\n`);
  await writeIfMissingOrEmpty(path.join(agent.knowledge, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    root: "knowledge",
    documents: [],
    fileCount: 0,
    chunkCount: 0,
    errorCount: 0,
    indexedAt
  }, null, 2)}\n`);
  await writeIfMissingOrEmpty(path.join(agent.root, "extensions", "mcp", "servers.json"), `${JSON.stringify({
    schemaVersion: 1,
    revision: EMPTY_EXTENSION_REVISION,
    servers: []
  }, null, 2)}\n`);
}

async function verifyIndexes(agent) {
  await assertDirectory(agent.dockerWorkbenchProjection);
  await readRegularFile(path.join(agent.workbench, "index.md"), 2 * 1024 * 1024);
  await readRegularFile(path.join(agent.dockerWorkbench, "index.md"), 2 * 1024 * 1024);
  await verifyJsonl(path.join(agent.selfie, "references.jsonl"));
  await emojiCatalogFiles(path.join(agent.emoji, "emojis.jsonl"));
  await verifyJson(path.join(agent.skills, "index.json"));
  await verifyJson(path.join(agent.knowledge, "index.json"));
  await verifyJson(path.join(agent.root, "extensions", "mcp", "servers.json"));
}

async function verifyJson(filePath) {
  const bytes = await readRegularFile(filePath, 2 * 1024 * 1024);
  try {
    JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid(`JSON 管理入口无效：${filePath}`, "AGENT_RESOURCES_INDEX_INVALID");
  }
}

async function verifyJsonl(filePath) {
  const bytes = await readRegularFile(filePath, 2 * 1024 * 1024);
  for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
    try {
      JSON.parse(line);
    } catch {
      invalid(`JSONL 管理入口无效：${filePath}`, "AGENT_RESOURCES_INDEX_INVALID");
    }
  }
}

async function emojiCatalogFiles(catalogPath) {
  if (!(await exists(catalogPath))) return [];
  const bytes = await readRegularFile(catalogPath, 2 * 1024 * 1024);
  const files = new Set(["emojis.jsonl"]);
  for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalid(`表情清单无效：${catalogPath}`, "AGENT_RESOURCES_EMOJI_INVALID");
    }
    if (!Array.isArray(record?.versions)) invalid(`表情清单无效：${catalogPath}`, "AGENT_RESOURCES_EMOJI_INVALID");
    for (const version of record.versions) {
      if (!EMOJI_FILE_PATTERN.test(version?.fileName ?? "")) {
        invalid(`表情文件名无效：${catalogPath}`, "AGENT_RESOURCES_EMOJI_INVALID");
      }
      files.add(version.fileName);
    }
  }
  for (const fileName of files) {
    await readRegularFile(path.join(path.dirname(catalogPath), fileName), 20 * 1024 * 1024);
  }
  return [...files].sort();
}

async function createBackup(workspace, agents, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupsRoot = path.join(workspace, "backups");
  await fs.mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  const directory = path.join(backupsRoot, `${MIGRATION_ID}-${stamp}`);
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  const manifestAgents = [];
  for (const agent of agents) {
    const backupAgent = path.join(directory, "agents", agent.agentId);
    await copyIfPresent(agent.legacySelfie, path.join(backupAgent, "selfie"));
    await copyIfPresent(agent.legacySkills, path.join(backupAgent, "skills"));
    await copyIfPresent(agent.legacyKnowledge, path.join(backupAgent, "knowledge"));
    const emojiBackup = path.join(backupAgent, "emoji");
    if (agent.emojiFiles.length) {
      await fs.mkdir(emojiBackup, { recursive: true, mode: 0o700 });
      for (const fileName of agent.emojiFiles) {
        await fs.copyFile(path.join(agent.legacyEmoji, fileName), path.join(emojiBackup, fileName));
      }
    }
    manifestAgents.push({
      agentId: agent.agentId,
      beforeSelfieSha256: await treeDigest(agent.legacySelfie),
      beforeSkillsSha256: await treeDigest(agent.legacySkills),
      beforeKnowledgeSha256: await treeDigest(agent.legacyKnowledge),
      beforeEmojiSha256: await treeDigest(emojiBackup)
    });
  }
  const manifest = {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    createdAt: now.toISOString(),
    agents: manifestAgents
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(directory, "manifest.json");
  await atomicWrite(manifestPath, bytes);
  const manifestSha256 = sha256(bytes);
  await atomicWrite(path.join(directory, "manifest.sha256"), Buffer.from(`${manifestSha256}  manifest.json\n`));
  return { directory, manifestPath, manifest, manifestSha256 };
}

async function copyIfPresent(source, target) {
  if (!(await exists(source))) return;
  await assertTreeSafe(source);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
}

async function restoreDirectory(backup, legacy, target) {
  if (!(await exists(backup))) return;
  if (await exists(legacy)) invalid(`旧资源目录已存在：${legacy}`, "AGENT_RESOURCES_ROLLBACK_CONFLICT");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(legacy), { recursive: true, mode: 0o700 });
  await fs.cp(backup, legacy, { recursive: true, errorOnExist: true, force: false });
}

async function restoreEmojiFiles(backup, agent) {
  if (!(await exists(backup))) return;
  await fs.mkdir(agent.legacyEmoji, { recursive: true, mode: 0o700 });
  for (const fileName of await fs.readdir(backup)) {
    const target = path.join(agent.legacyEmoji, fileName);
    if (await exists(target)) invalid(`旧表情文件已存在：${target}`, "AGENT_RESOURCES_ROLLBACK_CONFLICT");
    await fs.copyFile(path.join(backup, fileName), target);
  }
  await fs.rm(agent.emoji, { recursive: true, force: true });
}

async function agentResourceDigest(agent) {
  return sha256(Buffer.from(JSON.stringify(await Promise.all([
    agent.selfie,
    agent.emoji,
    agent.skills,
    agent.knowledge
  ].map(async (directory) => [path.basename(directory), await treeDigest(directory)])))));
}

async function treeDigest(root) {
  if (!(await exists(root))) return null;
  await assertTreeSafe(root);
  const hash = createHash("sha256");
  const visit = async (directory, relative = "") => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${childRelative}\0`);
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        const bytes = await readRegularFile(child, 64 * 1024 * 1024);
        hash.update(`f\0${childRelative}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      } else {
        invalid(`资源树包含链接或特殊文件：${child}`, "AGENT_RESOURCES_PATH_INVALID");
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function assertTreeSafe(root) {
  await assertDirectory(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await assertTreeSafe(child);
    else if (!entry.isFile()) invalid(`资源树包含链接或特殊文件：${child}`, "AGENT_RESOURCES_PATH_INVALID");
  }
}

async function writeIfMissingOrEmpty(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) invalid(`管理入口无效：${filePath}`, "AGENT_RESOURCES_PATH_INVALID");
    if (stats.size > 0) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWrite(filePath, Buffer.from(content));
}

async function writeWorkbenchIndex(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) invalid(`管理入口无效：${filePath}`, "AGENT_RESOURCES_PATH_INVALID");
    if (stats.size > 0) {
      const current = (await readRegularFile(filePath, 2 * 1024 * 1024)).toString("utf8");
      if (current.trimEnd() !== LEGACY_WORKBENCH_INDEX.trimEnd()) return;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWrite(filePath, Buffer.from(content));
}

async function verifyManifestChecksum(backup, manifestBytes) {
  const checksum = (await readRegularFile(path.join(backup, "manifest.sha256"), 1024))
    .toString("utf8")
    .trim();
  const expected = `${sha256(manifestBytes)}  manifest.json`;
  if (checksum !== expected) invalid("资源迁移备份校验和不匹配。", "AGENT_RESOURCES_BACKUP_INVALID");
}

async function atomicWrite(filePath, bytes) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
}

async function readRegularFile(filePath, maxBytes) {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBytes) {
    invalid(`文件无效：${filePath}`, "AGENT_RESOURCES_PATH_INVALID");
  }
  return fs.readFile(filePath);
}

async function assertDirectory(directory) {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    invalid(`目录无效：${directory}`, "AGENT_RESOURCES_PATH_INVALID");
  }
}

async function resolveWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) invalid("--workspace 必须是绝对路径。");
  await assertDirectory(value);
  return fs.realpath(value);
}

async function resolveBackup(workspace, value) {
  const backup = path.resolve(workspace, value);
  const root = path.join(workspace, "backups");
  const relative = path.relative(root, backup);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalid("--backup 必须位于 workspace/backups。");
  }
  await assertDirectory(backup);
  return fs.realpath(backup);
}

async function assertServiceStopped() {
  for (const port of [8787, 8788]) {
    if (await portOpen(port)) invalid(`端口 ${port} 仍在监听，请先停止 Sunabot。`, "AGENT_RESOURCES_SERVICE_RUNNING");
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function parseArguments(argv) {
  const command = argv[0] ?? "help";
  const values = new Map();
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) invalid(`参数无效：${argument}`);
    const key = argument.slice(2);
    if (key === "quiesced") {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) invalid(`参数缺少值：${argument}`);
    values.set(key, value);
    index += 1;
  }
  return { command, values, flags };
}

function requiredValue(values, key) {
  const value = values.get(key);
  if (!value) invalid(`缺少 --${key}。`);
  return value;
}

function requireQuiesced(value) {
  if (!value) invalid("apply/rollback 必须显式提供 --quiesced。", "AGENT_RESOURCES_QUIESCED_REQUIRED");
}

function publicAgent(agent) {
  return {
    agentId: agent.agentId,
    changesRequired: agent.changesRequired,
    workbench: "workbench",
    emojiFiles: agent.emojiFiles.length
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(candidate) {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function invalid(message, code = "ARGUMENT_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function usage() {
  return [
    "用法：",
    "  npm run migrate:agent-resources -- plan --workspace /absolute/workspace",
    "  npm run migrate:agent-resources -- apply --workspace /absolute/workspace --quiesced",
    "  npm run migrate:agent-resources -- verify --workspace /absolute/workspace",
    "  npm run migrate:agent-resources -- rollback --workspace /absolute/workspace --backup backups/<name> --quiesced"
  ].join("\n");
}
