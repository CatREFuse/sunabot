import type { DatabaseSync } from "node:sqlite";
import type { MemoryDataSource, MemorySourceRevisions } from "../../services/memory/persistence.js";

type JsonObject = Record<string, unknown>;

type SqlRow = Record<string, unknown>;

export function readMemorySourceRevisions(database: DatabaseSync): MemorySourceRevisions {
  const revisions = { working: -1, long_term: -1, user_profile: -1 };
  for (const row of database.prepare(`
    SELECT source, revision FROM memory_source_revisions ORDER BY source
  `).all() as SqlRow[]) {
    const source = String(row.source) as MemoryDataSource;
    revisions[source] = Number(row.revision);
  }
  if (Object.values(revisions).some((revision) => !Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error("Memory source revisions are incomplete.");
  }
  return revisions;
}

export function readMemorySourceSnapshot(
  database: DatabaseSync,
  read: (source: MemoryDataSource) => JsonObject[]
) {
  return {
    records: {
      working: read("working"),
      long_term: read("long_term"),
      user_profile: read("user_profile")
    },
    revisions: readMemorySourceRevisions(database)
  };
}
