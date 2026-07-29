// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  digestDreamMemorySnapshot,
  SqliteDreamStore,
  type CommitDreamConsolidationInput,
  type JsonObject
} from "../../adapters/sqlite/dreamStore.js";

const DIGEST = "a".repeat(64);
const NOW = new Date("2026-07-21T20:00:00.000Z");
const WORKING_BASELINE: JsonObject[] = [
  { id: "working_recent", fact: "今天在车站聊起一场雨。" }
];
const LONG_TERM_BASELINE: JsonObject[] = [
  { id: "long_term_keep", fact: "喜欢安静的夜晚。" },
  { id: "long_term_merge_a", fact: "旧车站有一面钟。" },
  { id: "long_term_merge_b", fact: "旧车站在雨夜很安静。" },
  { id: "long_term_archive", fact: "一条无关紧要的旧广告。" }
];
const WORKING_FINAL: JsonObject[] = [
  ...WORKING_BASELINE,
  {
    id: "working_dream_2026_07_22",
    fact: "月光落在旧车站，钟声沿着雨水缓慢散开。",
    memoryKind: "dream",
    factuality: "imagined"
  }
];
const LONG_TERM_FINAL: JsonObject[] = [
  LONG_TERM_BASELINE[0]!,
  { id: "long_term_merge_a", fact: "雨夜的旧车站有一面安静的钟。" }
];

describe("Dream consolidation SQLite commit", () => {
  let database: DatabaseSync;
  let store: SqliteDreamStore;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE memory_records (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('working', 'long_term', 'user_profile')),
        position INTEGER NOT NULL,
        record_id TEXT,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      );
      CREATE UNIQUE INDEX memory_records_source_record_id
        ON memory_records(source, record_id) WHERE record_id IS NOT NULL AND record_id <> '';
      CREATE INDEX memory_records_source_position ON memory_records(source, position);
    `);
    store = new SqliteDreamStore(database, {
      clock: () => new Date(NOW),
      idFactory: () => "dream-run"
    });
    replaceMemory("working", WORKING_BASELINE);
    replaceMemory("long_term", LONG_TERM_BASELINE);
  });

  afterEach(() => {
    if (database.isOpen) database.close();
  });

  it("atomically replaces both snapshots, archives, merges recall lineage, and writes reviews", () => {
    createGeneratedRun();
    seedRecallHistory();

    const committed = store.commitConsolidation(commitInput());

    expect(committed).toMatchObject({
      status: "committed",
      run: {
        status: "consolidated",
        workingMemoryId: "working_dream_2026_07_22",
        result: { schemaVersion: 1, merged: 1, archived: 1, promoted: 0 }
      }
    });
    expect(readMemory("working")).toEqual(WORKING_FINAL);
    expect(readMemory("long_term")).toEqual(LONG_TERM_FINAL);
    expect(store.listArchives({ runId: "dream-run" })).toEqual([
      expect.objectContaining({
        recordId: "long_term_archive",
        reason: "低重要度且追踪期内未召回",
        archivedAt: NOW.toISOString(),
        purgeAfter: "2026-08-20T20:00:00.000Z",
        data: LONG_TERM_BASELINE[3]
      })
    ]);
    expect(store.readRecallStats("long_term_merge_b")).toBeUndefined();
    expect(store.readRecallStats("long_term_archive")).toBeUndefined();
    expect(store.readRecallStats("long_term_merge_a")).toMatchObject({
      recallCount: 3,
      distinctRecallDays: 3,
      lastRecalledAt: "2026-07-19T03:00:00.000Z",
      trackingStartedAt: "2026-04-01T00:00:00.000Z",
      lastReviewedAt: NOW.toISOString(),
      importance: 0.72,
      futureRelevance: 0.44,
      emotionalSalience: 0.61
    });
    expect(store.readRecallStats("long_term_keep")).toMatchObject({
      recallCount: 0,
      trackingStartedAt: NOW.toISOString(),
      lastReviewedAt: NOW.toISOString(),
      importance: 0.8,
      futureRelevance: 0.7,
      emotionalSalience: 0.5
    });
    expect(database.prepare(`
      SELECT recall_key FROM memory_recall_receipts
      WHERE record_id = 'long_term_merge_a' ORDER BY recall_key
    `).all()).toEqual([
      { recall_key: "reply:a" },
      { recall_key: "reply:b" },
      { recall_key: "reply:shared" }
    ]);
  });

  it("archives a memory whose historical recall receipts still match the generated snapshot", () => {
    createGeneratedRun();
    seedRecallHistory();
    recall("long_term_archive", "reply:archive-a", "2026-05-01", "2026-05-01T02:00:00.000Z");
    recall("long_term_archive", "reply:archive-b", "2026-06-03", "2026-06-03T04:00:00.000Z");

    const input = commitInput();
    const archive = input.archives[0]!;
    const committed = store.commitConsolidation({
      ...input,
      archives: [{
        ...archive,
        recallSnapshot: {
          recallCount: 2,
          distinctRecallDays: 2,
          lastRecalledAt: "2026-06-03T04:00:00.000Z",
          trackingStartedAt: "2026-04-01T00:00:00.000Z"
        }
      }]
    });

    expect(committed).toMatchObject({ status: "committed" });
    expect(store.listArchives({ runId: "dream-run" })).toEqual([
      expect.objectContaining({ recordId: "long_term_archive" })
    ]);
    expect(store.readRecallStats("long_term_archive")).toBeUndefined();
  });

  it("leaves legacy SQLite working rows untouched when the Agent Markdown was committed externally", () => {
    createGeneratedRun();
    seedRecallHistory();
    const legacyRows = [{ id: "legacy-sqlite-working", fact: "只用于升级兼容。" }];
    replaceMemory("working", legacyRows);

    const committed = store.commitConsolidation(commitInput({
      expectedWorkingDigest: DIGEST,
      externalWorkingMemory: true
    }));

    expect(committed).toMatchObject({ status: "committed" });
    expect(readMemory("working")).toEqual(legacyRows);
    expect(readMemory("long_term")).toEqual(LONG_TERM_FINAL);
  });

  it("atomically migrates recall stats and receipts from a non-canonical legacy id", () => {
    const legacyId = "legacy id with spaces";
    const targetId = "legacy_long_term_target";
    const legacyLongTerm = [{ id: legacyId, fact: "旧格式长期记忆" }];
    const finalLongTerm = [{ id: targetId, legacyMemoryId: legacyId, fact: "旧格式长期记忆" }];
    replaceMemory("long_term", legacyLongTerm);
    createGeneratedRun();
    store.initializeRecallTracking([legacyId], new Date("2026-04-01T00:00:00.000Z"));
    recall(legacyId, "reply:legacy", "2026-07-18", "2026-07-18T02:00:00.000Z");

    const committed = store.commitConsolidation(commitInput({
      expectedLongTermDigest: digestDreamMemorySnapshot(legacyLongTerm),
      longTerm: finalLongTerm,
      archives: [],
      recallLineages: [{ targetId, sourceIds: [legacyId] }],
      reviews: [{
        recordId: targetId,
        sourceIds: [targetId],
        importance: 0.6,
        futureRelevance: 0.5,
        emotionalSalience: 0.4
      }],
      result: { schemaVersion: 1, merged: 0, archived: 0, promoted: 0 }
    }));

    expect(committed).toMatchObject({ status: "committed" });
    expect(store.readRecallStats(legacyId)).toBeUndefined();
    expect(store.readRecallStats(targetId)).toMatchObject({
      recallCount: 1,
      trackingStartedAt: "2026-04-01T00:00:00.000Z",
      lastReviewedAt: NOW.toISOString()
    });
    expect(database.prepare(`
      SELECT recall_key, record_id FROM memory_recall_receipts
    `).all()).toEqual([{ recall_key: "reply:legacy", record_id: targetId }]);
  });

  it("returns snapshot_conflict without changing memory or run state", () => {
    createGeneratedRun();
    seedRecallHistory();
    const input = commitInput();
    replaceMemory("working", [{ id: "working_drift", fact: "并发写入" }]);

    const result = store.commitConsolidation(input);

    expect(result).toMatchObject({ status: "snapshot_conflict", sources: ["working"] });
    expect(readMemory("working")).toEqual([{ id: "working_drift", fact: "并发写入" }]);
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.getRun("dream-run")).toMatchObject({ status: "generated", result: null });
    expect(store.listArchives()).toEqual([]);
  });

  it("returns snapshot_conflict when a real recall is recorded after generation", () => {
    createGeneratedRun();
    seedRecallHistory();
    recall("long_term_archive", "reply:after-generation", "2026-07-21", "2026-07-21T19:00:00.000Z");

    const result = store.commitConsolidation(commitInput());

    expect(result).toMatchObject({ status: "snapshot_conflict", sources: ["long_term"] });
    expect(readMemory("working")).toEqual(WORKING_BASELINE);
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.getRun("dream-run")).toMatchObject({ status: "generated", result: null });
    expect(store.listArchives()).toEqual([]);
    expect(store.readRecallStats("long_term_archive")).toMatchObject({ recallCount: 1 });
  });

  it("blocks archival while a model request has a pending exposure", () => {
    createGeneratedRun();
    seedRecallHistory();
    expect(store.reserveActualRecall({
      recordId: "long_term_archive",
      recallKey: "reply:in-flight-archive",
      at: new Date("2026-07-21T19:59:00.000Z")
    })).toMatchObject({ recordPresent: true });

    const result = store.commitConsolidation(commitInput());

    expect(result).toMatchObject({ status: "snapshot_conflict", sources: ["long_term"] });
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.listArchives()).toEqual([]);
    expect(store.readRecallStats("long_term_archive")).toMatchObject({ recallCount: 0 });
  });

  it("blocks a merge until its pending exposure becomes an actual receipt, then carries its lineage", () => {
    createGeneratedRun();
    seedRecallHistory();
    expect(store.reserveActualRecall({
      recordId: "long_term_merge_b",
      recallKey: "reply:in-flight-merge",
      at: new Date("2026-07-21T19:59:00.000Z")
    })).toMatchObject({ recordPresent: true });
    expect(store.commitConsolidation(commitInput()))
      .toMatchObject({ status: "snapshot_conflict", sources: ["long_term"] });

    expect(store.recordActualRecall({
      recordId: "long_term_merge_b",
      recallKey: "reply:in-flight-merge",
      localDate: "2026-07-22",
      at: new Date("2026-07-21T20:00:00.000Z")
    })).toMatchObject({ recorded: true, recordPresent: true });
    expect(store.commitConsolidation(commitInput())).toMatchObject({ status: "committed" });

    expect(store.readRecallStats("long_term_merge_b")).toBeUndefined();
    expect(store.readRecallStats("long_term_merge_a")).toMatchObject({ recallCount: 4 });
    expect(database.prepare(`
      SELECT record_id FROM memory_recall_receipts WHERE recall_key = 'reply:in-flight-merge'
    `).get()).toEqual({ record_id: "long_term_merge_a" });
  });

  it("does not let an expired pending exposure block later consolidation", () => {
    createGeneratedRun();
    seedRecallHistory();
    expect(store.reserveActualRecall({
      recordId: "long_term_archive",
      recallKey: "reply:expired",
      at: new Date("2026-07-20T18:00:00.000Z")
    })).toMatchObject({ recordPresent: true });
    expect(store.reserveActualRecall({
      recordId: "long_term_keep",
      recallKey: "reply:expired-retained",
      at: new Date("2026-07-20T18:00:00.000Z")
    })).toMatchObject({ recordPresent: true });

    expect(store.commitConsolidation(commitInput())).toMatchObject({ status: "committed" });
    expect(database.prepare(`
      SELECT pending_recall_json FROM memory_recall_stats WHERE record_id = 'long_term_keep'
    `).get()).toEqual({ pending_recall_json: "[]" });
  });

  it("returns snapshot_conflict when archive tracking changed after generation", () => {
    createGeneratedRun();
    seedRecallHistory();
    database.prepare(`
      UPDATE memory_recall_stats SET tracking_started_at = ? WHERE record_id = ?
    `).run("2026-04-02T00:00:00.000Z", "long_term_archive");

    const result = store.commitConsolidation(commitInput());

    expect(result).toMatchObject({ status: "snapshot_conflict", sources: ["long_term"] });
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.listArchives()).toEqual([]);
  });

  it("returns snapshot_conflict when receipt count no longer matches the generated recall snapshot", () => {
    createGeneratedRun();
    seedRecallHistory();
    recall("long_term_archive", "reply:archive", "2026-05-01", "2026-05-01T02:00:00.000Z");
    const input = commitInput();
    const archive = input.archives[0]!;
    database.prepare(`
      DELETE FROM memory_recall_receipts
      WHERE record_id = 'long_term_archive' AND recall_key = 'reply:archive'
    `).run();

    const result = store.commitConsolidation({
      ...input,
      archives: [{
        ...archive,
        recallSnapshot: {
          recallCount: 1,
          distinctRecallDays: 1,
          lastRecalledAt: "2026-05-01T02:00:00.000Z",
          trackingStartedAt: "2026-04-01T00:00:00.000Z"
        }
      }]
    });

    expect(result).toMatchObject({ status: "snapshot_conflict", sources: ["long_term"] });
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.listArchives()).toEqual([]);
  });

  it("returns lease_lost before touching snapshots", () => {
    createGeneratedRun(1_000);

    const result = store.commitConsolidation(commitInput({
      now: new Date(NOW.getTime() + 1_001)
    }));

    expect(result).toMatchObject({ status: "lease_lost", run: { status: "generated" } });
    expect(readMemory("working")).toEqual(WORKING_BASELINE);
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.listArchives()).toEqual([]);
  });

  it("returns existing for an exact retry and result_conflict for a different retry", () => {
    createGeneratedRun();
    seedRecallHistory();
    const input = commitInput();
    expect(store.commitConsolidation(input)).toMatchObject({ status: "committed" });

    expect(store.commitConsolidation({ ...input, now: new Date(NOW.getTime() + 50) }))
      .toMatchObject({ status: "existing", run: { status: "consolidated" } });
    expect(store.commitConsolidation({
      ...input,
      result: { schemaVersion: 1, merged: 99, archived: 1, promoted: 0 }
    })).toMatchObject({ status: "result_conflict", run: { status: "consolidated" } });
    expect(store.listArchives()).toHaveLength(1);
  });

  it("rolls back snapshot and recall changes when an archive collision fails mid-commit", () => {
    createGeneratedRun();
    seedRecallHistory();
    database.prepare(`
      INSERT INTO dream_memory_archive (
        record_id, run_id, data_json, reason, archived_at, purge_after
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "long_term_archive",
      "dream-run",
      JSON.stringify({ id: "long_term_archive", fact: "冲突副本" }),
      "已存在的不同归档",
      "2026-07-20T20:00:00.000Z",
      "2026-08-19T20:00:00.000Z"
    );

    expect(() => store.commitConsolidation(commitInput()))
      .toThrow("Dream memory archive collision for long_term_archive");

    expect(readMemory("working")).toEqual(WORKING_BASELINE);
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
    expect(store.getRun("dream-run")).toMatchObject({ status: "generated", result: null });
    expect(store.readRecallStats("long_term_merge_b")).toMatchObject({ recallCount: 2 });
    expect(store.readRecallStats("long_term_archive")).toMatchObject({ recallCount: 0 });
  });

  it("rejects invalid lineage before opening the commit transaction", () => {
    createGeneratedRun();
    expect(() => store.commitConsolidation(commitInput({
      recallLineages: [{
        targetId: "long_term_merge_a",
        sourceIds: ["long_term_merge_a", "long_term_keep"]
      }]
    }))).toThrow("Non-target recall lineage source remains in long-term memory: long_term_keep");
    expect(readMemory("working")).toEqual(WORKING_BASELINE);
    expect(store.getRun("dream-run")).toMatchObject({ status: "generated" });
  });

  it.each([
    {
      label: "negative recall count",
      snapshot: {
        recallCount: -1,
        distinctRecallDays: 0,
        lastRecalledAt: null,
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.recallCount must be a non-negative safe integer"
    },
    {
      label: "unsafe recall count",
      snapshot: {
        recallCount: Number.MAX_SAFE_INTEGER + 1,
        distinctRecallDays: 0,
        lastRecalledAt: "2026-05-01T02:00:00.000Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.recallCount must be a non-negative safe integer"
    },
    {
      label: "fractional distinct recall days",
      snapshot: {
        recallCount: 1,
        distinctRecallDays: 0.5,
        lastRecalledAt: "2026-05-01T02:00:00.000Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.distinctRecallDays must be a non-negative safe integer"
    },
    {
      label: "more distinct days than recalls",
      snapshot: {
        recallCount: 1,
        distinctRecallDays: 2,
        lastRecalledAt: "2026-05-01T02:00:00.000Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.distinctRecallDays must not exceed recallCount"
    },
    {
      label: "zero recalls with a last recall",
      snapshot: {
        recallCount: 0,
        distinctRecallDays: 0,
        lastRecalledAt: "2026-05-01T02:00:00.000Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.lastRecalledAt must be null exactly when recallCount is 0"
    },
    {
      label: "positive recalls without a last recall",
      snapshot: {
        recallCount: 1,
        distinctRecallDays: 1,
        lastRecalledAt: null,
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.lastRecalledAt must be null exactly when recallCount is 0"
    },
    {
      label: "non-canonical last recall time",
      snapshot: {
        recallCount: 1,
        distinctRecallDays: 1,
        lastRecalledAt: "2026-05-01T02:00:00Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.lastRecalledAt must be a canonical ISO timestamp"
    },
    {
      label: "non-canonical tracking start time",
      snapshot: {
        recallCount: 0,
        distinctRecallDays: 0,
        lastRecalledAt: null,
        trackingStartedAt: "2026-04-01T00:00:00Z"
      },
      error: "recallSnapshot.trackingStartedAt must be a canonical ISO timestamp"
    },
    {
      label: "last recall before tracking",
      snapshot: {
        recallCount: 1,
        distinctRecallDays: 1,
        lastRecalledAt: "2026-03-31T23:59:59.999Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      },
      error: "recallSnapshot.lastRecalledAt must not be earlier than trackingStartedAt"
    }
  ])("rejects an invalid archive recall snapshot: $label", ({ snapshot, error }) => {
    createGeneratedRun();
    seedRecallHistory();
    const input = commitInput();
    const archive = input.archives[0]!;

    expect(() => store.commitConsolidation({
      ...input,
      archives: [{ ...archive, recallSnapshot: snapshot }]
    })).toThrow(error);
    expect(readMemory("long_term")).toEqual(LONG_TERM_BASELINE);
  });

  function createGeneratedRun(leaseMs = 60_000) {
    const run = store.claimDailyRun({
      localDate: "2026-07-22",
      scheduledFor: "2026-07-21T20:00:00.000Z",
      timeZone: "Asia/Shanghai",
      window: {
        start: "2026-07-20T20:00:00.000Z",
        end: "2026-07-21T20:00:00.000Z"
      },
      workerId: "worker:a",
      leaseMs,
      seed: "dream-seed-2026-07-22",
      inputDigest: DIGEST,
      input: { schemaVersion: 1 },
      now: NOW
    }).run;
    store.markGenerated({
      runId: run.id,
      workerId: "worker:a",
      output: { schemaVersion: 1, dream: { text: "月光落在旧车站。" } },
      dreamText: "月光落在旧车站。",
      now: NOW
    });
  }

  function commitInput(
    overrides: Partial<CommitDreamConsolidationInput> = {}
  ): CommitDreamConsolidationInput {
    return {
      runId: "dream-run",
      workerId: "worker:a",
      expectedWorkingDigest: digestDreamMemorySnapshot(WORKING_BASELINE),
      expectedLongTermDigest: digestDreamMemorySnapshot(LONG_TERM_BASELINE),
      workingMemoryId: "working_dream_2026_07_22",
      working: WORKING_FINAL,
      longTerm: LONG_TERM_FINAL,
      archives: [{
        recordId: "long_term_archive",
        data: LONG_TERM_BASELINE[3]!,
        reason: "低重要度且追踪期内未召回",
        recallSnapshot: {
          recallCount: 0,
          distinctRecallDays: 0,
          lastRecalledAt: null,
          trackingStartedAt: "2026-04-01T00:00:00.000Z"
        }
      }],
      recallLineages: [{
        targetId: "long_term_merge_a",
        sourceIds: ["long_term_merge_a", "long_term_merge_b"]
      }],
      reviews: [
        {
          recordId: "long_term_merge_a",
          sourceIds: ["long_term_merge_a", "long_term_merge_b"],
          importance: 0.72,
          futureRelevance: 0.44,
          emotionalSalience: 0.61
        },
        {
          recordId: "long_term_keep",
          sourceIds: ["long_term_keep"],
          importance: 0.8,
          futureRelevance: 0.7,
          emotionalSalience: 0.5
        }
      ],
      result: { schemaVersion: 1, merged: 1, archived: 1, promoted: 0 },
      now: NOW,
      ...overrides
    };
  }

  function seedRecallHistory() {
    store.initializeRecallTracking([
      "long_term_merge_a",
      "long_term_merge_b",
      "long_term_archive"
    ], new Date("2026-04-01T00:00:00.000Z"));
    recall("long_term_merge_a", "reply:shared", "2026-07-17", "2026-07-17T01:00:00.000Z");
    recall("long_term_merge_a", "reply:a", "2026-07-18", "2026-07-18T02:00:00.000Z");
    recall("long_term_merge_b", "reply:shared", "2026-07-17", "2026-07-17T01:00:00.000Z");
    recall("long_term_merge_b", "reply:b", "2026-07-19", "2026-07-19T03:00:00.000Z");
  }

  function recall(recordId: string, recallKey: string, localDate: string, at: string) {
    store.recordActualRecall({ recordId, recallKey, localDate, at: new Date(at) });
  }

  function replaceMemory(source: "working" | "long_term", records: readonly JsonObject[]) {
    database.prepare("DELETE FROM memory_records WHERE source = ?").run(source);
    const insert = database.prepare(`
      INSERT INTO memory_records (source, position, record_id, data_json) VALUES (?, ?, ?, ?)
    `);
    records.forEach((record, position) => insert.run(source, position, record.id, JSON.stringify(record)));
  }

  function readMemory(source: "working" | "long_term") {
    return database.prepare(`
      SELECT data_json FROM memory_records WHERE source = ? ORDER BY position, row_id
    `).all(source).map((row) => JSON.parse(String((row as { data_json: string }).data_json)));
  }
});
