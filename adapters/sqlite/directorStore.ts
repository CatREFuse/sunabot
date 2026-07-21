import type { DatabaseSync } from "node:sqlite";
import {
  isDirectorSchedule,
  normalizeDirectorScheduleDraft,
  type DirectorScheduleCommitInput,
  type DirectorScheduleCommitResult,
  type DirectorScheduleTaskLink,
  type DirectorScheduleV1,
  type DirectorStore
} from "../../services/director/public.js";

type SqlRow = Record<string, unknown>;

export function migrateDirectorTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS director_daily_schedules (
      schedule_date TEXT PRIMARY KEY CHECK (schedule_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
      time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) BETWEEN 1 AND 80),
      seed_hash TEXT NOT NULL CHECK (length(seed_hash) = 64),
      schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
      generated_at TEXT NOT NULL CHECK (length(trim(generated_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS director_daily_schedule_revisions (
      schedule_date TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      source TEXT NOT NULL CHECK (source IN ('daily_plan', 'character_revision')),
      request_text TEXT,
      seed_hash TEXT NOT NULL CHECK (length(seed_hash) = 64),
      schedule_json TEXT NOT NULL CHECK (json_valid(schedule_json)),
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      PRIMARY KEY (schedule_date, revision)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS director_schedule_revisions_created
      ON director_daily_schedule_revisions(created_at DESC, schedule_date, revision);

    CREATE TABLE IF NOT EXISTS director_schedule_task_links (
      task_id TEXT PRIMARY KEY CHECK (length(trim(task_id)) BETWEEN 1 AND 128),
      schedule_date TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      item_id TEXT NOT NULL CHECK (length(trim(item_id)) BETWEEN 1 AND 48),
      run_at TEXT NOT NULL CHECK (length(trim(run_at)) > 0),
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      UNIQUE (schedule_date, revision, item_id, task_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS director_schedule_task_links_schedule
      ON director_schedule_task_links(schedule_date, revision, item_id);
  `);
}

export class SqliteDirectorStore implements DirectorStore {
  constructor(private readonly database: DatabaseSync) {
    migrateDirectorTables(database);
  }

  read(date: string): DirectorScheduleV1 | undefined {
    const row = this.database.prepare(`
      SELECT schedule_json FROM director_daily_schedules WHERE schedule_date = ?
    `).get(date) as SqlRow | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(String(row.schedule_json));
    if (!isDirectorSchedule(parsed)) {
      throw new Error(`Stored director schedule is invalid for ${date}.`);
    }
    return parsed;
  }

  commit(input: DirectorScheduleCommitInput): DirectorScheduleCommitResult {
    const now = input.now ?? new Date();
    const timestamp = now.toISOString();
    const draft = normalizeDirectorScheduleDraft(input.draft, {
      date: input.draft.date,
      timeZone: input.draft.timeZone
    });
    return this.transaction(() => {
      const current = this.read(draft.date);
      if (current && input.source === "daily_plan" && input.expectedRevision == null) {
        return { status: "existing", schedule: current };
      }
      if (current && input.expectedRevision !== current.revision) {
        return { status: "conflict", schedule: current };
      }
      if (!current && input.expectedRevision != null && input.expectedRevision !== 0) {
        throw new Error("Director schedule expectedRevision is invalid for a new day.");
      }
      const revision = (current?.revision ?? 0) + 1;
      const schedule: DirectorScheduleV1 = {
        ...draft,
        revision,
        source: input.source,
        generatedAt: current?.generatedAt ?? timestamp,
        updatedAt: timestamp
      };
      const encoded = JSON.stringify(schedule);
      this.database.prepare(`
        INSERT INTO director_daily_schedule_revisions (
          schedule_date, revision, source, request_text, seed_hash, schedule_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        schedule.date,
        revision,
        input.source,
        input.requestText?.trim() || null,
        input.seedHash,
        encoded,
        timestamp
      );
      this.database.prepare(`
        INSERT INTO director_daily_schedules (
          schedule_date, current_revision, time_zone, seed_hash, schedule_json, generated_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(schedule_date) DO UPDATE SET
          current_revision = excluded.current_revision,
          time_zone = excluded.time_zone,
          seed_hash = excluded.seed_hash,
          schedule_json = excluded.schedule_json,
          updated_at = excluded.updated_at
      `).run(
        schedule.date,
        revision,
        schedule.timeZone,
        input.seedHash,
        encoded,
        schedule.generatedAt,
        schedule.updatedAt
      );
      return { status: "committed", schedule };
    });
  }

  listTaskLinks(date: string): DirectorScheduleTaskLink[] {
    return (this.database.prepare(`
      SELECT schedule_date, revision, item_id, task_id, run_at, created_at
      FROM director_schedule_task_links
      WHERE schedule_date = ?
      ORDER BY revision, item_id, task_id
    `).all(date) as SqlRow[]).map((row) => ({
      scheduleDate: String(row.schedule_date),
      revision: Number(row.revision),
      itemId: String(row.item_id),
      taskId: String(row.task_id),
      runAt: String(row.run_at),
      createdAt: String(row.created_at)
    }));
  }

  linkTask(link: DirectorScheduleTaskLink) {
    this.database.prepare(`
      INSERT INTO director_schedule_task_links (
        task_id, schedule_date, revision, item_id, run_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        schedule_date = excluded.schedule_date,
        revision = excluded.revision,
        item_id = excluded.item_id,
        run_at = excluded.run_at
    `).run(
      link.taskId,
      link.scheduleDate,
      link.revision,
      link.itemId,
      link.runAt,
      link.createdAt
    );
  }

  deleteTaskLink(taskId: string) {
    this.database.prepare("DELETE FROM director_schedule_task_links WHERE task_id = ?").run(taskId);
  }

  private transaction<T>(operation: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
