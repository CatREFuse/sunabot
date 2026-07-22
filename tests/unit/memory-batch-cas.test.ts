// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";

describe("memory batch revision CAS", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it.each(["long_term", "user_profile"] as const)(
    "rejects a stale batch after a concurrent %s update",
    async (source) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-cas-"));
      roots.push(root);
      const databasePath = path.join(root, "sunabot.sqlite");
      const first = new ApplicationDataStore(databasePath);
      const second = new ApplicationDataStore(databasePath);
      try {
        const snapshot = first.readMemorySnapshot();
        second.replaceMemory(source, [{ id: `${source}_new`, text: "并发写入" }]);

        expect(first.commitMemoryBatch({
          batchId: `stale-${source}`,
          baselineRevisions: snapshot.revisions,
          working: [],
          longTerm: [],
          userProfile: [],
          result: { status: "applied" }
        })).toEqual({ status: "snapshot_conflict" });
        expect(second.readMemory(source)).toEqual([{ id: `${source}_new`, text: "并发写入" }]);
      } finally {
        first.close();
        second.close();
      }
    }
  );
});
