// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_MAX_MEMORY_SELECTION,
  DREAM_MEMORY_BUCKET_SELECTION,
  DREAM_RECENT_MEMORY_DAYS,
  selectDreamMemories,
  type DreamMemoryRecord,
  type DreamRecallStatsSnapshot
} from "../../services/memory/dream/public.js";

const NOW = new Date("2026-07-20T20:00:00.000Z");

describe("Dream memory selection", () => {
  it("samples one unified batch with 12 memories from the latest 2 days and 12 older memories", () => {
    const workingRecords = Array.from({ length: 40 }, (_, index) => memory(
      `working_${String(index).padStart(3, "0")}`,
      index < 20 ? "2026-07-19T00:00:00.000Z" : "2025-01-01T00:00:00.000Z"
    ));
    const longTermRecords = Array.from({ length: 40 }, (_, index) => memory(
      `long_${String(index).padStart(3, "0")}`,
      index < 20 ? "2026-07-20T00:00:00.000Z" : "2024-01-01T00:00:00.000Z"
    ));
    const recallStats = longTermRecords.map((record, index) => stats(String(record.id), index % 4));
    const first = selectDreamMemories({
      seed: "stable-seed",
      now: NOW,
      workingRecords,
      longTermRecords,
      recallStats
    });
    const second = selectDreamMemories({
      seed: "stable-seed",
      now: NOW,
      workingRecords: [...workingRecords].reverse(),
      longTermRecords: [...longTermRecords].reverse(),
      recallStats: [...recallStats].reverse()
    });

    expect(first).toEqual(second);
    expect(first.sourceMemoryIds).toHaveLength(DREAM_MAX_MEMORY_SELECTION);
    expect(new Set(first.sourceMemoryIds)).toHaveLength(DREAM_MAX_MEMORY_SELECTION);
    const selected = [...first.selectedWorking, ...first.selectedLongTerm];
    expect(selected.filter((item) => item.selectedBy === "recent"))
      .toHaveLength(DREAM_MEMORY_BUCKET_SELECTION);
    expect(selected.filter((item) => item.selectedBy === "remote"))
      .toHaveLength(DREAM_MEMORY_BUCKET_SELECTION);
    expect(selected.filter((item) => item.scoreComponents.ageDays! <= DREAM_RECENT_MEMORY_DAYS))
      .toHaveLength(DREAM_MEMORY_BUCKET_SELECTION);
    expect(selected.filter((item) => item.scoreComponents.ageDays! > DREAM_RECENT_MEMORY_DAYS))
      .toHaveLength(DREAM_MEMORY_BUCKET_SELECTION);
    expect(first.selectedLongTerm.every((item) => item.score >= 0 && item.score <= 1)).toBe(true);
  });

  it("uses the exact 48-hour boundary and does not backfill a short time bucket", () => {
    const boundary = new Date(NOW.getTime() - DREAM_RECENT_MEMORY_DAYS * 24 * 60 * 60_000);
    const workingRecords = [
      memory("recent_exact", boundary.toISOString()),
      memory("older_by_one_ms", new Date(boundary.getTime() - 1).toISOString()),
      memory("recent_now", NOW.toISOString())
    ];
    const longTermRecords = Array.from({ length: 20 }, (_, index) => memory(
      `older_${index}`,
      "2025-01-01T00:00:00.000Z"
    ));
    const selection = selectDreamMemories({
      seed: "boundary-seed",
      now: NOW,
      workingRecords,
      longTermRecords,
      recallStats: longTermRecords.map((record) => stats(String(record.id), 1))
    });
    const selected = [...selection.selectedWorking, ...selection.selectedLongTerm];

    expect(selected.filter((item) => item.selectedBy === "recent").map((item) => item.id).sort())
      .toEqual(["recent_exact", "recent_now"]);
    expect(selected.filter((item) => item.selectedBy === "remote"))
      .toHaveLength(DREAM_MEMORY_BUCKET_SELECTION);
    expect(selection.sourceMemoryIds).toHaveLength(DREAM_MEMORY_BUCKET_SELECTION + 2);
  });

  it("uses configured window and per-bucket limits without cross-bucket backfill", () => {
    const boundary = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const workingRecords = [
      memory("recent_exact", boundary.toISOString()),
      memory("recent_now", NOW.toISOString()),
      memory("older_by_one_ms", new Date(boundary.getTime() - 1).toISOString())
    ];
    const longTermRecords = Array.from({ length: 4 }, (_, index) => memory(
      `older_configured_${index}`,
      "2025-01-01T00:00:00.000Z"
    ));
    const selection = selectDreamMemories({
      seed: "configured-seed",
      now: NOW,
      workingRecords,
      longTermRecords,
      recallStats: longTermRecords.map((record) => stats(String(record.id), 1)),
      recentWindowHours: 24,
      recentMemoryLimit: 3,
      olderMemoryLimit: 5
    });
    const selected = [...selection.selectedWorking, ...selection.selectedLongTerm];

    expect(selected.filter((item) => item.selectedBy === "recent").map((item) => item.id).sort())
      .toEqual(["recent_exact", "recent_now"]);
    expect(selected.filter((item) => item.selectedBy === "remote")).toHaveLength(5);
    expect(selection.sourceMemoryIds).toHaveLength(7);
    expect(selected.find((item) => item.id === "recent_exact")?.reasons).toContain("recent_fragment");
    expect(selected.find((item) => item.id === "older_by_one_ms")?.reasons).not.toContain("recent_fragment");
  });

  it("keeps review, recall, salience, task, and imagined metadata without biasing the random sample", () => {
    const workingRecords = [
      memory("working_recent", "2026-07-20T10:00:00.000Z"),
      memory("working_task", "2026-07-19T10:00:00.000Z", { eventType: "task" }),
      memory("working_dream", "2026-07-19T20:00:00.000Z", {
        eventType: "dream",
        memoryKind: "dream",
        factuality: "imagined",
        dreamDate: "2026-07-20"
      })
    ];
    const longTermRecords = [
      memory("long_recent", "2026-07-10T00:00:00.000Z"),
      memory("long_remote", "2023-01-01T00:00:00.000Z"),
      memory("long_never", "2026-04-01T00:00:00.000Z"),
      memory("long_important", "2025-02-01T00:00:00.000Z"),
      memory("long_future", "2025-03-01T00:00:00.000Z"),
      memory("long_emotional", "2025-04-01T00:00:00.000Z"),
      memory("long_task", "2025-05-01T00:00:00.000Z", { eventType: "commitment" }),
      memory("long_dream", "2025-06-01T00:00:00.000Z", {
        eventType: "dream",
        realityStatus: "imagined"
      })
    ];
    const recallStats = longTermRecords.map((record) => stats(String(record.id), 3, {
      importance: record.id === "long_important" ? 0.9 : 0.2,
      futureRelevance: record.id === "long_future" ? 0.9 : 0.2,
      emotionalSalience: record.id === "long_emotional" ? 0.9 : 0.2
    }));
    recallStats.find((item) => item.recordId === "long_never")!.recallCount = 0;
    recallStats.find((item) => item.recordId === "long_never")!.distinctRecallDays = 0;
    recallStats.find((item) => item.recordId === "long_never")!.lastRecalledAt = null;

    const selection = selectDreamMemories({
      seed: "balanced-seed",
      now: NOW,
      workingRecords,
      longTermRecords,
      recallStats
    });

    expect(selection.selectedWorking.map((item) => item.id)).toEqual(expect.arrayContaining([
      "working_recent",
      "working_task",
      "working_dream"
    ]));
    expect(selection.selectedLongTerm.map((item) => item.id)).toEqual(expect.arrayContaining([
      "long_recent",
      "long_remote",
      "long_never",
      "long_important",
      "long_future",
      "long_emotional",
      "long_task",
      "long_dream"
    ]));
    expect(selected(selection, "long_never")).toMatchObject({
      selectedBy: "remote",
      reasons: expect.arrayContaining(["never_recalled_tracked", "review_due"]),
      recallStats: { recallCount: 0 }
    });
    expect(selected(selection, "long_recent").reasons).not.toContain("low_recall");
    expect(selected(selection, "long_remote").reasons).toContain("remote_anchor");
    expect(selected(selection, "long_important").reasons).toContain("important");
    expect(selected(selection, "long_future").reasons).toContain("future_relevant");
    expect(selected(selection, "long_emotional").reasons).toContain("emotionally_salient");
    expect(selected(selection, "long_task").reasons).toContain("active_task_or_commitment");
    expect(selected(selection, "long_dream")).toMatchObject({
      factuality: "imagined",
      selectedBy: "remote",
      reasons: expect.arrayContaining(["dream_material"])
    });
  });

  it("keeps imagined and uncertain memories out of persona evidence", () => {
    const selection = selectDreamMemories({
      seed: "persona-seed",
      now: NOW,
      workingRecords: [
        memory("factual_working", "2026-07-01T00:00:00.000Z", {
          factuality: "factual",
          importance: 0.8
        }),
        memory("imagined_working", "2026-07-02T00:00:00.000Z", { memoryKind: "dream" }),
        memory("uncertain_working", "2026-07-03T00:00:00.000Z", { realityStatus: "uncertain" }),
        memory("future_working", "2026-08-01T00:00:00.000Z", { factuality: "factual" }),
        memory("legacy_fallback", "2026-06-01T00:00:00.000Z", {
          eventKey: "",
          contextKey: "",
          eventType: "conversation"
        })
      ],
      longTermRecords: [
        memory("factual_long", "2026-06-01T00:00:00.000Z", { importance: 0.8 }),
        memory("imagined_long", "2026-05-01T00:00:00.000Z", { factuality: "imagined" })
      ],
      recallStats: [stats("factual_long", 1), stats("imagined_long", 1)]
    });

    expect(selection.personaEvidenceIds).toEqual(expect.arrayContaining([
      "factual_working",
      "factual_long"
    ]));
    expect(selection.personaEvidenceIds).not.toEqual(expect.arrayContaining([
      "imagined_working",
      "imagined_long",
      "uncertain_working",
      "future_working",
      "legacy_fallback"
    ]));
    expect(selection.sourceMemoryIds).toEqual(expect.arrayContaining([
      "imagined_working",
      "imagined_long"
    ]));
  });

  it("uses the run seed to vary both recent and older random samples", () => {
    const longTermRecords = Array.from({ length: 40 }, (_, index) => memory(
      `equal_${String(index).padStart(2, "0")}`,
      index < 20 ? "2026-07-20T00:00:00.000Z" : "2025-07-20T00:00:00.000Z"
    ));
    const recallStats = longTermRecords.map((record) => stats(String(record.id), 5));
    const selectedIds = (seed: string) => selectDreamMemories({
      seed,
      now: NOW,
      workingRecords: [],
      longTermRecords,
      recallStats
    }).selectedLongTerm.map((item) => item.id);

    expect(selectedIds("seed-a")).not.toEqual(selectedIds("seed-b"));
    expect(selectedIds("seed-a")).toEqual(selectedIds("seed-a"));
  });

  it("rejects invalid ids, duplicate records, unknown or inconsistent stats, time, and seed", () => {
    const base = {
      seed: "valid",
      now: NOW,
      workingRecords: [memory("working_a", "2026-07-01T00:00:00.000Z")],
      longTermRecords: [memory("long_a", "2026-01-01T00:00:00.000Z")],
      recallStats: [stats("long_a", 1)]
    };
    expect(() => selectDreamMemories({ ...base, seed: " " })).toThrow("seed is invalid");
    expect(() => selectDreamMemories({ ...base, now: new Date("invalid") })).toThrow("time is invalid");
    expect(() => selectDreamMemories({
      ...base,
      workingRecords: [memory("bad id", "2026-07-01T00:00:00.000Z")]
    })).toThrow("memory id is invalid");
    expect(() => selectDreamMemories({
      ...base,
      workingRecords: [memory("long_a", "2026-07-01T00:00:00.000Z")]
    })).toThrow("Duplicate dream selection memory id long_a");
    expect(() => selectDreamMemories({
      ...base,
      recallStats: [stats("missing", 1)]
    })).toThrow("unknown memory missing");
    expect(() => selectDreamMemories({
      ...base,
      recallStats: [{ ...stats("long_a", 0), lastRecalledAt: "2026-01-02T00:00:00.000Z" }]
    })).toThrow("are inconsistent");
    expect(() => selectDreamMemories({ ...base, recentWindowHours: 0 })).toThrow("recentWindowHours");
    expect(() => selectDreamMemories({ ...base, recentMemoryLimit: -1 })).toThrow("recentMemoryLimit");
    expect(() => selectDreamMemories({
      ...base,
      recentMemoryLimit: 13,
      olderMemoryLimit: 12
    })).toThrow("total memory limit");
    expect(() => selectDreamMemories({
      ...base,
      recentMemoryLimit: 0,
      olderMemoryLimit: 0
    })).toThrow("total memory limit");
  });
});

function memory(
  id: string,
  occurredAt: string,
  extra: Record<string, unknown> = {}
): DreamMemoryRecord {
  return {
    schemaVersion: 2,
    id,
    fact: `记忆 ${id}`,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    userIds: [],
    addressNames: [],
    eventKey: `event:${id}`,
    contextKey: `context:${id}`,
    ...extra
  };
}

function stats(
  recordId: string,
  recallCount: number,
  scores: Partial<Pick<
    DreamRecallStatsSnapshot,
    "importance" | "futureRelevance" | "emotionalSalience"
  >> = {}
): DreamRecallStatsSnapshot {
  return {
    recordId,
    recallCount,
    distinctRecallDays: recallCount ? 1 : 0,
    lastRecalledAt: recallCount ? "2026-07-10T00:00:00.000Z" : null,
    trackingStartedAt: "2026-01-01T00:00:00.000Z",
    lastReviewedAt: null,
    importance: scores.importance ?? null,
    futureRelevance: scores.futureRelevance ?? null,
    emotionalSalience: scores.emotionalSalience ?? null
  };
}

function selected(
  selection: ReturnType<typeof selectDreamMemories>,
  id: string
) {
  const value = [...selection.selectedWorking, ...selection.selectedLongTerm]
    .find((item) => item.id === id);
  if (!value) throw new Error(`Missing selected memory ${id}.`);
  return value;
}
