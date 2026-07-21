// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  dreamLegacyRecallLineages,
  normalizeDreamMemorySnapshot,
  projectDreamRecallStats
} from "../../services/memory/dream/public.js";

describe("Dream legacy memory normalization", () => {
  it("canonicalizes legacy body fields and creates stable unique ids without losing extra data", () => {
    const input = {
      workingRecords: [
        { id: "legacy_text", text: "旧格式正文", custom: { keep: true }, addressName: "老师", causal_chain_key: "causal:salary_case" },
        { content: "缺少 ID 的内容", causalChainKey: "untrusted chain" },
        { id: "x".repeat(300), summary: "非法 ID 的摘要" },
        { id: "duplicate", memory: { text: "嵌套记忆" } }
      ],
      longTermRecords: [
        { id: "duplicate", fact: "跨来源重复 ID" },
        { id: "no_body", opaque: 7 }
      ]
    };

    const first = normalizeDreamMemorySnapshot(input);
    const second = normalizeDreamMemorySnapshot(input);
    const records = [...first.workingRecords, ...first.longTermRecords];
    expect(first).toEqual(second);
    expect(new Set(records.map((record) => record.id)).size).toBe(records.length);
    expect(first.workingRecords[0]).toMatchObject({
      schemaVersion: 2,
      id: "legacy_text",
      fact: "旧格式正文",
      custom: { keep: true },
      addressNames: ["老师"],
      causalChainKey: "causal:salary_case"
    });
    expect(first.workingRecords[1]?.id).toMatch(/^legacy_working_[a-f0-9]{32}$/u);
    expect(first.workingRecords[1]).not.toHaveProperty("causalChainKey");
    expect(first.workingRecords[2]).toMatchObject({
      fact: "非法 ID 的摘要",
      legacyMemoryId: "x".repeat(300)
    });
    expect(first.workingRecords[3]?.fact).toBe("嵌套记忆");
    expect(first.longTermRecords[0]).toMatchObject({
      fact: "跨来源重复 ID",
      legacyMemoryId: "duplicate"
    });
    expect(first.longTermRecords[1]?.fact).toContain("opaque");
    expect(records.every((record) => typeof record.eventFingerprint === "string")).toBe(true);
  });

  it("fails closed for non-object memory entries", () => {
    expect(() => normalizeDreamMemorySnapshot({
      workingRecords: [null as unknown as Record<string, unknown>],
      longTermRecords: []
    })).toThrow("must be an object");
  });

  it("renames a 129-character id and keeps every canonical id within the store limit", () => {
    const normalized = normalizeDreamMemorySnapshot({
      workingRecords: [],
      longTermRecords: [
        { id: "a".repeat(128), fact: "边界内" },
        { id: "b".repeat(129), fact: "超过边界" }
      ]
    });

    expect(normalized.longTermRecords[0]?.id).toBe("a".repeat(128));
    expect(normalized.longTermRecords[1]).toMatchObject({
      id: expect.stringMatching(/^legacy_long_term_[a-f0-9]{32}$/u),
      legacyMemoryId: "b".repeat(129)
    });
    expect(normalized.longTermRecords.every((record) => [...String(record.id)].length <= 128)).toBe(true);
  });

  it("does not transfer an ambiguous duplicate lineage and conservatively blocks zero-recall treatment", () => {
    const normalized = normalizeDreamMemorySnapshot({
      workingRecords: [],
      longTermRecords: [
        { id: "duplicate", fact: "明确归属的原记录" },
        { id: "duplicate", fact: "需要重命名的重复记录" }
      ]
    });
    expect(dreamLegacyRecallLineages(normalized.longTermRecords)).toEqual([]);

    const projected = projectDreamRecallStats({
      records: normalized.longTermRecords,
      stats: [{
        recordId: "duplicate",
        recallCount: 4,
        distinctRecallDays: 2,
        lastRecalledAt: "2026-07-19T01:00:00.000Z",
        trackingStartedAt: "2026-04-01T00:00:00.000Z",
        lastReviewedAt: null,
        importance: null,
        futureRelevance: null,
        emotionalSalience: null
      }],
      trackingStartedAt: "2026-07-20T04:00:00.000Z"
    });
    expect(projected).toEqual([
      expect.objectContaining({ recordId: "duplicate", recallCount: 4 }),
      expect.objectContaining({ recallCount: 4 })
    ]);
  });

  it("projects a renamed zero-count legacy record as recalled for the current evaluation", () => {
    const normalized = normalizeDreamMemorySnapshot({
      workingRecords: [],
      longTermRecords: [{ id: "legacy id", fact: "旧格式记忆" }]
    });
    const targetId = String(normalized.longTermRecords[0]?.id);
    expect(dreamLegacyRecallLineages(normalized.longTermRecords)).toEqual([
      { targetId, sourceIds: ["legacy id"] }
    ]);
    expect(projectDreamRecallStats({
      records: normalized.longTermRecords,
      stats: [{
        recordId: "legacy id",
        recallCount: 0,
        distinctRecallDays: 0,
        lastRecalledAt: null,
        trackingStartedAt: "2026-04-01T00:00:00.000Z",
        lastReviewedAt: null,
        importance: null,
        futureRelevance: null,
        emotionalSalience: null
      }],
      trackingStartedAt: "2026-07-20T04:00:00.000Z"
    })).toEqual([
      expect.objectContaining({
        recordId: targetId,
        recallCount: 1,
        trackingStartedAt: "2026-04-01T00:00:00.000Z"
      })
    ]);
  });
});
