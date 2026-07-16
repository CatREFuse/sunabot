// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import type { GroupThreadStateV1 } from "../../services/conversations/groupThreadContext.js";

describe("group thread state SQLite store", () => {
  let root = "";
  let databasePath = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-group-thread-state-"));
    databasePath = path.join(root, "sunabot.sqlite");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("forward-migrates schema 9 with the strict thread state table", () => {
    const initial = new ApplicationDataStore(databasePath);
    initial.close();

    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec("DROP TABLE conversation_thread_states");
    oldDatabase.prepare("UPDATE app_metadata SET value = '9' WHERE key = 'storage-schema-version'").run();
    oldDatabase.close();

    const migrated = new ApplicationDataStore(databasePath);
    migrated.close();

    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT value FROM app_metadata WHERE key = 'storage-schema-version'").get())
      .toMatchObject({ value: "10" });
    const sql = String(database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'conversation_thread_states'
    `).get()?.sql ?? "").replaceAll(/\s+/g, " ").toLowerCase();
    expect(sql).toContain("strict");
    expect(sql).toContain("check (state_schema_version = 1)");
    expect(sql).toContain("check (json_valid(state_json))");
    expect(database.prepare("PRAGMA foreign_key_list(conversation_thread_states)").all()).toEqual([
      expect.objectContaining({
        table: "conversations",
        from: "conversation_id",
        to: "id",
        on_update: "CASCADE",
        on_delete: "CASCADE"
      })
    ]);
    database.close();
  });

  it("commits, reads, and deduplicates the latest run key", () => {
    const store = preparedStore();
    const committed = store.commitGroupThreadState(commitInput({
      baseRevision: 0,
      lastRunKey: "run-1",
      state: state(1, 12),
      now: new Date("2026-07-16T01:00:00.000Z")
    }));
    if (committed.status !== "committed") throw new Error(`Unexpected commit status: ${committed.status}`);
    expect(committed).toMatchObject({
      status: "committed",
      record: {
        conversationId: "user_group:100",
        revision: 1,
        processedThroughSequence: 12,
        lastRunKey: "run-1",
        classifierModel: "gpt-cheap",
        promptRevision: "group-thread-v1",
        createdAt: "2026-07-16T01:00:00.000Z",
        updatedAt: "2026-07-16T01:00:00.000Z",
        state: state(1, 12)
      }
    });

    const duplicate = store.commitGroupThreadState(commitInput({
      baseRevision: 0,
      lastRunKey: "run-1",
      state: state(1, 12, "duplicate must not overwrite"),
      now: new Date("2026-07-16T02:00:00.000Z")
    }));
    expect(duplicate).toEqual({ status: "existing", record: committed.record });
    expect(store.readGroupThreadState("user_group:100")).toEqual(committed.record);
    store.close();
  });

  it("rejects stale revisions and sequence rollback without changing durable state", () => {
    const store = preparedStore();
    const first = store.commitGroupThreadState(commitInput({
      baseRevision: 0,
      lastRunKey: "run-1",
      state: state(1, 12)
    }));
    expect(first.status).toBe("committed");

    expect(store.commitGroupThreadState(commitInput({
      baseRevision: 0,
      lastRunKey: "stale-revision",
      state: state(1, 13)
    }))).toMatchObject({ status: "snapshot_conflict", current: { revision: 1 } });

    expect(store.commitGroupThreadState(commitInput({
      baseRevision: 1,
      lastRunKey: "sequence-rollback",
      state: state(2, 11)
    }))).toMatchObject({
      status: "sequence_conflict",
      current: { revision: 1, processedThroughSequence: 12 }
    });

    expect(store.commitGroupThreadState(commitInput({
      baseRevision: 1,
      lastRunKey: "run-2",
      state: state(2, 12)
    }))).toMatchObject({ status: "committed", record: { revision: 2, processedThroughSequence: 12 } });
    store.close();
  });

  it("cascades thread state when its conversation is removed", () => {
    const store = preparedStore();
    expect(store.commitGroupThreadState(commitInput({
      baseRevision: 0,
      lastRunKey: "run-1",
      state: state(1, 12)
    })).status).toBe("committed");

    store.replaceConversations([]);

    expect(store.readGroupThreadState("user_group:100")).toBeUndefined();
    store.close();
  });

  it("rejects a JSON-valid but structurally invalid stored state", () => {
    const store = preparedStore();
    expect(store.commitGroupThreadState(commitInput({
      baseRevision: 0,
      lastRunKey: "run-1",
      state: state(1, 12)
    })).status).toBe("committed");
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE conversation_thread_states SET state_json = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ schemaVersion: 1, revision: 1, processedThroughSequence: 12 }), "user_group:100");
    database.close();

    const reopened = new ApplicationDataStore(databasePath);
    expect(() => reopened.readGroupThreadState("user_group:100")).toThrow("Group thread state is invalid");
    reopened.close();
  });

  function preparedStore() {
    const store = new ApplicationDataStore(databasePath);
    store.replaceConversations([{
      id: "user_group:100",
      scope: "user_group",
      title: "群聊 100",
      userId: 1,
      groupId: 100,
      messageCount: 0,
      lastAt: "2026-07-16T00:00:00.000Z",
      lastText: "",
      messages: []
    }]);
    return store;
  }
});

function state(
  revision: number,
  processedThroughSequence: number,
  topic = "群成员正在讨论杭州明天是否下雨。"
): GroupThreadStateV1 {
  const threadId = "thread:11111111111111111111111111111111";
  return {
    schemaVersion: 1,
    revision,
    processedThroughSequence,
    activeThreadId: threadId,
    threads: [{
      threadId,
      topic,
      status: "active",
      participantUids: ["2218471571"],
      messageIds: ["message-12"],
      anchorMessageId: "message-12",
      lastSequence: processedThroughSequence
    }],
    assignments: [{
      messageId: "message-12",
      primaryThreadId: threadId,
      relatedThreadIds: [],
      relation: "continue",
      confidence: 0.96,
      sequence: processedThroughSequence
    }]
  };
}

function commitInput(input: {
  baseRevision: number;
  lastRunKey: string;
  state: GroupThreadStateV1;
  now?: Date;
}) {
  return {
    conversationId: "user_group:100",
    classifierModel: "gpt-cheap",
    promptRevision: "group-thread-v1",
    ...input
  };
}
