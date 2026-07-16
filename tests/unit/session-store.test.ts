// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT,
  type ReplyGateSnapshotV1
} from "../../packages/contracts/session/runtimeMessages.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";

const stores: SessionStore[] = [];
const temporaryDirectories: string[] = [];
const THREAD_ID = "thread:22222222222222222222222222222222";

const threadContextSnapshot = {
  schemaVersion: 1,
  revision: 4,
  processedThroughSequence: 17,
  activeThreadId: THREAD_ID,
  threads: [{
    threadId: THREAD_ID,
    topic: "群成员正在检查异步工具执行期间的上下文是否保持一致。",
    status: "active",
    participantUids: ["171419991"],
    messageIds: ["4004"]
  }],
  messageAssignments: [{
    messageId: "4004",
    sequence: 17,
    primaryThreadId: THREAD_ID,
    relatedThreadIds: [],
    relation: "continue",
    confidence: 0.96
  }]
} as const;

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
    expect(after.replayUnknownOutbox({
      outboxId: sending.id,
      confirmedNotSent: true
    }).id).toBe(replay.id);
    const replayClaim = after.claimNextOutbox({ workerId: "replay-sender" });
    expect(replayClaim).toMatchObject({ id: replay.id, status: "sending" });
    after.finishOutbox({
      outboxId: replay.id,
      workerId: "replay-sender",
      outcome: "sent"
    });
    expect(after.replayUnknownOutbox({
      outboxId: sending.id,
      confirmedNotSent: true
    })).toMatchObject({ id: replay.id, status: "sent" });
    expect(after.listOutbox("group:unknown")).toHaveLength(2);
    expect(after.claimNextOutbox({ workerId: "must-not-resend" })).toBeNull();
  });

  it("replays recovered conversation assets through one stable idempotent row", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-asset-unknown-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const before = new SessionStore({ databasePath });
    storeForCleanup(before);
    before.enqueueEvent({ sessionId: "private:asset-unknown", kind: "incoming", payload: {} });
    const turn = before.claimNextTurn({ workerId: "turn" })!;
    before.finishTurn({
      turnId: turn.turn.id,
      workerId: "turn",
      outcome: "replied",
      outbox: [{
        kind: "onebot.conversation_asset",
        deliveryPartition: "primary",
        payload: { fixture: true }
      }]
    });
    const sending = before.claimNextOutbox({ workerId: "sender" })!;
    before.markOutboxTransportStarted(sending.id, "sender");
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ databasePath, recoverOnOpen: "all" });
    storeForCleanup(after);
    expect(after.getOutbox(sending.id)).toMatchObject({ status: "delivery_unknown" });
    const replay = after.replayUnknownOutbox({
      outboxId: sending.id,
      confirmedNotSent: true
    });
    expect(replay).toMatchObject({
      status: "pending",
      kind: "onebot.conversation_asset",
      deliveryPartition: "primary",
      payload: { fixture: true }
    });
    expect(replay.dedupeKey).toMatch(new RegExp(`^outbox-replay:${sending.id}:[a-f0-9]{64}$`));
    expect(after.replayUnknownOutbox({
      outboxId: sending.id,
      confirmedNotSent: true
    }).id).toBe(replay.id);
    const replayClaim = after.claimNextOutbox({ workerId: "asset-replay-unknown" });
    expect(replayClaim).toMatchObject({ id: replay.id, status: "sending" });
    after.markOutboxTransportStarted(replay.id, "asset-replay-unknown");
    after.finishOutbox({
      outboxId: replay.id,
      workerId: "asset-replay-unknown",
      outcome: "delivery_unknown"
    });
    const nestedReplay = after.replayUnknownOutbox({
      outboxId: replay.id,
      confirmedNotSent: true
    });
    expect(nestedReplay.dedupeKey).toMatch(new RegExp(`^outbox-replay:${replay.id}:[a-f0-9]{64}$`));
    expect(after.replayUnknownOutbox({
      outboxId: replay.id,
      confirmedNotSent: true
    }).id).toBe(nestedReplay.id);
    expect(after.listOutbox("private:asset-unknown")).toHaveLength(3);

    after.enqueueEvent({ sessionId: "private:asset-replay-tamper", kind: "incoming", payload: {} });
    const inspection = new DatabaseSync(databasePath);
    inspection.exec("PRAGMA foreign_keys = ON");
    inspection.prepare("UPDATE outbox SET session_id = ? WHERE id = ?")
      .run("private:asset-replay-tamper", nestedReplay.id);
    expect(() => after.replayUnknownOutbox({
      outboxId: replay.id,
      confirmedNotSent: true
    })).toThrow("Outbox replay provenance is invalid.");
    expect((inspection.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number }).count).toBe(3);
    inspection.close();
  });

  it("replays released held outbox with bounded trusted lineage and a stable dedupe key", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    const { turn, event } = createClaimedHeldTurn(store, "private:held-replay", "held-replay-turn");
    const held = store.appendHeldTurnOutbox({
      turnId: turn.id,
      workerId: "held-replay-turn",
      dedupeKey: `turn-outbox:${event.id}:1`,
      draft: heldReplyDraft(gate, "unchanged"),
      hold: heldOptions(gate, "unchanged")
    }).outbox;
    store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: gate
    });
    store.finishTurn({
      turnId: turn.id,
      workerId: "held-replay-turn",
      outcome: "replied"
    });
    quarantineOutbox(store, held.id, "held-replay-sender-0");

    const firstReplay = store.replayUnknownOutbox({
      outboxId: held.id,
      confirmedNotSent: true
    });
    expect(firstReplay).toMatchObject({
      holdState: "released",
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      dedupeKey: `outbox-replay:${held.id}:${TEST_MUTATION_FINGERPRINT}`,
      holdProvenance: {
        lineage: [{
          outboxId: held.id,
          mutationFingerprint: TEST_MUTATION_FINGERPRINT,
          holdState: "released"
        }]
      },
      releaseProvenance: { outcome: "released", replyGate: gate }
    });
    expect(store.replayUnknownOutbox({
      outboxId: held.id,
      confirmedNotSent: true
    })).toEqual(firstReplay);

    let source = firstReplay;
    for (let depth = 1; depth < 8; depth += 1) {
      quarantineOutbox(store, source.id, `held-replay-sender-${depth}`);
      source = store.replayUnknownOutbox({ outboxId: source.id, confirmedNotSent: true });
      expect(source.holdProvenance?.lineage).toHaveLength(depth + 1);
    }
    quarantineOutbox(store, source.id, "held-replay-sender-limit");
    expect(() => store.replayUnknownOutbox({
      outboxId: source.id,
      confirmedNotSent: true
    })).toThrow("lineage exceeds its maximum depth");
  });

  it("does not upgrade ordinary markers, replay held rows, or accept a cross-session replay collision", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    const ordinaryClaim = createClaimedHeldTurn(
      store,
      "private:ordinary-marker-replay",
      "ordinary-marker-turn"
    );
    const markerDraft = heldReplyDraft(gate, "private_scope_plus_one");
    const ordinary = store.finishTurn({
      turnId: ordinaryClaim.turn.id,
      workerId: "ordinary-marker-turn",
      outcome: "replied",
      outbox: [{ ...markerDraft, deliveryPartition: "ordinary-marker" }]
    }).outbox[0]!;
    quarantineOutbox(store, ordinary.id, "ordinary-marker-sender");
    const ordinaryReplay = store.replayUnknownOutbox({
      outboxId: ordinary.id,
      confirmedNotSent: true
    });
    expect(ordinaryReplay).toMatchObject({ holdState: "none" });
    expect(ordinaryReplay.mutationFingerprint).toBeUndefined();

    const heldClaim = createClaimedHeldTurn(store, "private:held-no-replay", "held-no-replay-turn");
    const stillHeld = store.appendHeldTurnOutbox({
      turnId: heldClaim.turn.id,
      workerId: "held-no-replay-turn",
      dedupeKey: `turn-outbox:${heldClaim.event.id}:1`,
      draft: heldReplyDraft(gate, "unchanged"),
      hold: heldOptions(gate, "unchanged")
    }).outbox;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.prepare(`
      UPDATE outbox
      SET status = 'unknown', delivery_state = 'delivery_unknown', finished_at = 1000
      WHERE id = ?
    `).run(stillHeld.id);
    expect(() => store.replayUnknownOutbox({
      outboxId: stillHeld.id,
      confirmedNotSent: true
    })).toThrow("cannot be replayed before release");

    const sourceClaim = createClaimedHeldTurn(
      store,
      "private:held-global-collision-source",
      "held-global-source-turn"
    );
    const source = store.appendHeldTurnOutbox({
      turnId: sourceClaim.turn.id,
      workerId: "held-global-source-turn",
      dedupeKey: `turn-outbox:${sourceClaim.event.id}:1`,
      draft: heldReplyDraft(gate, "unchanged"),
      hold: heldOptions(gate, "unchanged")
    }).outbox;
    store.releaseHeldOutbox({
      outboxId: source.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: gate
    });
    store.finishTurn({
      turnId: sourceClaim.turn.id,
      workerId: "held-global-source-turn",
      outcome: "replied"
    });
    quarantineOutbox(store, source.id, "held-global-source-sender");

    const collisionClaim = createClaimedHeldTurn(
      store,
      "private:held-global-collision-foreign",
      "held-global-foreign-turn"
    );
    store.finishTurn({
      turnId: collisionClaim.turn.id,
      workerId: "held-global-foreign-turn",
      outcome: "replied",
      outbox: [{
        kind: "reply",
        deliveryPartition: "foreign-partition",
        dedupeKey: `outbox-replay:${source.id}:${TEST_MUTATION_FINGERPRINT}`,
        payload: { text: "foreign collision" }
      }]
    });
    const countBefore = store.listOutbox("private:held-global-collision-source").length +
      store.listOutbox("private:held-global-collision-foreign").length;
    expect(() => store.replayUnknownOutbox({
      outboxId: source.id,
      confirmedNotSent: true
    })).toThrow("conflicts with its original row");
    expect(store.listOutbox("private:held-global-collision-source").length +
      store.listOutbox("private:held-global-collision-foreign").length).toBe(countBefore);
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
    const outboxColumns = inspection.prepare("PRAGMA table_info(outbox)").all()
      .map((row) => String((row as { name: unknown }).name));
    inspection.close();

    expect(columns).toEqual(expect.arrayContaining(["attempt_token", "process_identity_json"]));
    expect(outboxColumns).toEqual(expect.arrayContaining([
      "hold_state",
      "mutation_fingerprint",
      "hold_provenance_json",
      "release_provenance_json"
    ]));
    expect(version.version).toBe(5);
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
      status: "delivery_unknown",
      holdState: "none"
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

  it("finds and reschedules pending or active events without bypassing Session heads", async () => {
    const { store, advance } = await createHarness();
    const firstHead = store.enqueueEvent({
      sessionId: "debounce:first",
      kind: "reply_debounce",
      payload: { text: "head" },
      availableAt: 1_500
    }).event;
    const hiddenTail = store.enqueueEvent({
      sessionId: "debounce:first",
      kind: "reply_debounce",
      payload: { text: "tail" },
      availableAt: 1_100
    }).event;
    store.enqueueEvent({
      sessionId: "debounce:second",
      kind: "reply_debounce",
      payload: { text: "other" },
      availableAt: 1_300
    });

    expect(store.getPendingEvent("debounce:first", "reply_debounce")?.id).toBe(hiddenTail.id);
    expect(store.getActiveEvent("debounce:first", "reply_debounce")?.id).toBe(hiddenTail.id);
    expect(store.nextClaimableEventAvailableAt()).toBe(1_300);
    expect(store.reschedulePendingEvent(firstHead.id, 1_200)).toMatchObject({
      id: firstHead.id,
      availableAt: 1_200,
      status: "pending"
    });
    expect(store.nextClaimableEventAvailableAt()).toBe(1_200);
    expect(() => store.reschedulePendingEvent(firstHead.id, -1)).toThrow("non-negative integer");

    advance(200);
    const running = store.claimNextTurn({
      workerId: "debounce-worker",
      sessionId: "debounce:first"
    })!;
    expect(running.event.id).toBe(firstHead.id);
    expect(store.reschedulePendingEvent(firstHead.id, 1_600)).toBeUndefined();
    expect(store.bumpActiveEventAvailableAt(firstHead.id, "wrong_kind", 1_600)).toBeUndefined();
    expect(store.bumpActiveEventAvailableAt(firstHead.id, "reply_debounce", 1_600)).toMatchObject({
      id: firstHead.id,
      availableAt: 1_600,
      status: "running"
    });
    store.finishTurn({
      turnId: running.turn.id,
      workerId: "debounce-worker",
      outcome: "no_reply"
    });
    expect(store.bumpActiveEventAvailableAt(firstHead.id, "reply_debounce", 1_700)).toBeUndefined();
  });

  it("lists active events by kind in stable creation and id order", () => {
    const ids = ["active-b", "active-a", "other", "completed"];
    let generatedId = 0;
    const store = storeForCleanup(new SessionStore({
      databasePath: ":memory:",
      clock: () => 1_000,
      idFactory: () => ids.shift() ?? `generated-${++generatedId}`
    }));
    const activeB = store.enqueueEvent({
      sessionId: "active:list:b",
      kind: "reply_debounce",
      payload: { sender: "b" }
    }).event;
    const activeA = store.enqueueEvent({
      sessionId: "active:list:a",
      kind: "reply_debounce",
      payload: { sender: "a" }
    }).event;
    store.enqueueEvent({
      sessionId: "active:list:other",
      kind: "incoming",
      payload: {}
    });
    const terminal = store.enqueueEvent({
      sessionId: "active:list:completed",
      kind: "reply_debounce",
      payload: {}
    }).event;
    expect(store.claimNextTurn({
      workerId: "active-list-running",
      sessionId: activeB.sessionId
    })?.event.id).toBe(activeB.id);
    const terminalClaim = store.claimNextTurn({
      workerId: "active-list-completed",
      sessionId: terminal.sessionId
    })!;
    store.finishTurn({
      turnId: terminalClaim.turn.id,
      workerId: "active-list-completed",
      outcome: "no_reply"
    });

    expect(store.listActiveEvents("reply_debounce")).toMatchObject([
      { id: activeA.id, status: "pending", payload: { sender: "a" } },
      { id: activeB.id, status: "running", payload: { sender: "b" } }
    ]);
    expect(store.listActiveEvents("incoming")).toHaveLength(1);
    expect(() => store.listActiveEvents(" ")).toThrow("kind is required");
  });

  it("atomically replaces an active event deadline and payload while preserving envelope metadata", async () => {
    const { store, advance } = await createHarness();
    const event = store.enqueueEvent({
      sessionId: "debounce:active-update",
      kind: "reply_debounce",
      dedupeKey: "debounce:active-update:sender",
      payload: { trigger: "message-1", followUps: [] },
      availableAt: 1_200
    }).event;
    const database = (store as unknown as { database: DatabaseSync }).database;
    const readStoredEnvelope = () => JSON.parse(String((database.prepare(`
      SELECT payload_json FROM session_events WHERE id = ?
    `).get(event.id) as { payload_json: string }).payload_json)) as Record<string, unknown>;
    const before = readStoredEnvelope();
    const { payload: _beforePayload, ...beforeMetadata } = before;

    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_300,
      expectedAvailableAt: 1_200,
      expectedPayload: { trigger: "message-1", followUps: [] },
      payload: { trigger: "message-1", followUps: ["message-2"] }
    })).toMatchObject({
      status: "pending",
      availableAt: 1_300,
      payload: { trigger: "message-1", followUps: ["message-2"] }
    });
    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_350,
      expectedAvailableAt: 1_300,
      expectedPayload: { trigger: "message-1", followUps: [] },
      payload: { trigger: "must-not-overwrite-pending" }
    })).toBeUndefined();
    expect(store.getEvent(event.id)).toMatchObject({
      availableAt: 1_300,
      payload: { trigger: "message-1", followUps: ["message-2"] }
    });
    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_200,
      payload: { trigger: "message-1", followUps: ["message-2", "message-3"] }
    })).toMatchObject({
      status: "pending",
      availableAt: 1_200,
      payload: { trigger: "message-1", followUps: ["message-2", "message-3"] }
    });
    const { payload: _afterPayload, ...afterMetadata } = readStoredEnvelope();
    expect(afterMetadata).toEqual(beforeMetadata);
    expect(afterMetadata.id).toBe(event.id);

    advance(200);
    const running = store.claimNextTurn({
      workerId: "active-update-worker",
      sessionId: "debounce:active-update"
    })!;
    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_500,
      expectedAvailableAt: 1_200,
      expectedPayload: { trigger: "message-1", followUps: ["message-2", "message-3"] },
      payload: { trigger: "message-1", followUps: ["message-2", "message-3", "message-4"] }
    })).toMatchObject({
      status: "running",
      availableAt: 1_500,
      payload: { followUps: ["message-2", "message-3", "message-4"] }
    });
    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_550,
      expectedAvailableAt: 1_500,
      expectedPayload: { trigger: "message-1", followUps: ["message-2", "message-3"] },
      payload: { trigger: "must-not-overwrite-running" }
    })).toBeUndefined();
    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "wrong_kind",
      availableAt: 1_600,
      payload: { trigger: "must-not-apply" }
    })).toBeUndefined();
    expect(store.getEvent(event.id)).toMatchObject({
      availableAt: 1_500,
      payload: { followUps: ["message-2", "message-3", "message-4"] }
    });
    expect(() => store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_600,
      expectedAvailableAt: -1,
      payload: {}
    })).toThrow("expectedAvailableAt must be a non-negative integer");

    store.finishTurn({
      turnId: running.turn.id,
      workerId: "active-update-worker",
      outcome: "no_reply"
    });
    expect(store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_700,
      payload: { trigger: "must-not-revive" }
    })).toBeUndefined();
  });

  it("rolls back both active event fields when persistence rejects the update", async () => {
    const { store } = await createHarness();
    const event = store.enqueueEvent({
      sessionId: "debounce:active-update-fault",
      kind: "reply_debounce",
      payload: { trigger: "message-1", followUps: [] },
      availableAt: 1_400
    }).event;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.exec(`
      CREATE TRIGGER inject_active_event_update_failure
      BEFORE UPDATE OF available_at, payload_json ON session_events
      WHEN json_extract(NEW.payload_json, '$.payload.value.injectFailure') = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected active event update failure');
      END;
    `);

    expect(() => store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_800,
      payload: { trigger: "message-1", followUps: ["message-2"], injectFailure: true }
    })).toThrow("injected active event update failure");
    expect(store.getEvent(event.id)).toMatchObject({
      status: "pending",
      availableAt: 1_400,
      payload: { trigger: "message-1", followUps: [] }
    });

    database.prepare(`
      UPDATE session_events SET payload_json = json_set(payload_json, '$.id', 'wrong-event-id')
      WHERE id = ?
    `).run(event.id);
    expect(() => store.updateActiveEvent({
      eventId: event.id,
      kind: "reply_debounce",
      availableAt: 1_900,
      payload: { trigger: "must-not-reencode" }
    })).toThrow("envelope id");
    expect(store.getEvent(event.id)?.availableAt).toBe(1_400);
  });

  it("atomically hands a control turn to a deduplicated target event", async () => {
    const { store } = await createHarness();
    const source = store.enqueueEvent({
      sessionId: "debounce:handoff",
      kind: "reply_debounce",
      dedupeKey: "debounce:handoff:source",
      payload: { trigger: "message-1" },
      availableAt: 1_000
    }).event;
    const claim = store.claimNextTurn({ workerId: "handoff-worker" })!;
    const input = {
      turnId: claim.turn.id,
      workerId: "handoff-worker",
      expectedSourceAvailableAt: source.availableAt,
      targetEvent: {
        sessionId: "group:handoff",
        kind: "incoming",
        dedupeKey: `handoff:${source.id}`,
        payload: { trigger: "message-1" }
      }
    };

    const handedOff = store.handoffTurn(input);
    expect(handedOff).toMatchObject({
      handedOff: true,
      inserted: true,
      duplicate: false,
      turn: { status: "no_reply" },
      sourceEvent: { id: source.id, status: "completed" },
      targetEvent: {
        sessionId: "group:handoff",
        sequence: 1,
        kind: "incoming",
        status: "pending",
        dedupeKey: `handoff:${source.id}`
      }
    });
    expect(store.handoffTurn(input)).toMatchObject({
      handedOff: true,
      inserted: false,
      duplicate: true,
      targetEvent: { id: handedOff.handedOff ? handedOff.targetEvent.id : "unreachable" }
    });
    expect(store.listEvents("group:handoff")).toHaveLength(1);

    const existingTarget = store.enqueueEvent({
      sessionId: "group:existing-target",
      kind: "incoming",
      dedupeKey: "handoff:already-present",
      payload: { trigger: "already present" }
    }).event;
    const secondSource = store.enqueueEvent({
      sessionId: "debounce:existing-target",
      kind: "reply_debounce",
      payload: {},
      availableAt: 1_000
    }).event;
    const secondClaim = store.claimNextTurn({
      workerId: "handoff-existing-worker",
      sessionId: "debounce:existing-target"
    })!;
    expect(store.handoffTurn({
      turnId: secondClaim.turn.id,
      workerId: "handoff-existing-worker",
      expectedSourceAvailableAt: secondSource.availableAt,
      targetEvent: {
        sessionId: "group:existing-target",
        kind: "incoming",
        dedupeKey: "handoff:already-present",
        payload: { trigger: "already present" }
      }
    })).toMatchObject({
      handedOff: true,
      inserted: false,
      duplicate: false,
      sourceEvent: { status: "completed" },
      targetEvent: { id: existingTarget.id }
    });
    expect(store.listEvents("group:existing-target")).toHaveLength(1);
  });

  it("deduplicates a handoff target across nested JSON key insertion orders", async () => {
    const { store } = await createHarness();
    const composedKey = "\u00e9";
    const decomposedKey = "e\u0301";
    const targetSessionId = "group:handoff-canonical-order";
    const targetDedupeKey = "handoff:canonical-order";
    const existing = store.enqueueEvent({
      sessionId: targetSessionId,
      kind: "incoming",
      dedupeKey: targetDedupeKey,
      payload: {
        nested: {
          [composedKey]: "composed",
          [decomposedKey]: "decomposed"
        }
      }
    }).event;
    const source = store.enqueueEvent({
      sessionId: "debounce:handoff-canonical-order",
      kind: "reply_debounce",
      payload: {}
    }).event;
    const claim = store.claimNextTurn({
      workerId: "handoff-canonical-order",
      sessionId: source.sessionId
    })!;

    expect(store.handoffTurn({
      turnId: claim.turn.id,
      workerId: "handoff-canonical-order",
      expectedSourceAvailableAt: source.availableAt,
      targetEvent: {
        sessionId: targetSessionId,
        kind: "incoming",
        dedupeKey: targetDedupeKey,
        payload: {
          nested: {
            [decomposedKey]: "decomposed",
            [composedKey]: "composed"
          }
        }
      }
    })).toMatchObject({
      handedOff: true,
      inserted: false,
      sourceEvent: { id: source.id, status: "completed" },
      targetEvent: { id: existing.id }
    });
  });

  it.each([
    {
      label: "kind",
      existingKind: "different_kind",
      existingPayload: {
        incoming: { senderId: "sender-a", messageId: "message-1" },
        replyGate: { revision: 1 },
        contextThroughSequence: 4
      }
    },
    {
      label: "sender",
      existingKind: "incoming",
      existingPayload: {
        incoming: { senderId: "sender-b", messageId: "message-1" },
        replyGate: { revision: 1 },
        contextThroughSequence: 4
      }
    },
    {
      label: "message",
      existingKind: "incoming",
      existingPayload: {
        incoming: { senderId: "sender-a", messageId: "message-2" },
        replyGate: { revision: 1 },
        contextThroughSequence: 4
      }
    },
    {
      label: "gate",
      existingKind: "incoming",
      existingPayload: {
        incoming: { senderId: "sender-a", messageId: "message-1" },
        replyGate: { revision: 2 },
        contextThroughSequence: 4
      }
    },
    {
      label: "context",
      existingKind: "incoming",
      existingPayload: {
        incoming: { senderId: "sender-a", messageId: "message-1" },
        replyGate: { revision: 1 },
        contextThroughSequence: 5
      }
    }
  ])("rejects a handoff target dedupe $label collision without changing the source", async ({
    label,
    existingKind,
    existingPayload
  }) => {
    const { store } = await createHarness();
    const targetSessionId = `group:handoff-collision:${label}`;
    const targetDedupeKey = `handoff:collision:${label}`;
    const requestedPayload = {
      incoming: { senderId: "sender-a", messageId: "message-1" },
      replyGate: { revision: 1 },
      contextThroughSequence: 4
    };
    const existing = store.enqueueEvent({
      sessionId: targetSessionId,
      kind: existingKind,
      dedupeKey: targetDedupeKey,
      payload: existingPayload
    }).event;
    expect(store.enqueueEvent({
      sessionId: targetSessionId,
      kind: "incoming",
      dedupeKey: targetDedupeKey,
      payload: requestedPayload
    })).toMatchObject({ inserted: false, event: { id: existing.id } });
    const source = store.enqueueEvent({
      sessionId: `debounce:handoff-collision:${label}`,
      kind: "reply_debounce",
      payload: {}
    }).event;
    const claim = store.claimNextTurn({
      workerId: `handoff-collision:${label}`,
      sessionId: source.sessionId
    })!;

    expect(() => store.handoffTurn({
      turnId: claim.turn.id,
      workerId: `handoff-collision:${label}`,
      expectedSourceAvailableAt: source.availableAt,
      targetEvent: {
        sessionId: targetSessionId,
        kind: "incoming",
        dedupeKey: targetDedupeKey,
        payload: requestedPayload
      }
    })).toThrow("Handoff target dedupe collision");
    expect(store.getEvent(source.id)).toMatchObject({ status: "running" });
    expect(store.getTurn(claim.turn.id)).toMatchObject({ status: "running" });
    expect(store.getSessionState(source.sessionId)?.completedEventSequence).toBe(0);
    expect(store.getEvent(existing.id)).toMatchObject({
      kind: existingKind,
      payload: existingPayload
    });
  });

  it.each([
    ["conversationId", "group:wrong-conversation"],
    ["correlationId", "wrong-correlation"],
    ["causationId", "wrong-causation"],
    ["idempotencyKey", "wrong-idempotency"]
  ])("rejects mismatched handoff target %s provenance", async (field, replacement) => {
    const { store } = await createHarness();
    const targetSessionId = `group:handoff-provenance:${field}`;
    const targetDedupeKey = `handoff:provenance:${field}`;
    const payload = { incoming: { senderId: "sender-a", messageId: "message-1" } };
    const existing = store.enqueueEvent({
      sessionId: targetSessionId,
      kind: "incoming",
      dedupeKey: targetDedupeKey,
      payload
    }).event;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.prepare(`
      UPDATE session_events SET payload_json = json_set(payload_json, ?, ?)
      WHERE id = ?
    `).run(`$.${field}`, replacement, existing.id);
    const source = store.enqueueEvent({
      sessionId: `debounce:handoff-provenance:${field}`,
      kind: "reply_debounce",
      payload: {}
    }).event;
    const claim = store.claimNextTurn({
      workerId: `handoff-provenance:${field}`,
      sessionId: source.sessionId
    })!;

    expect(() => store.handoffTurn({
      turnId: claim.turn.id,
      workerId: `handoff-provenance:${field}`,
      expectedSourceAvailableAt: source.availableAt,
      targetEvent: {
        sessionId: targetSessionId,
        kind: "incoming",
        dedupeKey: targetDedupeKey,
        payload
      }
    })).toThrow("Handoff target dedupe collision");
    expect(store.getEvent(source.id)).toMatchObject({ status: "running" });
    expect(store.getTurn(claim.turn.id)).toMatchObject({ status: "running" });
  });

  it("lets a deadline bump win a running handoff and retries from pending", async () => {
    const { store, advance } = await createHarness();
    const source = store.enqueueEvent({
      sessionId: "debounce:race",
      kind: "reply_debounce",
      payload: { trigger: "message-1" },
      availableAt: 1_000
    }).event;
    const first = store.claimNextTurn({ workerId: "handoff:first" })!;
    expect(store.bumpActiveEventAvailableAt(source.id, "reply_debounce", 1_500)).toMatchObject({
      status: "running",
      availableAt: 1_500
    });

    const stale = store.handoffTurn({
      turnId: first.turn.id,
      workerId: "handoff:first",
      expectedSourceAvailableAt: 1_000,
      targetEvent: {
        sessionId: "group:race",
        kind: "incoming",
        dedupeKey: `handoff:${source.id}`,
        payload: { trigger: "message-1" }
      }
    });
    expect(stale).toMatchObject({
      handedOff: false,
      turn: { status: "interrupted" },
      sourceEvent: { status: "pending", availableAt: 1_500 }
    });
    expect(store.listEvents("group:race")).toEqual([]);
    expect(store.claimNextTurn({ workerId: "too-early" })).toBeNull();

    advance(500);
    const retry = store.claimNextTurn({ workerId: "handoff:retry" })!;
    const committed = store.handoffTurn({
      turnId: retry.turn.id,
      workerId: "handoff:retry",
      expectedSourceAvailableAt: 1_500,
      targetEvent: {
        sessionId: "group:race",
        kind: "incoming",
        dedupeKey: `handoff:${source.id}`,
        payload: { trigger: "message-2" }
      }
    });
    expect(committed).toMatchObject({ handedOff: true, inserted: true });
    expect(store.listTurns("debounce:race").map((turn) => turn.status)).toEqual([
      "interrupted",
      "no_reply"
    ]);
    expect(store.listEvents("group:race")).toHaveLength(1);
    expect(store.bumpActiveEventAvailableAt(source.id, "reply_debounce", 2_000)).toBeUndefined();
  });

  it("rolls back the target event when source handoff completion fails", async () => {
    const { store } = await createHarness();
    const source = store.enqueueEvent({
      sessionId: "debounce:fault",
      kind: "reply_debounce",
      payload: {},
      availableAt: 1_000
    }).event;
    const claim = store.claimNextTurn({ workerId: "handoff:fault" })!;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.exec(`
      CREATE TRIGGER inject_handoff_failure
      BEFORE UPDATE OF status ON turns
      WHEN NEW.status = 'no_reply'
      BEGIN
        SELECT RAISE(ABORT, 'injected handoff failure');
      END;
    `);

    const handoffInput = {
      turnId: claim.turn.id,
      workerId: "handoff:fault",
      expectedSourceAvailableAt: source.availableAt,
      targetEvent: {
        sessionId: "group:fault",
        kind: "incoming",
        dedupeKey: `handoff:${source.id}`,
        payload: { text: "must roll back" }
      }
    };
    expect(() => store.handoffTurn(handoffInput)).toThrow("injected handoff failure");
    expect(store.getSessionState("group:fault")).toBeUndefined();
    expect(store.getEvent(source.id)).toMatchObject({ status: "running" });
    expect(store.getTurn(claim.turn.id)).toMatchObject({ status: "running" });

    database.exec("DROP TRIGGER inject_handoff_failure");
    expect(store.handoffTurn(handoffInput)).toMatchObject({
      handedOff: true,
      inserted: true,
      sourceEvent: { status: "completed" },
      targetEvent: { payload: { text: "must roll back" } }
    });
    expect(store.listEvents("group:fault")).toHaveLength(1);
  });

  it("appends a running turn outbox idempotently across attempts and rejects key collisions", async () => {
    const { store } = await createHarness();
    const firstEvent = store.enqueueEvent({
      sessionId: "group:active-outbox",
      kind: "incoming",
      payload: { text: "first" }
    });
    store.enqueueEvent({
      sessionId: "group:active-outbox",
      kind: "incoming",
      payload: { text: "second" }
    });
    const firstAttempt = store.claimNextTurn({ workerId: "worker:first" })!;
    const input = {
      turnId: firstAttempt.turn.id,
      workerId: "worker:first",
      dedupeKey: `turn-outbox:${firstEvent.event.id}:1`,
      draft: {
        kind: "reply",
        payload: { text: "dispatch now" },
        dedupeFingerprint: "dispatch-now"
      }
    };

    expect(() => store.appendTurnOutbox({ ...input, workerId: "worker:wrong" }))
      .toThrow("does not own turn");
    const inserted = store.appendTurnOutbox(input);
    const duplicate = store.appendTurnOutbox({
      ...input,
      draft: { ...input.draft }
    });
    expect(inserted).toMatchObject({
      inserted: true,
      outbox: {
        status: "pending",
        dedupeKey: `${input.dedupeKey}:dispatch-now`,
        payload: { text: "dispatch now" }
      }
    });
    expect(duplicate).toEqual({ outbox: inserted.outbox, inserted: false });
    expect(() => store.appendTurnOutbox({
      ...input,
      draft: {
        kind: "reply",
        payload: { text: "changed dispatch" },
        dedupeFingerprint: "changed-dispatch"
      }
    })).toThrow("dedupe fingerprint changed");

    expect(store.recoverAllLeases().turns).toBe(1);
    const retry = store.claimNextTurn({ workerId: "worker:retry" })!;
    const repeatedAttempt = store.appendTurnOutbox({
      ...input,
      turnId: retry.turn.id,
      workerId: "worker:retry"
    });
    expect(repeatedAttempt).toEqual({ outbox: inserted.outbox, inserted: false });
    expect(store.listOutbox("group:active-outbox")).toHaveLength(1);

    store.finishTurn({
      turnId: retry.turn.id,
      workerId: "worker:retry",
      outcome: "no_reply"
    });
    const secondTurn = store.claimNextTurn({ workerId: "worker:second" })!;
    expect(() => store.appendTurnOutbox({
      turnId: secondTurn.turn.id,
      workerId: "worker:second",
      dedupeKey: input.dedupeKey,
      draft: {
        kind: "reply",
        payload: { text: "collision" },
        dedupeFingerprint: "collision"
      }
    })).toThrow(`belongs to event ${firstEvent.event.id}`);
  });

  it("inserts held outbox directly and blocks its Session and delivery partition FIFO", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    store.enqueueEvent({ sessionId: "private:held", kind: "incoming", payload: {} });
    const heldTurn = store.claimNextTurn({ workerId: "held-turn", sessionId: "private:held" })!;
    const database = (store as unknown as { database: DatabaseSync }).database;
    const appendInput = {
      turnId: heldTurn.turn.id,
      workerId: "held-turn",
      dedupeKey: `turn-outbox:${heldTurn.event.id}:1`,
      draft: heldReplyDraft(gate, "private_scope_plus_one"),
      hold: heldOptions(gate, "private_scope_plus_one")
    };
    database.exec(`
      CREATE TRIGGER inject_held_insert_failure
      BEFORE INSERT ON outbox
      WHEN NEW.hold_state = 'held'
      BEGIN
        SELECT RAISE(ABORT, 'injected held insert failure');
      END;
    `);
    expect(() => store.appendHeldTurnOutbox(appendInput)).toThrow("injected held insert failure");
    expect(store.listOutbox("private:held")).toEqual([]);
    expect(store.getSessionState("private:held")?.nextOutboxSequence).toBe(0);
    database.exec("DROP TRIGGER inject_held_insert_failure");
    database.exec(`
      CREATE TRIGGER reject_two_phase_hold
      BEFORE UPDATE OF hold_state ON outbox
      WHEN NEW.hold_state = 'held'
      BEGIN
        SELECT RAISE(ABORT, 'held must be inserted directly');
      END;
    `);

    const held = store.appendHeldTurnOutbox(appendInput);
    expect(held).toMatchObject({
      inserted: true,
      outbox: {
        holdState: "held",
        mutationFingerprint: TEST_MUTATION_FINGERPRINT,
        status: "pending",
        holdProvenance: {
          schemaVersion: 1,
          releasePolicy: "private_scope_plus_one",
          originalReplyGate: gate,
          lineage: []
        }
      }
    });
    expect(held.outbox.releaseProvenance).toBeUndefined();
    expect(store.appendHeldTurnOutbox({
      turnId: heldTurn.turn.id,
      workerId: "held-turn",
      dedupeKey: `turn-outbox:${heldTurn.event.id}:1`,
      draft: heldReplyDraft(gate, "private_scope_plus_one"),
      hold: heldOptions(gate, "private_scope_plus_one")
    })).toEqual({ outbox: held.outbox, inserted: false });
    expect(store.claimNextOutbox({ workerId: "blocked", sessionId: "private:held" })).toBeNull();

    store.enqueueEvent({ sessionId: "private:same-partition", kind: "incoming", payload: {} });
    const samePartitionTurn = store.claimNextTurn({
      workerId: "same-partition-turn",
      sessionId: "private:same-partition"
    })!;
    store.finishTurn({
      turnId: samePartitionTurn.turn.id,
      workerId: "same-partition-turn",
      outcome: "replied",
      outbox: [{ kind: "reply", deliveryPartition: "primary", payload: { text: "behind held" } }]
    });
    expect(store.claimNextOutbox({
      workerId: "partition-blocked",
      sessionId: "private:same-partition"
    })).toBeNull();

    store.enqueueEvent({ sessionId: "private:other-partition", kind: "incoming", payload: {} });
    const otherTurn = store.claimNextTurn({
      workerId: "other-turn",
      sessionId: "private:other-partition"
    })!;
    store.finishTurn({
      turnId: otherTurn.turn.id,
      workerId: "other-turn",
      outcome: "replied",
      outbox: [{ kind: "reply", deliveryPartition: "secondary", payload: { text: "independent" } }]
    });
    expect(store.claimNextOutbox({ workerId: "other-sender" })).toMatchObject({
      sessionId: "private:other-partition",
      deliveryPartition: "secondary"
    });

    expect(() => store.appendHeldTurnOutbox({
      turnId: heldTurn.turn.id,
      workerId: "held-turn",
      dedupeKey: `turn-outbox:${heldTurn.event.id}:1`,
      draft: heldReplyDraft(gate, "private_scope_plus_one"),
      hold: {
        ...heldOptions(gate, "private_scope_plus_one"),
        mutationFingerprint: `sha256:${"b".repeat(64)}`
      }
    })).toThrow("mutation fingerprint changed");
  });

  it("releases held outbox only for the recorded gate transition and stays idempotent", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    const { turn, event } = createClaimedHeldTurn(store, "private:release", "release-turn");
    const held = store.appendHeldTurnOutbox({
      turnId: turn.id,
      workerId: "release-turn",
      dedupeKey: `turn-outbox:${event.id}:1`,
      draft: heldReplyDraft(gate, "private_scope_plus_one"),
      hold: heldOptions(gate, "private_scope_plus_one")
    }).outbox;

    expect(() => store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: { ...gate, scopeEpoch: gate.scopeEpoch + 2 }
    })).toThrow("release gate");
    expect(() => store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: { ...gate, generation: "other-generation", scopeEpoch: 0, conversationEpoch: 0 }
    })).toThrow("generation changed");
    expect(() => store.neutralizeAndReleaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: { ...gate, generation: "other-generation", scopeEpoch: 0, conversationEpoch: 1 }
    })).toThrow("generation changed");
    expect(store.getOutbox(held.id)).toMatchObject({ holdState: "held" });

    const releaseGate = { ...gate, scopeEpoch: gate.scopeEpoch + 1 };
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.exec(`
      CREATE TRIGGER inject_release_failure
      BEFORE UPDATE OF hold_state ON outbox
      WHEN NEW.hold_state = 'released'
      BEGIN
        SELECT RAISE(ABORT, 'injected release failure');
      END;
    `);
    expect(() => store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: releaseGate
    })).toThrow("injected release failure");
    expect(store.getOutbox(held.id)).toMatchObject({ holdState: "held" });
    expect(store.getOutbox(held.id)?.releaseProvenance).toBeUndefined();
    database.exec("DROP TRIGGER inject_release_failure");
    const released = store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: releaseGate
    });
    expect(released).toMatchObject({
      holdState: "released",
      releaseProvenance: {
        schemaVersion: 1,
        outcome: "released",
        replyGate: releaseGate,
        releasedAt: 1_000
      }
    });
    expect(store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: releaseGate
    })).toEqual(released);
    expect(() => store.releaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: { ...releaseGate, conversationEpoch: 1 }
    })).toThrow("release provenance changed");
    expect(store.claimNextOutbox({ workerId: "released-sender" })).toMatchObject({
      id: held.id,
      holdState: "released"
    });
  });

  it("atomically neutralizes a held confirmation and leaves the success payload unreachable on failure", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    const { turn, event } = createClaimedHeldTurn(store, "private:fallback", "fallback-turn");
    const held = store.appendHeldTurnOutbox({
      turnId: turn.id,
      workerId: "fallback-turn",
      dedupeKey: `turn-outbox:${event.id}:1`,
      draft: heldReplyDraft(gate, "unchanged"),
      hold: heldOptions(gate, "unchanged")
    }).outbox;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.exec(`
      CREATE TRIGGER inject_neutralize_failure
      BEFORE UPDATE OF hold_state ON outbox
      WHEN NEW.hold_state = 'fallback_released'
      BEGIN
        SELECT RAISE(ABORT, 'injected neutralize failure');
      END;
    `);
    expect(() => store.neutralizeAndReleaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: gate
    })).toThrow("injected neutralize failure");
    expect(store.getOutbox(held.id)).toMatchObject({ holdState: "held" });
    expect(store.getOutbox(held.id)?.releaseProvenance).toBeUndefined();
    expect(decodeAssistantReply(store.getOutbox(held.id)!.payload)).toMatchObject({
      text: "设置已经保存。",
      generatedImages: [{ url: "https://example.invalid/success.png" }]
    });

    database.exec("DROP TRIGGER inject_neutralize_failure");
    const fallback = store.neutralizeAndReleaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: gate
    });
    expect(fallback).toMatchObject({
      holdState: "fallback_released",
      releaseProvenance: { outcome: "fallback_released", replyGate: gate }
    });
    expect(decodeAssistantReply(fallback.payload)).toMatchObject({
      text: SYSTEM_CONFIG_NEUTRAL_CONFIRMATION_TEXT,
      generatedImages: [],
      messageOrigin: "text",
      toolNames: ["system_config"]
    });
    expect(decodeAssistantReply(fallback.payload).deliverySemantics).toBeUndefined();
    expect(store.neutralizeAndReleaseHeldOutbox({
      outboxId: held.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: gate
    })).toEqual(fallback);
  });

  it("rejects non-canonical held provenance even when the stored JSON is valid", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    const { turn, event } = createClaimedHeldTurn(store, "private:strict-held", "strict-held-turn");
    const held = store.appendHeldTurnOutbox({
      turnId: turn.id,
      workerId: "strict-held-turn",
      dedupeKey: `turn-outbox:${event.id}:1`,
      draft: heldReplyDraft(gate, "unchanged"),
      hold: heldOptions(gate, "unchanged")
    }).outbox;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.prepare(`
      UPDATE outbox
      SET hold_provenance_json = json_set(hold_provenance_json, '$.unexpected', 1)
      WHERE id = ?
    `).run(held.id);
    expect(() => store.getOutbox(held.id)).toThrow("hold provenance fields are invalid");
    expect(() => database.prepare(`
      UPDATE outbox SET mutation_fingerprint = 'sha256:bad' WHERE id = ?
    `).run(held.id)).toThrow();
    expect(() => database.prepare(`
      UPDATE outbox SET mutation_fingerprint = ? WHERE id = ?
    `).run(`sha256:${"z".repeat(64)}`, held.id)).toThrow();
  });

  it("neutralizes held outbox in the same transaction that finishes its origin turn", async () => {
    const { store } = await createHarness();
    const gate = heldReplyGate();
    const { turn, event } = createClaimedHeldTurn(store, "private:finish-held", "finish-held-turn");
    const held = store.appendHeldTurnOutbox({
      turnId: turn.id,
      workerId: "finish-held-turn",
      dedupeKey: `turn-outbox:${event.id}:1`,
      draft: heldReplyDraft(gate, "private_scope_plus_one"),
      hold: heldOptions(gate, "private_scope_plus_one")
    }).outbox;
    const database = (store as unknown as { database: DatabaseSync }).database;
    database.exec(`
      CREATE TRIGGER inject_finish_held_failure
      BEFORE UPDATE OF hold_state ON outbox
      WHEN NEW.hold_state = 'fallback_released'
      BEGIN
        SELECT RAISE(ABORT, 'injected finish held failure');
      END;
    `);
    const finishInput = {
      turnId: turn.id,
      workerId: "finish-held-turn",
      outcome: "failed" as const,
      error: { code: "handler_failed" },
      resolveHeldReplyGate: () => gate
    };
    expect(() => store.finishTurn(finishInput)).toThrow("injected finish held failure");
    expect(store.getTurn(turn.id)).toMatchObject({ status: "running" });
    expect(store.getEvent(event.id)).toMatchObject({ status: "running" });
    expect(store.getOutbox(held.id)).toMatchObject({ holdState: "held" });

    database.exec("DROP TRIGGER inject_finish_held_failure");
    expect(store.finishTurn(finishInput)).toMatchObject({
      turn: { status: "failed" },
      duplicate: false
    });
    expect(store.getEvent(event.id)).toMatchObject({ status: "completed" });
    expect(store.getOutbox(held.id)).toMatchObject({
      holdState: "fallback_released",
      releaseProvenance: { replyGate: gate }
    });
  });

  it("recovers held and released unfinished turns without rerunning their origin events", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-held-v5-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    let id = 0;
    const before = new SessionStore({
      databasePath,
      idFactory: () => `held-recovery-${++id}`,
      clock: () => 1_000
    });
    storeForCleanup(before);
    const gate = heldReplyGate();
    const heldClaim = createClaimedHeldTurn(before, "private:recover-held", "recover-held-turn");
    const held = before.appendHeldTurnOutbox({
      turnId: heldClaim.turn.id,
      workerId: "recover-held-turn",
      dedupeKey: `turn-outbox:${heldClaim.event.id}:1`,
      draft: heldReplyDraft(gate, "private_scope_plus_one"),
      hold: heldOptions(gate, "private_scope_plus_one")
    }).outbox;
    const releasedClaim = createClaimedHeldTurn(before, "private:recover-released", "recover-released-turn");
    const releasedHeld = before.appendHeldTurnOutbox({
      turnId: releasedClaim.turn.id,
      workerId: "recover-released-turn",
      dedupeKey: `turn-outbox:${releasedClaim.event.id}:1`,
      draft: heldReplyDraft(gate, "unchanged"),
      hold: heldOptions(gate, "unchanged")
    }).outbox;
    before.releaseHeldOutbox({
      outboxId: releasedHeld.id,
      mutationFingerprint: TEST_MUTATION_FINGERPRINT,
      replyGate: gate
    });
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const restartedGate = {
      ...gate,
      generation: "generation-after-restart",
      scopeEpoch: 0,
      conversationEpoch: 0
    };
    expect(() => new SessionStore({ databasePath, recoverOnOpen: "all" }))
      .toThrow("held outbox without a reply gate resolver");
    const after = new SessionStore({
      databasePath,
      recoverOnOpen: "all",
      resolveHeldReplyGate: () => restartedGate
    });
    storeForCleanup(after);
    expect(after.getTurn(heldClaim.turn.id)).toMatchObject({ status: "failed" });
    expect(after.getEvent(heldClaim.event.id)).toMatchObject({ status: "completed" });
    expect(after.getOutbox(held.id)).toMatchObject({
      holdState: "fallback_released",
      releaseProvenance: { replyGate: restartedGate }
    });
    expect(after.getTurn(releasedClaim.turn.id)).toMatchObject({ status: "replied" });
    expect(after.getEvent(releasedClaim.event.id)).toMatchObject({ status: "completed" });
    expect(after.recoverAllLeases(() => restartedGate)).toMatchObject({ turns: 0, outbox: 0 });
    expect(after.claimNextTurn({
      workerId: "must-not-rerun-held",
      sessionId: "private:recover-held"
    })).toBeNull();
    expect(after.claimNextTurn({
      workerId: "must-not-rerun-released",
      sessionId: "private:recover-released"
    })).toBeNull();
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
    expect(store.claimToolJob(deferred.job.id, { workerId: "tool-worker" })).toMatchObject({
      id: deferred.job.id,
      status: "running"
    });
    expect(store.getOutbox(deferred.acknowledgement.id)).toMatchObject({ status: "pending" });
  });

  it("appends one idempotent tool completion event at the session tail", async () => {
    const { store } = await createHarness();
    store.enqueueEvent({ sessionId: "group:400", kind: "incoming", payload: { text: "first" } });
    const origin = store.claimNextTurn({ workerId: "agent" })!;
    const originalRequest = {
      text: "first",
      captureSequence: 17,
      threadContext: threadContextSnapshot
    };
    const deferred = store.deferTurn({
      turnId: origin.turn.id,
      workerId: "agent",
      job: {
        providerCallId: "call_42",
        toolName: "codex",
        originalRequest,
        arguments: { task: "deep research" }
      },
      acknowledgement: { kind: "onebot.group", payload: { text: "开始研究。" } }
    });
    const intervening = store.enqueueEvent({
      sessionId: "group:400",
      kind: "incoming",
      payload: { text: "arrived while the tool ran" }
    });

    deliverPersistedOutbox(store, deferred.acknowledgement.id, "ack-worker");
    const job = store.claimNextToolJob({ workerId: "codex-worker" })!;
    expect(job.id).toBe(deferred.job.id);
    expect(job.originalRequest).toEqual(originalRequest);
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
        originalRequest,
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
    deliverPersistedOutbox(store, deferred.acknowledgement.id, "ack-worker");
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
    deliverPersistedOutbox(store, deferred.acknowledgement.id, "ack-worker");
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

  it("preserves a bumped running event deadline when recovering after restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-session-bumped-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    let now = 10_000;
    let id = 0;
    const options = () => ({
      databasePath,
      clock: () => now,
      idFactory: () => `bumped-restart-${++id}`
    });

    const before = new SessionStore(options());
    storeForCleanup(before);
    const source = before.enqueueEvent({
      sessionId: "debounce:bumped-restart",
      kind: "reply_debounce",
      payload: {},
      availableAt: now
    }).event;
    const running = before.claimNextTurn({ workerId: "old-turn", leaseMs: 60_000 })!;
    expect(running.event.id).toBe(source.id);
    expect(before.bumpActiveEventAvailableAt(source.id, "reply_debounce", 15_000)).toMatchObject({
      status: "running",
      availableAt: 15_000
    });
    before.close();
    stores.splice(stores.indexOf(before), 1);

    now = 10_100;
    const after = new SessionStore({ ...options(), recoverOnOpen: "all" });
    storeForCleanup(after);
    expect(after.getTurn(running.turn.id)).toMatchObject({ status: "interrupted" });
    expect(after.getEvent(source.id)).toMatchObject({
      status: "pending",
      availableAt: 15_000
    });
    expect(after.nextClaimableEventAvailableAt()).toBe(15_000);
    expect(after.claimNextTurn({
      workerId: "too-early",
      sessionId: "debounce:bumped-restart"
    })).toBeNull();

    now = 15_000;
    expect(after.claimNextTurn({
      workerId: "after-deadline",
      sessionId: "debounce:bumped-restart"
    })).toMatchObject({
      event: { id: source.id, attempts: 2 },
      turn: { attempt: 2, status: "running" }
    });
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
    deliverPersistedOutbox(before, deferred.acknowledgement.id, "ack-worker");
    before.claimNextToolJob({ workerId: "old-job", leaseMs: 60_000, sessionId: "group:job" });
    before.enqueueEvent({ sessionId: "group:outbox", kind: "incoming", payload: {} });
    const outboxTurn = before.claimNextTurn({ workerId: "outbox-turn", sessionId: "group:outbox" })!;
    const pendingOutbox = before.finishTurn({
      turnId: outboxTurn.turn.id,
      workerId: "outbox-turn",
      outcome: "replied",
      outbox: [{ kind: "reply", payload: {} }]
    }).outbox[0]!;
    const sendingOutbox = before.claimNextOutbox({
      workerId: "old-sender",
      leaseMs: 60_000,
      sessionId: "group:outbox"
    })!;
    expect(sendingOutbox.id).toBe(pendingOutbox.id);
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ ...options(), recoverOnOpen: "all" });
    storeForCleanup(after);
    expect(after.getTurn(runningTurn.turn.id)?.status).toBe("interrupted");
    expect(after.getEvent(runningTurn.event.id)?.status).toBe("pending");
    expect(after.getToolJob(deferred.job.id)?.status).toBe("queued");
    expect(after.getOutbox(sendingOutbox.id)?.status).toBe("pending");

    expect(after.claimNextTurn({ workerId: "new-turn", sessionId: "group:turn" }))
      .toMatchObject({ turn: { attempt: 2 } });
    expect(after.claimNextToolJob({ workerId: "new-job", sessionId: "group:job" }))
      .toMatchObject({ attempts: 2 });
    expect(after.claimNextOutbox({ workerId: "new-sender", sessionId: "group:outbox" }))
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

function deliverPersistedOutbox(store: SessionStore, outboxId: string, workerId: string) {
  const outbox = store.getOutbox(outboxId)!;
  const claimed = store.claimNextOutbox({ workerId, sessionId: outbox.sessionId })!;
  expect(claimed.id).toBe(outboxId);
  store.finishOutbox({ outboxId, workerId, outcome: "sent" });
}

function quarantineOutbox(store: SessionStore, outboxId: string, workerId: string) {
  const outbox = store.getOutbox(outboxId)!;
  const claimed = store.claimNextOutbox({ workerId, sessionId: outbox.sessionId })!;
  expect(claimed.id).toBe(outboxId);
  store.markOutboxTransportStarted(outboxId, workerId);
  store.finishOutbox({
    outboxId,
    workerId,
    outcome: "delivery_unknown",
    error: { code: "confirmed_unknown_for_test" }
  });
}

const TEST_MUTATION_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function heldReplyGate(): ReplyGateSnapshotV1 {
  return {
    generation: "generation-held-v5",
    scope: "private",
    conversationId: "private:10001",
    scopeEpoch: 4,
    conversationEpoch: 7
  };
}

function heldOptions(
  originalReplyGate: ReplyGateSnapshotV1,
  releasePolicy: "unchanged" | "private_scope_plus_one"
) {
  return {
    mutationFingerprint: TEST_MUTATION_FINGERPRINT,
    semantics: "system_config_confirmation" as const,
    originalReplyGate,
    releasePolicy
  };
}

function heldReplyDraft(
  replyGate: ReplyGateSnapshotV1,
  releasePolicy: "unchanged" | "private_scope_plus_one"
) {
  return {
    kind: "onebot.reply" as const,
    deliveryPartition: "primary",
    dedupeFingerprint: "reply-fingerprint",
    payload: assistantReplyEnvelope({
      type: "assistant_reply",
      incoming: {
        schemaVersion: 1,
        transport: "onebot",
        agentId: "plana",
        accountId: "primary",
        scope: "private",
        messageId: 9001,
        time: "2026-07-17T00:00:00.000Z",
        userId: 10001,
        selfId: 20002,
        sender: { id: "10001", displayName: "管理员" },
        text: "关闭私聊回复",
        media: [],
        attachments: [],
        replyMessageIds: [],
        quoteReferences: [],
        mentionedSelf: false
      },
      text: "设置已经保存。",
      generatedImages: [{ url: "https://example.invalid/success.png" }],
      isAdmin: true,
      messageOrigin: "text",
      toolNames: ["system_config"],
      ...(releasePolicy === "private_scope_plus_one"
        ? { deliverySemantics: "system_config_confirmation" as const }
        : {}),
      replyGate
    }, {
      conversationId: replyGate.conversationId,
      correlationId: "log-held-v5"
    })
  };
}

function createClaimedHeldTurn(store: SessionStore, sessionId: string, workerId: string) {
  store.enqueueEvent({ sessionId, kind: "incoming", payload: {} });
  return store.claimNextTurn({ workerId, sessionId })!;
}
