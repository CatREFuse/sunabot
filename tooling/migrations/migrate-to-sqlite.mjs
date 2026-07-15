#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { getWorkspacePath, loadConfig, resolveProjectPath } from "../../dist/src/config.js";
import { applicationDatabasePath, applicationDataStore, closeApplicationDataStores } from "../../dist/adapters/sqlite/applicationDataStore.js";
import { SqliteChunkWriter } from "../../dist/services/media/attachments/chunks.js";
import { WORKSPACE_LAYOUT } from "../../dist/packages/platform/workspaceLayout.js";
import {
  createSqliteMigrationRecoveryPoint,
  drillSqliteMigrationRecoveryPoint,
  finalizeSqliteMigrationRecoveryPoint,
  verifySqliteMigrationRecoveryPoint
} from "./sqlite-migration-recovery.mjs";
import { importLegacyApplicationData } from "./sqlite-legacy-import.mjs";

const workspace = getWorkspacePath();
const legacyData = getWorkspacePath(WORKSPACE_LAYOUT.legacyData);
const attachmentCache = getWorkspacePath(WORKSPACE_LAYOUT.attachmentCache);
const config = await loadConfig();
const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
if (!agentWorkspace) throw new Error("Agent workspace is not configured.");

await assertServiceStopped();
await assertNoPendingFileTransaction(agentWorkspace);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupId = `sqlite-migration-${timestamp}`;
const legacy = {
  conversations: path.join(legacyData, "conversations.json"),
  requestLogs: path.join(legacyData, "request-bodies.jsonl"),
  working: path.join(agentWorkspace, "WORKING_MEMORY.jsonl"),
  longTerm: path.join(agentWorkspace, "LONG_TERM_MEMORY.jsonl"),
  userProfile: path.join(agentWorkspace, "USER_PROFILE.jsonl"),
  transactionJournal: path.join(agentWorkspace, "MEMORY_TXN_JOURNAL.jsonl"),
  memoryScheduler: path.join(agentWorkspace, "MEMORY_SCHEDULER.json"),
  imageHistory: path.join(legacyData, "image-history.json")
};

const legacyFiles = Object.values(legacy).filter(await existsFilter());
const chunkFiles = await findFiles(attachmentCache, "chunks.jsonl");
const existingChunkDatabases = await findFiles(attachmentCache, "chunks.sqlite");
const mainDatabasePath = applicationDatabasePath(config);
const safetyCandidates = [
  mainDatabasePath,
  `${mainDatabasePath}-wal`,
  `${mainDatabasePath}-shm`,
  getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue),
  `${getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue)}-wal`,
  `${getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue)}-shm`
];
const safetyFiles = await existingFiles(safetyCandidates);
const sourceDescriptors = await migrationSourceDescriptors(legacy, legacyFiles, chunkFiles);
const databaseDescriptors = [...safetyFiles, ...existingChunkDatabases]
  .filter((filePath) => filePath.endsWith(".sqlite"))
  .map(databaseDescriptor);
const recovery = await createSqliteMigrationRecoveryPoint({
  workspace,
  backupId,
  sources: sourceDescriptors,
  databases: databaseDescriptors
});

const store = applicationDataStore(config);
const imported = await importLegacyApplicationData({ store, databasePath: mainDatabasePath, legacy });
const sourceCounts = imported.sourceCounts;
const databaseCounts = imported.databaseCounts;

let attachmentChunks = 0;
const attachmentChunksBySource = {};
for (const sourcePath of chunkFiles) {
  const chunks = await readJsonl(sourcePath);
  const targetPath = path.join(path.dirname(sourcePath), "chunks.sqlite");
  const writer = await SqliteChunkWriter.open(targetPath);
  try {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.commit();
  } catch (error) {
    await writer.abort();
    throw error;
  }
  const chunkDatabase = new DatabaseSync(targetPath, { readOnly: true });
  try {
    const integrity = chunkDatabase.prepare("PRAGMA integrity_check").get();
    const actual = Number(chunkDatabase.prepare("SELECT COUNT(*) AS count FROM attachment_chunks").get()?.count ?? -1);
    if (String(integrity?.integrity_check ?? "") !== "ok" || actual !== chunks.length) {
      throw new Error(`SQLite attachment verification failed for ${sourcePath}: expected ${chunks.length}, got ${actual}`);
    }
  } finally {
    chunkDatabase.close();
  }
  attachmentChunks += chunks.length;
  attachmentChunksBySource[path.relative(workspace, sourcePath).replace(/\\/g, "/")] = chunks.length;
}
sourceCounts.attachmentChunksBySource = attachmentChunksBySource;

store.checkpoint();
store.compact();
store.checkpoint();
closeApplicationDataStores();

const chunkTargets = chunkFiles.map((sourcePath) => path.join(path.dirname(sourcePath), "chunks.sqlite"));
const targetPaths = [...new Set(await existingFiles([
  mainDatabasePath,
  getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue),
  ...existingChunkDatabases,
  ...chunkTargets
]))];
await finalizeSqliteMigrationRecoveryPoint({
  directory: recovery.directory,
  workspace,
  sourceCounts,
  databaseCounts,
  imports: imported.imports,
  targets: targetPaths.map(databaseDescriptor)
});
await verifySqliteMigrationRecoveryPoint(recovery.directory);
await drillSqliteMigrationRecoveryPoint({ directory: recovery.directory });
for (const filePath of [...legacyFiles, ...chunkFiles]) await fs.rm(filePath, { force: true });
await fs.rm(path.join(agentWorkspace, ".memory-transactions"), { recursive: true, force: true });
await verifySqliteMigrationRecoveryPoint(recovery.directory);

console.log(JSON.stringify({
  ok: true,
  databasePath: store.databasePath,
  backupRoot: recovery.directory,
  counts: databaseCounts,
  attachmentIndexes: chunkFiles.length,
  attachmentChunks
}, null, 2));

async function assertServiceStopped() {
  const pidPath = getWorkspacePath(WORKSPACE_LAYOUT.runtimeTemporary, "sunabot.pid");
  try {
    const pid = Number((await fs.readFile(pidPath, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error(`sunabot is still running with PID ${pid}; stop it before migrating.`);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (await isTcpListening(config.server.port)) {
    throw new Error(`sunabot port ${config.server.port} is still accepting connections; stop the service before migrating.`);
  }
}

function isTcpListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function assertNoPendingFileTransaction(workspace) {
  const journalPath = path.join(workspace, "MEMORY_TXN_JOURNAL.jsonl");
  const entries = await readJsonl(journalPath);
  const latest = new Map(entries.map((entry) => [entry.transactionId, entry]));
  const pending = [...latest.values()].filter((entry) => entry.phase !== "committed");
  if (pending.length) {
    throw new Error(`Found ${pending.length} pending legacy memory transaction(s); start the old service once to recover them.`);
  }
}

async function readJsonl(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record is not an object");
        return [value];
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function findFiles(directory, fileName) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return findFiles(candidate, fileName);
      return entry.isFile() && entry.name === fileName ? [candidate] : [];
    }));
    return nested.flat();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function migrationSourceDescriptors(legacyPaths, legacyFilePaths, chunkFilePaths) {
  const descriptors = [];
  const present = new Set(legacyFilePaths);
  for (const [name, filePath] of Object.entries(legacyPaths)) {
    if (!present.has(filePath)) continue;
    const records = await legacyRecords(name, filePath);
    descriptors.push({
      id: `legacy:${name}`,
      kind: name === "transactionJournal" ? "transaction-journal" : "legacy-source",
      path: filePath,
      recordCount: records.length,
      idempotencyKeys: records.map((record, index) => recordIdentity(record, index))
    });
  }
  for (const filePath of chunkFilePaths) {
    const records = await readJsonl(filePath);
    descriptors.push({
      id: `attachment:${path.relative(workspace, filePath).replace(/\\/g, "/")}`,
      kind: "attachment-chunks-source",
      path: filePath,
      recordCount: records.length,
      idempotencyKeys: records.map((record, index) => String(record.index ?? index))
    });
  }
  return descriptors;
}

async function legacyRecords(name, filePath) {
  if (["requestLogs", "working", "longTerm", "userProfile", "transactionJournal"].includes(name)) {
    return readJsonl(filePath);
  }
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (name === "conversations") {
    const records = Array.isArray(parsed) ? parsed : parsed.conversations;
    if (!Array.isArray(records)) throw new Error(`Invalid conversation store: ${filePath}`);
    return records;
  }
  if (name === "memoryScheduler") {
    if (parsed.version !== 1 || !parsed.conversations || typeof parsed.conversations !== "object") {
      throw new Error(`Invalid memory scheduler store: ${filePath}`);
    }
    return Object.entries(parsed.conversations).map(([id, value]) => ({ id, value }));
  }
  if (!Array.isArray(parsed)) throw new Error(`Invalid JSON array store: ${filePath}`);
  return parsed;
}

function recordIdentity(record, index) {
  for (const key of ["id", "transactionId", "conversationId", "requestId", "index"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return `${key}:${value.trim()}`;
    if (Number.isSafeInteger(value)) return `${key}:${value}`;
  }
  return `row:${index}:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

function databaseDescriptor(filePath) {
  if (filePath === mainDatabasePath) return { id: "application", kind: "application", path: filePath };
  if (filePath === getWorkspacePath(WORKSPACE_LAYOUT.sessionQueue)) {
    return { id: "session_queue", kind: "session_queue", path: filePath };
  }
  return {
    id: `attachment_chunks:${path.relative(workspace, filePath).replace(/\\/g, "/")}`,
    kind: "attachment_chunks",
    path: filePath
  };
}

async function existsFilter() {
  const existing = new Set();
  await Promise.all(Object.values(legacy).map(async (filePath) => {
    try {
      await fs.access(filePath);
      existing.add(filePath);
    } catch {
      // Missing legacy sources are valid on a repeated migration.
    }
  }));
  return (filePath) => existing.has(filePath);
}

async function existingFiles(candidates) {
  const output = [];
  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
      output.push(filePath);
    } catch {
      // Optional safety files may not exist yet.
    }
  }
  return output;
}
