// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applicationDatabasePath,
  applicationDataStore,
  closeApplicationDataStores,
  generatedImageHistoryRecords
} from "../../adapters/sqlite/applicationDataStore.js";
import { runWithAgentRuntimeContext } from "../../packages/platform/runtimeAgentContext.js";
import { appendRequestLogStrict } from "../../adapters/observability/requestLog.js";
import {
  loadConversationRecords,
  saveConversationRecordStrict,
  saveConversationRecordsStrict
} from "../../src/runtime/infrastructure.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("application SQLite data store", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-data-store-"));
  });

  afterEach(async () => {
    closeApplicationDataStores();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("deduplicates outbox conversation projection and request logs atomically", () => {
    const store = applicationDataStore(createAdminTestConfig(root));
    expect(store.replaceConversationsIdempotent("outbox:1:conversation", [
      conversation("private:1", "2026-07-10T01:00:00.000Z")
    ])).toBe(true);
    expect(store.replaceConversationsIdempotent("outbox:1:conversation", [
      conversation("private:2", "2026-07-10T02:00:00.000Z")
    ])).toBe(false);
    expect(store.readConversations().map((record) => record.id)).toEqual(["private:1"]);

    expect(store.appendRequestLogIdempotent(log(
      "outbox:1:request-log",
      "2026-07-10T01:00:00.000Z",
      "first"
    ))).toBe(true);
    expect(store.appendRequestLogIdempotent(log(
      "outbox:1:request-log",
      "2026-07-10T02:00:00.000Z",
      "duplicate"
    ))).toBe(false);
    expect(store.counts().requestLogs).toBe(1);
  });

  it("throws real SQLite failures from strict settle persistence", async () => {
    const config = createAdminTestConfig(root);
    const store = applicationDataStore(config);
    store.close();

    expect(() => saveConversationRecordsStrict([
      conversation("private:1", "2026-07-10T01:00:00.000Z")
    ], "outbox:closed:conversation", config)).toThrow();
    expect(() => saveConversationRecordStrict(
      conversation("private:1", "2026-07-10T01:00:00.000Z"),
      config
    )).toThrow();
    await expect(runWithAgentRuntimeContext(config, () => appendRequestLogStrict({
      category: "test",
      action: "closed"
    }, "outbox:closed:request-log"))).rejects.toThrow();
  });

  it("strictly upserts one conversation without replacing siblings", () => {
    const config = createAdminTestConfig(root);
    const store = applicationDataStore(config);
    store.replaceConversations([
      conversation("private:1", "2026-07-10T01:00:00.000Z"),
      conversation("private:2", "2026-07-10T02:00:00.000Z")
    ]);

    saveConversationRecordStrict({
      ...conversation("private:1", "2026-07-10T03:00:00.000Z"),
      lastText: "strict update",
      orchestratorResponseTimeOverrideEnabled: true,
      orchestratorResponseTimeMs: 15_000
    }, config);

    expect(store.readConversations()).toEqual([
      expect.objectContaining({
        id: "private:1",
        lastText: "strict update",
        orchestratorResponseTimeOverrideEnabled: true,
        orchestratorResponseTimeMs: 15_000
      }),
      expect.objectContaining({ id: "private:2", lastText: "" })
    ]);
  });

  it("recovers a legacy account-prefixed conversation without mutating SQLite on read", () => {
    const config = createAdminTestConfig(root);
    const store = applicationDataStore(config);
    const legacy = {
      ...conversation("account:secondary:group:20002", "2026-07-10T01:00:00.000Z"),
      scope: "user_group" as const,
      userId: 0,
      groupId: 20002,
      replyEnabled: true,
      messageCount: 1,
      messages: [{ id: "90001", role: "user" as const, text: "stored message", at: "2026-07-10T01:00:00.000Z", userId: 10001 }]
    };
    store.replaceConversations([legacy]);
    expect(loadConversationRecords(config)[0]).toMatchObject({
      ...legacy,
      accountId: "secondary"
    });
    expect(store.readConversations()[0]).not.toHaveProperty("accountId");
    saveConversationRecordStrict(loadConversationRecords(config)[0]!, config);
    expect(store.readConversations()[0]?.accountId).toBe("secondary");
  });

  it("preserves explicit accounts and leaves unprefixed and web conversations unchanged", () => {
    const config = createAdminTestConfig(root);
    const store = applicationDataStore(config);
    store.replaceConversations([
      { ...conversation("account:secondary:private:10001", "2026-07-10T01:00:00.000Z"), userId: 10001, accountId: "explicit" },
      conversation("private:10002", "2026-07-10T02:00:00.000Z"),
      { ...conversation("web:admin", "2026-07-10T03:00:00.000Z"), userId: 0 }
    ]);
    expect(loadConversationRecords(config).map((record) => record.accountId)).toEqual([
      undefined, undefined, "explicit"
    ]);
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
    expect(store.readImageHistory()).toEqual([expect.objectContaining({ id: "image-1" })]);
    store.appendImageHistory({
      id: "image-2",
      url: "/generated-images/image-2.png",
      prompt: "追加记录",
      createdAt: "2026-07-10T03:00:00.000Z"
    });
    expect(store.readImageHistory()).toEqual([
      expect.objectContaining({ id: "image-2", prompt: "追加记录" }),
      expect.objectContaining({ id: "image-1" })
    ]);
    expect(store.counts()).toMatchObject({
      conversations: 2,
      requestLogs: 2,
      imageHistory: 2
    });
  });

  it("indexes only regular generated PNG files with stable agent URLs", async () => {
    const imageDir = path.join(root, "images");
    await fs.mkdir(imageDir);
    await fs.writeFile(path.join(imageDir, "2026-07-24T10-29-13-152Z-example.png"), "image");
    await fs.writeFile(path.join(imageDir, "emoji-deadbeef.png"), "emoji");
    await fs.writeFile(path.join(imageDir, "ignored.jpg"), "image");

    expect(generatedImageHistoryRecords(imageDir, "arona")).toEqual([
      expect.objectContaining({
        id: "2026-07-24T10-29-13-152Z-example.png",
        url: "/generated-images/agents/arona/2026-07-24T10-29-13-152Z-example.png",
        createdAt: "2026-07-24T10:29:13.152Z"
      })
    ]);
  });

  it("rejects the retired external main database override", () => {
    const previous = process.env.SUNABOT_DATABASE_PATH;
    process.env.SUNABOT_DATABASE_PATH = path.join(root, "external.sqlite");
    try {
      expect(() => applicationDatabasePath()).toThrow("SUNABOT_DATABASE_PATH 已停止支持");
    } finally {
      if (previous == null) delete process.env.SUNABOT_DATABASE_PATH;
      else process.env.SUNABOT_DATABASE_PATH = previous;
    }
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
