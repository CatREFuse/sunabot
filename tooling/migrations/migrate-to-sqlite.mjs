#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { getWorkspacePath, loadConfig, resolveProjectPath } from "../../dist/src/config.js";
import { applicationDatabasePath, applicationDataStore, closeApplicationDataStores } from "../../dist/adapters/sqlite/applicationDataStore.js";
import { SqliteChunkWriter } from "../../dist/services/media/attachments/chunks.js";
import { WORKSPACE_LAYOUT } from "../../dist/packages/platform/workspaceLayout.js";
import { resolveProjectRoot } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const legacyData = getWorkspacePath(WORKSPACE_LAYOUT.legacyData);
const attachmentCache = getWorkspacePath(WORKSPACE_LAYOUT.attachmentCache);
const config = await loadConfig();
const agentWorkspace = resolveProjectPath(config.persona.agentWorkspace);
if (!agentWorkspace) throw new Error("Agent workspace is not configured.");

await assertServiceStopped();
await assertNoPendingFileTransaction(agentWorkspace);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = getWorkspacePath("backups", `sqlite-migration-${timestamp}`);
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
const legacyFileSet = new Set(legacyFiles);
const chunkFiles = await findFiles(attachmentCache, "chunks.jsonl");
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
await fs.mkdir(backupRoot, { recursive: true });
for (const filePath of [...legacyFiles, ...chunkFiles, ...safetyFiles]) await backupFile(filePath, backupRoot);

const store = applicationDataStore(config);
const sourceCounts = {
  conversations: await countConversationRecords(legacy.conversations),
  requestLogs: (await readJsonl(legacy.requestLogs)).length,
  workingMemory: (await readJsonl(legacy.working)).length,
  longTermMemory: (await readJsonl(legacy.longTerm)).length,
  userProfiles: (await readJsonl(legacy.userProfile)).length,
  memorySchedulerConversations: await countSchedulerConversations(legacy.memoryScheduler),
  imageHistory: await countJsonArray(legacy.imageHistory)
};

store.ensureLegacyConversationsImported(legacy.conversations);
store.ensureLegacyRequestLogsImported(legacy.requestLogs);
store.ensureLegacyMemoryImported("working", legacy.working);
store.ensureLegacyMemoryImported("long_term", legacy.longTerm);
store.ensureLegacyMemoryImported("user_profile", legacy.userProfile);
store.ensureLegacyMemorySchedulerImported(legacy.memoryScheduler);
store.ensureLegacyImageHistoryImported(legacy.imageHistory);

const databaseCounts = store.counts();
const verificationPaths = {
  conversations: legacy.conversations,
  requestLogs: legacy.requestLogs,
  workingMemory: legacy.working,
  longTermMemory: legacy.longTerm,
  userProfiles: legacy.userProfile,
  memorySchedulerConversations: legacy.memoryScheduler,
  imageHistory: legacy.imageHistory
};
for (const [key, expected] of Object.entries(sourceCounts)) {
  if (!legacyFileSet.has(verificationPaths[key])) continue;
  const actual = databaseCounts[key];
  if (actual !== expected) throw new Error(`SQLite verification failed for ${key}: expected ${expected}, got ${actual}`);
}

let attachmentChunks = 0;
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
  attachmentChunks += chunks.length;
}

store.checkpoint();
store.compact();
store.checkpoint();
for (const filePath of [...legacyFiles, ...chunkFiles]) await fs.rm(filePath, { force: true });
await fs.rm(path.join(agentWorkspace, ".memory-transactions"), { recursive: true, force: true });
closeApplicationDataStores();

console.log(JSON.stringify({
  ok: true,
  databasePath: store.databasePath,
  backupRoot,
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

async function countConversationRecords(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    const records = Array.isArray(parsed) ? parsed : parsed.conversations;
    if (!Array.isArray(records)) throw new Error(`Invalid conversation store: ${filePath}`);
    return records.length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function countSchedulerConversations(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed.version !== 1 || !parsed.conversations || typeof parsed.conversations !== "object") {
      throw new Error(`Invalid memory scheduler store: ${filePath}`);
    }
    return Object.keys(parsed.conversations).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function countJsonArray(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`Invalid JSON array store: ${filePath}`);
    return parsed.length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
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

async function backupFile(filePath, destinationRoot) {
  const relative = path.relative(root, filePath);
  const destination = path.join(destinationRoot, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(filePath, destination);
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
