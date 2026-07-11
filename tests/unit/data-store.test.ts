// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("application SQLite data store", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-data-store-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("imports legacy memory once and keeps subsequent SQLite writes authoritative", async () => {
    const config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const legacyPath = path.join(config.persona.agentWorkspace, "WORKING_MEMORY.jsonl");
    await fs.writeFile(legacyPath, `${JSON.stringify({ id: "legacy-1", fact: "旧记忆" })}\n`);
    const store = applicationDataStore(config);

    expect(store.ensureLegacyMemoryImported("working", legacyPath)).toEqual({ imported: true, count: 1 });
    store.replaceMemory("working", [{ id: "sqlite-1", fact: "新记忆" }]);
    await fs.writeFile(legacyPath, `${JSON.stringify({ id: "legacy-2", fact: "不应覆盖" })}\n`);

    expect(store.ensureLegacyMemoryImported("working", legacyPath)).toEqual({ imported: false, count: 1 });
    expect(store.readMemory("working")).toEqual([{ id: "sqlite-1", fact: "新记忆" }]);
  });

  it("stores conversations independently and queries indexed request logs newest first", () => {
    const config = createAdminTestConfig(root);
    const store = applicationDataStore(config);
    store.replaceConversations([
      conversation("private:1", "2026-07-10T01:00:00.000Z"),
      conversation("private:2", "2026-07-10T02:00:00.000Z")
    ]);
    store.appendRequestLog(log("log-1", "2026-07-10T01:00:00.000Z", "alpha"));
    store.appendRequestLog(log("log-2", "2026-07-10T02:00:00.000Z", "beta"));
    store.replaceMemoryScheduler({
      "private:1": { updatedAt: "2026-07-10T02:00:00.000Z", pendingMessages: [] }
    });
    store.replaceImageHistory([{
      id: "image-1",
      url: "/generated-images/image-1.png",
      filePath: "/tmp/image-1.png",
      createdAt: "2026-07-10T02:00:00.000Z"
    }]);

    expect(store.readConversations().map((record) => record.id)).toEqual(["private:2", "private:1"]);
    expect(store.readRequestLogs({ query: "BETA", limit: 10 })).toEqual([
      expect.objectContaining({ id: "log-2", metadata: { marker: "beta" } })
    ]);
    expect(store.readMemoryScheduler()).toHaveProperty("private:1");
    expect(store.readImageHistory()).toEqual([expect.objectContaining({ id: "image-1" })]);
    expect(store.counts()).toMatchObject({
      conversations: 2,
      requestLogs: 2,
      memorySchedulerConversations: 1,
      imageHistory: 1
    });
  });
});

function conversation(id: string, lastAt: string) {
  return {
    id,
    scope: "private" as const,
    title: id,
    userId: Number(id.split(":")[1]),
    messageCount: 0,
    lastAt,
    lastText: "",
    messages: []
  };
}

function log(id: string, at: string, marker: string) {
  return { id, at, category: "test", action: "write", metadata: { marker } };
}
