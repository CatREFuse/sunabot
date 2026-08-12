// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateDirectorTables,
  SqliteDirectorStore
} from "../../adapters/sqlite/directorStore.js";
import type { DirectorScheduleDraftV1 } from "../../services/director/public.js";

describe("director SQLite store", () => {
  let database: DatabaseSync;
  let store: SqliteDirectorStore;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    store = new SqliteDirectorStore(database);
  });

  afterEach(() => {
    if (database.isOpen) database.close();
  });

  it("creates idempotent STRICT current, revision and task-link tables", () => {
    migrateDirectorTables(database);
    const tables = database.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE name LIKE 'director_%' AND type = 'table' ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      "director_daily_schedule_revisions",
      "director_daily_schedules",
      "director_schedule_task_links"
    ]);
    expect(tables.every((table) => table.sql.toLowerCase().includes("strict"))).toBe(true);
  });

  it("commits one daily plan, appends CAS revisions and keeps immutable history", () => {
    const first = store.commit({
      draft: draft("初始安排"),
      seedHash: "a".repeat(64),
      source: "daily_plan",
      now: new Date("2026-07-20T07:00:00.000Z")
    });
    expect(first).toMatchObject({ status: "committed", schedule: { revision: 1, source: "daily_plan" } });

    expect(store.commit({
      draft: draft("不会覆盖"),
      seedHash: "a".repeat(64),
      source: "daily_plan",
      now: new Date("2026-07-20T07:01:00.000Z")
    })).toEqual({ status: "existing", schedule: first.schedule });

    const revised = store.commit({
      draft: draft("下午改去整理资料"),
      seedHash: "b".repeat(64),
      source: "character_revision",
      requestText: "临时需要整理资料",
      expectedRevision: 1,
      now: new Date("2026-07-20T12:00:00.000Z")
    });
    expect(revised).toMatchObject({
      status: "committed",
      schedule: { revision: 2, source: "character_revision", summary: "下午改去整理资料" }
    });
    expect(store.read("2026-07-20")).toEqual(revised.schedule);

    expect(store.commit({
      draft: draft("过期请求"),
      seedHash: "c".repeat(64),
      source: "character_revision",
      expectedRevision: 1,
      now: new Date("2026-07-20T12:01:00.000Z")
    })).toEqual({ status: "conflict", schedule: revised.schedule });

    expect(database.prepare(`
      SELECT revision, source, request_text FROM director_daily_schedule_revisions ORDER BY revision
    `).all()).toEqual([
      { revision: 1, source: "daily_plan", request_text: null },
      { revision: 2, source: "character_revision", request_text: "临时需要整理资料" }
    ]);
  });

  it("persists and removes schedule-to-task links", () => {
    store.linkTask({
      scheduleDate: "2026-07-20",
      revision: 1,
      itemId: "afternoon",
      taskId: "director-plana-20260720-afternoon-r1-c1",
      runAt: "2026-07-20T15:00:00.000Z",
      createdAt: "2026-07-20T07:00:00.000Z"
    });
    expect(store.listTaskLinks("2026-07-20")).toHaveLength(1);
    store.deleteTaskLink("director-plana-20260720-afternoon-r1-c1");
    expect(store.listTaskLinks("2026-07-20")).toEqual([]);
  });

  it("lists the latest decision for each day with bounded pagination", () => {
    store.commit({
      draft: draft("第一天"),
      seedHash: "a".repeat(64),
      source: "daily_plan",
      now: new Date("2026-07-20T07:00:00.000Z")
    });
    store.commit({
      draft: { ...draft("第二天"), date: "2026-07-21", items: draft("第二天").items.map((item) => ({
        ...item,
        startAt: item.startAt.replace("2026-07-20", "2026-07-21"),
        endAt: item.endAt.replace("2026-07-20", "2026-07-21"),
        share: { ...item.share, at: item.share.at?.replace("2026-07-20", "2026-07-21") ?? null }
      })) },
      seedHash: "b".repeat(64),
      source: "daily_plan",
      now: new Date("2026-07-21T07:00:00.000Z")
    });

    expect(store.list({ page: 1, pageSize: 1 })).toMatchObject({
      schedules: [{ date: "2026-07-21", summary: "第二天" }],
      pagination: { page: 1, pageSize: 1, total: 2, pageCount: 2 }
    });
    expect(store.list({ page: 9, pageSize: 1 })).toMatchObject({
      schedules: [{ date: "2026-07-20", summary: "第一天" }],
      pagination: { page: 2, pageSize: 1, total: 2, pageCount: 2 }
    });
  });
});

function draft(summary: string): DirectorScheduleDraftV1 {
  return {
    schemaVersion: 1,
    date: "2026-07-20",
    timeZone: "UTC",
    theme: "日常",
    summary,
    items: [
      item("morning", "07:00", "09:00"),
      item("afternoon", "13:00", "16:00", true),
      item("night", "20:00", "22:00")
    ]
  };
}

function item(id: string, start: string, end: string, share = false) {
  return {
    id,
    startAt: `2026-07-20T${start}:00+00:00`,
    endAt: `2026-07-20T${end}:00+00:00`,
    activity: `${id} activity`,
    location: "什亭之箱",
    participants: [],
    intent: "保持日常连续性",
    variant: "稳定日",
    share: share
      ? {
          enabled: true,
          at: "2026-07-20T15:00:00+00:00",
          textIntent: "分享进展",
          selfiePrompt: "角色本人在什亭之箱工作台前展示完成的资料，神情自然，午后柔光"
        }
      : { enabled: false, at: null, textIntent: null, selfiePrompt: null }
  } as DirectorScheduleDraftV1["items"][number];
}
