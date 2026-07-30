// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  migrateDreamTables,
  SqliteDreamStore
} from "../../adapters/sqlite/dreamStore.js";

const DIGEST = "a".repeat(64);

describe("Dream SQLite store", () => {
  let database: DatabaseSync;
  let now: number;
  let nextId: number;
  let store: SqliteDreamStore;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE memory_records (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        position INTEGER NOT NULL,
        record_id TEXT,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      );
      CREATE UNIQUE INDEX memory_records_source_record_id
        ON memory_records(source, record_id) WHERE record_id IS NOT NULL AND record_id <> '';
    `);
    now = Date.parse("2026-07-20T20:00:00.000Z");
    nextId = 0;
    store = createStore();
  });

  afterEach(() => {
    if (database.isOpen) database.close();
  });

  it("creates the four idempotent STRICT tables and their operational indexes", () => {
    migrateDreamTables(database);
    const tables = database.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE name IN (
        'memory_recall_stats', 'memory_recall_receipts', 'dream_runs', 'dream_memory_archive'
      ) ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "dream_memory_archive",
      "dream_runs",
      "memory_recall_receipts",
      "memory_recall_stats"
    ]);
    expect(tables.every((table) => table.sql.toLowerCase().includes("strict"))).toBe(true);
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'dream_runs_status_retry'").get())
      .toEqual({ name: "dream_runs_status_retry" });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'dream_memory_archive_purge'").get())
      .toEqual({ name: "dream_memory_archive_purge" });
    expect(database.prepare("PRAGMA table_info(memory_recall_stats)").all())
      .toContainEqual(expect.objectContaining({ name: "pending_recall_json", dflt_value: "'[]'" }));
  });

  it("forward adds pending exposure storage to a v15 recall table and reopens idempotently", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE memory_records (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          position INTEGER NOT NULL,
          record_id TEXT,
          data_json TEXT NOT NULL CHECK (json_valid(data_json))
        );
        CREATE TABLE memory_recall_stats (
          record_id TEXT PRIMARY KEY,
          recall_count INTEGER NOT NULL DEFAULT 0,
          distinct_recall_days INTEGER NOT NULL DEFAULT 0,
          last_recalled_at TEXT,
          last_recall_local_date TEXT,
          tracking_started_at TEXT NOT NULL,
          last_reviewed_at TEXT,
          importance REAL,
          future_relevance REAL,
          emotional_salience REAL
        ) STRICT;
        INSERT INTO memory_recall_stats (
          record_id, tracking_started_at
        ) VALUES ('legacy_pending', '2026-07-01T00:00:00.000Z');
      `);

      migrateDreamTables(legacy);
      migrateDreamTables(legacy);

      expect(legacy.prepare(`
        SELECT pending_recall_json FROM memory_recall_stats WHERE record_id = 'legacy_pending'
      `).get()).toEqual({ pending_recall_json: "[]" });
      expect(legacy.prepare("PRAGMA table_info(memory_recall_stats)").all()
        .filter((column) => (column as { name: string }).name === "pending_recall_json")).toHaveLength(1);
    } finally {
      legacy.close();
    }
  });

  it("forward migrates a schema 14 application database to 17 and reopens idempotently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-dream-v14-"));
    const databasePath = path.join(root, "sunabot.sqlite");
    try {
      const current = new ApplicationDataStore(databasePath);
      try {
        const committed = current.director.commit({
          draft: directorDraft(),
          seedHash: "d".repeat(64),
          source: "daily_plan",
          now: new Date("2026-07-20T07:00:00.000Z")
        });
        expect(committed.status).toBe("committed");
        current.director.linkTask({
          scheduleDate: "2026-07-20",
          revision: 1,
          itemId: "morning",
          taskId: "director-plana-20260720-morning-r1-c1",
          runAt: "2026-07-20T08:00:00.000Z",
          createdAt: "2026-07-20T07:00:00.000Z"
        });
      } finally {
        current.close();
      }

      const legacy = new DatabaseSync(databasePath);
      try {
        legacy.exec(`
          CREATE TABLE dream_migration_sentinel (
            id TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
          INSERT INTO dream_migration_sentinel (id, value) VALUES ('preserve', 'keep');
          DROP TABLE dream_memory_archive;
          DROP TABLE dream_runs;
          DROP TABLE memory_recall_receipts;
          DROP TABLE memory_recall_stats;
        `);
        legacy.prepare(`
          UPDATE app_metadata SET value = '14' WHERE key = 'storage-schema-version'
        `).run();
        expect(legacy.prepare(`
          SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE type = 'table' AND name IN (
            'memory_recall_stats', 'memory_recall_receipts', 'dream_runs', 'dream_memory_archive'
          )
        `).get()).toEqual({ count: 0 });
        expect(legacy.prepare(`
          SELECT
            (SELECT COUNT(*) FROM director_daily_schedules) AS schedules,
            (SELECT COUNT(*) FROM director_daily_schedule_revisions) AS revisions,
            (SELECT COUNT(*) FROM director_schedule_task_links) AS links
        `).get()).toEqual({ schedules: 1, revisions: 1, links: 1 });
      } finally {
        legacy.close();
      }

      const migrated = new ApplicationDataStore(databasePath);
      try {
        expect(migrated.director.read("2026-07-20")).toMatchObject({
          revision: 1,
          summary: "保留导演迁移夹具"
        });
        expect(migrated.director.listTaskLinks("2026-07-20")).toEqual([
          expect.objectContaining({ taskId: "director-plana-20260720-morning-r1-c1" })
        ]);
      } finally {
        migrated.close();
      }
      const afterMigration = inspectApplicationSchema(databasePath);

      const reopened = new ApplicationDataStore(databasePath);
      try {
        expect(reopened.director.read("2026-07-20")).toMatchObject({ revision: 1 });
      } finally {
        reopened.close();
      }
      const afterReopen = inspectApplicationSchema(databasePath);

      expect(afterMigration).toEqual({
        version: "17",
        dreamTables: [
          { name: "dream_memory_archive", strict: true },
          { name: "dream_runs", strict: true },
          { name: "memory_recall_receipts", strict: true },
          { name: "memory_recall_stats", strict: true }
        ],
        directorTables: [
          "director_daily_schedule_revisions",
          "director_daily_schedules",
          "director_schedule_task_links"
        ],
        directorRows: { schedules: 1, revisions: 1, links: 1 },
        sentinel: { value: "keep" }
      });
      expect(afterReopen).toEqual(afterMigration);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reopens with 129-character and non-canonical legacy long-term ids", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-dream-legacy-id-"));
    const databasePath = path.join(root, "sunabot.sqlite");
    try {
      new ApplicationDataStore(databasePath).close();
      const legacy = new DatabaseSync(databasePath);
      try {
        const insert = legacy.prepare(`
          INSERT INTO memory_records (source, position, record_id, data_json)
          VALUES ('long_term', ?, ?, ?)
        `);
        const oversized = "x".repeat(129);
        insert.run(0, oversized, JSON.stringify({ id: oversized, text: "超长旧记忆" }));
        insert.run(1, "legacy id with spaces", JSON.stringify({ id: "legacy id with spaces", text: "非法旧记忆" }));
      } finally {
        legacy.close();
      }

      const reopened = new ApplicationDataStore(databasePath);
      try {
        expect(reopened.readMemory("long_term")).toHaveLength(2);
        expect(reopened.listRecallStats()).toEqual([
          expect.objectContaining({ recordId: "legacy id with spaces", recallCount: 0 })
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes a late recall from a second connection after memory removal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-dream-recall-race-"));
    const databasePath = path.join(root, "sunabot.sqlite");
    try {
      new ApplicationDataStore(databasePath).close();
      const primary = new DatabaseSync(databasePath, { timeout: 5_000 });
      const secondary = new DatabaseSync(databasePath, { timeout: 5_000 });
      try {
        const primaryStore = new SqliteDreamStore(primary);
        const secondaryStore = new SqliteDreamStore(secondary);
        const archiveRun = primaryStore.claimDailyRun(claimInput("archive-worker")).run;
        primary.prepare(`
          INSERT INTO memory_records (source, position, record_id, data_json)
          VALUES ('long_term', 0, 'long_term_race', ?)
        `).run(JSON.stringify({ id: "long_term_race", fact: "竞态记忆" }));
        primaryStore.initializeRecallTracking(["long_term_race"], new Date("2026-07-01T00:00:00.000Z"));

        primary.exec("BEGIN IMMEDIATE");
        primary.prepare(`
          INSERT INTO dream_memory_archive (
            record_id, run_id, data_json, reason, archived_at, purge_after
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          "long_term_race",
          archiveRun.id,
          JSON.stringify({ id: "long_term_race", fact: "竞态记忆" }),
          "低价值且零召回",
          "2026-07-20T02:00:00.000Z",
          "2026-08-19T02:00:00.000Z"
        );
        primary.prepare("DELETE FROM memory_records WHERE source = 'long_term' AND record_id = ?")
          .run("long_term_race");
        primary.prepare("DELETE FROM memory_recall_stats WHERE record_id = ?").run("long_term_race");
        primary.exec("COMMIT");

        expect(secondaryStore.recordActualRecall({
          recordId: "long_term_race",
          recallKey: "reply:after-archive",
          localDate: "2026-07-20",
          at: new Date("2026-07-20T02:00:00.000Z")
        })).toMatchObject({ recorded: false, recordPresent: false });
        expect(primaryStore.listArchives({ runId: archiveRun.id })).toEqual([
          expect.objectContaining({ recordId: "long_term_race" })
        ]);
        expect(primary.prepare("SELECT COUNT(*) AS count FROM memory_recall_stats").get()).toEqual({ count: 0 });
        expect(primary.prepare("SELECT COUNT(*) AS count FROM memory_recall_receipts").get()).toEqual({ count: 0 });
      } finally {
        if (secondary.isOpen) secondary.close();
        if (primary.isOpen) primary.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("counts actual recall receipts once per key and counts distinct local days", () => {
    putLongTerm("long_term_alpha");
    const tracked = store.initializeRecallTracking(["long_term_alpha"], new Date("2026-07-01T00:00:00.000Z"));
    expect(tracked).toEqual([expect.objectContaining({
      recordId: "long_term_alpha",
      recallCount: 0,
      distinctRecallDays: 0,
      trackingStartedAt: "2026-07-01T00:00:00.000Z"
    })]);

    const first = store.recordActualRecall({
      recordId: "long_term_alpha",
      recallKey: "reply:one",
      localDate: "2026-07-20",
      at: new Date("2026-07-20T01:00:00.000Z")
    });
    expect(first).toMatchObject({ recorded: true, stats: { recallCount: 1, distinctRecallDays: 1 } });
    expect(store.recordActualRecall({
      recordId: "long_term_alpha",
      recallKey: "reply:one",
      localDate: "2026-07-20",
      at: new Date("2026-07-20T02:00:00.000Z")
    })).toMatchObject({ recorded: false, stats: { recallCount: 1, distinctRecallDays: 1 } });
    expect(store.recordActualRecall({
      recordId: "long_term_alpha",
      recallKey: "reply:two",
      localDate: "2026-07-20",
      at: new Date("2026-07-20T03:00:00.000Z")
    })).toMatchObject({ recorded: true, stats: { recallCount: 2, distinctRecallDays: 1 } });
    const nextDay = store.recordActualRecall({
      recordId: "long_term_alpha",
      recallKey: "reply:three",
      localDate: "2026-07-21",
      at: new Date("2026-07-21T01:00:00.000Z")
    });
    expect(nextDay).toMatchObject({
      recorded: true,
      stats: {
        recallCount: 3,
        distinctRecallDays: 2,
        lastRecalledAt: "2026-07-21T01:00:00.000Z",
        lastRecallLocalDate: "2026-07-21"
      }
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_recall_receipts").get())
      .toEqual({ count: 3 });
  });

  it("persists one bounded pending exposure until the actual recall receipt commits", () => {
    putLongTerm("long_term_pending");

    expect(store.reserveActualRecall({
      recordId: "long_term_pending",
      recallKey: "reply:pending",
      at: new Date("2026-07-20T01:00:00.000Z")
    })).toEqual({ reserved: true, recordPresent: true });
    expect(store.reserveActualRecall({
      recordId: "long_term_pending",
      recallKey: "reply:pending",
      at: new Date("2026-07-20T01:01:00.000Z")
    })).toEqual({ reserved: false, recordPresent: true });
    expect(store.readRecallStats("long_term_pending")).toMatchObject({ recallCount: 0 });
    expect(database.prepare(`
      SELECT json_array_length(pending_recall_json) AS count,
        json_extract(pending_recall_json, '$[0].expiresAt') AS expires_at
      FROM memory_recall_stats WHERE record_id = 'long_term_pending'
    `).get()).toEqual({ count: 1, expires_at: "2026-07-21T02:01:00.000Z" });

    expect(store.recordActualRecall({
      recordId: "long_term_pending",
      recallKey: "reply:pending",
      localDate: "2026-07-20",
      at: new Date("2026-07-20T01:02:00.000Z")
    })).toMatchObject({ recorded: true, recordPresent: true, stats: { recallCount: 1 } });
    expect(database.prepare(`
      SELECT pending_recall_json FROM memory_recall_stats WHERE record_id = 'long_term_pending'
    `).get()).toEqual({ pending_recall_json: "[]" });
  });

  it("rejects a pending exposure after the source long-term memory disappeared", () => {
    putLongTerm("long_term_missing_before_exposure");
    database.prepare("DELETE FROM memory_records WHERE source = 'long_term' AND record_id = ?")
      .run("long_term_missing_before_exposure");

    expect(store.reserveActualRecall({
      recordId: "long_term_missing_before_exposure",
      recallKey: "reply:stale-context",
      at: new Date("2026-07-20T01:00:00.000Z")
    })).toEqual({ reserved: false, recordPresent: false });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_recall_stats
      WHERE record_id = 'long_term_missing_before_exposure'
    `).get()).toEqual({ count: 0 });
  });

  it("records bounded review scores without resetting recall history", () => {
    putLongTerm("long_term_reviewed");
    store.recordActualRecall({
      recordId: "long_term_reviewed",
      recallKey: "reply:review",
      localDate: "2026-07-20",
      at: new Date("2026-07-20T01:00:00.000Z")
    });
    const reviewed = store.recordMemoryReview({
      recordId: "long_term_reviewed",
      importance: 0.7,
      futureRelevance: 0.4,
      emotionalSalience: 0.8,
      at: new Date("2026-07-20T20:00:00.000Z")
    });
    expect(reviewed).toMatchObject({
      recallCount: 1,
      lastReviewedAt: "2026-07-20T20:00:00.000Z",
      importance: 0.7,
      futureRelevance: 0.4,
      emotionalSalience: 0.8
    });
    expect(() => store.recordMemoryReview({
      recordId: "long_term_reviewed",
      importance: 1.1,
      futureRelevance: 0.4,
      emotionalSalience: 0.8
    })).toThrow("importance must be between 0 and 1");
  });

  it("claims one run per local day idempotently and recovers an expired lease", () => {
    const created = store.claimDailyRun(claimInput("worker:a"));
    expect(created).toMatchObject({
      status: "created",
      run: { id: "dream-1", localDate: "2026-07-21", status: "running", attemptCount: 1 }
    });
    expect(store.claimDailyRun(claimInput("worker:b"))).toMatchObject({
      status: "busy",
      run: { id: "dream-1", workerId: "worker:a", attemptCount: 1 }
    });

    now += 1_001;
    const recovered = store.claimDailyRun(claimInput("worker:b"));
    expect(recovered).toMatchObject({
      status: "recovered",
      run: { id: "dream-1", workerId: "worker:b", status: "running", attemptCount: 2 }
    });
    expect(store.listRuns()).toHaveLength(1);
    expect(() => store.claimDailyRun({ ...claimInput("worker:c"), seed: "changed" }))
      .toThrow("Dream run occurrence collision");
  });

  it("persists generated output through lease recovery, consolidation, persona audit, and completion", () => {
    const created = store.claimDailyRun(claimInput("worker:a")).run;
    now += 10;
    const generated = store.markGenerated({
      runId: created.id,
      workerId: "worker:a",
      output: { schemaVersion: 1, choices: ["retain"] },
      dreamText: "月光落在旧车站，今天的谈话变成一列缓慢驶来的车。",
      now: new Date(now)
    });
    expect(generated).toMatchObject({
      status: "generated",
      output: { schemaVersion: 1, choices: ["retain"] },
      personaStatus: "pending"
    });

    now += 1_001;
    const recovered = store.claimDailyRun(claimInput("worker:b"));
    expect(recovered).toMatchObject({
      status: "recovered",
      run: { status: "generated", workerId: "worker:b", attemptCount: 2 }
    });
    expect(recovered.run.output).toEqual({ schemaVersion: 1, choices: ["retain"] });

    now += 10;
    expect(store.markConsolidated({
      runId: created.id,
      workerId: "worker:b",
      workingMemoryId: "working_dream_2026_07_21",
      result: { archived: ["long_term_old"], merged: 2 },
      now: new Date(now)
    })).toMatchObject({ status: "consolidated", result: { archived: ["long_term_old"], merged: 2 } });
    now += 10;
    expect(store.markPersona({
      runId: created.id,
      workerId: "worker:b",
      status: "applied",
      persona: { file: "PREFERENCE.md", statement: "更偏爱安静的夜间交流。" },
      now: new Date(now)
    })).toMatchObject({ status: "consolidated", personaStatus: "applied" });
    now += 10;
    const completed = store.complete({ runId: created.id, workerId: "worker:b", now: new Date(now) });
    expect(completed).toMatchObject({
      status: "completed",
      workerId: null,
      leaseUntil: null,
      workingMemoryId: "working_dream_2026_07_21"
    });
    expect(store.getRunByLocalDate("2026-07-21")).toEqual(completed);
    expect(store.claimDailyRun(claimInput("worker:c"))).toMatchObject({
      status: "existing",
      run: { status: "completed", attemptCount: 2 }
    });
  });

  it("records retryable failure and resumes from the last durable phase", () => {
    const run = store.claimDailyRun(claimInput("worker:a")).run;
    now += 50;
    const failed = store.markFailed({
      runId: run.id,
      workerId: "worker:a",
      errorCode: "MODEL_UNAVAILABLE",
      errorText: "provider unavailable",
      retryAt: new Date(now + 500),
      now: new Date(now)
    });
    expect(failed).toMatchObject({ status: "failed", nextRetryAt: new Date(now + 500).toISOString() });
    now += 499;
    expect(store.claimDailyRun(claimInput("worker:b"))).toMatchObject({ status: "existing" });
    now += 1;
    expect(store.claimDailyRun(claimInput("worker:b"))).toMatchObject({
      status: "recovered",
      run: {
        status: "running",
        attemptCount: 2,
        workerId: "worker:b",
        errorCode: null,
        errorText: null,
        failedAt: null
      }
    });
  });

  it("clears invalid generated artifacts before recovering the run at generation", () => {
    const run = store.claimDailyRun(claimInput("worker:a")).run;
    now += 10;
    expect(store.markGenerated({
      runId: run.id,
      workerId: "worker:a",
      output: {
        schemaVersion: 1,
        dream: { text: "旧版宽松输出", factuality: "imagined" }
      },
      dreamText: "旧版宽松输出",
      now: new Date(now)
    })).toMatchObject({
      status: "generated",
      output: expect.any(Object),
      dreamText: "旧版宽松输出",
      generatedAt: new Date(now).toISOString()
    });

    now += 10;
    const failed = store.markFailed({
      runId: run.id,
      workerId: "worker:a",
      errorCode: "DREAM_OUTPUT_CONTRACT_INVALID",
      errorText: "Dream 输出格式校验未通过。",
      resetGeneratedOutput: true,
      retryAt: new Date(now + 500),
      now: new Date(now)
    });
    expect(failed).toMatchObject({
      status: "failed",
      output: null,
      dreamText: null,
      generatedAt: null
    });

    now += 500;
    expect(store.claimDailyRun(claimInput("worker:b"))).toMatchObject({
      status: "recovered",
      run: {
        status: "running",
        attemptCount: 2,
        output: null,
        dreamText: null,
        generatedAt: null
      }
    });
  });

  it("terminally fails a retryable failure when the third attempt becomes due", () => {
    const run = store.claimDailyRun(claimInput("worker:a")).run;
    for (const [index, worker] of ["worker:a", "worker:b", "worker:c"].entries()) {
      now += 10;
      store.markFailed({
        runId: run.id,
        workerId: worker,
        errorCode: "MODEL_UNAVAILABLE",
        errorText: `failure-${index + 1}`,
        retryAt: new Date(now + 500),
        now: new Date(now)
      });
      now += 500;
      const claim = store.claimDailyRun(claimInput(`worker:${String.fromCharCode(98 + index)}`));
      if (index < 2) expect(claim).toMatchObject({ status: "recovered", run: { attemptCount: index + 2 } });
      else expect(claim).toMatchObject({
        status: "existing",
        run: { status: "failed", attemptCount: 3, nextRetryAt: null, errorCode: "DREAM_ATTEMPT_LIMIT" }
      });
    }
  });

  it("terminally fails an expired running lease after three interrupted generation attempts", () => {
    expect(store.claimDailyRun(claimInput("worker:a"))).toMatchObject({
      status: "created",
      run: { status: "running", attemptCount: 1 }
    });
    now += 1_001;
    expect(store.claimDailyRun(claimInput("worker:b"))).toMatchObject({
      status: "recovered",
      run: { status: "running", attemptCount: 2 }
    });
    now += 1_001;
    expect(store.claimDailyRun(claimInput("worker:c"))).toMatchObject({
      status: "recovered",
      run: { status: "running", attemptCount: 3 }
    });
    now += 1_001;
    expect(store.claimDailyRun(claimInput("worker:d"))).toMatchObject({
      status: "existing",
      run: {
        status: "failed",
        attemptCount: 3,
        workerId: null,
        nextRetryAt: null,
        errorCode: "DREAM_ATTEMPT_LIMIT"
      }
    });
    expect(store.claimDailyRun(claimInput("worker:e"))).toMatchObject({
      status: "existing",
      run: { status: "failed", attemptCount: 3 }
    });

    expect(store.claimDailyRun({ ...claimInput("worker:manual"), force: true })).toMatchObject({
      status: "recovered",
      run: { status: "running", attemptCount: 4, workerId: "worker:manual", nextRetryAt: null }
    });
  });

  it.each(["generated", "consolidated"] as const)(
    "terminally fails an expired %s lease after three total claims",
    (stage) => {
      const run = store.claimDailyRun(claimInput("worker:a")).run;
      store.markGenerated({
        runId: run.id,
        workerId: "worker:a",
        output: { schemaVersion: 1, dream: { text: "月光落在旧车站。" } },
        dreamText: "月光落在旧车站。",
        now: new Date(now)
      });
      if (stage === "consolidated") {
        store.markConsolidated({
          runId: run.id,
          workerId: "worker:a",
          workingMemoryId: "working_dream_2026_07_21",
          result: { schemaVersion: 1, retained: 1 },
          now: new Date(now)
        });
      }
      now += 1_001;
      expect(store.claimDailyRun(claimInput("worker:b"))).toMatchObject({
        status: "recovered",
        run: { status: stage, attemptCount: 2, dreamText: "月光落在旧车站。" }
      });
      now += 1_001;
      expect(store.claimDailyRun(claimInput("worker:c"))).toMatchObject({
        status: "recovered",
        run: { status: stage, attemptCount: 3 }
      });
      now += 1_001;
      expect(store.claimDailyRun(claimInput("worker:d"))).toMatchObject({
        status: "existing",
        run: { status: "failed", attemptCount: 3, errorCode: "DREAM_ATTEMPT_LIMIT" }
      });
    }
  );

  it("does not recreate recall rows after the long-term memory was removed", () => {
    putLongTerm("long_term_late");
    store.initializeRecallTracking(["long_term_late"], new Date("2026-07-01T00:00:00.000Z"));
    database.prepare("DELETE FROM memory_records WHERE source = 'long_term' AND record_id = ?")
      .run("long_term_late");

    expect(store.recordActualRecall({
      recordId: "long_term_late",
      recallKey: "reply:late",
      localDate: "2026-07-21",
      at: new Date("2026-07-21T01:00:00.000Z")
    })).toMatchObject({ recorded: false, recordPresent: false, stats: { recallCount: 0 } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_recall_stats").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_recall_receipts").get()).toEqual({ count: 0 });
  });

  it("archives complete memory JSON and only purges it after 30 days", () => {
    const run = store.claimDailyRun(claimInput("worker:a")).run;
    const archivedAt = new Date("2026-07-21T20:00:00.000Z");
    const archived = store.archiveMemory({
      recordId: "long_term_old",
      runId: run.id,
      data: {
        id: "long_term_old",
        fact: "曾经在雨天去过旧车站。",
        addressNames: ["老师"]
      },
      reason: "低重要度且追踪期内未召回",
      archivedAt
    });
    expect(archived).toMatchObject({
      status: "created",
      archive: {
        recordId: "long_term_old",
        purgeAfter: "2026-08-20T20:00:00.000Z",
        data: { addressNames: ["老师"] }
      }
    });
    expect(store.archiveMemory({
      recordId: "long_term_old",
      runId: run.id,
      data: {
        id: "long_term_old",
        fact: "曾经在雨天去过旧车站。",
        addressNames: ["老师"]
      },
      reason: "低重要度且追踪期内未召回",
      archivedAt
    })).toMatchObject({ status: "existing" });
    expect(store.purgeArchivedMemories({ now: new Date("2026-08-20T19:59:59.999Z") })).toEqual([]);
    expect(store.purgeArchivedMemories({ now: new Date("2026-08-20T20:00:00.000Z") }))
      .toEqual([expect.objectContaining({ recordId: "long_term_old" })]);
    expect(store.listArchives()).toEqual([]);
  });

  it("rejects non-object stored JSON instead of widening the persisted contract", () => {
    const run = store.claimDailyRun(claimInput("worker:a")).run;
    expect(() => database.prepare("UPDATE dream_runs SET input_json = '[]' WHERE id = ?").run(run.id))
      .toThrow("CHECK constraint failed");
    expect(() => store.claimDailyRun({
      ...claimInput("worker:b"),
      input: { invalid: Number.NaN }
    })).toThrow("non-finite number");
  });

  function createStore() {
    return new SqliteDreamStore(database, {
      clock: () => new Date(now),
      idFactory: () => `dream-${++nextId}`
    });
  }

  function putLongTerm(id: string) {
    database.prepare(`
      INSERT INTO memory_records (source, position, record_id, data_json)
      VALUES ('long_term', 0, ?, ?)
    `).run(id, JSON.stringify({ id, fact: `记忆 ${id}` }));
  }

  function claimInput(workerId: string) {
    return {
      localDate: "2026-07-21",
      scheduledFor: "2026-07-20T20:00:00.000Z",
      timeZone: "Asia/Shanghai",
      window: {
        start: "2026-07-19T20:00:00.000Z",
        end: "2026-07-20T20:00:00.000Z"
      },
      workerId,
      leaseMs: 1_000,
      seed: "dream-seed-2026-07-21",
      inputDigest: DIGEST,
      input: { schemaVersion: 1, memoryIds: ["long_term_old"] }
    };
  }
});

function inspectApplicationSchema(databasePath: string) {
  const inspected = new DatabaseSync(databasePath);
  try {
    const dreamTables = inspected.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'memory_recall_stats', 'memory_recall_receipts', 'dream_runs', 'dream_memory_archive'
      ) ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    const directorTables = inspected.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'director_daily_schedules',
        'director_daily_schedule_revisions',
        'director_schedule_task_links'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    return {
      version: String((inspected.prepare(`
        SELECT value FROM app_metadata WHERE key = 'storage-schema-version'
      `).get() as { value: string }).value),
      dreamTables: dreamTables.map((table) => ({
        name: table.name,
        strict: table.sql.toLowerCase().includes("strict")
      })),
      directorTables: directorTables.map((table) => table.name),
      directorRows: inspected.prepare(`
        SELECT
          (SELECT COUNT(*) FROM director_daily_schedules) AS schedules,
          (SELECT COUNT(*) FROM director_daily_schedule_revisions) AS revisions,
          (SELECT COUNT(*) FROM director_schedule_task_links) AS links
      `).get(),
      sentinel: inspected.prepare(`
        SELECT value FROM dream_migration_sentinel WHERE id = 'preserve'
      `).get()
    };
  } finally {
    inspected.close();
  }
}

function directorDraft() {
  return {
    schemaVersion: 1 as const,
    date: "2026-07-20",
    timeZone: "Asia/Shanghai",
    theme: "日常",
    summary: "保留导演迁移夹具",
    items: [
      directorItem("morning", "08:00", "09:00", true),
      directorItem("afternoon", "13:00", "14:00"),
      directorItem("night", "20:00", "21:00")
    ]
  };
}

function directorItem(id: string, startAt: string, endAt: string, share = false) {
  return {
    id,
    startAt: `2026-07-20T${startAt}:00+08:00`,
    endAt: `2026-07-20T${endAt}:00+08:00`,
    activity: "整理资料",
    location: "什亭之箱",
    participants: [],
    intent: "保持日常连续性",
    variant: "稳定日",
    share: share
      ? {
          enabled: true,
          at: "2026-07-20T08:30:00+08:00",
          textIntent: "分享整理进展",
          selfiePrompt: "角色本人在什亭之箱工作台前整理资料，晨光自然"
        }
      : { enabled: false, at: null, textIntent: null, selfiePrompt: null }
  };
}
