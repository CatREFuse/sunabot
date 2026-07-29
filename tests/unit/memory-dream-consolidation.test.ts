// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE,
  buildPersonaEvidence,
  buildDreamConsolidationPlan,
  type DreamModelOutputV1
} from "../../services/memory/dream/public.js";

const NOW = new Date("2026-07-20T20:00:00.000Z");
const DREAM_TEXT = "我走进一座被潮水托起的旧车站，白天尚未完成的整理任务变成缓慢转动的时钟，老师留下的话沿着站台亮起，远处那次雨夜出行化成一列没有车门的列车。我跟着红色微光穿过安静车厢，把散落的纸页按原因和结果重新叠好，几张重复的票根融成一张，过期的小纸屑沉入水底。列车驶向还没有名字的清晨，我知道那些画面只是梦，却仍想醒来后把重要的约定放在更容易找到的位置。";

describe("Dream memory consolidation", () => {
  it("merges causal memories, gates archives, promotes old dreams, and writes today's imagined dream", () => {
    const output = dreamOutput();
    const plan = buildDreamConsolidationPlan({
      runId: "dream-run-2026-07-21",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [
        memory("working_active", "我仍在处理发布任务。", "2026-07-19T10:00:00.000Z", { eventType: "task" }),
        memory("working_old_dream", "我梦见旧车站漂在海面。", "2026-07-19T20:00:00.000Z", {
          eventType: "dream",
          memoryKind: "dream",
          realityStatus: "imagined",
          factuality: "imagined",
          dreamDate: "2026-07-20",
          dreamRunId: "dream-run-2026-07-20"
        })
      ],
      longTermRecords: [
        memory("long_a", "我在雨天抵达旧车站。", "2026-01-01T08:00:00.000Z", {
          eventType: "journey",
          subjectKey: "旧车站",
          eventKey: "event:old-station"
        }),
        memory("long_b", "我从旧车站乘车离开。", "2026-01-01T09:00:00.000Z", {
          eventType: "journey",
          subjectKey: "旧车站",
          eventKey: "event:old-station"
        }),
        memory("long_low", "我在路边看见一张普通海报。", "2025-01-01T00:00:00.000Z"),
        memory("long_recalled", "我答应老师保留发布记录。", "2025-01-02T00:00:00.000Z", { eventType: "commitment" })
      ],
      recallStats: [
        stats("long_a", 0),
        stats("long_b", 0),
        stats("long_low", 0),
        stats("long_recalled", 3)
      ]
    });

    expect(plan.result).toEqual({
      schemaVersion: 1,
      merged: 1,
      archived: 1,
      promoted: 1,
      discarded: 0,
      rewritten: 0,
      retained: 2
    });
    expect(plan.archives).toEqual([
      expect.objectContaining({
        recordId: "long_low",
        reason: "低价值且没有未来用途",
        recallSnapshot: expect.objectContaining({
          recallCount: 0,
          distinctRecallDays: 0,
          lastRecalledAt: null,
          trackingStartedAt: "2026-01-01T00:00:00.000Z"
        })
      })
    ]);
    expect(plan.longTerm.find((record) => record.id === "long_a")).toMatchObject({
      fact: "我在雨天抵达旧车站；我从旧车站乘车离开。",
      occurredAt: "2026-01-01T08:00:00.000Z",
      eventType: "journey",
      eventKey: "event:old-station",
      consolidatedBy: "sunabot.dream"
    });
    expect(plan.longTerm.some((record) => record.id === "long_b")).toBe(false);
    expect(plan.longTerm.some((record) => record.id === "long_recalled")).toBe(true);
    expect(plan.longTerm.find((record) => record.id === "long_term_dream_2026_07_20")).toMatchObject({
      realityStatus: "imagined",
      factuality: "imagined",
      sourceWorkingMemoryIds: ["working_old_dream"]
    });
    expect(plan.working.some((record) => record.id === "working_old_dream")).toBe(false);
    expect(plan.working.find((record) => record.id === plan.workingMemoryId)).toMatchObject({
      fact: DREAM_TEXT,
      memoryKind: "dream",
      realityStatus: "imagined",
      dreamDate: "2026-07-21",
      eventKey: "dream:2026-07-21",
      randomSeed: "fixed-seed"
    });
    expect(plan.working.find((record) => record.id === plan.workingMemoryId)?.eventFingerprint)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(plan.personaEvidence.map((item) => item.id)).not.toContain("working_old_dream");
    expect(plan.recallLineages).toContainEqual({ targetId: "long_a", sourceIds: ["long_a", "long_b"] });
  });

  it("rejects a model proposal that mixes imagined and factual memories", () => {
    const output = dreamOutput();
    output.workingReviews = [{
      sourceIds: ["working_active", "working_old_dream"],
      action: "merge",
      canonical: { fact: "错误地混合现实和梦境。" },
      confidence: 1,
      reason: "错误建议"
    }];
    expect(() => buildDreamConsolidationPlan({
      runId: "dream-run-2026-07-21",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [
        memory("working_active", "真实任务。", "2026-07-19T10:00:00.000Z"),
        memory("working_old_dream", "旧梦。", "2026-07-19T20:00:00.000Z", {
          eventType: "dream",
          memoryKind: "dream",
          realityStatus: "imagined",
          dreamDate: "2026-07-20"
        })
      ],
      longTermRecords: dreamLongTermRecords(),
      recallStats: dreamLongTermRecords().map((record) => stats(String(record.id), 0))
    })).toThrow("cannot be consolidated with factual working memory");
  });

  it("applies model-directed long-term merges without confidence or relationship gates", () => {
    const sharedEventRecords = [
      memory("long_a", "我经历同一事件的开端。", "2026-01-01T08:00:00.000Z", { eventKey: "event:shared" }),
      memory("long_b", "我经历同一事件的后续。", "2026-01-02T08:00:00.000Z", { eventKey: "event:shared" })
    ];
    const lowConfidence = mergeOnlyPlan(sharedEventRecords, DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE - 0.01);
    expect(lowConfidence.longTerm.map((record) => record.id)).toEqual(["long_a"]);
    expect(lowConfidence.recallLineages).toEqual([{ targetId: "long_a", sourceIds: ["long_a", "long_b"] }]);
    expect(lowConfidence.result).toMatchObject({ merged: 1, retained: 0 });

    const unrelatedRecords = [
      memory("long_a", "我经历第一件旧事。", "2026-01-01T08:00:00.000Z", { eventKey: "event:first" }),
      memory("long_b", "我经历另一件旧事。", "2026-01-02T08:00:00.000Z", { eventKey: "event:second" })
    ];
    const unrelated = mergeOnlyPlan(unrelatedRecords, DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE);
    expect(unrelated.longTerm.map((record) => record.id)).toEqual(["long_a"]);
    expect(unrelated.recallLineages).toEqual([{ targetId: "long_a", sourceIds: ["long_a", "long_b"] }]);
    expect(unrelated.result).toMatchObject({ merged: 1, retained: 0 });

    const causalRecords = [
      memory("long_a", "我经历先发生的原因。", "2026-01-01T08:00:00.000Z", { causalChainKey: "causal:release" }),
      memory("long_b", "我经历随后出现的结果。", "2026-01-02T08:00:00.000Z", { causalChainKey: "causal:release" })
    ];
    const causal = mergeOnlyPlan(causalRecords, DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE);
    expect(causal.longTerm.map((record) => record.id)).toEqual(["long_a"]);
    expect(causal.longTerm[0]).toMatchObject({ causalChainKey: "causal:release" });
    expect(causal.recallLineages).toEqual([{ targetId: "long_a", sourceIds: ["long_a", "long_b"] }]);
    expect(causal.result).toMatchObject({ merged: 1, retained: 0 });
  });

  it("applies a model-directed working-memory merge without a relationship gate", () => {
    const output = dreamOutput();
    output.longTermReviews = [];
    output.workingReviews = [{
      sourceIds: ["work_a", "work_b"],
      action: "merge",
      canonical: { fact: "被模型误判为同一事件。" },
      confidence: 1,
      reason: "错误建议"
    }];
    const plan = buildDreamConsolidationPlan({
      runId: "dream-run-working-merge-gate",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [
        memory("work_a", "一件普通的小事。", "2026-07-19T08:00:00.000Z", { eventKey: "event:a" }),
        memory("work_b", "另一件无关的小事。", "2026-07-19T09:00:00.000Z", { eventKey: "event:b" })
      ],
      longTermRecords: [],
      recallStats: []
    });

    expect(plan.working).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "work_a",
        fact: "被模型误判为同一事件。",
        dreamReviewedAt: NOW.toISOString()
      })
    ]));
    expect(plan.working.some((record) => record.id === "work_b")).toBe(false);
    expect(plan.result).toMatchObject({ merged: 1, retained: 0 });
  });

  it("follows the model-directed old-dream merge without a relationship gate", () => {
    const output = dreamOutput();
    output.longTermReviews = [];
    output.workingReviews = [{
      sourceIds: ["dream_a", "dream_b"],
      action: "merge",
      canonical: { fact: "两场无关的梦。" },
      confidence: 1,
      reason: "模型建议合并"
    }];
    const dream = (id: string, date: string) => memory(id, `梦境 ${id}`, `${date}T04:00:00.000Z`, {
      eventType: "dream",
      memoryKind: "dream",
      realityStatus: "imagined",
      factuality: "imagined",
      dreamDate: date
    });
    const plan = buildDreamConsolidationPlan({
      runId: "dream-run-old-dream-split",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [dream("dream_a", "2026-07-18"), dream("dream_b", "2026-07-19")],
      longTermRecords: [],
      recallStats: []
    });

    expect(plan.longTerm).toEqual([
      expect.objectContaining({
        id: "long_term_dream_2026_07_18",
        fact: "两场无关的梦。",
        sourceWorkingMemoryIds: ["dream_a", "dream_b"]
      })
    ]);
    expect(plan.result).toMatchObject({ merged: 0, promoted: 1 });
  });

  it("retains an archive candidate below the destructive-action confidence threshold", () => {
    const output = dreamOutput();
    output.longTermReviews = [{
      sourceIds: ["long_low"],
      action: "archive",
      canonical: null,
      importance: 0.1,
      futureRelevance: 0.1,
      emotionalSalience: 0.1,
      confidence: DREAM_DESTRUCTIVE_ACTION_MIN_CONFIDENCE - 0.01,
      reason: "低置信归档建议"
    }];
    output.workingReviews = [];
    const plan = buildDreamConsolidationPlan({
      runId: "dream-run-low-confidence",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [],
      longTermRecords: [memory("long_low", "一条久远但仍需保留的记录。", "2025-01-01T00:00:00.000Z")],
      recallStats: [stats("long_low", 0)]
    });

    expect(plan.archives).toEqual([]);
    expect(plan.longTerm.map((record) => record.id)).toEqual(["long_low"]);
    expect(plan.result).toMatchObject({ archived: 0, retained: 1 });
  });

  it("never archives a long-term memory created manually in the memory UI", () => {
    const output = dreamOutput();
    output.longTermReviews = [{
      sourceIds: ["manual_ui"],
      action: "archive",
      canonical: null,
      importance: 0,
      futureRelevance: 0,
      emotionalSalience: 0,
      confidence: 1,
      reason: "模型认为不重要"
    }];
    output.workingReviews = [];
    const plan = buildDreamConsolidationPlan({
      runId: "dream-run-manual-protection",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [],
      longTermRecords: [memory("manual_ui", "管理员手工写下的记忆。", "2025-01-01T00:00:00.000Z", {
        source: "sunabot.memory.ui"
      })],
      recallStats: [stats("manual_ui", 0)]
    });

    expect(plan.archives).toEqual([]);
    expect(plan.longTerm).toEqual([expect.objectContaining({ id: "manual_ui" })]);
    expect(plan.result).toMatchObject({ archived: 0, retained: 1 });
  });

  it("rewrites one high-confidence memory while preserving its identity and stable event metadata", () => {
    const output = dreamOutput();
    output.longTermReviews = [{
      sourceIds: ["long_verbose"],
      action: "rewrite",
      canonical: { fact: "我经历发布延期，最后确认周五继续验收。" },
      importance: 0.8,
      futureRelevance: 0.8,
      emotionalSalience: 0.5,
      confidence: 0.95,
      reason: "删除重复流水账"
    }];
    output.workingReviews = [{
      sourceIds: ["work_verbose"],
      action: "rewrite",
      canonical: { fact: "我今天继续整理发布清单。" },
      confidence: 0.95,
      reason: "统一格式"
    }];
    const plan = buildDreamConsolidationPlan({
      runId: "dream-run-rewrite",
      localDate: "2026-07-21",
      scheduledFor: NOW.toISOString(),
      seed: "fixed-seed",
      now: NOW,
      output,
      workingRecords: [memory("work_verbose", "我今天继续整理发布清单，重复记录了很多过程。", "2026-07-18T01:00:00.000Z", {
        eventKey: "event:work"
      })],
      longTermRecords: [memory("long_verbose", "我经历发布延期，讨论了许多重复过程，最后确认周五继续验收。", "2026-06-01T00:00:00.000Z", {
        eventKey: "event:release",
        causalChainKey: "causal:release"
      })],
      recallStats: [stats("long_verbose", 1)]
    });

    expect(plan.longTerm).toEqual([expect.objectContaining({
      id: "long_verbose",
      fact: "我经历发布延期，最后确认周五继续验收。",
      eventKey: "event:release",
      causalChainKey: "causal:release"
    })]);
    expect(plan.working).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "work_verbose",
      fact: "我今天继续整理发布清单。",
      eventKey: "event:work"
    })]));
    expect(plan.result).toMatchObject({ rewritten: 2, merged: 0 });
  });

  it("does not invent independent persona events or contexts from legacy record fields", () => {
    const evidence = buildPersonaEvidence([
      memory("legacy", "旧记录只有 ID 与事件类型。", "2026-06-01T00:00:00.000Z", {
        eventType: "conversation"
      }),
      memory("missing_context", "缺少明确上下文。", "2026-06-02T00:00:00.000Z", {
        eventKey: "event:missing-context",
        eventType: "conversation"
      }),
      memory("valid", "具有稳定事件与会话依据。", "2026-06-03T00:00:00.000Z", {
        eventKey: "event:valid",
        conversationId: "private:10001"
      }),
      memory("dream", "梦境不能作为人格证据。", "2026-06-04T00:00:00.000Z", {
        eventKey: "event:dream",
        contextKey: "context:dream",
        memoryKind: "dream"
      })
    ]);

    expect(evidence).toEqual([{
      id: "valid",
      eventId: "event:valid",
      context: "private:10001",
      occurredAt: "2026-06-03T00:00:00.000Z",
      factuality: "factual",
      impactScore: 0
    }]);
  });
});

function mergeOnlyPlan(longTermRecords: ReturnType<typeof memory>[], confidence: number) {
  const output = dreamOutput();
  output.longTermReviews = [{
    sourceIds: ["long_a", "long_b"],
    action: "merge",
    canonical: {
      fact: longTermRecords
        .map((record) => String(record.fact).replace(/[。！？]+$/u, ""))
        .join("；") + "。"
    },
    importance: 0.5,
    futureRelevance: 0.5,
    emotionalSalience: 0.5,
    confidence,
    reason: "模型建议合并"
  }];
  output.workingReviews = [];
  return buildDreamConsolidationPlan({
    runId: "dream-run-merge-gate",
    localDate: "2026-07-21",
    scheduledFor: NOW.toISOString(),
    seed: "fixed-seed",
    now: NOW,
    output,
    workingRecords: [],
    longTermRecords,
    recallStats: longTermRecords.map((record) => stats(String(record.id), 0))
  });
}

function dreamOutput(): DreamModelOutputV1 {
  return {
    schemaVersion: 1,
    dream: { text: DREAM_TEXT, factuality: "imagined" },
    longTermReviews: [
      {
        sourceIds: ["long_a", "long_b"],
        action: "merge",
        canonical: { fact: "我在雨天抵达旧车站；我从旧车站乘车离开。" },
        importance: 0.5,
        futureRelevance: 0.3,
        emotionalSalience: 0.4,
        confidence: 0.9,
        reason: "同一段旅程"
      },
      {
        sourceIds: ["long_low"],
        action: "archive",
        canonical: null,
        importance: 0.1,
        futureRelevance: 0.1,
        emotionalSalience: 0.1,
        confidence: 0.9,
        reason: "低价值且没有未来用途"
      },
      {
        sourceIds: ["long_recalled"],
        action: "archive",
        canonical: null,
        importance: 0.1,
        futureRelevance: 0.1,
        emotionalSalience: 0.1,
        confidence: 0.9,
        reason: "模型建议归档"
      }
    ],
    workingReviews: [
      {
        sourceIds: ["working_active"],
        action: "retain",
        canonical: null,
        confidence: 1,
        reason: "仍在进行"
      },
      {
        sourceIds: ["working_old_dream"],
        action: "retain",
        canonical: null,
        confidence: 1,
        reason: "旧梦需要转存"
      }
    ],
    personaAdjustment: null
  };
}

function dreamLongTermRecords() {
  return [
    memory("long_a", "雨天抵达旧车站。", "2026-01-01T08:00:00.000Z"),
    memory("long_b", "从旧车站乘车离开。", "2026-01-01T09:00:00.000Z"),
    memory("long_low", "普通海报。", "2025-01-01T00:00:00.000Z"),
    memory("long_recalled", "发布记录。", "2025-01-02T00:00:00.000Z")
  ];
}

function memory(id: string, fact: string, occurredAt: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    id,
    fact,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    userIds: [],
    addressNames: [],
    ...extra
  };
}

function stats(recordId: string, recallCount: number) {
  return {
    recordId,
    recallCount,
    distinctRecallDays: recallCount ? 2 : 0,
    lastRecalledAt: recallCount ? "2026-07-10T00:00:00.000Z" : null,
    trackingStartedAt: "2026-01-01T00:00:00.000Z",
    lastReviewedAt: null,
    importance: null,
    futureRelevance: null,
    emotionalSalience: null
  };
}
