// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../services/sessions/sessionStore.js";

const stores: SessionStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("SessionStore", () => {
  it("migrates an existing v1 database with attempt fencing columns", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-v1-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1);
      CREATE TABLE tool_jobs (id TEXT PRIMARY KEY) STRICT;
    `);
    legacy.close();

    stores.push(new SessionStore({ databasePath }));
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const columns = inspection.prepare("PRAGMA table_info(tool_jobs)").all()
      .map((row) => String((row as { name: unknown }).name));
    const version = inspection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as unknown as {
      version: number;
    };
    inspection.close();

    expect(columns).toEqual(expect.arrayContaining(["attempt_token", "process_identity_json"]));
    expect(version.version).toBe(2);
  });

  it("uses WAL, deduplicates intake, and leases FIFO turns independently per session", async () => {
    const harness = await createHarness();
    const { store } = harness;
    expect(store.getJournalMode()).toBe("wal");

    const first = store.enqueueEvent({
      sessionId: "group:100",
      kind: "incoming",
      dedupeKey: "onebot:1001",
      payload: { text: "first" }
    });
    const duplicate = store.enqueueEvent({
      sessionId: "group:100",
      kind: "incoming",
      dedupeKey: "onebot:1001",
      payload: { text: "ignored duplicate" }
    });
    const second = store.enqueueEvent({
      sessionId: "group:100",
      kind: "incoming",
      dedupeKey: "onebot:1002",
      payload: { text: "second" }
    });
    const other = store.enqueueEvent({
      sessionId: "group:200",
      kind: "incoming",
      payload: { text: "parallel" }
    });

    expect(duplicate).toEqual({ event: first.event, inserted: false });
    expect(second.event.sequence).toBe(2);

    const claimedFirst = store.claimNextTurn({ workerId: "turn-a", leaseMs: 100 });
    expect(claimedFirst?.event.id).toBe(first.event.id);
    expect(store.claimNextTurn({
      workerId: "same-session-blocked",
      sessionId: "group:100"
    })).toBeNull();

    const claimedOther = store.claimNextTurn({ workerId: "turn-b", leaseMs: 100 });
    expect(claimedOther?.event.id).toBe(other.event.id);
    store.finishTurn({
      turnId: claimedOther!.turn.id,
      workerId: "turn-b",
      outcome: "no_reply"
    });
    store.finishTurn({
      turnId: claimedFirst!.turn.id,
      workerId: "turn-a",
      outcome: "replied",
      outbox: [{ kind: "onebot.group", payload: { text: "reply one" } }]
    });
    const outbound = store.claimNextOutbox({ workerId: "sender", sessionId: "group:100" })!;
    expect(store.finishOutbox({
      outboxId: outbound.id,
      workerId: "sender",
      outcome: "sent",
      result: { messageId: 9001 }
    })).toMatchObject({
      status: "sent",
      result: { messageId: 9001 }
    });

    const claimedSecond = store.claimNextTurn({ workerId: "turn-c", sessionId: "group:100" });
    expect(claimedSecond?.event.id).toBe(second.event.id);
    expect(claimedSecond?.turn.attempt).toBe(1);
    expect(store.getSessionState("group:100")).toMatchObject({
      nextEventSequence: 2,
      completedEventSequence: 1,
      nextOutboxSequence: 1,
      completedOutboxSequence: 1
    });
  });

  it("atomically defers a turn into a queued tool job and acknowledgement", async () => {
    const { store } = await createHarness();
    const incoming = store.enqueueEvent({
      sessionId: "group:300",
      kind: "incoming",
      payload: { text: "inspect the workspace" }
    });
    const claim = store.claimNextTurn({ workerId: "agent" })!;

    const deferred = store.deferTurn({
      turnId: claim.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "call_codex_1",
        toolName: "codex",
        taskKind: "local",
        originalRequest: { text: "inspect the workspace" },
        arguments: { task: "run tests" }
      },
      acknowledgement: {
        kind: "onebot.group",
        payload: { text: "任务已经开始。" }
      }
    });

    expect(deferred).toMatchObject({
      duplicate: false,
      turn: { status: "deferred", eventId: incoming.event.id },
      job: {
        status: "queued",
        providerCallId: "call_codex_1",
        toolName: "codex",
        originalRequest: { text: "inspect the workspace" }
      },
      acknowledgement: {
        sequence: 1,
        status: "pending",
        payload: { text: "任务已经开始。" }
      }
    });
    expect(store.getEvent(incoming.event.id)?.status).toBe("completed");
    expect(store.getSessionState("group:300")).toMatchObject({
      completedEventSequence: 1,
      nextOutboxSequence: 1
    });

    const duplicate = store.deferTurn({
      turnId: claim.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "call_codex_1",
        toolName: "codex",
        originalRequest: null,
        arguments: null
      },
      acknowledgement: { kind: "ignored", payload: null }
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.job.id).toBe(deferred.job.id);
    expect(store.listOutbox("group:300")).toHaveLength(1);
  });

  it("appends one idempotent tool completion event at the session tail", async () => {
    const { store } = await createHarness();
    store.enqueueEvent({ sessionId: "group:400", kind: "incoming", payload: { text: "first" } });
    const origin = store.claimNextTurn({ workerId: "agent" })!;
    const deferred = store.deferTurn({
      turnId: origin.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "call_42",
        toolName: "codex",
        originalRequest: { text: "first" },
        arguments: { task: "deep research" }
      },
      acknowledgement: { kind: "onebot.group", payload: { text: "开始研究。" } }
    });
    const intervening = store.enqueueEvent({
      sessionId: "group:400",
      kind: "incoming",
      payload: { text: "arrived while the tool ran" }
    });

    const job = store.claimNextToolJob({ workerId: "codex-worker" })!;
    expect(job.id).toBe(deferred.job.id);
    const completed = store.completeToolJob({
      jobId: job.id,
      workerId: "codex-worker",
      status: "succeeded",
      result: { summary: "done" }
    });
    const repeated = store.completeToolJob({
      jobId: job.id,
      workerId: "codex-worker",
      status: "failed",
      error: { message: "must not overwrite success" }
    });

    expect(completed.inserted).toBe(true);
    expect(repeated.inserted).toBe(false);
    expect(repeated.event.id).toBe(completed.event.id);
    expect(repeated.job.status).toBe("succeeded");
    expect(store.listEvents("group:400").map((event) => [event.sequence, event.kind])).toEqual([
      [1, "incoming"],
      [2, "incoming"],
      [3, "tool_completion"]
    ]);
    expect(completed.event.payload).toMatchObject({
      schemaVersion: 1,
      type: "runtime.tool_result",
      conversationId: "group:400",
      correlationId: "call_42",
      payload: {
        type: "tool_result",
        toolJobId: job.id,
        providerCallId: "call_42",
        toolName: "codex",
        originalRequest: { text: "first" },
        arguments: { task: "deep research" },
        outcome: { status: "succeeded", result: { summary: "done" }, error: null }
      }
    });

    const next = store.claimNextTurn({ workerId: "agent-next", sessionId: "group:400" })!;
    expect(next.event.id).toBe(intervening.event.id);
    store.finishTurn({ turnId: next.turn.id, workerId: "agent-next", outcome: "no_reply" });
    const completionTurn = store.claimNextTurn({ workerId: "agent-result", sessionId: "group:400" })!;
    expect(completionTurn.event.id).toBe(completed.event.id);
  });

  it("recovers expired turn, tool-job, and outbox leases without breaking cursors", async () => {
    const harness = await createHarness();
    const { store } = harness;

    store.enqueueEvent({ sessionId: "group:turn", kind: "incoming", payload: {} });
    const abandonedTurn = store.claimNextTurn({ workerId: "old-turn", leaseMs: 50 })!;

    store.enqueueEvent({ sessionId: "group:job", kind: "incoming", payload: {} });
    const jobTurn = store.claimNextTurn({ workerId: "agent", sessionId: "group:job" })!;
    const deferred = store.deferTurn({
      turnId: jobTurn.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "call-recover",
        toolName: "codex",
        originalRequest: {},
        arguments: {}
      },
      acknowledgement: { kind: "ack", payload: {} }
    });
    store.claimNextToolJob({ workerId: "old-job", leaseMs: 50, sessionId: "group:job" });

    store.enqueueEvent({ sessionId: "group:outbox", kind: "incoming", payload: {} });
    const outboxTurn = store.claimNextTurn({ workerId: "agent", sessionId: "group:outbox" })!;
    const finished = store.finishTurn({
      turnId: outboxTurn.turn.id,
      workerId: "agent",
      outcome: "replied",
      outbox: [{ kind: "reply", payload: {} }]
    });
    store.claimNextOutbox({ workerId: "old-sender", leaseMs: 50, sessionId: "group:outbox" });

    harness.advance(51);
    expect(store.recoverExpiredLeases()).toEqual({ turns: 1, toolJobs: 1, outbox: 1 });
    expect(store.getTurn(abandonedTurn.turn.id)?.status).toBe("interrupted");
    expect(store.getEvent(abandonedTurn.event.id)?.status).toBe("pending");
    expect(store.getToolJob(deferred.job.id)?.status).toBe("queued");
    expect(store.getOutbox(finished.outbox[0]!.id)?.status).toBe("pending");

    expect(() => store.finishTurn({
      turnId: abandonedTurn.turn.id,
      workerId: "old-turn",
      outcome: "no_reply"
    })).toThrow("not running");
    expect(store.claimNextTurn({ workerId: "new-turn", sessionId: "group:turn" }))
      .toMatchObject({ turn: { attempt: 2 } });
    expect(store.claimNextToolJob({ workerId: "new-job", sessionId: "group:job" }))
      .toMatchObject({ attempts: 2 });
    expect(store.claimNextOutbox({ workerId: "new-sender", sessionId: "group:outbox" }))
      .toMatchObject({ attempts: 2 });
  });

  it("persists orphan process identity and fences a recovered tool attempt", async () => {
    const { store } = await createHarness();
    store.enqueueEvent({ sessionId: "group:fence", kind: "incoming", payload: {} });
    const turn = store.claimNextTurn({ workerId: "agent" })!;
    const deferred = store.deferTurn({
      turnId: turn.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "call-fence",
        toolName: "codex",
        taskKind: "analysis",
        originalRequest: {},
        arguments: { task: "recover", kind: "analysis" }
      },
      acknowledgement: { kind: "ack", payload: {} }
    });
    const first = store.claimNextToolJob({ workerId: "same-worker" })!;
    const firstToken = first.attemptToken!;
    store.recordToolJobProcess(first.id, "same-worker", first.attempts, firstToken, {
      pid: 4242,
      processGroupId: 4242,
      attempt: first.attempts,
      runToken: firstToken,
      commandMarker: `/jobs/${first.id}/attempt-${first.attempts}-${firstToken}`,
      startedAt: 100
    });

    expect(store.recoverAllLeases().toolJobs).toBe(1);
    const recovered = store.claimToolJob(deferred.job.id, { workerId: "same-worker" })!;
    expect(recovered).toMatchObject({ attempts: 2, processIdentity: { runToken: firstToken } });
    expect(recovered.attemptToken).not.toBe(firstToken);

    expect(() => store.completeToolJob({
      jobId: first.id,
      workerId: "same-worker",
      attempt: first.attempts,
      attemptToken: firstToken,
      status: "succeeded",
      result: { content: "stale result" }
    })).toThrow("attempt ownership was lost");
    expect(store.getToolJob(first.id)?.status).toBe("running");

    store.clearRecoveredToolJobProcess(
      recovered.id,
      "same-worker",
      recovered.attempts,
      recovered.attemptToken!,
      firstToken
    );
    expect(store.getToolJob(first.id)?.processIdentity).toBeUndefined();
  });

  it("recovers all abandoned leases after reopening the database", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-store-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    let now = 10_000;
    let id = 0;
    const options = () => ({
      databasePath,
      clock: () => now,
      idFactory: () => `restart-${++id}`
    });

    const before = new SessionStore(options());
    storeForCleanup(before);
    before.enqueueEvent({ sessionId: "group:turn", kind: "incoming", payload: {} });
    const runningTurn = before.claimNextTurn({ workerId: "old-turn", leaseMs: 60_000 })!;

    before.enqueueEvent({ sessionId: "group:job", kind: "incoming", payload: {} });
    const origin = before.claimNextTurn({ workerId: "agent", sessionId: "group:job" })!;
    const deferred = before.deferTurn({
      turnId: origin.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "restart-call",
        toolName: "codex",
        originalRequest: {},
        arguments: {}
      },
      acknowledgement: { kind: "ack", payload: {} }
    });
    before.claimNextToolJob({ workerId: "old-job", leaseMs: 60_000, sessionId: "group:job" });
    const ack = before.claimNextOutbox({ workerId: "old-sender", leaseMs: 60_000, sessionId: "group:job" })!;
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ ...options(), recoverOnOpen: "all" });
    storeForCleanup(after);
    expect(after.getTurn(runningTurn.turn.id)?.status).toBe("interrupted");
    expect(after.getEvent(runningTurn.event.id)?.status).toBe("pending");
    expect(after.getToolJob(deferred.job.id)?.status).toBe("queued");
    expect(after.getOutbox(ack.id)?.status).toBe("pending");

    expect(after.claimNextTurn({ workerId: "new-turn", sessionId: "group:turn" }))
      .toMatchObject({ turn: { attempt: 2 } });
    expect(after.claimNextToolJob({ workerId: "new-job", sessionId: "group:job" }))
      .toMatchObject({ attempts: 2 });
    expect(after.claimNextOutbox({ workerId: "new-sender", sessionId: "group:job" }))
      .toMatchObject({ attempts: 2 });
  });
});

async function createHarness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-store-"));
  temporaryDirectories.push(directory);
  let now = 1_000;
  let id = 0;
  const store = new SessionStore({
    databasePath: path.join(directory, "sessions.sqlite"),
    clock: () => now,
    idFactory: () => `id-${++id}`
  });
  storeForCleanup(store);
  return {
    store,
    advance(milliseconds: number) {
      now += milliseconds;
    }
  };
}

function storeForCleanup(store: SessionStore) {
  stores.push(store);
  return store;
}
