// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteScheduledTaskStore } from "../../adapters/sqlite/scheduledTaskStore.js";
import { ScheduledTaskScheduler } from "../../services/scheduling/public.js";

describe("ScheduledTaskScheduler", () => {
  let database: DatabaseSync;
  let now = Date.parse("2026-07-19T00:00:00.000Z");
  let nextId = 0;
  let store: SqliteScheduledTaskStore;

  beforeEach(() => {
    now = Date.parse("2026-07-19T00:00:00.000Z");
    nextId = 0;
    database = new DatabaseSync(":memory:");
    store = new SqliteScheduledTaskStore(database, {
      clock: () => new Date(now),
      idFactory: () => `scheduler-${++nextId}`,
      allowedConversationIds: (conversationId) => conversationId === "group:20001"
    });
  });

  afterEach(() => {
    if (database.isOpen) database.close();
  });

  it("claims a due occurrence, generates once, delivers, and completes it", async () => {
    const task = createTask("2026-07-19T00:01:00.000Z");
    now = Date.parse("2026-07-19T00:02:00.000Z");
    const generate = vi.fn(async () => "定时回复");
    const deliver = vi.fn(async () => undefined);
    const scheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:worker-a",
      leaseMs: 500,
      clock: () => new Date(now),
      generate,
      deliver
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      claimedOccurrences: 1,
      claimedRuns: 1,
      generatedRuns: 1,
      deliveredRuns: 1,
      completedRuns: 1,
      failedRuns: 0
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ status: "generated", resultText: "定时回复" }),
      expect.any(AbortSignal)
    );
    expect(store.listRuns(task.id)).toEqual([
      expect.objectContaining({ status: "completed", resultText: "定时回复" })
    ]);
    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimedOccurrences: 0, claimedRuns: 0 });
  });

  it("purges an expired archive during the normal scheduler drain", async () => {
    const task = createTask("2026-07-19T00:01:00.000Z");
    now = Date.parse("2026-07-19T00:02:00.000Z");
    const scheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:archive-cleanup",
      leaseMs: 500,
      clock: () => new Date(now),
      generate: async () => "定时回复",
      deliver: async () => undefined
    });
    await scheduler.runOnce();
    expect(store.get(task.id)).toBeDefined();

    now = Date.parse("2026-07-22T00:02:00.000Z");
    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimedOccurrences: 0, claimedRuns: 0 });
    expect(store.get(task.id)).toBeUndefined();
    expect(store.listRuns(task.id)).toHaveLength(1);
  });

  it("recovers a generated run after lease expiry without calling generate again", async () => {
    const task = createTask("2026-07-19T00:01:00.000Z");
    now = Date.parse("2026-07-19T00:02:00.000Z");
    store.claimDueOccurrence();
    const running = store.claimPendingRun({ workerId: "scheduler:crashed", leaseMs: 200 })!;
    store.markGenerated({
      runId: running.id,
      workerId: "scheduler:crashed",
      resultText: "崩溃前已经生成"
    });
    now += 201;

    const generate = vi.fn(async () => "不应重新生成");
    const deliver = vi.fn(async () => undefined);
    const scheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:recovery",
      leaseMs: 200,
      clock: () => new Date(now),
      generate,
      deliver
    });
    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimedOccurrences: 0,
      claimedRuns: 1,
      generatedRuns: 0,
      deliveredRuns: 1,
      completedRuns: 1
    });
    expect(generate).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ resultText: "崩溃前已经生成", attempts: 2 }),
      expect.any(AbortSignal)
    );
    expect(store.listRuns(task.id)[0]).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("retains generated output after delivery failure and retries only delivery", async () => {
    createTask("2026-07-19T00:01:00.000Z");
    now = Date.parse("2026-07-19T00:02:00.000Z");
    const generate = vi.fn(async () => "持久化回复");
    const firstDelivery = vi.fn(async () => { throw new Error("transport offline"); });
    const errors = vi.fn();
    const firstScheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:first",
      leaseMs: 200,
      clock: () => new Date(now),
      generate,
      deliver: firstDelivery,
      onError: errors
    });
    await expect(firstScheduler.runOnce()).resolves.toMatchObject({
      generatedRuns: 1,
      deliveredRuns: 0,
      completedRuns: 0,
      failedRuns: 0
    });
    const generated = store.listRuns()[0]!;
    expect(generated).toMatchObject({
      status: "generated",
      resultText: "持久化回复",
      deliveryAttempts: 1,
      lastDeliveryError: "transport offline",
      nextDeliveryAt: expect.any(String)
    });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transport offline" }),
      expect.objectContaining({ phase: "deliver" })
    );

    now = Date.parse(generated.nextDeliveryAt!) + 1;
    const recoveredDelivery = vi.fn(async () => undefined);
    const recoveryScheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:second",
      leaseMs: 200,
      clock: () => new Date(now),
      generate,
      deliver: recoveredDelivery
    });
    await recoveryScheduler.runOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(recoveredDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "generated", resultText: "持久化回复" }),
      expect.any(AbortSignal)
    );
    expect(store.listRuns()[0]).toMatchObject({ status: "completed", attempts: 2, deliveryAttempts: 1 });
  });

  it("backs off delivery failures and terminally fails the third delivery attempt", async () => {
    createTask("2026-07-19T00:01:00.000Z");
    now = Date.parse("2026-07-19T00:02:00.000Z");
    const deliver = vi.fn(async () => { throw new Error("transport offline"); });
    const scheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:delivery-limit",
      leaseMs: 200,
      clock: () => new Date(now),
      generate: async () => "只生成一次",
      deliver
    });

    await scheduler.runOnce();
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      now = Date.parse(store.listRuns()[0]!.nextDeliveryAt!) + 1;
      const result = await scheduler.runOnce();
      if (attempt === 3) expect(result.failedRuns).toBe(1);
    }

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(store.listRuns()[0]).toMatchObject({
      status: "failed",
      deliveryAttempts: 3,
      errorText: "transport offline",
      nextDeliveryAt: null,
      completedAt: expect.any(String)
    });

    const failed = store.listRuns()[0]!;
    expect(store.replayDelivery({ runId: failed.id, now: new Date(now) })).toMatchObject({
      status: "generated",
      resultText: "只生成一次",
      deliveryAttempts: 0,
      lastDeliveryError: null,
      nextDeliveryAt: new Date(now).toISOString(),
      completedAt: null
    });
    const replayDelivery = vi.fn(async () => undefined);
    const replayScheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:manual-replay",
      leaseMs: 200,
      clock: () => new Date(now),
      generate: async () => { throw new Error("must not regenerate"); },
      deliver: replayDelivery
    });
    await expect(replayScheduler.runOnce()).resolves.toMatchObject({ completedRuns: 1 });
    expect(replayDelivery).toHaveBeenCalledOnce();
    expect(store.listRuns()[0]).toMatchObject({ status: "completed", deliveryAttempts: 0 });
  });

  it("marks generation failures terminal while continuing to expose them for audit", async () => {
    createTask("2026-07-19T00:01:00.000Z");
    now = Date.parse("2026-07-19T00:02:00.000Z");
    const deliver = vi.fn();
    const scheduler = new ScheduledTaskScheduler({
      store,
      workerId: "scheduler:failure",
      leaseMs: 500,
      clock: () => new Date(now),
      generate: async () => { throw new Error("provider failed"); },
      deliver
    });
    await expect(scheduler.runOnce()).resolves.toMatchObject({
      claimedRuns: 1,
      generatedRuns: 0,
      deliveredRuns: 0,
      failedRuns: 1
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(store.listRuns()[0]).toMatchObject({ status: "failed", errorText: "provider failed" });
    expect(store.nextWakeAt()).toBe("2026-07-22T00:02:00.000Z");
  });

  function createTask(runAt: string) {
    return store.create({
      name: "定时任务",
      schedule: { kind: "once", runAt },
      context: "按时发送",
      targets: [{ conversationId: "group:20001", mentionUserIds: ["30001"] }]
    });
  }
});
