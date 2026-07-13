import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MULTI_AGENT_MIGRATION_MARKER = "business/migrations/multi-agent-v1.json";

export async function inspectMultiAgentMigrationGate(workspaceInput) {
  const workspace = absoluteWorkspace(workspaceInput);
  const markerPath = path.join(workspace, MULTI_AGENT_MIGRATION_MARKER);
  let workspaceStat;
  try {
    workspaceStat = await fs.lstat(workspace);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "fresh", workspace, markerPath, existingEntries: [] };
    throw error;
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw gateError("WORKSPACE_INVALID", `workspace 必须是普通目录且不能是符号链接：${workspace}。`);
  }

  await assertMarkerPathSafe(workspace, markerPath);
  const marker = await readOptionalJson(markerPath);
  if (marker) {
    validateMarker(marker);
    const mainDatabase = path.join(workspace, "business/data/sunabot.sqlite");
    if (marker.kind === "completed-migration" || await pathExists(mainDatabase)) {
      await validateRegisteredWorkspaceState(workspace, marker.kind === "completed-migration" ? marker : undefined);
    }
    return { state: "trusted", workspace, markerPath, marker };
  }

  const existingEntries = (await fs.readdir(workspace)).sort();
  if (existingEntries.length === 0) return { state: "fresh", workspace, markerPath, existingEntries };
  if (await isRecoverableFreshMarkerState(workspace, existingEntries)) {
    return { state: "fresh", workspace, markerPath, existingEntries };
  }
  return { state: "migration-required", workspace, markerPath, existingEntries };
}

export async function prepareFreshInstallMarker(workspaceInput, now = new Date()) {
  const gate = await inspectMultiAgentMigrationGate(workspaceInput);
  if (gate.state === "trusted") return gate;
  if (gate.state !== "fresh") {
    throw gateError(
      "MULTI_AGENT_MIGRATION_REQUIRED",
      "现有 workspace 缺少可信多 Agent 迁移标记；请停服后执行 npm run migrate:multi-agent -- --workspace <绝对路径>，确认计划后增加 --apply --quiesced。",
      { existingEntries: gate.existingEntries }
    );
  }
  const marker = signedMarker({
    schemaVersion: 1,
    kind: "fresh-install",
    createdAt: validDate(now).toISOString(),
    initialWorkspaceState: "empty"
  });
  await removeIncompleteMarkerWrites(gate.markerPath);
  await atomicWriteMarker(gate.workspace, gate.markerPath, marker);
  return { state: "trusted", workspace: gate.workspace, markerPath: gate.markerPath, marker };
}

export async function writeCompletedMigrationMarker(options) {
  const workspace = absoluteWorkspace(options.workspace);
  const markerPath = path.join(workspace, MULTI_AGENT_MIGRATION_MARKER);
  const marker = signedMarker({
    schemaVersion: 1,
    kind: "completed-migration",
    completedAt: validDate(options.completedAt ?? new Date()).toISOString(),
    recoveryPointId: requiredText(options.recoveryPointId, "recoveryPointId"),
    recoveryManifestSha256: sha256Value(options.recoveryManifestSha256, "recoveryManifestSha256"),
    reportSha256: sha256Value(options.reportSha256, "reportSha256"),
    sourceStateSha256: sha256Value(options.sourceStateSha256, "sourceStateSha256"),
    target: {
      agentId: requiredText(options.target?.agentId, "target.agentId"),
      agentWorkspace: requiredText(options.target?.agentWorkspace, "target.agentWorkspace"),
      accountId: requiredText(options.target?.accountId, "target.accountId"),
      webuiPort: validPort(options.target?.webuiPort, "target.webuiPort")
    }
  });
  await validateRegisteredWorkspaceState(workspace, marker);
  await atomicWriteMarker(workspace, markerPath, marker);
  const sealed = await inspectMultiAgentMigrationGate(workspace);
  if (sealed.state !== "trusted" || sealed.marker?.markerSha256 !== marker.markerSha256) {
    throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", "完成标记写入后复验失败。");
  }
  return { markerPath, marker };
}

export function sha256Json(value) {
  return sha256(canonicalJson(value));
}

export async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function validateMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "多 Agent 迁移标记必须是 JSON 对象。");
  }
  const { markerSha256, ...payload } = marker;
  if (sha256Value(markerSha256, "markerSha256") !== sha256Json(payload)) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "多 Agent 迁移标记校验失败。");
  }
  if (payload.schemaVersion !== 1) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "多 Agent 迁移标记版本不受支持。");
  }
  if (payload.kind === "fresh-install") {
    if (payload.initialWorkspaceState !== "empty") {
      throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "首次安装标记缺少空 workspace 证据。");
    }
    validDate(payload.createdAt);
    return;
  }
  if (payload.kind !== "completed-migration") {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "多 Agent 迁移标记类型无效。");
  }
  validDate(payload.completedAt);
  if (!/^sqlite-recovery-[A-Za-z0-9T_Z-]{8,96}$/.test(requiredText(payload.recoveryPointId, "recoveryPointId"))) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "recoveryPointId 无效。");
  }
  sha256Value(payload.recoveryManifestSha256, "recoveryManifestSha256");
  sha256Value(payload.reportSha256, "reportSha256");
  sha256Value(payload.sourceStateSha256, "sourceStateSha256");
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(requiredText(payload.target?.agentId, "target.agentId"))) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "target.agentId 无效。");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requiredText(payload.target?.accountId, "target.accountId"))) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "target.accountId 无效。");
  }
  const agentWorkspace = requiredText(payload.target?.agentWorkspace, "target.agentWorkspace");
  if (agentWorkspace !== `workspace/business/agents/${payload.target.agentId}`) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "target.agentWorkspace 无效。");
  }
  validPort(payload.target?.webuiPort, "target.webuiPort");
}

async function validateRegisteredWorkspaceState(workspace, marker) {
  const mainDatabase = path.join(workspace, "business/data/sunabot.sqlite");
  const requiredPaths = [
    { filePath: mainDatabase, kind: "file" },
    { filePath: path.join(workspace, "business/data/session-queue.sqlite"), kind: "file" }
  ];
  for (const entry of requiredPaths) await assertRequiredPath(workspace, entry.filePath, entry.kind);

  let database;
  try {
    database = new DatabaseSync(mainDatabase, { readOnly: true, timeout: 5_000 });
    const tableNames = new Set(database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('agents', 'agent_accounts')
    `).all().map((row) => String(row.name)));
    if (!tableNames.has("agents") || !tableNames.has("agent_accounts")) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", "注册数据库缺少多 Agent 表。");
    }
    const agents = database.prepare("SELECT id, workspace FROM agents ORDER BY id").all().map((row) => ({
      id: String(row.id),
      workspace: String(row.workspace)
    }));
    const accounts = database.prepare(`
      SELECT id, agent_id, webui_port FROM agent_accounts ORDER BY id
    `).all().map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      webuiPort: Number(row.webui_port)
    }));
    await validateRegisteredAgents(workspace, agents);
    await validateRegisteredAccounts(workspace, agents, accounts);
    validatePrimaryRegistration(agents, accounts);
    if (marker) validateCompletedTarget(marker, agents, accounts);
  } catch (error) {
    if (error?.code === "MULTI_AGENT_MIGRATION_STATE_INVALID") throw error;
    throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `注册数据库无法验证：${error.message}`);
  } finally {
    database?.close();
  }
}

async function validateRegisteredAgents(workspace, agents) {
  if (agents.length === 0) {
    throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", "注册数据库中没有 Agent。");
  }
  for (const agent of agents) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(agent.id)) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `Agent ID 无效：${agent.id}。`);
    }
    const expectedWorkspace = `workspace/business/agents/${agent.id}`;
    if (agent.workspace !== expectedWorkspace) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `Agent workspace 与注册状态不一致：${agent.id}。`);
    }
    const directory = path.join(workspace, "business/agents", agent.id);
    const manifestPath = path.join(directory, "agent.json");
    await assertRequiredPath(workspace, manifestPath, "file");
    if (agent.id !== "plana") {
      await assertRequiredPath(workspace, path.join(directory, "data/sunabot.sqlite"), "file");
      await assertRequiredPath(workspace, path.join(directory, "data/session-queue.sqlite"), "file");
    }
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `Agent manifest 无法读取：${error.message}`);
    }
    if (manifest?.schemaVersion !== 1 || manifest?.id !== agent.id) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `Agent manifest 与注册状态不一致：${agent.id}。`);
    }
  }
}

async function validateRegisteredAccounts(workspace, agents, accounts) {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const webuiPortOwners = new Map();
  for (const account of accounts) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(account.id) || !agentIds.has(account.agentId)) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `QQ 接入注册状态无效：${account.id}。`);
    }
    validPort(account.webuiPort, `agent_accounts.${account.id}.webui_port`, "MULTI_AGENT_MIGRATION_STATE_INVALID");
    const owner = webuiPortOwners.get(account.webuiPort);
    if (owner) {
      throw gateError(
        "MULTI_AGENT_MIGRATION_STATE_INVALID",
        `QQ 接入 WebUI 端口重复：${owner} 与 ${account.id} 共用 ${account.webuiPort}。`
      );
    }
    webuiPortOwners.set(account.webuiPort, account.id);
    for (const segment of ["config-full", "qq", "plugins"]) {
      await assertRequiredPath(
        workspace,
        path.join(workspace, "runtime/napcat/accounts", account.id, segment),
        "directory"
      );
    }
  }
}

function validatePrimaryRegistration(agents, accounts) {
  const plana = agents.find((agent) => agent.id === "plana");
  const primary = accounts.find((account) => account.id === "primary");
  if (!plana || !primary || primary.agentId !== "plana" || primary.webuiPort !== 6099) {
    throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", "Plana/primary 基线注册状态无效。");
  }
}

function validateCompletedTarget(marker, agents, accounts) {
  const agent = agents.find((entry) => entry.id === marker.target.agentId);
  const account = accounts.find((entry) => entry.id === marker.target.accountId);
  if (
    !agent
    || agent.workspace !== marker.target.agentWorkspace
    || !account
    || account.agentId !== marker.target.agentId
    || account.webuiPort !== marker.target.webuiPort
  ) {
    throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", "迁移目标注册状态与完成标记不一致。");
  }
}

async function assertRequiredPath(workspace, filePath, kind) {
  const relative = path.relative(workspace, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `迁移完成状态路径越界：${filePath}。`);
  }
  const segments = relative.split(path.sep);
  let current = workspace;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `迁移完成状态缺少路径：${current}。`);
      }
      throw error;
    }
    const expected = index === segments.length - 1 ? kind : "directory";
    if (stat.isSymbolicLink() || (expected === "file" ? !stat.isFile() : !stat.isDirectory())) {
      throw gateError("MULTI_AGENT_MIGRATION_STATE_INVALID", `迁移完成状态路径无效：${current}。`);
    }
  }
}

function signedMarker(payload) {
  return { ...payload, markerSha256: sha256Json(payload) };
}

async function atomicWriteMarker(workspace, markerPath, marker) {
  await assertMarkerPathSafe(workspace, markerPath);
  await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await fs.rename(temporary, markerPath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function isRecoverableFreshMarkerState(workspace, existingEntries) {
  if (existingEntries.length !== 1 || existingEntries[0] !== "business") return false;
  const business = path.join(workspace, "business");
  const businessEntries = await fs.readdir(business, { withFileTypes: true });
  if (businessEntries.length !== 1 || businessEntries[0].name !== "migrations" || !businessEntries[0].isDirectory()) {
    return false;
  }
  const migrations = path.join(business, "migrations");
  const migrationEntries = await fs.readdir(migrations, { withFileTypes: true });
  const temporaryPattern = markerTemporaryPattern(path.join(migrations, "multi-agent-v1.json"));
  return migrationEntries.every((entry) => entry.isFile() && temporaryPattern.test(entry.name));
}

async function removeIncompleteMarkerWrites(markerPath) {
  let entries;
  try {
    entries = await fs.readdir(path.dirname(markerPath), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const temporaryPattern = markerTemporaryPattern(markerPath);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && temporaryPattern.test(entry.name))
    .map((entry) => fs.rm(path.join(path.dirname(markerPath), entry.name), { force: true })));
}

function markerTemporaryPattern(markerPath) {
  const escaped = path.basename(markerPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.\\d+\\.\\d+\\.tmp$`);
}

async function assertMarkerPathSafe(workspace, markerPath) {
  const entries = [
    { filePath: path.join(workspace, "business"), kind: "directory" },
    { filePath: path.join(workspace, "business/migrations"), kind: "directory" },
    { filePath: markerPath, kind: "file" }
  ];
  for (const entry of entries) {
    let stat;
    try {
      stat = await fs.lstat(entry.filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || (entry.kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
      throw gateError(
        "MULTI_AGENT_MIGRATION_MARKER_INVALID",
        `多 Agent 迁移标记路径包含无效的${entry.kind === "directory" ? "目录" : "文件"}：${entry.filePath}。`
      );
    }
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", `${filePath} 不是有效 JSON。`);
    }
    throw error;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", `${label} 缺失。`);
  }
  return value.trim();
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", `${label} 必须是 SHA-256。`);
  }
  return value;
}

function validPort(value, label, code = "MULTI_AGENT_MIGRATION_MARKER_INVALID") {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw gateError(code, `${label} 必须是有效端口。`);
  }
  return value;
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

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw gateError("MULTI_AGENT_MIGRATION_MARKER_INVALID", "迁移标记时间无效。");
  }
  return date;
}

function absoluteWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw gateError("WORKSPACE_INVALID", "workspace 必须是绝对路径。");
  }
  return path.normalize(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gateError(code, message, details) {
  const error = new Error(message);
  error.name = "MultiAgentMigrationGateError";
  error.code = code;
  error.details = details;
  return error;
}
