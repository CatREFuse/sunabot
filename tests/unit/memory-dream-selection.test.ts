// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_MAX_MEMORY_SELECTION,
  DREAM_MEMORY_BUCKET_SELECTION,
  DREAM_OLDER_MEMORY_SELECTION,
  DREAM_RECENT_MEMORY_DAYS,
  DREAM_RECENT_MEMORY_SELECTION,
  normalizeDreamMemorySnapshot,
  projectDreamRecallStats,
  selectDreamMemories,
  type DreamMemoryRecord,
  type DreamRecallStatsSnapshot
} from "../../services/memory/dream/public.js";

const NOW = new Date("2026-07-20T20:00:00.000Z");

describe("Dream memory selection", () => {
  it("selects 24 memories from the latest day and 12 older memories with input-order independence", () => {
    const workingRecords = Array.from({ length: 40 }, (_, index) => memory(
      `working_${String(index).padStart(3, "0")}`,
      index < 20 ? "2026-07-20T00:00:00.000Z" : "2025-01-01T00:00:00.000Z"
    ));
    const longTermRecords = Array.from({ length: 40 }, (_, index) => memory(
      `long_${String(index).padStart(3, "0")}`,
      index < 20 ? "2026-07-20T10:00:00.000Z" : "2024-01-01T00:00:00.000Z"
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
    expect(DREAM_MAX_MEMORY_SELECTION).toBe(48);
    expect(DREAM_MEMORY_BUCKET_SELECTION).toBe(DREAM_OLDER_MEMORY_SELECTION);
    expect(first.sourceMemoryIds)
      .toHaveLength(DREAM_RECENT_MEMORY_SELECTION + DREAM_OLDER_MEMORY_SELECTION);
    expect(new Set(first.sourceMemoryIds))
      .toHaveLength(DREAM_RECENT_MEMORY_SELECTION + DREAM_OLDER_MEMORY_SELECTION);
    const selected = [...first.selectedWorking, ...first.selectedLongTerm];
    expect(selected.filter((item) => item.selectedBy === "recent"))
      .toHaveLength(DREAM_RECENT_MEMORY_SELECTION);
    expect(selected.filter((item) => item.selectedBy === "remote"))
      .toHaveLength(DREAM_OLDER_MEMORY_SELECTION);
    expect(selected.filter((item) => item.scoreComponents.ageDays! <= DREAM_RECENT_MEMORY_DAYS))
      .toHaveLength(DREAM_RECENT_MEMORY_SELECTION);
    expect(selected.filter((item) => item.scoreComponents.ageDays! > DREAM_RECENT_MEMORY_DAYS))
      .toHaveLength(DREAM_OLDER_MEMORY_SELECTION);
    expect(first.selectedLongTerm.every((item) => item.score >= 0 && item.score <= 1)).toBe(true);
  });

  it("uses the exact 24-hour boundary and does not backfill a short time bucket", () => {
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
      .toHaveLength(DREAM_OLDER_MEMORY_SELECTION);
    expect(selection.sourceMemoryIds).toHaveLength(DREAM_OLDER_MEMORY_SELECTION + 2);
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

  it("keeps every recent candidate when the bucket stays within its limit", () => {
    const workingRecords = Array.from({ length: 13 }, (_, index) => memory(
      `recent_work_${String(index).padStart(2, "0")}`,
      `2026-07-20T${String(index).padStart(2, "0")}:00:00.000Z`
    ));
    const longTermRecords = Array.from({ length: 11 }, (_, index) => memory(
      `recent_long_${String(index).padStart(2, "0")}`,
      "2026-07-20T19:00:00.000Z"
    ));
    const expectedIds = [...workingRecords, ...longTermRecords]
      .map((record) => String(record.id))
      .sort();
    const selectIds = (seed: string) => selectDreamMemories({
      seed,
      now: NOW,
      workingRecords,
      longTermRecords,
      recallStats: longTermRecords.map((record) => stats(String(record.id), 1))
    }).sourceMemoryIds.slice().sort();

    expect(selectIds("complete-a")).toEqual(expectedIds);
    expect(selectIds("complete-b")).toEqual(expectedIds);
  });

  it("prioritizes working memory, active commitments and high-relevance recent items on overflow", () => {
    const workingRecords = Array.from({ length: 10 }, (_, index) => memory(
      `recent_working_${String(index).padStart(2, "0")}`,
      "2026-07-20T18:00:00.000Z"
    ));
    const longTermRecords = Array.from({ length: 20 }, (_, index) => memory(
      `recent_long_${String(index).padStart(2, "0")}`,
      "2026-07-20T18:30:00.000Z",
      index === 0
        ? { eventType: "commitment" }
        : index === 1
          ? { eventType: "boundary" }
          : {}
    ));
    const recallStats = longTermRecords.map((record, index) => stats(String(record.id), 3, {
      importance: index === 2 ? 0.95 : 0.1,
      futureRelevance: index === 3 ? 0.95 : 0.1,
      emotionalSalience: index === 4 ? 0.95 : 0.1
    }));
    const selection = selectDreamMemories({
      seed: "recent-overflow",
      now: NOW,
      workingRecords,
      longTermRecords,
      recallStats
    });
    const selectedIds = new Set(selection.sourceMemoryIds);

    expect(selection.sourceMemoryIds).toHaveLength(DREAM_RECENT_MEMORY_SELECTION);
    expect(workingRecords.every((record) => selectedIds.has(String(record.id)))).toBe(true);
    for (const id of [
      "recent_long_00",
      "recent_long_01",
      "recent_long_02",
      "recent_long_03",
      "recent_long_04"
    ]) {
      expect(selectedIds.has(id), id).toBe(true);
    }
  });

  it("ranks older memories by recall need, salience, task relevance and review need", () => {
    const longTermRecords = [
      memory("older_recall", "2025-01-01T00:00:00.000Z"),
      memory("older_important", "2025-01-01T00:00:00.000Z"),
      memory("older_future", "2025-01-01T00:00:00.000Z"),
      memory("older_emotional", "2025-01-01T00:00:00.000Z"),
      memory("older_task", "2025-01-01T00:00:00.000Z", { eventType: "commitment" }),
      memory("older_review", "2025-01-01T00:00:00.000Z"),
      ...Array.from({ length: 12 }, (_, index) => memory(
        `older_low_${String(index).padStart(2, "0")}`,
        "2025-01-01T00:00:00.000Z"
      ))
    ];
    const recallStats = longTermRecords.map((record) => {
      const id = String(record.id);
      const value = stats(id, id === "older_recall" ? 0 : 5, {
        importance: id === "older_important" ? 1 : 0,
        futureRelevance: id === "older_future" ? 1 : 0,
        emotionalSalience: id === "older_emotional" ? 1 : 0
      });
      value.lastReviewedAt = id === "older_review" ? null : NOW.toISOString();
      return value;
    });
    const selection = selectDreamMemories({
      seed: "older-priority",
      now: NOW,
      workingRecords: [],
      longTermRecords,
      recallStats,
      recentMemoryLimit: 0,
      olderMemoryLimit: 6
    });

    expect(selection.sourceMemoryIds.slice().sort()).toEqual([
      "older_emotional",
      "older_future",
      "older_important",
      "older_recall",
      "older_review",
      "older_task"
    ]);
  });

  it("keeps review, recall, salience, task, and imagined metadata", () => {
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

  it("uses the run seed to vary tied recent and older overflow samples", () => {
    const longTermRecords = Array.from({ length: 80 }, (_, index) => memory(
      `equal_${String(index).padStart(2, "0")}`,
      index < 40 ? "2026-07-20T00:00:00.000Z" : "2025-07-20T00:00:00.000Z"
    ));
    const recallStats = longTermRecords.map((record) => stats(String(record.id), 5));
    const selectedIds = (seed: string) => {
      const selection = selectDreamMemories({
        seed,
        now: NOW,
        workingRecords: [],
        longTermRecords,
        recallStats
      });
      return {
        recent: selection.selectedLongTerm
          .filter((item) => item.selectedBy === "recent")
          .map((item) => item.id),
        remote: selection.selectedLongTerm
          .filter((item) => item.selectedBy === "remote")
          .map((item) => item.id)
      };
    };

    expect(selectedIds("seed-a").recent).not.toEqual(selectedIds("seed-b").recent);
    expect(selectedIds("seed-a").remote).not.toEqual(selectedIds("seed-b").remote);
    expect(selectedIds("seed-a")).toEqual(selectedIds("seed-a"));
  });

  it("exposes only factual scoped agreements as field-knowledge evidence", () => {
    const selection = selectDreamMemories({
      seed: "field-knowledge",
      now: NOW,
      workingRecords: [
        memory("field_boundary", "2026-07-20T10:00:00.000Z", { eventType: "boundary" }),
        memory("field_rule", "2026-07-20T11:00:00.000Z", {
          eventType: "rule",
          contextKey: "",
          conversationId: "group:20001"
        }),
        memory("field_dream", "2026-07-20T12:00:00.000Z", {
          eventType: "commitment",
          memoryKind: "dream"
        }),
        memory("field_unscoped", "2026-07-20T13:00:00.000Z", {
          eventType: "preference",
          contextKey: ""
        }),
        memory("field_trivia", "2026-07-20T14:00:00.000Z", {
          eventType: "conversation"
        }),
        memory("field_uncertain", "2026-07-20T15:00:00.000Z", {
          eventType: "relationship",
          realityStatus: "uncertain"
        })
      ],
      longTermRecords: [
        memory("field_convention", "2026-06-01T00:00:00.000Z", {
          eventType: "convention"
        })
      ],
      recallStats: [stats("field_convention", 1)]
    });

    expect(selection.fieldKnowledgeEvidenceIds.slice().sort()).toEqual([
      "field_boundary",
      "field_convention",
      "field_rule"
    ]);
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
      recentMemoryLimit: 37,
      olderMemoryLimit: 12
    })).toThrow("total memory limit");
    expect(() => selectDreamMemories({
      ...base,
      recentMemoryLimit: 0,
      olderMemoryLimit: 0
    })).toThrow("total memory limit");
  });

  it("keeps an uncalled legacy-id memory selectable without inventing a recall", () => {
    const normalized = normalizeDreamMemorySnapshot({
      workingRecords: [],
      longTermRecords: [{
        ...memory("legacy id with spaces", "2026-01-01T00:00:00.000Z"),
        id: "legacy id with spaces"
      }]
    });
    const recallStats = projectDreamRecallStats({
      records: normalized.longTermRecords,
      stats: [],
      trackingStartedAt: "2026-07-20T20:00:00.000Z"
    });

    expect(recallStats).toEqual([
      expect.objectContaining({
        recordId: String(normalized.longTermRecords[0]?.id),
        recallCount: 0,
        distinctRecallDays: 0,
        lastRecalledAt: null
      })
    ]);
    expect(() => selectDreamMemories({
      seed: "legacy-id-no-recall",
      now: NOW,
      workingRecords: [],
      longTermRecords: normalized.longTermRecords,
      recallStats
    })).not.toThrow();
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
