import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  parseWorkingMemoryMarkdown,
  renderWorkingMemoryMarkdown,
  type WorkingMemoryDocumentItem
} from "../../services/memory/workingMemoryDocument.js";

const MIGRATION_ID = "dream-working-memory-boundary-v1";
const WORKING_MEMORY_FILE = "WORKING_MEMORY.md";
const FACTUAL_LEGACY_ID = /^working_[a-f0-9]{32}$/u;
const DREAM_LEGACY_ID = /^working_dream_(\d{4})_(\d{2})_(\d{2})(?:_\d+)?$/u;

interface DreamRunEvidence {
  id: string;
  localDate: string;
  generatedAt: string;
}

interface AgentInspection {
  agentId: string;
  filePath: string;
  databasePath: string;
  beforeContent: string;
  afterContent: string;
  beforeSha256: string;
  afterSha256: string;
  changes: Array<{
    id: string;
    action: "restore_dream" | "restore_factual";
    reason: string;
  }>;
  ambiguousIds: string[];
}

export interface DreamWorkingMemoryBoundaryInspection {
  migrationId: typeof MIGRATION_ID;
  workspace: string;
  changedAgents: number;
  restoredDreams: number;
  restoredFactual: number;
  ambiguous: number;
  agents: Array<{
    agentId: string;
    changed: number;
    restoredDreams: number;
    restoredFactual: number;
    ambiguousIds: string[];
    beforeSha256: string;
    afterSha256: string;
  }>;
}

export function repairDreamWorkingMemoryItems(
  items: readonly WorkingMemoryDocumentItem[],
  lookupDreamRun: (runId: string) => DreamRunEvidence | undefined
) {
  const changes: AgentInspection["changes"] = [];
  const ambiguousIds: string[] = [];
  const repaired = items.map((item) => {
    if (item.memoryKind === "dream" || item.sourceKind !== "dream") return item;
    const dreamMatch = DREAM_LEGACY_ID.exec(item.id);
    if (dreamMatch) {
      const localDate = `${dreamMatch[1]}-${dreamMatch[2]}-${dreamMatch[3]}`;
      const run = item.batchId ? lookupDreamRun(item.batchId) : undefined;
      if (!run || run.localDate !== localDate) {
        ambiguousIds.push(item.id);
        return item;
      }
      changes.push({
        id: item.id,
        action: "restore_dream",
        reason: "legacy_dream_id_and_run_match"
      });
      return {
        ...item,
        sourceKind: "dream" as const,
        memoryKind: "dream",
        realityStatus: "imagined",
        factuality: "imagined",
        eventType: "dream",
        subjectKey: `dream:${localDate}`,
        eventKey: `dream:${localDate}`,
        dreamRunId: run.id,
        dreamDate: localDate,
        dreamReviewedAt: run.generatedAt
      };
    }
    if (!FACTUAL_LEGACY_ID.test(item.id)) {
      ambiguousIds.push(item.id);
      return item;
    }
    changes.push({
      id: item.id,
      action: "restore_factual",
      reason: "legacy_host_allocated_factual_id"
    });
    return {
      ...item,
      conversationId: "system:memory",
      conversationScope: "system",
      conversationTitle: "",
      sourceKind: "model_merge" as const,
      batchId: "",
      memoryKind: "",
      realityStatus: "",
      factuality: "",
      dreamRunId: "",
      dreamDate: "",
      dreamReviewedAt: undefined
    };
  });
  return { items: repaired, changes, ambiguousIds };
}

export async function inspectDreamWorkingMemoryBoundary(workspaceInput: string) {
  const workspace = path.resolve(workspaceInput);
  await assertPlainDirectory(workspace);
  const agents = await discoverAgents(workspace);
  const inspections: AgentInspection[] = [];
  for (const agent of agents) {
    const beforeContent = await readRegularUtf8(agent.filePath);
    const items = parseWorkingMemoryMarkdown(beforeContent);
    const database = new DatabaseSync(agent.databasePath, { readOnly: true, timeout: 5_000 });
    try {
      const statement = database.prepare(`
        SELECT id, local_date, COALESCE(generated_at, consolidated_at, completed_at, created_at) AS generated_at
        FROM dream_runs
        WHERE id = ?
      `);
      const repaired = repairDreamWorkingMemoryItems(items, (runId) => {
        const row = statement.get(runId) as {
          id?: unknown;
          local_date?: unknown;
          generated_at?: unknown;
        } | undefined;
        if (!row || typeof row.id !== "string" || typeof row.local_date !== "string" ||
          typeof row.generated_at !== "string") return undefined;
        return { id: row.id, localDate: row.local_date, generatedAt: row.generated_at };
      });
      const afterContent = renderWorkingMemoryMarkdown(repaired.items);
      const roundTrip = parseWorkingMemoryMarkdown(afterContent);
      if (JSON.stringify(roundTrip) !== JSON.stringify(repaired.items)) {
        throw migrationError("WORKING_MEMORY_ROUND_TRIP_FAILED", `${agent.agentId} 修复结果无法完整回读。`);
      }
      inspections.push({
        ...agent,
        beforeContent,
        afterContent,
        beforeSha256: sha256(beforeContent),
        afterSha256: sha256(afterContent),
        changes: repaired.changes,
        ambiguousIds: repaired.ambiguousIds
      });
    } finally {
      database.close();
    }
  }
  return { workspace, inspections };
}

export async function applyDreamWorkingMemoryBoundaryRepair(
  workspaceInput: string,
  options: { quiesced: boolean; now?: Date } = { quiesced: false }
) {
  if (!options.quiesced) {
    throw migrationError("QUIESCED_REQUIRED", "apply 必须在 Sunabot 停止后使用 --quiesced。");
  }
  const inspected = await inspectDreamWorkingMemoryBoundary(workspaceInput);
  const ambiguous = inspected.inspections.flatMap((agent) => agent.ambiguousIds);
  if (ambiguous.length) {
    throw migrationError("AMBIGUOUS_LEGACY_MEMORY", `存在 ${ambiguous.length} 条无法安全分类的历史记录。`);
  }
  const changed = inspected.inspections.filter((agent) => agent.beforeSha256 !== agent.afterSha256);
  if (!changed.length) {
    return {
      inspection: publicInspection(inspected),
      backup: null,
      appliedAgents: 0
    };
  }
  const backup = await createBackup(inspected.workspace, changed, options.now ?? new Date());
  for (const agent of changed) {
    const latest = await readRegularUtf8(agent.filePath);
    if (sha256(latest) !== agent.beforeSha256) {
      throw migrationError("WORKING_MEMORY_CHANGED", `${agent.agentId} 工作记忆在检查后发生变化。`);
    }
  }
  for (const agent of changed) {
    await atomicWrite(agent.filePath, `${agent.afterContent}\n`);
  }
  for (const agent of changed) {
    const installed = await readRegularUtf8(agent.filePath);
    if (sha256(installed) !== sha256(`${agent.afterContent}\n`)) {
      throw migrationError("WORKING_MEMORY_VERIFY_FAILED", `${agent.agentId} 修复后校验失败。`);
    }
    parseWorkingMemoryMarkdown(installed);
  }
  return {
    inspection: publicInspection(inspected),
    backup,
    appliedAgents: changed.length
  };
}

export async function rollbackDreamWorkingMemoryBoundaryRepair(
  workspaceInput: string,
  backupInput: string,
  options: { quiesced: boolean }
) {
  if (!options.quiesced) {
    throw migrationError("QUIESCED_REQUIRED", "rollback 必须在 Sunabot 停止后使用 --quiesced。");
  }
  const workspace = path.resolve(workspaceInput);
  const backupsRoot = path.join(workspace, "backups");
  const backup = path.resolve(workspace, backupInput);
  const relative = path.relative(backupsRoot, backup);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw migrationError("BACKUP_INVALID", "备份必须位于 workspace/backups 内。");
  }
  await assertPlainDirectory(backup);
  const manifestBytes = await readRegularUtf8(path.join(backup, "manifest.json"));
  const checksum = (await readRegularUtf8(path.join(backup, "manifest.sha256"))).trim();
  if (checksum !== `${sha256(manifestBytes)}  manifest.json`) {
    throw migrationError("BACKUP_INVALID", "备份 manifest 校验失败。");
  }
  const manifest = JSON.parse(manifestBytes) as {
    migrationId?: unknown;
    agents?: Array<{
      agentId?: unknown;
      file?: unknown;
      beforeSha256?: unknown;
      afterSha256?: unknown;
    }>;
  };
  if (manifest.migrationId !== MIGRATION_ID || !Array.isArray(manifest.agents)) {
    throw migrationError("BACKUP_INVALID", "备份 manifest 与迁移不匹配。");
  }
  const restores: Array<{ agentId: string; target: string; content: string }> = [];
  for (const entry of manifest.agents) {
    if (typeof entry.agentId !== "string" || typeof entry.file !== "string" ||
      typeof entry.beforeSha256 !== "string" || typeof entry.afterSha256 !== "string") {
      throw migrationError("BACKUP_INVALID", "备份 manifest Agent 项不完整。");
    }
    const source = path.join(backup, entry.file);
    const content = await readRegularUtf8(source);
    if (sha256(content) !== entry.beforeSha256) {
      throw migrationError("BACKUP_INVALID", `${entry.agentId} 备份工作记忆摘要不匹配。`);
    }
    const target = path.join(workspace, "business", "agents", entry.agentId, WORKING_MEMORY_FILE);
    const current = await readRegularUtf8(target);
    if (sha256(current.trimEnd()) !== entry.afterSha256) {
      throw migrationError("WORKING_MEMORY_CHANGED", `${entry.agentId} 工作记忆已在修复后变化，不能自动回滚。`);
    }
    restores.push({ agentId: entry.agentId, target, content });
  }
  for (const restore of restores) {
    await atomicWrite(restore.target, restore.content.endsWith("\n") ? restore.content : `${restore.content}\n`);
  }
  return {
    migrationId: MIGRATION_ID,
    backup,
    restoredAgents: restores.map((restore) => restore.agentId)
  };
}

function publicInspection(inspected: Awaited<ReturnType<typeof inspectDreamWorkingMemoryBoundary>>):
DreamWorkingMemoryBoundaryInspection {
  const agents = inspected.inspections.map((agent) => ({
    agentId: agent.agentId,
    changed: agent.changes.length,
    restoredDreams: agent.changes.filter((change) => change.action === "restore_dream").length,
    restoredFactual: agent.changes.filter((change) => change.action === "restore_factual").length,
    ambiguousIds: agent.ambiguousIds,
    beforeSha256: agent.beforeSha256,
    afterSha256: agent.afterSha256
  }));
  return {
    migrationId: MIGRATION_ID,
    workspace: inspected.workspace,
    changedAgents: agents.filter((agent) => agent.beforeSha256 !== agent.afterSha256).length,
    restoredDreams: agents.reduce((sum, agent) => sum + agent.restoredDreams, 0),
    restoredFactual: agents.reduce((sum, agent) => sum + agent.restoredFactual, 0),
    ambiguous: agents.reduce((sum, agent) => sum + agent.ambiguousIds.length, 0),
    agents
  };
}

async function discoverAgents(workspace: string) {
  const business = path.join(workspace, "business");
  const agentsRoot = path.join(business, "agents");
  await assertPlainDirectory(agentsRoot);
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
  const agents = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const agentId = entry.name;
      return {
        agentId,
        filePath: path.join(agentsRoot, agentId, WORKING_MEMORY_FILE),
        databasePath: agentId === "plana"
          ? path.join(business, "data", "sunabot.sqlite")
          : path.join(agentsRoot, agentId, "data", "sunabot.sqlite")
      };
    });
  for (const agent of agents) {
    await assertRegularFile(agent.filePath);
    await assertRegularFile(agent.databasePath);
  }
  return agents.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

async function createBackup(workspace: string, agents: readonly AgentInspection[], now: Date) {
  const stamp = now.toISOString().replaceAll(/[-:.]/gu, "").replace("Z", "Z");
  const directory = path.join(workspace, "backups", `${MIGRATION_ID}-${stamp}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    migrationId: MIGRATION_ID,
    createdAt: now.toISOString(),
    agents: [] as Array<{
      agentId: string;
      file: string;
      beforeSha256: string;
      afterSha256: string;
      changedIds: string[];
    }>
  };
  for (const agent of agents) {
    const relative = `agents/${agent.agentId}/${WORKING_MEMORY_FILE}`;
    const target = path.join(directory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, agent.beforeContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
    manifest.agents.push({
      agentId: agent.agentId,
      file: relative,
      beforeSha256: agent.beforeSha256,
      afterSha256: agent.afterSha256,
      changedIds: agent.changes.map((change) => change.id)
    });
  }
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(directory, "manifest.json"), manifestBytes, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await fs.writeFile(path.join(directory, "manifest.sha256"), `${sha256(manifestBytes)}  manifest.json\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return {
    directory,
    manifestSha256: sha256(manifestBytes)
  };
}

async function atomicWrite(filePath: string, content: string) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertRegularFile(filePath);
    await fs.rename(temporary, filePath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readRegularUtf8(filePath: string) {
  await assertRegularFile(filePath);
  return fs.readFile(filePath, "utf8");
}

async function assertPlainDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw migrationError("DIRECTORY_UNSAFE", `${directory} 必须是普通目录。`);
  }
}

async function assertRegularFile(filePath: string) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw migrationError("FILE_UNSAFE", `${filePath} 必须是普通文件。`);
  }
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function migrationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function parseArgs(argv: readonly string[]) {
  const command = argv[0] ?? "dry-run";
  const values = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) throw migrationError("ARGUMENT_INVALID", `未知参数：${argument}`);
    const key = argument.slice(2);
    if (key === "quiesced") {
      values.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw migrationError("ARGUMENT_INVALID", `--${key} 缺少值。`);
    values.set(key, value);
    index += 1;
  }
  const workspace = values.get("workspace");
  if (typeof workspace !== "string") throw migrationError("ARGUMENT_INVALID", "--workspace 不能为空。");
  const backup = values.get("backup");
  return {
    command,
    workspace,
    backup: typeof backup === "string" ? backup : undefined,
    quiesced: values.get("quiesced") === true
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "dry-run") {
    const inspected = await inspectDreamWorkingMemoryBoundary(args.workspace);
    console.log(JSON.stringify(publicInspection(inspected), null, 2));
    return;
  }
  if (args.command === "apply") {
    const result = await applyDreamWorkingMemoryBoundaryRepair(args.workspace, {
      quiesced: args.quiesced
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.command === "rollback") {
    if (!args.backup) throw migrationError("ARGUMENT_INVALID", "rollback 需要 --backup。");
    const result = await rollbackDreamWorkingMemoryBoundaryRepair(args.workspace, args.backup, {
      quiesced: args.quiesced
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw migrationError("ARGUMENT_INVALID", `未知命令：${args.command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: typeof error?.code === "string" ? error.code : "DREAM_WORKING_MEMORY_REPAIR_FAILED",
      error: error instanceof Error ? error.message : String(error)
    }));
    process.exitCode = 1;
  });
}
