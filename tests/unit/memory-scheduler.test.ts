// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySchedulerStore, type MemoryQueuedMessage } from "../../services/memory/public.js";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  closeApplicationDataStores();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("MemorySchedulerStore", () => {
  it("persists a stable full batch and removes it only after completion", async () => {
    const scheduler = await createScheduler();
    const messages = Array.from({ length: 3 }, (_, index) => message(index + 1));
    await scheduler.enqueue(conversation(), messages);

    const claim = await scheduler.claimNext(3, Date.now());
    expect(claim?.messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(claim?.batchId).toMatch(/^sha256:/);

    const recovered = await createSchedulerFrom(scheduler);
    expect(await recovered.claimNext(3, Date.now())).toBeUndefined();
    await recovered.enqueue(conversation(), [message(4), message(5), message(6)]);
    const replay = await recovered.claimNext(3, Date.now());
    expect(replay?.batchId).toBe(claim?.batchId);
    expect(replay?.messageIds).toEqual(claim?.messageIds);

    await recovered.complete(replay!);
    expect(await recovered.claimNext(3, Date.now())).toBeUndefined();
  });

  it("does not flush a partial batch after a silence deadline", async () => {
    const scheduler = await createScheduler();
    const now = Date.now();
    await scheduler.enqueue(conversation(), [message(1, new Date(now - 10_000).toISOString())]);

    const claim = await scheduler.claimNext(5, now);
    expect(claim).toBeUndefined();
    expect(await scheduler.nextWakeAt(5)).toBeUndefined();
  });

  it("uses the configured message threshold as the compression window", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(conversation(), Array.from({ length: 7 }, (_, index) => message(index + 1)));

    const first = await scheduler.claimNext(5);
    expect(first?.messages.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    await scheduler.complete(first!);
    expect(await scheduler.claimNext(5)).toBeUndefined();

    await scheduler.enqueue(conversation(), [message(8), message(9), message(10)]);
    expect((await scheduler.claimNext(5))?.messages.map((item) => item.sequence)).toEqual([6, 7, 8, 9, 10]);
  });

  it("retains messages arriving while a batch is running", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(conversation(), [message(1), message(2)]);
    const claim = await scheduler.claimNext(2);
    await scheduler.enqueue(conversation(), [message(3)]);
    await scheduler.complete(claim!);

    const snapshot = await scheduler.snapshot();
    expect(snapshot.conversations[conversation().id]?.pendingMessages.map((item) => item.sequence)).toEqual([3]);
  });

  it("spends one full message window before retrying a failed batch", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(conversation(), [message(1), message(2)]);
    const claim = await scheduler.claimNext(2, 1_000);
    await scheduler.fail(claim!, 1_000);

    const recovered = await createSchedulerFrom(scheduler);
    expect(await recovered.claimNext(2, 999_999)).toBeUndefined();
    await recovered.enqueue(conversation(), [message(3)]);
    expect(await recovered.claimNext(2, 999_999)).toBeUndefined();
    await recovered.enqueue(conversation(), [message(4)]);
    const retry = await recovered.claimNext(2, 1_000_000);
    expect(retry?.batchId).toBe(claim?.batchId);
    await recovered.complete(retry!, 1_000_001);

    const snapshot = await recovered.snapshot();
    expect(snapshot.conversations[conversation().id]?.failureCount).toBe(0);
    expect(await recovered.claimNext(2, 1_000_002)).toBeUndefined();
    await recovered.enqueue(conversation(), [message(5), message(6)]);
    expect((await recovered.claimNext(2, 1_000_003))?.messages.map((item) => item.sequence)).toEqual([3, 4]);
  });

  it("does not re-enqueue messages at or before the committed cursor", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(conversation(), Array.from({ length: 50 }, (_, index) => message(index + 8)), {
      committedThrough: 9
    });
    const claim = await scheduler.claimNext(48);
    expect(claim?.messages.map((item) => item.sequence)).toEqual(Array.from({ length: 48 }, (_, index) => index + 10));
  });
});

async function createScheduler() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-scheduler-"));
  temporaryDirectories.push(root);
  const scheduler = new MemorySchedulerStore(createAdminTestConfig(root));
  await scheduler.initialize();
  return scheduler;
}

async function createSchedulerFrom(previous: MemorySchedulerStore) {
  const root = path.dirname(path.dirname(previous.databasePath()));
  const scheduler = new MemorySchedulerStore(createAdminTestConfig(root));
  await scheduler.initialize();
  return scheduler;
}

function conversation() {
  return {
    id: "group:1030412235",
    scope: "user_group",
    title: "测试群",
    groupId: 1030412235
  };
}

function message(sequence: number, at = new Date().toISOString()): MemoryQueuedMessage {
  return {
    id: `message-${sequence}`,
    sequence,
    role: sequence % 2 ? "user" : "assistant",
    text: `消息 ${sequence}`,
    at,
    userId: 171419991,
    senderName: "测试用户",
    imageCount: 0,
    quoteCount: 0
  };
}
