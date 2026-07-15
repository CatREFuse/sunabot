import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const IMPORTS = [
  { name: "conversations", count: "conversations" },
  { name: "requestLogs", count: "requestLogs" },
  { name: "working", count: "workingMemory" },
  { name: "longTerm", count: "longTermMemory" },
  { name: "userProfile", count: "userProfiles" },
  { name: "memoryScheduler", count: "memorySchedulerConversations" },
  { name: "imageHistory", count: "imageHistory" }
];

export async function importLegacyApplicationData(options) {
  const sources = {};
  for (const definition of IMPORTS) {
    sources[definition.name] = await readLegacySource(definition.name, options.legacy[definition.name]);
  }
  const before = inspectImportKeys(options.databasePath);
  for (const definition of IMPORTS) {
    const source = sources[definition.name];
    if (!source.present) continue;
    assertUniqueKeys(definition.name, source.keys, source.records.length);
    const missing = source.keys.filter((key) => !before[definition.name].has(key));
    if (before[definition.name].size > 0 && missing.length > 0) {
      throw importError(
        "SQLITE_MIGRATION_IMPORT_KEY_MISMATCH",
        `${definition.name} 目标已含数据但缺少 ${missing.length} 个旧来源幂等键。`
      );
    }
  }

  if (sources.conversations.present) options.store.ensureLegacyConversationsImported(options.legacy.conversations);
  if (sources.requestLogs.present) options.store.ensureLegacyRequestLogsImported(options.legacy.requestLogs);
  if (sources.working.present) options.store.ensureLegacyMemoryImported("working", options.legacy.working);
  if (sources.longTerm.present) options.store.ensureLegacyMemoryImported("long_term", options.legacy.longTerm);
  if (sources.userProfile.present) options.store.ensureLegacyMemoryImported("user_profile", options.legacy.userProfile);
  if (sources.memoryScheduler.present) options.store.ensureLegacyMemorySchedulerImported(options.legacy.memoryScheduler);
  if (sources.imageHistory.present) options.store.ensureLegacyImageHistoryImported(options.legacy.imageHistory);

  const after = inspectImportKeys(options.databasePath);
  const imports = {};
  const sourceCounts = {};
  for (const definition of IMPORTS) {
    const source = sources[definition.name];
    sourceCounts[definition.count] = source.records.length;
    if (!source.present) continue;
    const expected = new Set([...before[definition.name], ...source.keys]);
    if (!sameKeys(after[definition.name], expected)) {
      throw importError(
        "SQLITE_MIGRATION_IMPORT_KEY_MISMATCH",
        `${definition.name} 导入后的幂等键集合与旧来源不一致。`
      );
    }
    const delta = [...after[definition.name]].filter((key) => !before[definition.name].has(key));
    const expectedDelta = source.keys.filter((key) => !before[definition.name].has(key));
    if (!sameKeys(new Set(delta), new Set(expectedDelta))) {
      throw importError("SQLITE_MIGRATION_IMPORT_DELTA_MISMATCH", `${definition.name} 导入增量与旧来源不一致。`);
    }
    imports[definition.name] = {
      beforeCount: before[definition.name].size,
      sourceCount: source.keys.length,
      afterCount: after[definition.name].size,
      deltaCount: delta.length,
      sourceKeysSha256: digestKeys(source.keys),
      beforeKeysSha256: digestKeys([...before[definition.name]]),
      afterKeysSha256: digestKeys([...after[definition.name]])
    };
  }
  return { sourceCounts, databaseCounts: options.store.counts(), imports };
}

function inspectImportKeys(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    return {
      conversations: stringColumn(database, "SELECT id AS value FROM conversations"),
      requestLogs: stringColumn(database, "SELECT id AS value FROM request_logs"),
      working: memoryKeys(database, "working"),
      longTerm: memoryKeys(database, "long_term"),
      userProfile: memoryKeys(database, "user_profile"),
      memoryScheduler: stringColumn(database, "SELECT conversation_id AS value FROM memory_scheduler"),
      imageHistory: stringColumn(database, "SELECT id AS value FROM image_history")
    };
  } finally {
    database.close();
  }
}

function stringColumn(database, sql) {
  return new Set(database.prepare(sql).all().map((row) => requiredKey(row.value)));
}

function memoryKeys(database, source) {
  return new Set(database.prepare(`
    SELECT position, record_id, data_json FROM memory_records WHERE source = ? ORDER BY position
  `).all(source).map((row) => memoryKey(JSON.parse(String(row.data_json)), Number(row.position), row.record_id)));
}

async function readLegacySource(name, filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, records: [], keys: [] };
    throw error;
  }
  let records;
  if (["requestLogs", "working", "longTerm", "userProfile"].includes(name)) {
    records = raw.split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record is not an object");
        return [value];
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
  } else {
    const parsed = JSON.parse(raw);
    if (name === "conversations") records = Array.isArray(parsed) ? parsed : parsed.conversations;
    else if (name === "memoryScheduler") {
      if (parsed?.version !== 1 || !parsed.conversations || typeof parsed.conversations !== "object") {
        throw new Error(`Invalid memory scheduler store: ${filePath}`);
      }
      records = Object.entries(parsed.conversations).map(([id, value]) => ({ id, value }));
    } else records = parsed;
    if (!Array.isArray(records)) throw new Error(`Invalid legacy store: ${filePath}`);
  }
  const keys = records.map((record, index) => sourceKey(name, record, index));
  return { present: true, records, keys };
}

function sourceKey(name, record, index) {
  if (["conversations", "requestLogs", "imageHistory", "memoryScheduler"].includes(name)) {
    return requiredKey(record.id);
  }
  return memoryKey(record, index, record.id);
}

function memoryKey(record, position, recordId) {
  if (typeof recordId === "string" && recordId.trim()) return `id:${recordId.trim()}`;
  return `row:${position}:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

function requiredKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw importError("SQLITE_MIGRATION_IMPORT_KEY_INVALID", "旧来源或目标记录缺少稳定幂等键。");
  }
  return value.trim();
}

function assertUniqueKeys(name, keys, recordCount) {
  if (new Set(keys).size !== recordCount) {
    throw importError("SQLITE_MIGRATION_IMPORT_KEY_INVALID", `${name} 旧来源包含重复幂等键。`);
  }
}

function sameKeys(left, right) {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

function digestKeys(keys) {
  return createHash("sha256").update(JSON.stringify([...keys].sort())).digest("hex");
}

function importError(code, message) {
  return Object.assign(new Error(message), { code });
}
