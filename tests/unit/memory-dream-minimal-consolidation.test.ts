// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDreamMinimalConsolidationPlan,
  type DreamMemoryRecord,
  type DreamMinimalModelOutput
} from "../../services/memory/dream/public.js";

const now = new Date("2026-08-04T04:05:00.000Z");

function working(id: string, fact: string): DreamMemoryRecord {
  return {
    schemaVersion: 2,
    id,
    fact,
    source: "admin",
    factuality: "factual",
    realityStatus: "factual",
    occurredAt: "2026-08-03T08:00:00.000Z",
    createdAt: "2026-08-03T08:00:00.000Z",
    conversationId: "private:99112233",
    eventType: "release_rule",
    subjectKey: "release",
    eventKey: "release:completion-gate",
    causalChainKey: "causal:release-tests",
    userIds: ["99112233"],
    addressNames: ["老师"]
  };
}

function output(overrides: Partial<DreamMinimalModelOutput> = {}): DreamMinimalModelOutput {
  return {
    workingMemoryCompression: "发布必须等自动回归全部通过后才能确认完成。",
    longTermMemoryAdditions: ["每次发布都必须等自动回归全部通过后才能确认完成。"],
    dreamDescription: "我梦见测试灯逐盏亮起，最后一盏亮起后，写着完成的门才打开。",
    ...overrides
  };
}

function plan(value = output(), longTermRecords: DreamMemoryRecord[] = []) {
  return buildDreamMinimalConsolidationPlan({
    runId: "dream-run-1",
    localDate: "2026-08-04",
    scheduledFor: "2026-08-04T04:00:00.000Z",
    seed: "seed",
    now,
    output: value,
    workingRecords: [
      working("working_a", "自动回归未全部通过时不能确认发布完成。"),
      working("working_b", "只有自动回归全部通过，发布才能标记完成。")
    ],
    longTermRecords
  });
}

describe("minimal Dream consolidation", () => {
  it("returns one document replacement, adds one long-term fact, and leaves the Dream description in run history", () => {
    const result = plan();
    expect(result.workingMemoryCompression).toBe("发布必须等自动回归全部通过后才能确认完成。");
    expect(result.working).toHaveLength(2);
    expect(result.workingMemoryId).toBeNull();
    expect(result.longTerm).toEqual([
      expect.objectContaining({
        fact: "每次发布都必须等自动回归全部通过后才能确认完成。",
        sourceWorkingMemoryIds: [],
        dreamRunId: "dream-run-1",
        consolidatedBy: "sunabot.dream"
      })
    ]);
    expect(result.result).toMatchObject({
      workingMemoryCompression: { sourceCount: 2, outputCount: 1, reducedBy: 1 },
      longTermMemoryAdditions: {
        requested: 1,
        added: 1,
        duplicate: 0,
        unavailable: 0
      }
    });
  });

  it("keeps every existing long-term record byte-for-byte and reports duplicate-only zero write", () => {
    const existing = working(
      "long_term_existing",
      "每次发布都必须等自动回归全部通过后才能确认完成。"
    );
    const before = structuredClone(existing);
    const result = plan(output(), [existing]);
    expect(result.longTerm).toEqual([before]);
    expect(result.result.longTermMemoryAdditions).toMatchObject({
      requested: 1,
      added: 0,
      duplicate: 1,
      unavailable: 0
    });
  });

  it("accepts no proposed addition without adding visible decision metadata", () => {
    const value = output({
      longTermMemoryAdditions: []
    });
    const result = plan(value);
    expect(result.result.longTermMemoryAdditions).toMatchObject({
      requested: 0,
      added: 0
    });
    expect(result.result.longTermMemoryAdditions).not.toHaveProperty("reason");
    expect(result.result.longTermMemoryAdditions).not.toHaveProperty("reasonCode");
  });

  it("does not interpret the working document as source-linked items", () => {
    const retained = working("working_c", "仍需保留的独立事项。");
    const result = buildDreamMinimalConsolidationPlan({
      runId: "dream-run-1",
      localDate: "2026-08-04",
      scheduledFor: "2026-08-04T04:00:00.000Z",
      seed: "seed",
      now,
      output: output(),
      workingRecords: [
        working("working_a", "自动回归未全部通过时不能确认发布完成。"),
        working("working_b", "只有自动回归全部通过，发布才能标记完成。"),
        retained
      ],
      longTermRecords: []
    });
    expect(result.workingMemoryCompression).toBe("发布必须等自动回归全部通过后才能确认完成。");
    expect(result.working).toContainEqual(retained);
  });

  it("allows an empty replacement document without inventing an output record", () => {
    const result = plan(output({ workingMemoryCompression: "" }));
    expect(result.workingMemoryCompression).toBe("");
    expect(result.result.workingMemoryCompression).toMatchObject({
      sourceCount: 2,
      outputCount: 0,
      reducedBy: 2
    });
  });
});
