// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateScheduledTaskTables,
  SqliteScheduledTaskStore
} from "../../adapters/sqlite/scheduledTaskStore.js";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";

describe("scheduled task SQLite store", () => {
  let database: DatabaseSync;
  let now = Date.parse("2026-07-19T00:00:00.000Z");
  let nextId = 0;
  let allowed: Set<string>;
  let store: SqliteScheduledTaskStore;

  beforeEach(() => {
    now = Date.parse("2026-07-19T00:00:00.000Z");
    nextId = 0;
    database = new DatabaseSync(":memory:");
    allowed = new Set(["private:10001", "group:20001", "account:secondary:group:20002"]);
    store = createStore();
  });

  afterEach(() => {
    if (database.isOpen) database.close();
  });

  it("creates idempotent STRICT tables with due and status indexes", () => {
    migrateScheduledTaskTables(database);
    const tables = database.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE name IN ('scheduled_tasks', 'scheduled_task_runs') ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    expect(tables.map((table) => table.name)).toEqual(["scheduled_task_runs", "scheduled_tasks"]);
    expect(tables.every((table) => table.sql.toLowerCase().includes("strict"))).toBe(true);
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'scheduled_tasks_due'").get())
      .toMatchObject({ name: "scheduled_tasks_due" });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'scheduled_task_runs_status'").get())
      .toMatchObject({ name: "scheduled_task_runs_status" });
  });

  it.each(["10", "11", "12"])("forward migrates application schema %s to 13 and reopens idempotently", async (version) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `sunabot-scheduled-v${version}-`));
    const databasePath = path.join(root, "sunabot.sqlite");
    try {
      const current = new ApplicationDataStore(databasePath);
      current.close();
      const legacy = new DatabaseSync(databasePath);
      legacy.exec("DROP TABLE scheduled_task_runs; DROP TABLE scheduled_tasks;");
      legacy.prepare("UPDATE app_metadata SET value = ? WHERE key = 'storage-schema-version'").run(version);
      legacy.prepare("INSERT INTO app_metadata (key, value) VALUES ('scheduled-test-sentinel', 'keep')").run();
      legacy.prepare(`
        INSERT INTO conversations (id, last_at, data_json) VALUES (?, ?, ?)
      `).run(
        "group:20001",
        "2026-07-19T00:00:00.000Z",
        JSON.stringify({
          id: "group:20001",
          scope: "user_group",
          title: "测试群",
          groupId: 20001,
          messageCount: 0,
          lastAt: "2026-07-19T00:00:00.000Z",
          lastText: "",
          messages: []
        })
      );
      legacy.close();

      const migrated = new ApplicationDataStore(databasePath);
      const futureRunAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const task = migrated.scheduledTasks.create(input("迁移任务", futureRunAt));
      migrated.close();
      const reopened = new ApplicationDataStore(databasePath);
      expect(reopened.scheduledTasks.get(task.id)).toEqual(task);
      reopened.close();

      const verified = new DatabaseSync(databasePath);
      expect(verified.prepare("SELECT value FROM app_metadata WHERE key = 'storage-schema-version'").get())
        .toEqual({ value: "13" });
      expect(verified.prepare("SELECT value FROM app_metadata WHERE key = 'scheduled-test-sentinel'").get())
        .toEqual({ value: "keep" });
      const tables = verified.prepare(`
        SELECT name, sql FROM sqlite_schema
        WHERE name IN ('scheduled_tasks', 'scheduled_task_runs') ORDER BY name
      `).all() as Array<{ name: string; sql: string }>;
      expect(tables).toHaveLength(2);
      expect(tables.every((table) => table.sql.toLowerCase().includes("strict"))).toBe(true);
      verified.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes targets, validates existing conversations, and enforces private mention and size rules", () => {
    const task = store.create({
      name: "  早报  ",
      schedule: once("2026-07-19T01:00:00.000Z"),
      context: "发送今日早报",
      targets: [
        { conversationId: "group:20001", mentionUserIds: ["30001", "30001"] },
        { conversationId: "group:20001", mentionUserIds: ["30002"] },
        { conversationId: "private:10001", mentionUserIds: [] }
      ]
    });
    expect(task).toMatchObject({
      revision: 1,
      name: "早报",
      enabled: true,
      nextRunAt: "2026-07-19T01:00:00.000Z",
      targets: [
        { conversationId: "group:20001", mentionUserIds: ["30001", "30002"] },
        { conversationId: "private:10001", mentionUserIds: [] }
      ]
    });
    expect(store.get(task.id)).toEqual(task);

    expect(() => store.create({
      name: "未知会话",
      schedule: once("2026-07-19T01:00:00.000Z"),
      context: "",
      targets: [{ conversationId: "group:99999", mentionUserIds: [] }]
    })).toThrow("does not exist");
    expect(() => store.create({
      name: "私聊 at",
      schedule: once("2026-07-19T01:00:00.000Z"),
      context: "",
      targets: [{ conversationId: "private:10001", mentionUserIds: ["30001"] }]
    })).toThrow("cannot contain");
    expect(() => store.create({
      name: "非法 QQ",
      schedule: once("2026-07-19T01:00:00.000Z"),
      context: "",
      targets: [{ conversationId: "group:20001", mentionUserIds: ["0"] }]
    })).toThrow("positive QQ");
    expect(() => store.create({
      name: "超限",
      schedule: once("2026-07-19T01:00:00.000Z"),
      context: "",
      targets: Array.from({ length: 21 }, () => ({ conversationId: "group:20001", mentionUserIds: [] }))
    })).toThrow("between 1 and 20");
    expect(() => store.create({
      name: "合并后 at 超限",
      schedule: once("2026-07-19T01:00:00.000Z"),
      context: "",
      targets: [
        { conversationId: "group:20001", mentionUserIds: Array.from({ length: 20 }, (_, index) => String(40_000 + index)) },
        { conversationId: "group:20001", mentionUserIds: ["50000"] }
      ]
    })).toThrow("at most 20 unique");
  });

  it("uses revision CAS for update and delete and provides stable list pagination", () => {
    const first = store.create(input("第一项", "2026-07-19T01:00:00.000Z"));
    const second = store.create(input("第二项", "2026-07-19T02:00:00.000Z"));
    expect(store.update({
      id: first.id,
      expectedRevision: 99,
      context: "旧快照"
    })).toEqual({ status: "conflict", current: first });

    now += 1_000;
    const updated = store.update({
      id: first.id,
      expectedRevision: 1,
      enabled: false,
      context: "新上下文"
    });
    expect(updated).toMatchObject({
      status: "updated",
      task: { revision: 2, enabled: false, context: "新上下文", nextRunAt: null }
    });
    expect(store.list({ limit: 1 })).toEqual({
      items: [expect.objectContaining({ id: first.id })],
      nextCursor: first.id
    });
    expect(store.list({ cursor: first.id, limit: 1 })).toEqual({
      items: [expect.objectContaining({ id: second.id })],
      nextCursor: null
    });
    expect(store.list({ enabled: false }).items.map((task) => task.id)).toEqual([first.id]);

    expect(store.delete(first.id, 1)).toMatchObject({
      status: "conflict",
      current: { revision: 2 }
    });
    expect(store.delete(first.id, 2)).toEqual({ status: "deleted" });
    expect(store.delete(first.id, 2)).toEqual({ status: "not_found" });
  });

  it("keeps reopen migration idempotent and rejects a concurrent stale revision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-scheduled-store-"));
    const databasePath = path.join(root, "sunabot.sqlite");
    const options = {
      clock: () => new Date(now),
      idFactory: () => `file-${++nextId}`,
      allowedConversationIds: (conversationId: string) => allowed.has(conversationId)
    };
    let firstDatabase: DatabaseSync | undefined;
    let secondDatabase: DatabaseSync | undefined;
    try {
      firstDatabase = new DatabaseSync(databasePath);
      const firstStore = new SqliteScheduledTaskStore(firstDatabase, options);
      const task = firstStore.create(input("并发任务", "2026-07-19T01:00:00.000Z"));
      firstDatabase.close();
      firstDatabase = undefined;

      firstDatabase = new DatabaseSync(databasePath);
      secondDatabase = new DatabaseSync(databasePath);
      const reopened = new SqliteScheduledTaskStore(firstDatabase, options);
      const concurrent = new SqliteScheduledTaskStore(secondDatabase, options);
      expect(reopened.get(task.id)).toEqual(task);
      expect(concurrent.get(task.id)).toEqual(task);
      expect(reopened.update({
        id: task.id,
        expectedRevision: 1,
        context: "第一写入者"
      })).toMatchObject({ status: "updated", task: { revision: 2 } });
      expect(concurrent.update({
        id: task.id,
        expectedRevision: 1,
        context: "过期写入者"
      })).toMatchObject({
        status: "conflict",
        current: { revision: 2, context: "第一写入者" }
      });
    } finally {
      if (firstDatabase?.isOpen) firstDatabase.close();
      if (secondDatabase?.isOpen) secondDatabase.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("claims one overdue occurrence, skips the backlog, and deduplicates task plus scheduled time", () => {
    const task = store.create({
      name: "整点任务",
      schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      context: "整点播报",
      targets: [{ conversationId: "group:20001", mentionUserIds: [] }]
    });
    expect(task.nextRunAt).toBe("2026-07-19T01:00:00.000Z");

    now = Date.parse("2026-07-19T03:30:00.000Z");
    const occurrence = store.claimDueOccurrence();
    expect(occurrence).toMatchObject({
      status: "created",
      run: {
        taskId: task.id,
        taskRevision: 1,
        scheduledFor: "2026-07-19T01:00:00.000Z",
        status: "pending",
        attempts: 0
      }
    });
    expect(store.get(task.id)).toMatchObject({
      revision: 1,
      nextRunAt: "2026-07-19T04:00:00.000Z",
      lastScheduledAt: "2026-07-19T01:00:00.000Z"
    });
    expect(store.claimDueOccurrence()).toBeUndefined();

    database.prepare("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?")
      .run("2026-07-19T01:00:00.000Z", task.id);
    expect(store.claimDueOccurrence()).toMatchObject({
      status: "existing",
      run: { id: occurrence!.run.id }
    });
    expect(store.listRuns(task.id)).toHaveLength(1);
    expect(store.get(task.id)?.revision).toBe(1);
  });

  it("persists generated text across an expired lease and completes without regenerating state", () => {
    const task = store.create(input("一次任务", "2026-07-19T00:01:00.000Z"));
    now = Date.parse("2026-07-19T00:02:00.000Z");
    const occurrence = store.claimDueOccurrence()!;
    expect(store.get(task.id)?.nextRunAt).toBeNull();
    expect(store.nextWakeAt()).toBe("2026-07-19T00:02:00.000Z");

    const running = store.claimPendingRun({ workerId: "worker:a", leaseMs: 200 })!;
    expect(running).toMatchObject({ status: "running", attempts: 1, workerId: "worker:a" });
    now += 50;
    const renewed = store.renew({ runId: running.id, workerId: "worker:a", leaseMs: 200 })!;
    expect(Date.parse(renewed.leaseUntil!)).toBe(now + 200);
    const generated = store.markGenerated({
      runId: running.id,
      workerId: "worker:a",
      resultText: "已生成的稳定回复"
    })!;
    expect(generated).toMatchObject({ status: "generated", resultText: "已生成的稳定回复" });

    now += 201;
    store = createStore();
    const recovered = store.claimPendingRun({ workerId: "worker:b", leaseMs: 200 })!;
    expect(recovered).toMatchObject({
      id: occurrence.run.id,
      status: "generated",
      attempts: 2,
      workerId: "worker:b",
      resultText: "已生成的稳定回复"
    });
    expect(store.complete({ runId: recovered.id, workerId: "worker:a" })).toBeUndefined();
    expect(store.complete({ runId: recovered.id, workerId: "worker:b" })).toMatchObject({
      status: "completed",
      resultText: "已生成的稳定回复",
      workerId: null,
      leaseUntil: null
    });
    expect(store.nextWakeAt()).toBeNull();
  });

  it("records a failed claimed run and retains the immutable task snapshot after task deletion", () => {
    const task = store.create(input("失败任务", "2026-07-19T00:01:00.000Z"));
    now = Date.parse("2026-07-19T00:02:00.000Z");
    store.claimDueOccurrence();
    const running = store.claimPendingRun({ workerId: "worker:failure", leaseMs: 1_000 })!;
    expect(store.delete(task.id, task.revision)).toEqual({ status: "deleted" });
    const failed = store.fail({
      runId: running.id,
      workerId: "worker:failure",
      errorText: "provider unavailable"
    })!;
    expect(failed).toMatchObject({
      status: "failed",
      taskId: task.id,
      errorText: "provider unavailable",
      snapshot: { name: "失败任务", context: "提醒内容" }
    });
    expect(store.get(task.id)).toBeUndefined();
    expect(store.getRun(running.id)).toEqual(failed);
  });

  function createStore() {
    return new SqliteScheduledTaskStore(database, {
      clock: () => new Date(now),
      idFactory: () => `scheduled-${++nextId}`,
      allowedConversationIds: (conversationId) => allowed.has(conversationId)
    });
  }
});

function input(name: string, runAt: string) {
  return {
    name,
    schedule: once(runAt),
    context: "提醒内容",
    targets: [{ conversationId: "group:20001", mentionUserIds: ["30001"] }]
  };
}

function once(runAt: string) {
  return { kind: "once" as const, runAt };
}
