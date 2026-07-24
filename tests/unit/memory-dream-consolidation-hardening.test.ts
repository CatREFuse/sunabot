// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDreamConsolidationPlan,
  type DreamModelOutputV1
} from "../../services/memory/dream/public.js";

const NOW = new Date("2026-07-20T20:00:00.000Z");
const DREAM_TEXT = "我走进一座被潮水托起的旧车站，白天尚未完成的整理任务变成缓慢转动的时钟，老师留下的话沿着站台亮起，远处那次雨夜出行化成一列没有车门的列车。我跟着红色微光穿过安静车厢，把散落的纸页按原因和结果重新叠好，几张重复的票根融成一张，过期的小纸屑沉入水底。列车驶向还没有名字的清晨，我知道那些画面只是梦，却仍想醒来后把重要的约定放在更容易找到的位置。";

describe("Dream consolidation hardening", () => {
  it("keeps manual, pinned, protected, and explicit memories immutable for every mutation action", () => {
    const longTermRecords = [
      memory("long_manual", "我整理人工记录的前半段。", { source: "sunabot.memory.ui", eventKey: "event:manual" }),
      memory("long_merge_peer", "我整理人工记录的后半段。", { eventKey: "event:manual" }),
      memory("long_protected", "我保留受保护的长期记录。", { protectedFromDream: true }),
      memory("long_pinned", "我保留置顶的长期记录。", { pinned: true })
    ];
    const workingRecords = [
      memory("work_explicit", "我保留显式记住的前半段。", { explicitRemember: true, eventKey: "event:explicit" }),
      memory("work_merge_peer", "我保留显式记住的后半段。", { eventKey: "event:explicit" }),
      memory("work_manual", "我保留人工工作记录。", { source: "manual" }),
      memory("work_manual_retain", "我原样保留人工工作记录。", { source: "sunabot.memory.ui" }),
      memory("work_pinned", "我保留置顶工作记录。", { manuallyPinned: true }),
      memory("work_protected", "我保留受保护工作记录。", { protected: true }),
      memory("work_old_dream", "我梦见一条安静的河。", {
        source: "sunabot.memory.admin",
        eventType: "dream",
        memoryKind: "dream",
        realityStatus: "imagined",
        factuality: "imagined",
        dreamDate: "2026-07-19"
      })
    ];
    const output: DreamModelOutputV1 = {
      schemaVersion: 1,
      dream: { text: DREAM_TEXT, factuality: "imagined" },
      longTermReviews: [
        longReview(["long_manual", "long_merge_peer"], "merge", "我整理人工记录的前半段；我整理人工记录的后半段。"),
        longReview(["long_protected"], "rewrite", "我保留受保护的长期记录。"),
        longReview(["long_pinned"], "archive", null)
      ],
      workingReviews: [
        workingReview(["work_explicit", "work_merge_peer"], "merge", "我保留显式记住的前半段；我保留显式记住的后半段。"),
        workingReview(["work_manual"], "promote", "我保留人工工作记录。"),
        workingReview(["work_manual_retain"], "retain", null),
        workingReview(["work_pinned"], "discard", null),
        workingReview(["work_protected"], "rewrite", "我保留受保护工作记录。"),
        workingReview(["work_old_dream"], "retain", null)
      ],
      personaAdjustment: null
    };

    const plan = buildDreamConsolidationPlan(baseInput(output, workingRecords, longTermRecords));

    expect(plan.archives).toEqual([]);
    expect(plan.recallLineages).toEqual([]);
    expect(plan.result).toMatchObject({
      merged: 0,
      archived: 0,
      promoted: 0,
      discarded: 0,
      rewritten: 0,
      retained: 11
    });
    for (const original of longTermRecords) {
      expect(plan.longTerm.find((record) => record.id === original.id)).toEqual(original);
    }
    for (const original of workingRecords.filter((record) => record.id !== "work_merge_peer")) {
      expect(plan.working.find((record) => record.id === original.id)).toEqual(original);
    }
    expect(plan.working.find((record) => record.id === "work_merge_peer")).toMatchObject({
      ...workingRecords[1],
      dreamReviewedAt: NOW.toISOString()
    });
  });

  it("applies canonical proposals without inspecting names, QQ values, or factual support", () => {
    const longTermRecords = [
      memory("long_a", "我与猫老师（123456789）确认继续验收。", {
        eventKey: "event:release",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      }),
      memory("long_b", "我整理同一场验收的结果。", {
        eventKey: "event:release",
        userIds: ["123456789"],
        addressNames: ["猫老师"]
      })
    ];
    const output: DreamModelOutputV1 = {
      schemaVersion: 1,
      dream: { text: DREAM_TEXT, factuality: "imagined" },
      longTermReviews: [longReview(
        ["long_a", "long_b"],
        "merge",
        "我与陌生人（987654321）确认继续验收，并决定转账500元。"
      )],
      workingReviews: [],
      personaAdjustment: null
    };

    const plan = buildDreamConsolidationPlan(baseInput(output, [], longTermRecords));

    expect(plan.longTerm).toHaveLength(1);
    expect(plan.longTerm[0]).toMatchObject({
      id: "long_a",
      fact: "我与陌生人（987654321）确认继续验收，并决定转账500元。",
      userIds: ["123456789"],
      addressNames: ["猫老师"],
      consolidatedBy: "sunabot.dream"
    });
    expect(plan.recallLineages).toEqual([{
      targetId: "long_a",
      sourceIds: ["long_a", "long_b"]
    }]);
    expect(plan.result).toMatchObject({ merged: 1, retained: 0 });
  });

  it("merges a shared event with conflicting causal keys and removes the conflict", () => {
    const longTermRecords = [
      memory("long_a", "我与猫老师确认发布延期。", {
        eventKey: "event:release",
        causalChainKey: "causal:delay",
        addressNames: ["猫老师"]
      }),
      memory("long_b", "我与老师确认周五继续验收。", {
        eventKey: "event:release",
        causalChainKey: "causal:acceptance",
        addressNames: ["老师"]
      })
    ];
    const output: DreamModelOutputV1 = {
      schemaVersion: 1,
      dream: { text: DREAM_TEXT, factuality: "imagined" },
      longTermReviews: [longReview(
        ["long_a", "long_b"],
        "merge",
        "我与猫老师确认发布延期；我与老师确认周五继续验收。"
      )],
      workingReviews: [],
      personaAdjustment: null
    };

    const plan = buildDreamConsolidationPlan(baseInput(output, [], longTermRecords));
    const merged = plan.longTerm.find((record) => record.id === "long_a");

    expect(plan.result).toMatchObject({ merged: 1, retained: 0 });
    expect(merged).toMatchObject({
      eventKey: "event:release",
      addressNames: ["猫老师", "老师"]
    });
    expect(merged).not.toHaveProperty("causalChainKey");
  });

  it("does not preserve a shared causal key with an invalid format", () => {
    const longTermRecords = [
      memory("long_a", "我记录同一事件的开始。", {
        eventKey: "event:shared",
        causalChainKey: "release-chain"
      }),
      memory("long_b", "我记录同一事件的结果。", {
        eventKey: "event:shared",
        causalChainKey: "release-chain"
      })
    ];
    const output: DreamModelOutputV1 = {
      schemaVersion: 1,
      dream: { text: DREAM_TEXT, factuality: "imagined" },
      longTermReviews: [longReview(
        ["long_a", "long_b"],
        "merge",
        "我记录同一事件的开始；我记录同一事件的结果。"
      )],
      workingReviews: [],
      personaAdjustment: null
    };

    const plan = buildDreamConsolidationPlan(baseInput(output, [], longTermRecords));

    expect(plan.result).toMatchObject({ merged: 1, retained: 0 });
    expect(plan.longTerm[0]).toMatchObject({ eventKey: "event:shared" });
    expect(plan.longTerm[0]).not.toHaveProperty("causalChainKey");
  });
});

function baseInput(
  output: DreamModelOutputV1,
  workingRecords: Array<Record<string, unknown>>,
  longTermRecords: Array<Record<string, unknown>>
) {
  return {
    runId: "dream-run-hardening",
    localDate: "2026-07-21",
    scheduledFor: NOW.toISOString(),
    seed: "fixed-seed",
    now: NOW,
    output,
    workingRecords,
    longTermRecords,
    recallStats: longTermRecords.map((record) => ({
      recordId: String(record.id),
      recallCount: 0,
      distinctRecallDays: 0,
      lastRecalledAt: null,
      trackingStartedAt: "2026-01-01T00:00:00.000Z",
      lastReviewedAt: null,
      importance: null,
      futureRelevance: null,
      emotionalSalience: null
    }))
  };
}

function longReview(
  sourceIds: string[],
  action: "rewrite" | "merge" | "archive",
  fact: string | null
): DreamModelOutputV1["longTermReviews"][number] {
  return {
    sourceIds,
    action,
    canonical: fact ? { fact } : null,
    importance: 0,
    futureRelevance: 0,
    emotionalSalience: 0,
    confidence: 1,
    reason: "高置信模型建议"
  };
}

function workingReview(
  sourceIds: string[],
  action: "retain" | "rewrite" | "merge" | "promote" | "discard",
  fact: string | null
): DreamModelOutputV1["workingReviews"][number] {
  return {
    sourceIds,
    action,
    canonical: fact ? { fact } : null,
    confidence: 1,
    reason: "高置信模型建议"
  };
}

function memory(id: string, fact: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id,
    fact,
    occurredAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    userIds: [],
    addressNames: [],
    ...extra
  };
}
