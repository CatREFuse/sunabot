// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WorkingMemoryDocumentItem } from "../../services/memory/public.js";
import {
  repairDreamWorkingMemoryItems
} from "../../tooling/migrations/repair-dream-working-memory-boundary.js";

describe("Dream working-memory boundary repair", () => {
  it("restores a legacy Dream and reclassifies host-allocated factual records", () => {
    const factual = item({
      id: "working_16741f7568e4e873aebe07bf883e91f4",
      content: "普通事实",
      sourceKind: "dream",
      batchId: "run-factual",
      conversationId: "dream:agent-a",
      conversationScope: "dream"
    });
    const dream = item({
      id: "working_dream_2026_07_28_0",
      content: "梦见旧车站",
      sourceKind: "dream",
      batchId: "run-dream",
      conversationId: "dream:agent-a",
      conversationScope: "dream"
    });

    const repaired = repairDreamWorkingMemoryItems([factual, dream], (runId) => runId === "run-dream"
      ? {
          id: "run-dream",
          localDate: "2026-07-28",
          generatedAt: "2026-07-28T04:00:10.000+08:00"
        }
      : undefined);

    expect(repaired.ambiguousIds).toEqual([]);
    expect(repaired.changes).toEqual([
      expect.objectContaining({ id: factual.id, action: "restore_factual" }),
      expect.objectContaining({ id: dream.id, action: "restore_dream" })
    ]);
    expect(repaired.items[0]).toMatchObject({
      id: factual.id,
      sourceKind: "model_merge",
      conversationId: "system:memory",
      conversationScope: "system",
      memoryKind: ""
    });
    expect(repaired.items[1]).toMatchObject({
      id: dream.id,
      sourceKind: "dream",
      memoryKind: "dream",
      realityStatus: "imagined",
      factuality: "imagined",
      eventType: "dream",
      eventKey: "dream:2026-07-28",
      dreamRunId: "run-dream",
      dreamDate: "2026-07-28",
      dreamReviewedAt: "2026-07-28T04:00:10.000+08:00"
    });
  });

  it("leaves an unverified legacy Dream unchanged and reports it as ambiguous", () => {
    const legacy = item({
      id: "working_dream_2026_07_28_0",
      content: "无法核验的旧记录",
      sourceKind: "dream",
      batchId: "missing-run"
    });

    const repaired = repairDreamWorkingMemoryItems([legacy], () => undefined);

    expect(repaired.items).toEqual([legacy]);
    expect(repaired.changes).toEqual([]);
    expect(repaired.ambiguousIds).toEqual([legacy.id]);
  });

  it("does not modify records that already have explicit Dream semantics", () => {
    const current = item({
      id: "working_dream_2026_07_30",
      content: "完整 Dream",
      sourceKind: "dream",
      memoryKind: "dream",
      realityStatus: "imagined",
      factuality: "imagined"
    });

    const repaired = repairDreamWorkingMemoryItems([current], () => undefined);

    expect(repaired.items).toEqual([current]);
    expect(repaired.changes).toEqual([]);
    expect(repaired.ambiguousIds).toEqual([]);
  });
});

function item(overrides: Partial<WorkingMemoryDocumentItem>): WorkingMemoryDocumentItem {
  return {
    id: "working_default",
    content: "内容",
    recordedAt: "2026-07-28T04:00:00.000+08:00",
    timeZone: "Asia/Shanghai",
    conversationId: "system:memory",
    conversationScope: "system",
    conversationTitle: "",
    sourceKind: "model_merge",
    ...overrides
  };
}
