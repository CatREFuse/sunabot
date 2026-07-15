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
  it("gates an interrupted non-idempotent settle effect until explicit resolution", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-effect-unknown-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const before = new SessionStore({ databasePath });
    storeForCleanup(before);
    before.enqueueEvent({ sessionId: "group:effect", kind: "incoming", payload: {} });
    const turn = before.claimNextTurn({ workerId: "turn" })!;
    before.finishTurn({
      turnId: turn.turn.id,
      workerId: "turn",
      outcome: "replied",
      outbox: [{ kind: "onebot.reply", deliveryPartition: "qq-effect", payload: { text: "hello" } }]
    });
    const sending = before.claimNextOutbox({ workerId: "sender" })!;
    before.markOutboxTransportStarted(sending.id, "sender");
    before.markOutboxRemoteSent(sending.id, "sender", { accepted: true });
    before.beginOutboxSettleEffect(sending.id, "sender", "after_reply:audit");
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ databasePath, recoverOnOpen: "all" });
    storeForCleanup(after);
    expect(after.getOutbox(sending.id)).toMatchObject({
      status: "delivery_unknown",
      uncertainSettleStep: "after_reply:audit",
      completedSettleSteps: []
    });
    expect(after.claimNextOutbox({ workerId: "automatic" })).toBeNull();
    expect(() => after.replayUnknownOutbox({
      outboxId: sending.id,
      confirmedNotSent: true
    })).toThrow("settle effect");
    expect(() => after.resolveUnknownSettle({
      outboxId: sending.id,
      settleStep: "after_reply:audit",
      confirmed: "unknown"
    } as never)).toThrow("confirmed");
    expect(() => after.resolveUnknownSettle({
      outboxId: sending.id,
      settleStep: "",
      confirmed: "applied"
    })).toThrow("settleStep");
    expect(() => after.resolveUnknownSettle({
      outboxId: sending.id,
      settleStep: "after_reply:wrong",
      confirmed: "applied"
    })).toThrow("unknown settle effect is after_reply:audit");

    const resumed = after.resolveUnknownSettle({
      outboxId: sending.id,
      settleStep: "after_reply:audit",
      confirmed: "applied"
    });
    expect(resumed).toMatchObject({
      status: "sent_remote",
      uncertainSettleStep: undefined,
      completedSettleSteps: ["after_reply:audit"]
    });
    expect(() => after.resolveUnknownSettle({
      outboxId: sending.id,
      settleStep: "after_reply:audit",
      confirmed: "applied"
    })).toThrow("does not have an unknown settle effect");
    expect(after.claimNextOutbox({ workerId: "settler" })).toMatchObject({ id: sending.id });
  });

  it("persists delivery partitions and excludes only paused partitions from claims", async () => {
    const { store } = await createHarness();
    for (const [sessionId, accountId] of [["group:offline", "qq-offline"], ["group:online", "qq-online"]]) {
      store.enqueueEvent({ sessionId, kind: "incoming", payload: {} });
      const turn = store.claimNextTurn({ workerId: `turn:${accountId}`, sessionId })!;
      store.finishTurn({
        turnId: turn.turn.id,
        workerId: `turn:${accountId}`,
        outcome: "replied",
        outbox: [{
          kind: "onebot.reply",
          deliveryPartition: accountId,
          payload: { text: accountId }
        }]
      });
    }

    expect(() => store.claimNextOutbox({
      workerId: "sender",
      excludedDeliveryPartitions: [""]
    })).toThrow("excludedDeliveryPartitions");

    const claimed = store.claimNextOutbox({
      workerId: "sender",
      excludedDeliveryPartitions: ["qq-offline"]
    });
    expect(claimed).toMatchObject({
      sessionId: "group:online",
      deliveryPartition: "qq-online"
    });
    expect(store.listOutbox("group:offline")[0]).toMatchObject({
      status: "pending",
      deliveryPartition: "qq-offline"
    });
  });

  it("persists remote receipts before idempotent settlement and resumes settlement after reopening", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-settle-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const before = new SessionStore({ databasePath });
    storeForCleanup(before);
    before.enqueueEvent({ sessionId: "group:settle", kind: "incoming", payload: {} });
    const turn = before.claimNextTurn({ workerId: "turn" })!;
    before.finishTurn({
      turnId: turn.turn.id,
      workerId: "turn",
      outcome: "replied",
      outbox: [{ kind: "onebot.reply", deliveryPartition: "qq-1", payload: { text: "hello" } }]
    });
    const sending = before.claimNextOutbox({ workerId: "sender" })!;
    expect(() => before.markOutboxRemoteSent(
      sending.id,
      "sender",
      { accepted: true }
    )).toThrow("transport has not started");
    before.markOutboxTransportStarted(sending.id, "sender");
    before.markOutboxRemoteSent(sending.id, "sender", { accepted: true, messageId: "9001" });
    expect(() => before.completeOutboxSettleStep(sending.id, "sender", "")).toThrow("settleStep");
    before.completeOutboxSettleStep(sending.id, "sender", "conversation_projection");
    expect(before.getOutbox(sending.id)).toMatchObject({
      status: "sent_remote",
      remoteReceipt: { accepted: true, messageId: "9001" },
      completedSettleSteps: ["conversation_projection"]
    });
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ databasePath, recoverOnOpen: "all" });
    storeForCleanup(after);
    const settlement = after.claimNextOutbox({ workerId: "settler" });
    expect(settlement).toMatchObject({
      id: sending.id,
      status: "sent_remote",
      attempts: 1,
      settleAttempts: 1,
      remoteReceipt: { accepted: true, messageId: "9001" },
      completedSettleSteps: ["conversation_projection"]
    });
  });

  it("quarantines a recovered in-flight transport and requires explicit not-sent confirmation to replay", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-unknown-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const before = new SessionStore({ databasePath });
    storeForCleanup(before);
    before.enqueueEvent({ sessionId: "group:unknown", kind: "incoming", payload: {} });
    const turn = before.claimNextTurn({ workerId: "turn" })!;
    before.finishTurn({
      turnId: turn.turn.id,
      workerId: "turn",
      outcome: "replied",
      outbox: [{ kind: "onebot.reply", deliveryPartition: "qq-unknown", payload: { text: "maybe" } }]
    });
    const sending = before.claimNextOutbox({ workerId: "sender" })!;
    before.markOutboxTransportStarted(sending.id, "sender");
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ databasePath, recoverOnOpen: "all" });
    storeForCleanup(after);
    expect(after.getOutbox(sending.id)).toMatchObject({
      status: "delivery_unknown",
      attempts: 1,
      error: { code: "delivery_recovered_unknown" }
    });
    expect(after.claimNextOutbox({ workerId: "automatic-retry" })).toBeNull();
    expect(() => after.replayUnknownOutbox({
      outboxId: sending.id,
      confirmedNotSent: false
    } as never)).toThrow("confirmedNotSent");

    const replay = after.replayUnknownOutbox({ outboxId: sending.id, confirmedNotSent: true });
    expect(replay).toMatchObject({
      status: "pending",
      deliveryPartition: "qq-unknown",
      partitionSequence: 2,
      attempts: 0
    });
    expect(replay.id).not.toBe(sending.id);
  });

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
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
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
    expect(version.version).toBe(4);
  });

  it("migrates v2 outbox rows into stable OneBot and Web delivery partitions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-v2-outbox-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (2, 1);
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        next_event_sequence INTEGER NOT NULL DEFAULT 0,
        completed_event_sequence INTEGER NOT NULL DEFAULT 0,
        next_outbox_sequence INTEGER NOT NULL DEFAULT 0,
        completed_outbox_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO sessions (
        session_id, next_outbox_sequence, completed_outbox_sequence, created_at, updated_at
      ) VALUES ('group:migrating', 2, 0, 1, 1);
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        lease_until INTEGER,
        started_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE tool_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        worker_id TEXT,
        lease_until INTEGER,
        available_at INTEGER NOT NULL,
        attempt_token TEXT,
        process_identity_json TEXT
      ) STRICT;
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        origin_turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        worker_id TEXT,
        lease_until INTEGER,
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        finished_at INTEGER
      ) STRICT;
    `);
    const payload = (id: string, transport: "onebot" | "web", accountId?: string) => JSON.stringify({
      schemaVersion: 1,
      id,
      type: "session.outbox_message",
      occurredAt: "2026-07-14T00:00:00.000Z",
      conversationId: `group:${id}`,
      correlationId: `turn:${id}`,
      payload: {
        kind: "onebot.reply",
        value: {
          schemaVersion: 1,
          id: `runtime:${id}`,
          type: "runtime.assistant_reply",
          occurredAt: "2026-07-14T00:00:00.000Z",
          correlationId: `message:${id}`,
          payload: {
            incoming: { transport, ...(accountId ? { accountId } : {}) }
          }
        }
      }
    });
    const insert = legacy.prepare(`
      INSERT INTO outbox (
        id, session_id, sequence, origin_turn_id, kind, payload_json,
        status, attempts, available_at, created_at
      ) VALUES (?, ?, 1, ?, 'onebot.reply', ?, ?, 1, 1, ?)
    `);
    insert.run("onebot", "group:onebot", "turn:onebot", payload("onebot", "onebot", "account-secondary"), "unknown", 1);
    insert.run("web", "web:admin", "turn:web", payload("web", "web"), "pending", 2);
    legacy.prepare(`
      INSERT INTO outbox (
        id, session_id, sequence, origin_turn_id, kind, payload_json,
        status, attempts, available_at, worker_id, lease_until, created_at
      ) VALUES (?, 'group:migrating', ?, ?, 'onebot.reply', ?, ?, 1, 1, ?, 999999, ?)
    `).run(
      "legacy-sending",
      1,
      "turn:legacy-sending",
      payload("legacy-sending", "onebot", "account-migrating"),
      "sending",
      "legacy-worker",
      3
    );
    legacy.prepare(`
      INSERT INTO outbox (
        id, session_id, sequence, origin_turn_id, kind, payload_json,
        status, attempts, available_at, created_at
      ) VALUES (?, 'group:migrating', ?, ?, 'onebot.reply', ?, 'pending', 0, 1, ?)
    `).run(
      "legacy-next",
      2,
      "turn:legacy-next",
      payload("legacy-next", "onebot", "account-migrating"),
      4
    );
    legacy.close();

    const migrated = new SessionStore({ databasePath, recoverOnOpen: "all" });
    storeForCleanup(migrated);
    expect(migrated.getOutbox("onebot")).toMatchObject({
      deliveryPartition: "account-secondary",
      partitionSequence: 1,
      status: "delivery_unknown"
    });
    expect(migrated.getOutbox("web")).toMatchObject({
      deliveryPartition: "web",
      partitionSequence: 1,
      status: "pending"
    });
    expect(migrated.getOutbox("legacy-sending")).toMatchObject({
      status: "delivery_unknown",
      error: { code: "legacy_transport_migration_unknown" }
    });
    expect(migrated.getSessionState("group:migrating")?.completedOutboxSequence).toBe(1);
    expect(migrated.claimNextOutbox({ workerId: "post-migration" })).toMatchObject({
      id: "legacy-next",
      status: "sending"
    });
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
