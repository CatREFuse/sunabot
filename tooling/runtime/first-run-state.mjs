import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  inspectMultiAgentMigrationGate,
  MULTI_AGENT_MIGRATION_MARKER,
  sha256Json,
  validateMultiAgentWorkspacePath
} from "../../packages/platform/multiAgentMigrationGate.mjs";

export const FIRST_RUN_JOURNAL = "runtime/first-run-bootstrap.json";
const FIRST_RUN_SIGNING_KEY = "secrets/first-run-bootstrap.key";
const COMPLETED_REPORT = "runtime/first-run-bootstrap.completed.json";
const BOUNDARIES = ["marker", "main", "queue", "manifest", "registration", "account-runtime"];
const MAIN_SCHEMA_VERSION = 17;
const QUEUE_SCHEMA_VERSION = 5;
const MAIN_TABLES = [
  "admin_sessions",
  "agent_accounts",
  "agents",
  "app_metadata",
  "conversations",
  "director_daily_schedule_revisions",
  "director_daily_schedules",
  "director_schedule_task_links",
  "dream_memory_archive",
  "dream_runs",
  "emojis",
  "emoji_versions",
  "image_history",
  "memory_recall_receipts",
  "memory_recall_stats",
  "memory_records",
  "memory_source_revisions",
  "model_call_aggregates",
  "model_call_model_aggregates",
  "outbox_local_effects",
  "request_logs",
  "scheduled_task_runs",
  "scheduled_tasks"
];
const QUEUE_TABLES = ["outbox", "schema_migrations", "session_events", "sessions", "tool_jobs", "turns"];

export async function beginFirstRunBootstrap(workspaceInput, now = new Date()) {
  const workspace = await validateWorkspace(workspaceInput);
  const existing = await inspectFirstRunBootstrap(workspace);
  if (existing.state === "active") return existing;
  const marker = await readAndValidateFreshMarker(workspace);
  if (!marker) return { state: "inactive", workspace };
  if (await safePathExists(workspace, "business/data/sunabot.sqlite", "file")) {
    return { state: "inactive", workspace };
  }
  const signingKey = await ensureSigningKey(workspace);
  const payload = {
    schemaVersion: 1,
    kind: "first-run-bootstrap",
    workspace,
    markerSha256: marker.markerSha256,
    startedAt: validDate(now).toISOString(),
    boundaries: BOUNDARIES
  };
  const journal = signJournal(payload, signingKey);
  await atomicJson(path.join(workspace, FIRST_RUN_JOURNAL), journal);
  return { state: "active", workspace, journal };
}

export async function inspectFirstRunBootstrap(workspaceInput) {
  const workspace = await validateWorkspace(workspaceInput);
  const journalPath = path.join(workspace, FIRST_RUN_JOURNAL);
  const present = await safePathExists(workspace, FIRST_RUN_JOURNAL, "file");
  if (!present) return { state: "inactive", workspace };
  const [journal, signingKey, marker] = await Promise.all([
    readJournal(journalPath),
    readSigningKey(workspace),
    readAndValidateFreshMarker(workspace)
  ]);
  validateJournal(journal, workspace, signingKey);
  if (!marker || marker.markerSha256 !== journal.markerSha256) {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行 journal 与 fresh-install marker 不一致。");
  }
  await validateExistingBoundaries(workspace);
  return { state: "active", workspace, journal };
}

export async function completeFirstRunBootstrap(workspaceInput, now = new Date()) {
  const active = await inspectFirstRunBootstrap(workspaceInput);
  if (active.state !== "active") return active;
  const missing = await missingBoundaries(active.workspace);
  if (missing.length > 0) return { ...active, state: "pending", missing };
  const gate = await inspectMultiAgentMigrationGate(active.workspace).catch((error) => {
    throw firstRunError(
      "FIRST_RUN_BOUNDARY_INVALID",
      `首次运行完整状态复验失败：${safeMessage(error)}。`
    );
  });
  if (gate.state !== "trusted" || gate.marker?.markerSha256 !== active.journal.markerSha256) {
    throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", "首次运行完整状态未通过多 Agent 门禁。");
  }
  const signingKey = await readSigningKey(active.workspace);
  const reportPayload = {
    ...active.journal,
    state: "completed",
    completedAt: validDate(now).toISOString()
  };
  const report = {
    ...reportPayload,
    completionHmacSha256: hmacJson(reportPayload, signingKey)
  };
  await atomicJson(path.join(active.workspace, COMPLETED_REPORT), report);
  await fs.rm(path.join(active.workspace, FIRST_RUN_JOURNAL));
  await syncDirectory(path.join(active.workspace, "runtime"));
  return { state: "completed", workspace: active.workspace, report };
}

export async function rollbackFirstRunBootstrap(workspaceInput, now = new Date()) {
  let active = await inspectFirstRunBootstrap(workspaceInput);
  if (active.state !== "active") return active;
  const signingKey = await readSigningKey(active.workspace);
  const stamp = active.journal.startedAt.replaceAll(/[-:.]/g, "");
  const backup = active.journal.rollback?.backup
    ?? path.join(active.workspace, "backups/first-run-rollback", stamp);
  assertInsideWorkspace(active.workspace, backup);
  await ensureSafeDirectory(active.workspace, path.relative(active.workspace, backup));
  if (!active.journal.rollback) {
    const payload = withoutJournalSignature(active.journal);
    active = {
      ...active,
      journal: signJournal({
        ...payload,
        rollback: {
          backup,
          startedAt: validDate(now).toISOString(),
          moved: []
        }
      }, signingKey)
    };
    await atomicJson(path.join(active.workspace, FIRST_RUN_JOURNAL), active.journal);
  }

  const moved = new Set(active.journal.rollback.moved);
  for (const relative of rollbackEntries()) {
    const source = path.join(active.workspace, relative);
    const destination = path.join(backup, relative);
    const sourceExists = await safePathExists(active.workspace, relative, expectedKind(relative));
    const destinationRelative = path.relative(active.workspace, destination);
    const destinationExists = await safePathExists(active.workspace, destinationRelative, expectedKind(relative));
    if (sourceExists && destinationExists) {
      throw firstRunError("FIRST_RUN_ROLLBACK_CONFLICT", `首次运行回滚源和恢复副本同时存在：${relative}。`);
    }
    if (sourceExists) {
      await ensureSafeDirectory(active.workspace, path.dirname(destinationRelative));
      await fs.rename(source, destination);
      await Promise.all([syncDirectory(path.dirname(source)), syncDirectory(path.dirname(destination))]);
    }
    if (sourceExists || destinationExists) moved.add(relative);
    if (!active.journal.rollback.moved.includes(relative) && moved.has(relative)) {
      const payload = withoutJournalSignature(active.journal);
      active.journal = signJournal({
        ...payload,
        rollback: { ...payload.rollback, moved: [...moved] }
      }, signingKey);
      await atomicJson(path.join(active.workspace, FIRST_RUN_JOURNAL), active.journal);
    }
  }

  const reportPayload = {
    schemaVersion: 1,
    kind: "first-run-rollback",
    state: "rolled-back",
    rolledBackAt: validDate(now).toISOString(),
    markerSha256: active.journal.markerSha256,
    moved: [...moved]
  };
  const report = { ...reportPayload, reportHmacSha256: hmacJson(reportPayload, signingKey) };
  await atomicJson(path.join(backup, "rollback.json"), report);
  await fs.rename(path.join(active.workspace, FIRST_RUN_JOURNAL), path.join(backup, "first-run-bootstrap.json"));
  await Promise.all([syncDirectory(path.join(active.workspace, "runtime")), syncDirectory(backup)]);
  return { state: "rolled-back", workspace: active.workspace, backup, moved: [...moved] };
}

async function validateExistingBoundaries(workspace) {
  const mainPresent = await safePathExists(workspace, "business/data/sunabot.sqlite", "file");
  if (mainPresent) validateSqlite(path.join(workspace, "business/data/sunabot.sqlite"), MAIN_TABLES, "main");
  const queuePresent = await safePathExists(workspace, "business/data/session-queue.sqlite", "file");
  if (queuePresent) validateSqlite(path.join(workspace, "business/data/session-queue.sqlite"), QUEUE_TABLES, "queue");

  const manifestPresent = await safePathExists(workspace, "business/agents/plana/agent.json", "file");
  if (manifestPresent) {
    const manifest = await readJson(path.join(workspace, "business/agents/plana/agent.json"));
    if (
      manifest?.schemaVersion !== 1
      || manifest.id !== "plana"
      || typeof manifest.name !== "string"
      || !manifest.name.trim()
      || !plainObject(manifest.bot)
      || !plainObject(manifest.onebot)
    ) {
      throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", "首次运行的 Plana manifest 无效。");
    }
  }

  for (const relative of [
    "runtime/napcat/accounts/primary",
    "runtime/napcat/accounts/primary/config-full",
    "runtime/napcat/accounts/primary/qq",
    "runtime/napcat/accounts/primary/plugins"
  ]) {
    await safePathExists(workspace, relative, "directory");
  }

  if (mainPresent) validateRegistration(path.join(workspace, "business/data/sunabot.sqlite"));
}

async function missingBoundaries(workspace) {
  const missing = [];
  for (const [boundary, relative, kind] of [
    ["main", "business/data/sunabot.sqlite", "file"],
    ["queue", "business/data/session-queue.sqlite", "file"],
    ["manifest", "business/agents/plana/agent.json", "file"],
    ["account-runtime", "runtime/napcat/accounts/primary/config-full", "directory"],
    ["account-runtime", "runtime/napcat/accounts/primary/qq", "directory"],
    ["account-runtime", "runtime/napcat/accounts/primary/plugins", "directory"]
  ]) {
    if (!await safePathExists(workspace, relative, kind)) missing.push(boundary);
  }
  if (await safePathExists(workspace, "business/data/sunabot.sqlite", "file")) {
    const database = new DatabaseSync(path.join(workspace, "business/data/sunabot.sqlite"), { readOnly: true });
    try {
      const plana = database.prepare("SELECT id FROM agents WHERE id = 'plana'").get();
      const primary = database.prepare("SELECT id FROM agent_accounts WHERE id = 'primary' AND agent_id = 'plana'").get();
      if (!plana || !primary) missing.push("registration");
    } finally {
      database.close();
    }
  } else {
    missing.push("registration");
  }
  return [...new Set(missing)];
}

function validateSqlite(filePath, requiredTables, boundary) {
  let database;
  try {
    database = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("integrity_check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("foreign_key_check failed");
    }
    const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()
      .map((row) => String(row.name)));
    const missing = requiredTables.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`missing tables: ${missing.join(", ")}`);
    if (boundary === "main") validateMainSchema(database);
    if (boundary === "queue") validateQueueSchema(database);
  } catch (error) {
    throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", `首次运行的 ${boundary} SQLite 无效：${safeMessage(error)}。`);
  } finally {
    database?.close();
  }
}

function validateMainSchema(database) {
  const version = Number(database.prepare(
    "SELECT value FROM app_metadata WHERE key = 'storage-schema-version'"
  ).get()?.value);
  if (version !== MAIN_SCHEMA_VERSION) throw new Error(`unsupported main schema ${version}`);
  requireColumns(database, "agents", ["id", "name", "enabled", "workspace", "created_at", "updated_at"]);
  requireColumns(database, "agent_accounts", [
    "id", "agent_id", "label", "qq_id", "enabled", "webui_port", "created_at", "updated_at"
  ]);
  requireColumns(database, "emojis", [
    "emoji_key", "file_name", "source", "size_bytes", "width", "height", "created_at", "updated_at"
  ]);
  requireColumns(database, "emoji_versions", [
    "emoji_key", "file_name", "source", "size_bytes", "width", "height", "created_at"
  ]);
  requireColumns(database, "scheduled_tasks", [
    "id", "revision", "name", "enabled", "permanent_retention", "schedule_kind",
    "cron_expression", "timezone", "run_at",
    "context_text", "targets_json", "next_run_at", "last_scheduled_at", "created_at", "updated_at"
  ]);
  requireColumns(database, "scheduled_task_runs", [
    "id", "task_id", "task_revision", "scheduled_for", "status", "snapshot_json", "result_text",
    "error_text", "attempts", "worker_id", "lease_until", "created_at", "updated_at",
    "generated_at", "completed_at", "delivery_attempts", "last_delivery_error", "next_delivery_at"
  ]);
  requireColumns(database, "memory_source_revisions", ["source", "revision"]);
  requireIndexes(database, "agent_accounts", ["agent_accounts_agent", "agent_accounts_webui_port"]);
  requireIndexes(database, "emojis", ["emojis_updated_at"]);
  requireIndexes(database, "emoji_versions", ["emoji_versions_key_created_at"]);
  requireIndexes(database, "scheduled_tasks", ["scheduled_tasks_due", "scheduled_tasks_archive"]);
  requireIndexes(database, "scheduled_task_runs", ["scheduled_task_runs_status", "scheduled_task_runs_task"]);
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(agent_accounts)").all();
  if (!foreignKeys.some((row) => (
    row.table === "agents"
    && row.from === "agent_id"
    && row.to === "id"
    && row.on_update === "CASCADE"
    && row.on_delete === "RESTRICT"
  ))) {
    throw new Error("agent_accounts foreign key is invalid");
  }
  const emojiVersionForeignKeys = database.prepare("PRAGMA foreign_key_list(emoji_versions)").all();
  if (!emojiVersionForeignKeys.some((row) => (
    row.table === "emojis"
    && row.from === "emoji_key"
    && row.to === "emoji_key"
    && row.on_update === "CASCADE"
    && row.on_delete === "CASCADE"
  ))) {
    throw new Error("emoji_versions foreign key is invalid");
  }
  requireSchemaSql(database, "agents", ["check (enabled in (0, 1))", "workspace text not null unique"]);
  requireSchemaSql(database, "agent_accounts", [
    "check (enabled in (0, 1))",
    "check (webui_port between 1 and 65535)",
    "unique (webui_port)"
  ]);
  requireSchemaSql(database, "emojis", [
    "strict",
    "source in ('upload', 'generated')",
    "check (size_bytes > 0)",
    "check (width > 0)",
    "check (height > 0)"
  ]);
  requireSchemaSql(database, "emoji_versions", [
    "strict",
    "source in ('upload', 'generated')",
    "check (size_bytes > 0)",
    "check (width > 0)",
    "check (height > 0)",
    "primary key (emoji_key, file_name)"
  ]);
  requireSchemaSql(database, "scheduled_tasks", [
    "strict",
    "check (enabled in (0, 1))",
    "check (permanent_retention in (0, 1))",
    "schedule_kind in ('cron', 'once')",
    "check (json_valid(targets_json))",
    "schedule_kind = 'cron' and cron_expression is not null and timezone is not null and run_at is null",
    "schedule_kind = 'once' and cron_expression is null and timezone is null and run_at is not null"
  ]);
  requireSchemaSql(database, "scheduled_task_runs", [
    "strict",
    "status in ('pending', 'running', 'generated', 'completed', 'failed')",
    "check (json_valid(snapshot_json))",
    "check (attempts >= 0)",
    "unique (task_id, scheduled_for)"
  ]);
  requireSchemaSql(database, "memory_source_revisions", [
    "strict",
    "source in ('working', 'long_term', 'user_profile')",
    "check (revision >= 0)"
  ]);
  requireTriggers(database, [
    "memory_records_revision_insert",
    "memory_records_revision_update",
    "memory_records_revision_delete"
  ]);
}

function validateQueueSchema(database) {
  const version = Number(database.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
  ).get()?.version);
  if (version !== QUEUE_SCHEMA_VERSION) throw new Error(`unsupported queue schema ${version}`);
  requireColumns(database, "outbox", [
    "id", "session_id", "sequence", "origin_turn_id", "status",
    "delivery_partition", "partition_sequence", "delivery_state", "settle_attempts",
    "transport_started_at", "remote_receipt_json", "remote_sent_at", "settle_steps_json",
    "settle_started_step", "hold_state", "mutation_fingerprint", "hold_provenance_json",
    "release_provenance_json"
  ]);
  requireIndexes(database, "outbox", [
    "outbox_partition_claim_idx", "outbox_partition_sequence_idx", "outbox_hold_claim_idx"
  ]);
  requireIndexSql(database, "outbox_partition_claim_idx", [
    "on outbox(delivery_state, delivery_partition, partition_sequence, available_at, session_id, sequence)"
  ]);
  requireIndexSql(database, "outbox_partition_sequence_idx", [
    "unique index", "on outbox(delivery_partition, partition_sequence)"
  ]);
  requireIndexSql(database, "outbox_hold_claim_idx", [
    "on outbox(hold_state, delivery_state, available_at, session_id, sequence)"
  ]);
  requireSchemaSql(database, "outbox", [
    "strict",
    "check (sequence > 0)",
    "check (hold_state in ('none', 'held', 'released', 'fallback_released'))",
    "length(mutation_fingerprint) = 71",
    "substr(mutation_fingerprint, 1, 7) = 'sha256:'",
    "json_valid(hold_provenance_json)",
    "json_valid(release_provenance_json)",
    "hold_state = 'none' and mutation_fingerprint is null",
    "hold_state = 'held' and mutation_fingerprint is not null",
    "hold_state in ('released', 'fallback_released') and mutation_fingerprint is not null"
  ]);
}

function requireColumns(database, table, expected) {
  const columns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
  const missing = expected.filter((column) => !columns.has(column));
  if (missing.length > 0) throw new Error(`${table} missing columns: ${missing.join(", ")}`);
}

function requireIndexes(database, table, expected) {
  const indexes = new Set(database.prepare(`PRAGMA index_list(${table})`).all().map((row) => String(row.name)));
  const missing = expected.filter((index) => !indexes.has(index));
  if (missing.length > 0) throw new Error(`${table} missing indexes: ${missing.join(", ")}`);
}

function requireTriggers(database, expected) {
  const triggers = new Set(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'trigger'"
  ).all().map((row) => String(row.name)));
  const missing = expected.filter((trigger) => !triggers.has(trigger));
  if (missing.length > 0) throw new Error(`missing triggers: ${missing.join(", ")}`);
}

function requireIndexSql(database, index, fragments) {
  const sql = String(database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?"
  ).get(index)?.sql ?? "").replaceAll(/\s+/g, " ").toLowerCase();
  const missing = fragments.filter((fragment) => !sql.includes(fragment));
  if (missing.length > 0) throw new Error(`${index} missing constraints: ${missing.join(", ")}`);
}

function requireSchemaSql(database, table, fragments) {
  const sql = String(database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?"
  ).get(table)?.sql ?? "").replaceAll(/\s+/g, " ").toLowerCase();
  const missing = fragments.filter((fragment) => !sql.includes(fragment));
  if (missing.length > 0) throw new Error(`${table} missing constraints: ${missing.join(", ")}`);
}

function validateRegistration(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    const agents = database.prepare("SELECT id, workspace FROM agents ORDER BY id").all();
    const accounts = database.prepare("SELECT id, agent_id, webui_port FROM agent_accounts ORDER BY id").all();
    for (const row of agents) {
      if (row.id !== "plana" || row.workspace !== "workspace/business/agents/plana") {
        throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", "首次运行注册表包含非预期 Agent。");
      }
    }
    for (const row of accounts) {
      if (row.id !== "primary" || row.agent_id !== "plana" || Number(row.webui_port) !== 6099) {
        throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", "首次运行注册表包含非预期 QQ 账号。");
      }
    }
  } finally {
    database.close();
  }
}

function validateJournal(journal, workspace, signingKey) {
  if (
    journal?.schemaVersion !== 1
    || journal.kind !== "first-run-bootstrap"
    || journal.workspace !== workspace
    || typeof journal.markerSha256 !== "string"
    || !Array.isArray(journal.boundaries)
    || journal.boundaries.length !== BOUNDARIES.length
    || journal.boundaries.some((value, index) => value !== BOUNDARIES[index])
  ) {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行 journal 无效。");
  }
  validDate(journal.startedAt);
  if (journal.rollback) {
    assertInsideWorkspace(workspace, journal.rollback.backup);
    validDate(journal.rollback.startedAt);
    if (!Array.isArray(journal.rollback.moved) || journal.rollback.moved.some((item) => !rollbackEntries().includes(item))) {
      throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行回滚 journal 无效。");
    }
  }
  const { journalHmacSha256, ...payload } = journal;
  const expected = hmacJson(payload, signingKey);
  if (!safeHexEqual(journalHmacSha256, expected)) {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行 journal 校验失败。");
  }
}

async function readAndValidateFreshMarker(workspace) {
  const relative = MULTI_AGENT_MIGRATION_MARKER;
  if (!await safePathExists(workspace, relative, "file")) return undefined;
  const marker = await readJson(path.join(workspace, relative));
  const { markerSha256, ...payload } = marker ?? {};
  if (
    payload.schemaVersion !== 1
    || typeof markerSha256 !== "string"
    || markerSha256 !== sha256Json(payload)
  ) {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "fresh-install marker 无效。");
  }
  if (payload.kind !== "fresh-install") return undefined;
  if (payload.initialWorkspaceState !== "empty") {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "fresh-install marker 无效。");
  }
  validDate(payload.createdAt);
  return marker;
}

async function validateWorkspace(workspaceInput) {
  try {
    return await validateMultiAgentWorkspacePath(workspaceInput);
  } catch (error) {
    throw firstRunError("FIRST_RUN_PATH_INVALID", safeMessage(error));
  }
}

async function safePathExists(workspace, relative, expectedKind) {
  const target = path.resolve(workspace, relative);
  assertInsideWorkspace(workspace, target);
  const segments = path.relative(workspace, target).split(path.sep).filter(Boolean);
  let current = workspace;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!stat) return false;
    const final = index === segments.length - 1;
    if (stat.isSymbolicLink() || (!final && !stat.isDirectory())) {
      throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", `首次运行路径无效：${current}。`);
    }
    if (final && (expectedKind === "file" ? !stat.isFile() : !stat.isDirectory())) {
      throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", `首次运行路径类型无效：${current}。`);
    }
  }
  const real = await fs.realpath(target);
  assertInsideWorkspace(await fs.realpath(workspace), real);
  return true;
}

async function ensureSafeDirectory(workspace, relative) {
  if (!relative || relative === ".") return;
  const target = path.resolve(workspace, relative);
  assertInsideWorkspace(workspace, target);
  const segments = path.relative(workspace, target).split(path.sep).filter(Boolean);
  let current = workspace;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", `首次运行目录无效：${current}。`);
      }
    } else {
      await fs.mkdir(current, { mode: 0o700 });
      await syncDirectory(path.dirname(current));
    }
  }
}

async function ensureSigningKey(workspace) {
  const keyPath = path.join(workspace, FIRST_RUN_SIGNING_KEY);
  if (await safePathExists(workspace, FIRST_RUN_SIGNING_KEY, "file")) return readSigningKey(workspace);
  await ensureSafeDirectory(workspace, path.dirname(FIRST_RUN_SIGNING_KEY));
  const key = crypto.randomBytes(32).toString("hex");
  await atomicText(keyPath, `${key}\n`, 0o600);
  return key;
}

async function readSigningKey(workspace) {
  if (!await safePathExists(workspace, FIRST_RUN_SIGNING_KEY, "file")) {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行 journal 签名密钥缺失。");
  }
  const key = (await fs.readFile(path.join(workspace, FIRST_RUN_SIGNING_KEY), "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行 journal 签名密钥无效。");
  }
  return key;
}

function signJournal(payload, signingKey) {
  return { ...payload, journalHmacSha256: hmacJson(payload, signingKey) };
}

function withoutJournalSignature(journal) {
  const { journalHmacSha256: _signature, ...payload } = journal;
  return payload;
}

function hmacJson(value, key) {
  return crypto.createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(sortObject(value)))
    .digest("hex");
}

function safeHexEqual(actual, expected) {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function rollbackEntries() {
  return [
    "runtime/napcat/accounts/primary",
    "business/agents/plana",
    "business/data/session-queue.sqlite-wal",
    "business/data/session-queue.sqlite-shm",
    "business/data/session-queue.sqlite",
    "business/data/sunabot.sqlite-wal",
    "business/data/sunabot.sqlite-shm",
    "business/data/sunabot.sqlite"
  ];
}

function expectedKind(relative) {
  return relative === "runtime/napcat/accounts/primary" || relative === "business/agents/plana"
    ? "directory"
    : "file";
}

function assertInsideWorkspace(workspace, target) {
  const relative = path.relative(workspace, target);
  if (!relative || relative === ".") return;
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw firstRunError("FIRST_RUN_PATH_INVALID", `首次运行路径越界：${target}。`);
  }
}

async function atomicJson(filePath, value) {
  await atomicText(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function atomicText(filePath, value, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true });
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

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行时间无效。");
  return date;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw firstRunError("FIRST_RUN_BOUNDARY_INVALID", `首次运行 JSON 无效：${filePath}。`);
    }
    throw error;
  }
}

async function readJournal(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "FIRST_RUN_BOUNDARY_INVALID") {
      throw firstRunError("FIRST_RUN_JOURNAL_INVALID", "首次运行 journal 无效。");
    }
    throw error;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeMessage(value) {
  return (value instanceof Error ? value.message : String(value ?? "未知错误")).replaceAll(/[\r\n]+/g, " ").slice(0, 1_000);
}

function firstRunError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
