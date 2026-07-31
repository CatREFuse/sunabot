// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_PARTIAL_BATCH_MAX_WAIT_MS,
  MemorySchedulerStore,
  selectGroupMemoryMessagesNearAssistant,
  type MemoryQueuedMessage
} from "../../services/memory/public.js";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const temporaryDirectories: string[] = [];
const completeGroupHistory = { reconcileGroupHistory: true as const };

afterEach(async () => {
  closeApplicationDataStores();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("MemorySchedulerStore", () => {
  it("persists a stable full batch and removes it only after completion", async () => {
    const scheduler = await createScheduler();
    const messages = Array.from({ length: 3 }, (_, index) => message(index + 1));
    await scheduler.enqueue(privateConversation(), messages);

    const claim = await scheduler.claimNext(3, Date.now());
    expect(claim?.messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(claim?.batchId).toMatch(/^sha256:/);

    const recovered = await createSchedulerFrom(scheduler);
    expect(await recovered.claimNext(3, Date.now())).toBeUndefined();
    await recovered.enqueue(privateConversation(), [message(4), message(5), message(6)]);
    const replay = await recovered.claimNext(3, Date.now());
    expect(replay?.batchId).toBe(claim?.batchId);
    expect(replay?.messageIds).toEqual(claim?.messageIds);

    await recovered.complete(replay!);
    expect((await recovered.claimNext(3, Date.now()))?.messages.map((item) => item.sequence))
      .toEqual([4, 5, 6]);
  });

  it("drains a partial FIFO tail after ten quiet minutes and persists its wake deadline", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      privateConversation(),
      [message(1, "2026-07-31T01:00:00.000Z", "user")]
    );
    const state = (await scheduler.snapshot()).conversations[privateConversation().id]!;
    const dueAt = Date.parse(state.updatedAt) + MEMORY_PARTIAL_BATCH_MAX_WAIT_MS;

    expect(await scheduler.claimNext(5, dueAt - 1)).toBeUndefined();
    expect(await scheduler.nextWakeAt(5, dueAt - 1)).toBe(dueAt);

    const recovered = await createSchedulerFrom(scheduler);
    const claim = await recovered.claimNext(5, dueAt);
    expect(claim?.messages.map((item) => item.sequence)).toEqual([1]);
    expect(claim?.attemptMessageCount).toBe(1);
    await recovered.complete(claim!, dueAt + 1);
    expect((await recovered.snapshot()).conversations[privateConversation().id]?.pendingMessages)
      .toEqual([]);
  });

  it("selects the oldest ready partial tail across conversations", async () => {
    const scheduler = await createScheduler();
    const laterConversation = {
      ...privateConversation(),
      id: "private:91012",
      userId: 91012
    };
    await scheduler.enqueue(
      laterConversation,
      [message(1, "2026-07-31T02:00:00.000Z", "user")]
    );
    await scheduler.enqueue(
      privateConversation(),
      [message(1, "2026-07-31T01:00:00.000Z", "user")]
    );
    const states = (await scheduler.snapshot()).conversations;
    const dueAt = Math.max(
      Date.parse(states[laterConversation.id]!.updatedAt),
      Date.parse(states[privateConversation().id]!.updatedAt)
    ) + MEMORY_PARTIAL_BATCH_MAX_WAIT_MS;

    const first = await scheduler.claimNext(5, dueAt);
    expect(first?.conversation.id).toBe(privateConversation().id);
    await scheduler.complete(first!, dueAt + 1);
    expect((await scheduler.claimNext(5, dueAt + 2))?.conversation.id)
      .toBe(laterConversation.id);
  });

  it("uses the configured message threshold as the compression window", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(privateConversation(), Array.from({ length: 7 }, (_, index) => message(index + 1)));

    const first = await scheduler.claimNext(5);
    expect(first?.messages.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    await scheduler.complete(first!);
    expect(await scheduler.claimNext(5)).toBeUndefined();

    await scheduler.enqueue(privateConversation(), [message(8), message(9), message(10)]);
    expect((await scheduler.claimNext(5))?.messages.map((item) => item.sequence)).toEqual([6, 7, 8, 9, 10]);
  });

  it("retains messages arriving while a batch is running", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(privateConversation(), [message(1), message(2)]);
    const claim = await scheduler.claimNext(2);
    await scheduler.enqueue(privateConversation(), [message(3)]);
    await scheduler.complete(claim!);

    const snapshot = await scheduler.snapshot();
    expect(snapshot.conversations[privateConversation().id]?.pendingMessages.map((item) => item.sequence)).toEqual([3]);
  });

  it("retries the same failed batch after backoff without consuming newer messages", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(privateConversation(), [message(1), message(2)]);
    const claim = await scheduler.claimNext(2, 1_000);
    await scheduler.fail(claim!, 1_000);

    const recovered = await createSchedulerFrom(scheduler);
    expect(await recovered.claimNext(2, 60_999)).toBeUndefined();
    await recovered.enqueue(privateConversation(), [message(3)]);
    expect(await recovered.claimNext(2, 60_999)).toBeUndefined();
    expect(await recovered.nextWakeAt(2, 60_999)).toBe(61_000);

    const retry = await recovered.claimNext(2, 61_000);
    expect(retry?.batchId).toBe(claim?.batchId);
    expect(retry?.messageIds).toEqual(claim?.messageIds);
    expect(retry?.attemptMessageCount).toBe(0);
    await recovered.complete(retry!, 61_001);

    await recovered.enqueue(privateConversation(), [message(4)]);
    const next = await recovered.claimNext(2, 61_002);
    expect(next?.messages.map((item) => item.sequence)).toEqual([3, 4]);

    const snapshot = await recovered.snapshot();
    expect(snapshot.conversations[privateConversation().id]?.failureCount).toBe(0);
  });

  it("increments exponential backoff after each recovered running-batch crash", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(privateConversation(), [message(1), message(2)]);
    const first = await scheduler.claimNext(2);
    expect(first).toBeDefined();

    const recoveredOnce = await reopenSchedulerFrom(scheduler);
    const firstRecovery = (await recoveredOnce.snapshot())
      .conversations[privateConversation().id]!;
    expect(firstRecovery.failureCount).toBe(1);
    expect(Date.parse(firstRecovery.nextRetryAt!) - Date.parse(firstRecovery.updatedAt))
      .toBe(60_000);

    const secondClaim = await recoveredOnce.claimNext(2, Date.parse(firstRecovery.nextRetryAt!));
    expect(secondClaim?.batchId).toBe(first?.batchId);

    const recoveredTwice = await reopenSchedulerFrom(recoveredOnce);
    const secondRecovery = (await recoveredTwice.snapshot())
      .conversations[privateConversation().id]!;
    expect(secondRecovery.failureCount).toBe(2);
    expect(Date.parse(secondRecovery.nextRetryAt!) - Date.parse(secondRecovery.updatedAt))
      .toBe(120_000);
  });

  it("spends one early retry per later full window without exceeding the available windows", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(privateConversation(), [message(1), message(2)]);
    const first = await scheduler.claimNext(2, 1_000);
    await scheduler.fail(first!, 1_000);

    await scheduler.enqueue(
      privateConversation(),
      [message(3), message(4), message(5), message(6)]
    );
    const earlyRetry = await scheduler.claimNext(2, 1_001);
    expect(earlyRetry?.batchId).toBe(first?.batchId);
    expect(earlyRetry?.messageIds).toEqual(first?.messageIds);
    await scheduler.fail(earlyRetry!, 1_001);

    const secondEarlyRetry = await scheduler.claimNext(2, 1_001);
    expect(secondEarlyRetry?.batchId).toBe(first?.batchId);
    expect(secondEarlyRetry?.messageIds).toEqual(first?.messageIds);
    await scheduler.fail(secondEarlyRetry!, 1_001);

    expect(await scheduler.claimNext(2, 1_001)).toBeUndefined();
    expect(await scheduler.nextWakeAt(2, 1_001)).toBe(241_001);

    const recovered = await reopenSchedulerFrom(scheduler);
    expect(await recovered.claimNext(2, 241_000)).toBeUndefined();
    const scheduledRetry = await recovered.claimNext(2, 241_001);
    expect(scheduledRetry?.batchId).toBe(first?.batchId);
    await recovered.complete(scheduledRetry!, 241_002);

    const second = await recovered.claimNext(2, 241_003);
    expect(second?.messages.map((item) => item.sequence)).toEqual([3, 4]);
    await recovered.complete(second!, 241_004);
    expect((await recovered.claimNext(2, 241_005))?.messages.map((item) => item.sequence))
      .toEqual([5, 6]);
  });

  it("persists one debt-alert latch per continuous over-limit episode", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );

    const first = await scheduler.claimDebtAlert(100, 1_000);
    expect(first).toMatchObject({ pendingMessageCount: 101, threshold: 100 });

    const recoveredBeforeQueue = await createSchedulerFrom(scheduler);
    expect(await recoveredBeforeQueue.claimDebtAlert(100, 2_000)).toEqual(first);
    await recoveredBeforeQueue.bindDebtAlertTarget(
      first!.episodeId,
      "private:171419991",
      2_500
    );
    expect(await recoveredBeforeQueue.markDebtAlertQueued(first!.episodeId, 3_000)).toBe(true);
    expect(await recoveredBeforeQueue.claimDebtAlert(100, 4_000)).toBeUndefined();

    const recoveredAfterQueue = await reopenSchedulerFrom(recoveredBeforeQueue);
    expect(await recoveredAfterQueue.claimDebtAlert(100, 5_000)).toBeUndefined();

    const processed = await recoveredAfterQueue.claimNext(1, 5_000);
    await recoveredAfterQueue.complete(processed!, 5_001);
    expect(await recoveredAfterQueue.claimDebtAlert(100, 6_000)).toBeUndefined();

    await recoveredAfterQueue.enqueue(privateConversation(), [message(102)]);
    const second = await recoveredAfterQueue.claimDebtAlert(100, 7_000);
    expect(second).toMatchObject({ pendingMessageCount: 101, threshold: 100 });
    expect(second?.episodeId).not.toBe(first?.episodeId);
  });

  it("does not acknowledge a stale debt-alert episode", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );
    const claim = await scheduler.claimDebtAlert();

    expect(await scheduler.markDebtAlertQueued("stale-episode")).toBe(false);
    expect(await scheduler.claimDebtAlert()).toEqual(claim);
  });

  it("refuses to mark an unbound debt-alert episode as queued", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );
    const claim = await scheduler.claimDebtAlert(100, 1_000);

    expect(await scheduler.markDebtAlertQueued(claim!.episodeId, 2_000)).toBe(false);
    expect(await scheduler.claimDebtAlert(100, 3_000)).toEqual(claim);
  });

  it("safely reopens a legacy queued debt-alert episode that has no target", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    await scheduler.initialize();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );
    applicationDataStore(config).writeMemoryDebtAlertState({
      schemaVersion: 1,
      active: true,
      episodeId: "legacy-unbound-episode",
      queued: true,
      updatedAt: "2026-07-31T00:00:00.000Z"
    });

    await expect(scheduler.claimDebtAlert(100, 1_000)).resolves.toMatchObject({
      episodeId: "legacy-unbound-episode",
      pendingMessageCount: 101
    });
    expect(applicationDataStore(config).readMemoryDebtAlertState()).toMatchObject({
      active: true,
      episodeId: "legacy-unbound-episode",
      queued: false
    });
  });

  it("persists the first debt-alert target before queueing and reuses it after recovery", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );
    const claim = await scheduler.claimDebtAlert(100, 1_000);

    await expect(scheduler.bindDebtAlertTarget(
      claim!.episodeId,
      "account:connected-a:private:171419991",
      2_000
    )).resolves.toBe("account:connected-a:private:171419991");

    const recovered = await reopenSchedulerFrom(scheduler);
    await expect(recovered.claimDebtAlert(100, 3_000)).resolves.toEqual({
      ...claim,
      targetConversationId: "account:connected-a:private:171419991"
    });
    await expect(recovered.bindDebtAlertTarget(
      claim!.episodeId,
      "account:connected-b:private:171419991",
      4_000
    )).resolves.toBe("account:connected-a:private:171419991");
  });

  it("rechecks the episode and pending threshold before enqueueing a debt alert", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    await scheduler.initialize();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );
    const claim = await scheduler.claimDebtAlert(100, 1_000);
    const targetConversationId = "private:171419991";
    await scheduler.bindDebtAlertTarget(claim!.episodeId, targetConversationId, 2_000);

    const processed = await scheduler.claimNext(1, 3_000);
    await scheduler.complete(processed!, 3_001);
    let enqueueCalls = 0;
    await expect(scheduler.enqueueDebtAlertIfDue(
      claim!.episodeId,
      targetConversationId,
      async () => {
        enqueueCalls += 1;
        return { queued: true };
      },
      100,
      4_000
    )).resolves.toEqual({ executed: false, reason: "not_due" });
    expect(enqueueCalls).toBe(0);
    expect(applicationDataStore(config).readMemoryDebtAlertState()).toMatchObject({
      active: false,
      episodeId: null,
      queued: false
    });
  });

  it("marks the bound episode queued inside the same scheduler lock as Session enqueue", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      privateConversation(),
      Array.from({ length: 101 }, (_, index) => message(index + 1))
    );
    const claim = await scheduler.claimDebtAlert(100, 1_000);
    const targetConversationId = "private:171419991";
    await scheduler.bindDebtAlertTarget(claim!.episodeId, targetConversationId, 2_000);

    await expect(scheduler.enqueueDebtAlertIfDue(
      claim!.episodeId,
      targetConversationId,
      async () => ({ queued: true, eventId: "event-1" }),
      100,
      3_000
    )).resolves.toEqual({
      executed: true,
      result: { queued: true, eventId: "event-1" }
    });
    expect(await scheduler.claimDebtAlert(100, 4_000)).toBeUndefined();
  });

  it("keeps debt-alert latches isolated between Agent databases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-agent-alert-"));
    temporaryDirectories.push(root);
    const planaConfig = createAdminTestConfig(path.join(root, "plana"));
    const aronaConfig = createAdminTestConfig(path.join(root, "agents", "arona"));
    aronaConfig.persona.defaultAgentId = "arona";
    const plana = new MemorySchedulerStore(planaConfig);
    const arona = new MemorySchedulerStore(aronaConfig);
    await Promise.all([plana.initialize(), arona.initialize()]);
    await Promise.all([
      plana.enqueue(privateConversation(), Array.from({ length: 101 }, (_, index) => message(index + 1))),
      arona.enqueue(privateConversation(), Array.from({ length: 101 }, (_, index) => message(index + 1)))
    ]);

    const [planaClaim, aronaClaim] = await Promise.all([
      plana.claimDebtAlert(100, 1_000),
      arona.claimDebtAlert(100, 1_000)
    ]);
    expect(planaClaim?.episodeId).not.toBe(aronaClaim?.episodeId);
    await plana.bindDebtAlertTarget(planaClaim!.episodeId, "private:171419991", 2_000);
    await arona.bindDebtAlertTarget(
      aronaClaim!.episodeId,
      "account:arona-connected:private:171419991",
      2_000
    );
    await plana.markDebtAlertQueued(planaClaim!.episodeId, 3_000);

    expect(await plana.claimDebtAlert(100, 4_000)).toBeUndefined();
    expect(await arona.claimDebtAlert(100, 4_000)).toMatchObject({
      episodeId: aronaClaim!.episodeId,
      targetConversationId: "account:arona-connected:private:171419991"
    });
  });

  it("does not re-enqueue messages at or before the committed cursor", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(privateConversation(), Array.from({ length: 50 }, (_, index) => message(index + 8)), {
      committedThrough: 9
    });
    const claim = await scheduler.claimNext(48);
    expect(claim?.messages.map((item) => item.sequence)).toEqual(Array.from({ length: 48 }, (_, index) => index + 10));
  });

  it("does not queue group messages before the bot has spoken", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 100 }, (_, index) => message(index + 1, undefined, "user")),
      completeGroupHistory
    );

    const snapshot = await scheduler.snapshot();
    expect(snapshot.conversations[conversation().id]?.pendingMessages).toEqual([]);
    expect(await scheduler.claimNext(1)).toBeUndefined();
  });

  it("queues only the twenty group messages on either side of a bot reply", async () => {
    const scheduler = await createScheduler();
    const messages = Array.from(
      { length: 43 },
      (_, index) => message(index + 1, undefined, index === 21 ? "assistant" : "user")
    );
    await scheduler.enqueue(conversation(), messages, completeGroupHistory);

    const claim = await scheduler.claimNext(41);
    expect(claim?.messages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 2)
    );
  });

  it("adds the next twenty group messages incrementally and excludes the twenty-first", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 25 }, (_, index) => message(index + 1, undefined, "user")),
      completeGroupHistory
    );
    await scheduler.enqueue(conversation(), [message(26, undefined, "assistant")]);
    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 21 }, (_, index) => message(index + 27, undefined, "user"))
    );

    const snapshot = await scheduler.snapshot();
    expect(snapshot.conversations[conversation().id]?.pendingMessages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 6)
    );
  });

  it("merges overlapping bot neighborhoods without duplicate group messages", async () => {
    const scheduler = await createScheduler();
    const messages = Array.from(
      { length: 63 },
      (_, index) => message(
        index + 1,
        undefined,
        index === 21 || index === 41 ? "assistant" : "user"
      )
    );
    await scheduler.enqueue(conversation(), messages, completeGroupHistory);

    const claim = await scheduler.claimNext(61);
    expect(claim?.messages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 61 }, (_, index) => index + 2)
    );
  });

  it("counts only bot-neighborhood messages toward the group threshold", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      conversation(),
      Array.from(
        { length: 43 },
        (_, index) => message(index + 1, undefined, index === 21 ? "assistant" : "user")
      ),
      completeGroupHistory
    );
    expect(await scheduler.claimNext(48)).toBeUndefined();

    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 50 }, (_, index) => message(index + 44, undefined, "user"))
    );
    expect(await scheduler.claimNext(48)).toBeUndefined();

    await scheduler.enqueue(conversation(), [message(94, undefined, "assistant")]);
    expect((await scheduler.claimNext(48))?.messages).toHaveLength(48);
  });

  it("creates a group batch at forty-eight selected messages but not forty-seven", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      conversation(),
      Array.from(
        { length: 48 },
        (_, index) => message(
          index + 1,
          undefined,
          index === 21 || index === 27 ? "assistant" : "user"
        )
      ),
      completeGroupHistory
    );

    const beforeThreshold = (await scheduler.snapshot()).conversations[conversation().id];
    expect(beforeThreshold?.currentBatch).toBeUndefined();
    expect(beforeThreshold?.unattemptedMessageCount).toBe(47);
    expect(await scheduler.claimNext(48)).toBeUndefined();

    await scheduler.enqueue(conversation(), [message(49, undefined, "assistant")]);
    expect((await scheduler.claimNext(48))?.messages).toHaveLength(48);
  });

  it("matches full-history selection while retaining only bounded incremental context", async () => {
    const scheduler = await createScheduler();
    const assistantSequences = new Set([25, 74, 75, 110]);
    const messages = Array.from(
      { length: 140 },
      (_, index) => message(
        index + 1,
        undefined,
        assistantSequences.has(index + 1) ? "assistant" : "user"
      )
    );
    for (const [index, item] of messages.entries()) {
      await scheduler.enqueue(conversation(), [item], index === 0 ? completeGroupHistory : undefined);
    }

    const state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.pendingMessages).toEqual(selectGroupMemoryMessagesNearAssistant(messages));
    expect(state?.groupMemorySelectionSource).toHaveLength(41);
  });

  it("keeps the previous twenty group messages available across a restart", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 30 }, (_, index) => message(index + 1, undefined, "user")),
      completeGroupHistory
    );

    const recovered = await reopenSchedulerFrom(scheduler);
    await recovered.enqueue(conversation(), [message(31, undefined, "assistant")]);

    expect((await recovered.snapshot()).conversations[conversation().id]?.pendingMessages
      .map((item) => item.sequence)).toEqual(
        Array.from({ length: 21 }, (_, index) => index + 11)
      );
  });

  it("does not spend a failed group retry window on messages outside bot neighborhoods", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(
      conversation(),
      Array.from(
        { length: 43 },
        (_, index) => message(index + 1, undefined, index === 21 ? "assistant" : "user")
      ),
      completeGroupHistory
    );
    const first = await scheduler.claimNext(41);
    await scheduler.fail(first!);

    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 41 }, (_, index) => message(index + 44, undefined, "user"))
    );
    expect(await scheduler.claimNext(41)).toBeUndefined();

    await scheduler.enqueue(conversation(), [message(85, undefined, "assistant")]);
    await scheduler.enqueue(
      conversation(),
      Array.from({ length: 20 }, (_, index) => message(index + 86, undefined, "user"))
    );
    expect((await scheduler.claimNext(41))?.batchId).toBe(first?.batchId);
  });

  it.each(["user_group", "bot_group"] as const)(
    "applies the bot neighborhood policy to %s conversations",
    async (scope) => {
      const scheduler = await createScheduler();
      const descriptor = { ...conversation(), id: `${scope}:1030412235`, scope };
      await scheduler.enqueue(descriptor, [
        message(1, undefined, "user"),
        message(2, undefined, "assistant"),
        message(3, undefined, "user")
      ], completeGroupHistory);

      expect((await scheduler.claimNext(3))?.conversation.scope).toBe(scope);
    }
  );

  it("keeps private messages eligible without a bot reply", async () => {
    const scheduler = await createScheduler();
    const descriptor = { ...conversation(), id: "private:171419991", scope: "private" };
    await scheduler.enqueue(
      descriptor,
      Array.from({ length: 3 }, (_, index) => message(index + 1, undefined, "user"))
    );

    expect((await scheduler.claimNext(3))?.messages.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it("does not restore spent quota when complete group history is replayed", async () => {
    const scheduler = await createScheduler();
    const messages = thresholdGroupHistory();
    await scheduler.enqueue(conversation(), messages, completeGroupHistory);
    const first = await scheduler.claimNext(48);
    await scheduler.fail(first!);

    expect(await scheduler.enqueue(conversation(), messages, completeGroupHistory)).toBe(0);
    const state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.currentBatch?.batchId).toBe(first?.batchId);
    expect(state?.unattemptedMessageCount).toBe(0);
    expect(await scheduler.claimNext(48)).toBeUndefined();
  });

  it("recovers a current-policy running group batch without refunding quota after SQLite reopen", async () => {
    const scheduler = await createScheduler();
    await scheduler.enqueue(conversation(), thresholdGroupHistory(), completeGroupHistory);
    const first = await scheduler.claimNext(48);
    expect(first?.messages).toHaveLength(48);

    const recovered = await reopenSchedulerFrom(scheduler);
    let state = (await recovered.snapshot()).conversations[conversation().id];
    expect(state).toMatchObject({
      state: "queued",
      groupMemorySelectionPolicy: "assistant-neighborhood-v1",
      unattemptedMessageCount: 0
    });
    expect(state?.currentBatch?.batchId).toBe(first?.batchId);
    expect(await recovered.claimNext(48)).toBeUndefined();

    await recovered.enqueue(
      conversation(),
      Array.from({ length: 20 }, (_, index) => message(index + 50, undefined, "user"))
    );
    await recovered.enqueue(
      conversation(),
      Array.from({ length: 26 }, (_, index) => message(index + 70, undefined, "user"))
    );
    await recovered.enqueue(conversation(), [
      message(96, undefined, "assistant"),
      ...Array.from({ length: 5 }, (_, index) => message(index + 97, undefined, "user")),
      message(102, undefined, "assistant")
    ]);
    state = (await recovered.snapshot()).conversations[conversation().id];
    expect(state?.unattemptedMessageCount).toBe(47);
    expect(await recovered.claimNext(48)).toBeUndefined();

    await recovered.enqueue(conversation(), [message(103, undefined, "assistant")]);
    const retry = await recovered.claimNext(48);
    expect(retry?.batchId).toBe(first?.batchId);
    expect(retry?.messageIds).toEqual(first?.messageIds);
  });

  it("settles a committed current-policy group batch after SQLite reopen", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    await scheduler.initialize();
    await scheduler.enqueue(conversation(), thresholdGroupHistory(), completeGroupHistory);
    const first = await scheduler.claimNext(48);
    expect(first?.messages).toHaveLength(48);
    const memoryStore = applicationDataStore(config);
    expect(memoryStore.commitMemoryBatch({
      batchId: first!.batchId,
      baselineRevisions: memoryStore.readMemorySnapshot().revisions,
      working: [],
      longTerm: [],
      userProfile: [],
      result: { status: "applied" }
    }).status).toBe("committed");

    const recovered = await reopenSchedulerFrom(scheduler);
    const replay = await recovered.claimNext(48);
    expect(replay).toMatchObject({
      batchId: first?.batchId,
      attemptMessageCount: 0
    });
    expect(replay?.messageIds).toEqual(first?.messageIds);
    await recovered.complete(replay!);

    const state = (await recovered.snapshot()).conversations[conversation().id];
    expect(state?.pendingMessages).toEqual([]);
    expect(state?.lastCommittedSequence).toBe(49);
  });

  it("fails closed for malformed current-policy context until complete history reconciles it", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    const completeHistory = thresholdGroupHistory();
    const selected = selectGroupMemoryMessagesNearAssistant(completeHistory);
    applicationDataStore(config).replaceMemoryScheduler({
      [conversation().id]: {
        conversation: conversation(),
        state: "queued",
        pendingMessages: selected,
        groupMemorySelectionPolicy: "assistant-neighborhood-v1",
        groupMemorySelectionSource: { malformed: true },
        dirty: false,
        failureCount: 0,
        unattemptedMessageCount: selected.length,
        lastCommittedSequence: 0,
        updatedAt: "2026-07-18T00:00:00.000Z"
      }
    });

    expect(await scheduler.claimNext(48)).toBeUndefined();
    await scheduler.initialize();
    let state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.groupMemorySelectionPolicy).toBeUndefined();
    expect(state?.groupMemorySelectionSource).toBeUndefined();
    expect(await scheduler.enqueue(conversation(), completeHistory)).toBe(0);
    expect(await scheduler.claimNext(48)).toBeUndefined();

    await scheduler.enqueue(conversation(), completeHistory, completeGroupHistory);
    state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.groupMemorySelectionPolicy).toBe("assistant-neighborhood-v1");
    expect(state?.groupMemorySelectionSource).toHaveLength(41);
    expect((await scheduler.claimNext(48))?.messages).toHaveLength(48);
  });

  it("repairs and persists a valid oversized current-policy context", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    const oversized = [
      ...Array.from({ length: 60 }, (_, index) => message(60 - index, undefined, "user")),
      message(60, undefined, "user")
    ];
    applicationDataStore(config).replaceMemoryScheduler({
      [conversation().id]: {
        conversation: conversation(),
        state: "idle",
        pendingMessages: [],
        groupMemorySelectionPolicy: "assistant-neighborhood-v1",
        groupMemorySelectionSource: oversized,
        dirty: false,
        failureCount: 0,
        unattemptedMessageCount: 0,
        lastCommittedSequence: 0,
        updatedAt: "2026-07-18T00:00:00.000Z"
      }
    });

    await scheduler.initialize();
    const repaired = (await scheduler.snapshot()).conversations[conversation().id]
      ?.groupMemorySelectionSource;
    expect(repaired?.map((item) => item.sequence)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 20)
    );

    const recovered = await reopenSchedulerFrom(scheduler);
    expect((await recovered.snapshot()).conversations[conversation().id]
      ?.groupMemorySelectionSource).toEqual(repaired);
  });

  it("rebuilds a legacy failed group batch from bot neighborhoods", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    const messages = Array.from(
      { length: 48 },
      (_, index) => message(index + 1, undefined, index === 21 ? "assistant" : "user")
    );
    applicationDataStore(config).replaceMemoryScheduler({
      [conversation().id]: legacyConversationState(messages, "legacy-uncommitted")
    });

    await scheduler.initialize();
    expect(await scheduler.claimNext(1)).toBeUndefined();
    await scheduler.enqueue(conversation(), messages, completeGroupHistory);
    const state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state).toMatchObject({
      dirty: false,
      failureCount: 0,
      groupMemorySelectionPolicy: "assistant-neighborhood-v1",
      unattemptedMessageCount: 0
    });
    expect(state?.currentBatch).toBeUndefined();
    expect(state?.pendingMessages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 41 }, (_, index) => index + 2)
    );

    const recovered = await createSchedulerFrom(scheduler);
    expect((await recovered.snapshot()).conversations[conversation().id]?.pendingMessages)
      .toEqual(state?.pendingMessages);
  });

  it.each(["queued", "running"] as const)(
    "preserves spent retry quota while migrating a legacy %s group batch",
    async (legacyState) => {
      const { scheduler, config } = await createUninitializedScheduler();
      const oldMessages = Array.from(
        { length: 48 },
        (_, index) => message(index + 1, undefined, index === 21 ? "assistant" : "user")
      );
      const oldBatchId = `legacy-${legacyState}`;
      applicationDataStore(config).replaceMemoryScheduler({
        [conversation().id]: {
          ...legacyConversationState(oldMessages, oldBatchId),
          state: legacyState,
          failureCount: legacyState === "queued" ? 1 : 0,
          unattemptedMessageCount: 0
        }
      });

      await scheduler.initialize();
      await scheduler.enqueue(conversation(), oldMessages, completeGroupHistory);
      let state = (await scheduler.snapshot()).conversations[conversation().id];
      expect(state?.currentBatch).toBeUndefined();
      expect(state?.pendingMessages).toHaveLength(41);
      expect(state?.unattemptedMessageCount).toBe(0);

      await scheduler.enqueue(
        conversation(),
        Array.from({ length: 41 }, (_, index) => message(index + 49, undefined, "user"))
      );
      await scheduler.enqueue(
        conversation(),
        Array.from(
          { length: 48 },
          (_, index) => message(
            index + 90,
            undefined,
            index === 21 || index === 27 ? "assistant" : "user"
          )
        )
      );
      state = (await scheduler.snapshot()).conversations[conversation().id];
      expect(state?.unattemptedMessageCount).toBe(47);
      expect(await scheduler.claimNext(48)).toBeUndefined();

      await scheduler.enqueue(conversation(), [message(138, undefined, "assistant")]);
      const retry = await scheduler.claimNext(48);
      expect(retry?.batchId).not.toBe(oldBatchId);
      expect(retry?.messages).toHaveLength(48);
    }
  );

  it("settles a committed legacy group batch without spending another attempt", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    const messages = Array.from(
      { length: 43 },
      (_, index) => message(index + 1, undefined, index === 21 ? "assistant" : "user")
    );
    const batchId = "legacy-committed";
    applicationDataStore(config).replaceMemoryScheduler({
      [conversation().id]: legacyConversationState(messages, batchId)
    });
    const memoryStore = applicationDataStore(config);
    expect(memoryStore.commitMemoryBatch({
      batchId,
      baselineRevisions: memoryStore.readMemorySnapshot().revisions,
      working: [],
      longTerm: [],
      userProfile: [],
      result: { status: "applied" }
    }).status).toBe("committed");

    await scheduler.initialize();
    expect(await scheduler.nextWakeAt(48)).toBeUndefined();
    await scheduler.enqueue(conversation(), messages, completeGroupHistory);
    expect(await scheduler.nextWakeAt(48)).toEqual(expect.any(Number));
    const claim = await scheduler.claimNext(48);
    expect(claim).toMatchObject({ batchId, attemptMessageCount: 0 });
    await scheduler.complete(claim!, Date.now(), { refundAttempt: true });

    const state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.pendingMessages).toEqual([]);
    expect(state?.lastCommittedSequence).toBe(43);
  });

  it("requires explicit complete history to reconcile a plain legacy group", async () => {
    const { scheduler, config } = await createUninitializedScheduler();
    const pending = Array.from(
      { length: 20 },
      (_, index) => message(index + 21, undefined, "user")
    );
    applicationDataStore(config).replaceMemoryScheduler({
      [conversation().id]: {
        ...legacyConversationState(pending, "legacy-boundary"),
        currentBatch: undefined,
        failureCount: 0,
        unattemptedMessageCount: 20,
        lastCommittedSequence: 20
      }
    });
    await scheduler.initialize();
    expect(await scheduler.claimNext(1)).toBeUndefined();

    const completeHistory = [
      message(20, undefined, "assistant"),
      ...pending
    ];
    expect(await scheduler.enqueue(conversation(), [message(41, undefined, "assistant")])).toBe(0);
    expect(await scheduler.enqueue(conversation(), completeHistory)).toBe(0);
    let state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.groupMemorySelectionPolicy).toBeUndefined();
    expect(state?.groupMemorySelectionSource).toBeUndefined();
    expect(state?.pendingMessages).toEqual(pending);
    expect(state?.unattemptedMessageCount).toBe(20);
    expect(await scheduler.claimNext(1)).toBeUndefined();
    expect(await scheduler.nextWakeAt(1)).toBeUndefined();

    await scheduler.enqueue(conversation(), completeHistory, completeGroupHistory);

    state = (await scheduler.snapshot()).conversations[conversation().id];
    expect(state?.pendingMessages.map((item) => item.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 21)
    );
    expect(state?.unattemptedMessageCount).toBe(20);
    expect(state?.groupMemorySelectionPolicy).toBe("assistant-neighborhood-v1");
  });
});

async function createScheduler() {
  const { scheduler } = await createUninitializedScheduler();
  await scheduler.initialize();
  return scheduler;
}

async function createUninitializedScheduler() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-scheduler-"));
  temporaryDirectories.push(root);
  const config = createAdminTestConfig(root);
  return { scheduler: new MemorySchedulerStore(config), config };
}

async function createSchedulerFrom(previous: MemorySchedulerStore) {
  const root = path.dirname(path.dirname(previous.databasePath()));
  const scheduler = new MemorySchedulerStore(createAdminTestConfig(root));
  await scheduler.initialize();
  return scheduler;
}

async function reopenSchedulerFrom(previous: MemorySchedulerStore) {
  const root = path.dirname(path.dirname(previous.databasePath()));
  closeApplicationDataStores();
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

function privateConversation() {
  return {
    id: "private:171419991",
    scope: "private",
    title: "测试私聊",
    userId: 171419991
  };
}

function message(
  sequence: number,
  at = new Date().toISOString(),
  role: MemoryQueuedMessage["role"] = sequence % 2 ? "user" : "assistant"
): MemoryQueuedMessage {
  return {
    id: `message-${sequence}`,
    sequence,
    role,
    text: `消息 ${sequence}`,
    at,
    userId: 171419991,
    senderName: "测试用户",
    imageCount: 0,
    quoteCount: 0
  };
}

function thresholdGroupHistory() {
  return Array.from(
    { length: 49 },
    (_, index) => message(
      index + 1,
      undefined,
      index === 21 || index === 27 || index === 48 ? "assistant" : "user"
    )
  );
}

function legacyConversationState(messages: MemoryQueuedMessage[], batchId: string) {
  return {
    conversation: conversation(),
    state: "queued",
    pendingMessages: messages,
    currentBatch: {
      batchId,
      messageIds: messages.map((item) => `${item.sequence}:${item.id}`),
      startedAt: "2026-07-18T00:00:00.000Z"
    },
    dirty: true,
    failureCount: 1,
    unattemptedMessageCount: 0,
    lastCommittedSequence: 0,
    updatedAt: "2026-07-18T00:00:00.000Z"
  };
}
