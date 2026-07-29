import { describe, expect, it, vi } from "vitest";
import type { SqliteDreamStore } from "../../adapters/sqlite/dreamStore.js";
import {
  DREAM_PAYLOAD_VARIABLE,
  type DreamFieldKnowledgeV1,
  type DreamMemorySelectionSettings,
  type DreamMemoryRecord,
  type DreamPersonaAdjustmentV1
} from "../../services/memory/dream/public.js";
import {
  RuntimeDreams,
  type RuntimeDreamContextPort,
  type RuntimeDreamContextSnapshot,
  type RuntimeDreamFieldKnowledgePort,
  type RuntimeDreamModelPort,
  type RuntimeDreamPersonaPort,
  type RuntimeDreamRun,
  type RuntimeDreamStorePort,
  type RuntimeDreamWorkingMemoryPort
} from "../../src/runtime/dreamPipeline.js";

type StoreIsDirectlyCompatible = SqliteDreamStore extends RuntimeDreamStorePort ? true : false;
const storeIsDirectlyCompatible: StoreIsDirectlyCompatible = true;
void storeIsDirectlyCompatible;

const UTC = "UTC";
const WORKING_DIGEST = "a".repeat(64);
const LONG_TERM_DIGEST = "b".repeat(64);

describe("RuntimeDreams", () => {
  it("skips yesterday on a fresh install before 04:00, then runs today once", async () => {
    let now = new Date("2026-07-20T03:30:00.000Z");
    const fixture = createFixture(() => now);

    await expect(fixture.runtime.tick(now)).resolves.toBeUndefined();
    expect(fixture.context.captureCalls).toHaveLength(0);
    expect(fixture.store.claimCalls).toHaveLength(0);

    now = new Date("2026-07-20T04:05:00.000Z");
    const completed = await fixture.runtime.tick(now);
    expect(completed).toMatchObject({ localDate: "2026-07-20", status: "completed" });
    expect(fixture.model.calls).toBe(1);
    expect(fixture.store.commitCalls).toHaveLength(1);
    expect(fixture.store.commitCalls[0]?.working).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "working_dream_2026_07_20",
        memoryKind: "dream",
        factuality: "imagined",
        dreamDate: "2026-07-20"
      })
    ]));

    await fixture.runtime.tick(new Date("2026-07-20T12:00:00.000Z"));
    expect(fixture.model.calls).toBe(1);
    expect(fixture.store.claimCalls).toHaveLength(1);
  });

  it("catches up only the latest missed 04:00 occurrence", async () => {
    let now = new Date("2026-07-20T03:30:00.000Z");
    const fixture = createFixture(() => now);
    fixture.store.addRun(runRecord({
      id: "old-run",
      localDate: "2026-07-16",
      scheduledFor: "2026-07-16T04:00:00.000Z",
      status: "completed"
    }));

    const completed = await fixture.runtime.tick(now);
    expect(completed).toMatchObject({ localDate: "2026-07-19", status: "completed" });
    expect(fixture.store.claimCalls).toHaveLength(1);
    expect(fixture.store.listRuns({ limit: 10 }).map((run) => run.localDate)).toEqual([
      "2026-07-19",
      "2026-07-16"
    ]);
  });

  it("sends one model request with a unified 24-recent and 12-older memory batch", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const recentWorking = Array.from({ length: 20 }, (_, index) => memory(
      `recent-work-${index}`,
      "2026-07-19T04:05:00.000Z",
      "conversation",
      `event:recent-work-${index}`
    ));
    const recentLongTerm = Array.from({ length: 20 }, (_, index) => memory(
      `recent-long-${index}`,
      "2026-07-19T12:00:00.000Z",
      "conversation",
      `event:recent-long-${index}`
    ));
    const olderWorking = Array.from({ length: 20 }, (_, index) => memory(
      `older-work-${index}`,
      "2026-07-10T04:05:00.000Z",
      "conversation",
      `event:older-work-${index}`
    ));
    const olderLongTerm = Array.from({ length: 20 }, (_, index) => memory(
      `older-long-${index}`,
      "2025-07-20T04:05:00.000Z",
      "conversation",
      `event:older-long-${index}`
    ));
    const fixture = createFixture(() => now, memorySnapshot({
      workingRecords: [...recentWorking, ...olderWorking],
      longTermRecords: [...recentLongTerm, ...olderLongTerm],
      recallStats: []
    }));

    await fixture.runtime.tick(now);

    expect(fixture.model.calls).toBe(1);
    const request = fixture.model.requests[0] as Record<string, unknown>;
    const payload = request[DREAM_PAYLOAD_VARIABLE] as Record<string, unknown>;
    const ids = [
      ...promptIds(payload.workingMemories),
      ...promptIds(payload.longTermMemories)
    ];
    expect(ids).toHaveLength(36);
    expect(ids.filter((id) => id.startsWith("recent-"))).toHaveLength(24);
    expect(ids.filter((id) => id.startsWith("older-"))).toHaveLength(12);
  });

  it("reads current Dream selection settings when creating a new persisted run", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const settings = vi.fn((): DreamMemorySelectionSettings => ({
      recentWindowHours: 12,
      recentMemoryLimit: 2,
      olderMemoryLimit: 3
    }));
    const fixture = createFixture(() => now, memorySnapshot({
      workingRecords: Array.from({ length: 10 }, (_, index) => memory(
        `recent-config-${index}`,
        "2026-07-20T00:00:00.000Z",
        "conversation",
        `event:recent-config-${index}`
      )),
      longTermRecords: Array.from({ length: 10 }, (_, index) => memory(
        `older-config-${index}`,
        "2026-07-18T00:00:00.000Z",
        "conversation",
        `event:older-config-${index}`
      )),
      recallStats: []
    }), settings);

    await fixture.runtime.tick(now);

    const request = fixture.model.requests[0] as Record<string, unknown>;
    const payload = request[DREAM_PAYLOAD_VARIABLE] as Record<string, unknown>;
    const ids = [...promptIds(payload.workingMemories), ...promptIds(payload.longTermMemories)];
    expect(ids.filter((id) => id.startsWith("recent-config-"))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("older-config-"))).toHaveLength(3);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes legacy memory bodies and unstable ids before selection and atomic replacement", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRecords: [{ id: "legacy-work", text: "旧格式工作记忆" }],
      longTermRecords: [{ id: "x".repeat(300), content: "旧格式长期记忆" }],
      recallStats: []
    }));

    const completed = await fixture.runtime.tick(now);
    expect(completed).toMatchObject({ status: "completed" });
    const commit = fixture.store.commitCalls[0]!;
    expect(commit.working).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "legacy-work", fact: "旧格式工作记忆", schemaVersion: 2 })
    ]));
    expect(commit.longTerm).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^legacy_long_term_[a-f0-9]{32}$/u),
        fact: "旧格式长期记忆",
        legacyMemoryId: "x".repeat(300),
        schemaVersion: 2
      })
    ]);
  });

  it("carries an unambiguous legacy recall lineage into the atomic commit", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRecords: [],
      longTermRecords: [{ id: "legacy id with spaces", fact: "旧格式长期记忆" }],
      recallStats: []
    }));

    await fixture.runtime.tick(now);
    const commit = fixture.store.commitCalls[0]!;
    const targetId = String(commit.longTerm[0]?.id);
    expect(targetId).toMatch(/^legacy_long_term_[a-f0-9]{32}$/u);
    expect(commit.recallLineages).toContainEqual({
      targetId,
      sourceIds: ["legacy id with spaces"]
    });
  });

  it("resumes persisted generated output without a second model call", async () => {
    let now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.store.commitFailures = 1;

    const failed = await fixture.runtime.tick(now);
    expect(failed).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(failed?.output).not.toBeNull();
    expect(fixture.model.calls).toBe(1);

    now = new Date("2026-07-20T04:21:00.000Z");
    const recovered = await fixture.runtime.tick(now);
    expect(recovered).toMatchObject({ status: "completed", attemptCount: 2 });
    expect(fixture.model.calls).toBe(1);
    expect(fixture.store.commitCalls).toHaveLength(2);
  });

  it("commits the Dream working result through Markdown CAS before the SQLite consolidation", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({ status: "completed" });
    expect(fixture.workingMemory.calls).toEqual([
      expect.objectContaining({
        expectedRevision: "d".repeat(64),
        runId: expect.any(String),
        localDate: "2026-07-20",
        records: expect.arrayContaining([
          expect.objectContaining({ id: "working_dream_2026_07_20" })
        ])
      })
    ]);
    expect(fixture.store.commitCalls[0]).toMatchObject({
      externalWorkingMemory: true
    });
  });

  it("fails closed before SQLite commit when the working Markdown revision changed", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.workingMemory.conflict = true;

    const failed = await fixture.runtime.tick(now);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "DREAM_SNAPSHOT_CONFLICT",
      nextRetryAt: null
    });
    expect(fixture.store.commitCalls).toHaveLength(0);
  });

  it("rolls the Markdown write back when the SQLite commit throws", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.store.commitFailures = 1;

    const failed = await fixture.runtime.tick(now);

    expect(failed).toMatchObject({ status: "failed" });
    expect(fixture.workingMemory.rollbacks).toBe(1);
  });

  it("commits scoped field knowledge through CAS before SQLite consolidation", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.model.fieldKnowledge = {
      content: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n### context:relationship\n\n- 发布前需要双人复核。",
      evidenceMemoryIds: ["long-1"]
    };

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({
      status: "completed",
      result: expect.objectContaining({ fieldKnowledgeUpdated: true })
    });
    expect(fixture.fieldKnowledge.calls).toEqual([
      expect.objectContaining({
        expectedRevision: "e".repeat(64),
        content: expect.stringContaining("## 场域约定")
      })
    ]);
    expect(fixture.store.commitCalls[0]?.result).toMatchObject({
      fieldKnowledgeUpdated: true
    });
  });

  it("restores AIR identity aliases locally before the CAS write", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const identifiedWorking = {
      ...memory("work-1", "2026-07-19T18:00:00.000Z", "conversation", "event:work"),
      userId: "95011",
      userName: "Rin",
      addressNames: ["Rin"]
    };
    const originalAir = "# 场域知识\n\n## 使用边界\n\n- 约定只在协作群生效。\n\n## 场域约定\n\n- Rin 负责发布前双人复核。";
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64),
      workingRecords: [identifiedWorking],
      persona: { preference: "表达清楚", relation: "重视长期相处", air: originalAir }
    }));
    fixture.model.fieldKnowledgeFactory = (payload) => ({
      content: String((payload.persona as Record<string, unknown>).air),
      evidenceMemoryIds: []
    });

    const completed = await fixture.runtime.tick(now);
    const persistedInput = fixture.store.claimCalls[0]?.input as Record<string, unknown>;
    const providerPayload = persistedInput.payload as Record<string, unknown>;

    expect(completed).toMatchObject({
      status: "completed",
      result: expect.objectContaining({ fieldKnowledgeUpdated: true })
    });
    expect(JSON.stringify(providerPayload)).not.toContain("Rin");
    expect(persistedInput.fieldKnowledgeBindings).toEqual([
      expect.objectContaining({ value: "Rin" })
    ]);
    expect(fixture.fieldKnowledge.calls[0]?.content).toBe(originalAir);
    expect(fixture.fieldKnowledge.calls[0]?.content).not.toMatch(/人物-[a-f0-9]{24}/u);
  });

  it("does not replace field knowledge when the projected AIR is lossy", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64),
      persona: {
        preference: "表达清楚",
        relation: "重视长期相处",
        air: "# 场域知识\n\n## 使用边界\n\n- 工作区在 /Users/example/project。\n\n## 场域约定\n\n- password=super-secret-value。"
      }
    }));
    fixture.model.fieldKnowledge = {
      content: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n- 发布前需要双人复核。",
      evidenceMemoryIds: ["long-1"]
    };

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({
      status: "completed",
      result: expect.objectContaining({ fieldKnowledgeUpdated: false })
    });
    expect(fixture.fieldKnowledge.calls).toEqual([]);
  });

  it("does not replace field knowledge when a persisted run predates the write gate", async () => {
    let now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.model.fieldKnowledge = {
      content: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n- 发布前需要双人复核。",
      evidenceMemoryIds: ["long-1"]
    };
    fixture.store.commitFailures = 1;

    const failed = await fixture.runtime.tick(now);
    expect(failed).toMatchObject({ status: "failed" });
    const persistedPayload = failed?.input.payload as Record<string, unknown>;
    delete persistedPayload.fieldKnowledgeWritable;
    fixture.fieldKnowledge.calls.length = 0;
    now = new Date("2026-07-20T04:21:00.000Z");

    const recovered = await fixture.runtime.tick(now);

    expect(recovered).toMatchObject({
      status: "completed",
      result: expect.objectContaining({ fieldKnowledgeUpdated: false })
    });
    expect(fixture.fieldKnowledge.calls).toEqual([]);
  });

  it("fails before SQLite and rolls working memory back when field knowledge changed", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.model.fieldKnowledge = {
      content: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n- 发布前需要双人复核。",
      evidenceMemoryIds: ["long-1"]
    };
    fixture.fieldKnowledge.conflict = true;

    const failed = await fixture.runtime.tick(now);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "DREAM_SNAPSHOT_CONFLICT",
      nextRetryAt: null
    });
    expect(fixture.workingMemory.rollbacks).toBe(1);
    expect(fixture.store.commitCalls).toHaveLength(0);
  });

  it("rolls field knowledge and working memory back when SQLite commit throws", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.model.fieldKnowledge = {
      content: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n- 发布前需要双人复核。",
      evidenceMemoryIds: ["long-1"]
    };
    fixture.store.commitFailures = 1;

    const failed = await fixture.runtime.tick(now);

    expect(failed).toMatchObject({ status: "failed" });
    expect(fixture.fieldKnowledge.rollbacks).toBe(1);
    expect(fixture.workingMemory.rollbacks).toBe(1);
  });

  it("stops retrying after three failed attempts", async () => {
    let now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.error = new Error("model unavailable");

    await fixture.runtime.tick(now);
    now = new Date("2026-07-20T04:21:00.000Z");
    await fixture.runtime.tick(now);
    now = new Date("2026-07-20T04:37:00.000Z");
    const terminal = await fixture.runtime.tick(now);
    expect(terminal).toMatchObject({ status: "failed", attemptCount: 3, nextRetryAt: null });
    expect(fixture.model.calls).toBe(3);

    now = new Date("2026-07-20T05:30:00.000Z");
    await fixture.runtime.tick(now);
    expect(fixture.model.calls).toBe(3);
  });

  it("does not retry a deterministic Provider rejection", async () => {
    let now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.error = Object.assign(new Error("response schema rejected"), {
      status: 400,
      retryable: false
    });

    const failed = await fixture.runtime.tick(now);
    expect(failed).toMatchObject({ status: "failed", attemptCount: 1, nextRetryAt: null });
    expect(fixture.model.calls).toBe(1);

    now = new Date("2026-07-20T04:21:00.000Z");
    await fixture.runtime.tick(now);
    expect(fixture.model.calls).toBe(1);
  });

  it("completes with raw generated text when the model ignores the preferred JSON format", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now, memorySnapshot({
      workingRevision: "d".repeat(64)
    }));
    fixture.model.response = "梦里出现了一段没有 JSON 包装的文字。";

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({
      status: "completed",
      dreamText: "梦里出现了一段没有 JSON 包装的文字。",
      output: {
        rawOutput: "梦里出现了一段没有 JSON 包装的文字。",
        workingReviews: [
          { sourceIds: ["work-1"], action: "retain", confidence: 0 }
        ]
      }
    });
    expect(fixture.model.calls).toBe(1);
    expect(fixture.workingMemory.calls[0]?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ memoryKind: "dream", factuality: "imagined" })
    ]));
  });

  it("manually runs today's Dream before 04:00 and notifies after the durable claim", async () => {
    const now = new Date("2026-07-20T03:30:00.000Z");
    const fixture = createFixture(() => now);
    let acceptedRun: RuntimeDreamRun | undefined;
    const accepted = vi.fn(async (run: RuntimeDreamRun) => { acceptedRun = structuredClone(run); });

    const completed = await fixture.runtime.force(now, accepted);

    expect(completed).toMatchObject({ localDate: "2026-07-20", status: "completed" });
    expect(fixture.store.claimCalls[0]).toMatchObject({
      localDate: "2026-07-20",
      scheduledFor: "2026-07-20T03:30:00.000Z",
      force: true
    });
    expect(accepted).toHaveBeenCalledOnce();
    expect(acceptedRun).toMatchObject({ status: "running", attemptCount: 1 });
  });

  it("manually retries a terminal failed Dream without changing automatic retry limits", async () => {
    let now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.error = Object.assign(new Error("response schema rejected"), {
      status: 400,
      retryable: false
    });

    await fixture.runtime.tick(now);
    expect(fixture.store.getRunByLocalDate("2026-07-20")).toMatchObject({
      status: "failed",
      attemptCount: 1,
      nextRetryAt: null
    });
    fixture.model.error = undefined;
    now = new Date("2026-07-20T12:00:00.000Z");
    const accepted = vi.fn();

    const completed = await fixture.runtime.force(now, accepted);

    expect(completed).toMatchObject({ status: "completed", attemptCount: 2 });
    expect(fixture.store.claimCalls.at(-1)).toMatchObject({ force: true });
    expect(fixture.model.calls).toBe(2);
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("does not rerun or notify after today's Dream completed", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const fixture = createFixture(() => now);
    fixture.store.addRun(runRecord({
      id: "completed-today",
      localDate: "2026-07-20",
      scheduledFor: "2026-07-20T04:00:00.000Z",
      status: "completed"
    }));
    const accepted = vi.fn();

    await expect(fixture.runtime.force(now, accepted)).rejects.toMatchObject({ code: "DREAM_ALREADY_COMPLETED" });
    expect(accepted).not.toHaveBeenCalled();
    expect(fixture.store.claimCalls).toHaveLength(0);
  });

  it("fails without an automatic retry when the manual notification cannot be queued", async () => {
    const now = new Date("2026-07-20T03:30:00.000Z");
    const fixture = createFixture(() => now);
    const notificationError = Object.assign(new Error("callback queue unavailable"), {
      code: "DREAM_NOTIFICATION_FAILED",
      retryable: false
    });

    const failed = await fixture.runtime.force(now, () => Promise.reject(notificationError));

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "DREAM_NOTIFICATION_FAILED",
      nextRetryAt: null
    });
    expect(fixture.model.calls).toBe(0);
  });

  it("rejects a structured Provider response contract before the Provider call", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.prompt.responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "memory_dream",
        strict: true,
        schema: { type: "object" }
      }
    };

    const failed = await fixture.runtime.tick(now);
    expect(failed).toMatchObject({
      status: "failed",
      attemptCount: 1,
      nextRetryAt: null,
      errorCode: "DREAM_PROMPT_SCHEMA_INVALID"
    });
    expect(fixture.model.calls).toBe(0);
  });

  it("applies one evidence-backed persona adjustment through CAS", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const snapshot = memorySnapshot({
      workingRecords: [],
      longTermRecords: [
        memory("lt-1", "2026-06-01T09:00:00.000Z", "conversation", "event:1"),
        memory("lt-2", "2026-06-18T09:00:00.000Z", "shared_task", "event:2"),
        memory("lt-3", "2026-07-01T09:00:00.000Z", "conversation", "event:3")
      ]
    });
    const fixture = createFixture(() => now, snapshot);
    fixture.model.adjustment = {
      kind: "communication_preference",
      targetFile: "PREFERENCE.md",
      statement: "在复杂讨论后留出片刻整理思路。",
      evidenceMemoryIds: ["lt-1", "lt-2", "lt-3"]
    };

    const completed = await fixture.runtime.tick(now);
    expect(completed).toMatchObject({ status: "completed", personaStatus: "applied" });
    expect(fixture.persona.writes).toEqual([
      expect.objectContaining({ id: "persona.preference", revision: "preference-r1" })
    ]);
    expect(fixture.persona.content).toContain("## 缓慢形成的倾向");
    expect(fixture.persona.content).toContain("- 在复杂讨论后留出片刻整理思路。");
  });

  it("drops imagined persona evidence without blocking the Dream", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const imagined = {
      ...memory("dream-old", "2026-06-01T09:00:00.000Z", "dream", "event:dream"),
      factuality: "imagined",
      realityStatus: "imagined",
      memoryKind: "dream"
    };
    const fixture = createFixture(() => now, memorySnapshot({
      workingRecords: [],
      longTermRecords: [
        imagined,
        memory("lt-2", "2026-06-18T09:00:00.000Z", "shared_task", "event:2"),
        memory("lt-3", "2026-07-01T09:00:00.000Z", "conversation", "event:3")
      ]
    }));
    fixture.model.adjustment = {
      kind: "habit",
      targetFile: "PREFERENCE.md",
      statement: "把梦中的暗示当作稳定习惯。",
      evidenceMemoryIds: ["dream-old", "lt-2", "lt-3"]
    };

    const completed = await fixture.runtime.tick(now);
    expect(completed).toMatchObject({ status: "completed", personaStatus: "none" });
    expect(fixture.persona.writes).toHaveLength(0);
  });

  it("completes the dream with a failed persona status when CAS conflicts", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const snapshot = memorySnapshot({
      workingRecords: [],
      longTermRecords: [
        memory("lt-1", "2026-06-01T09:00:00.000Z", "conversation", "event:1"),
        memory("lt-2", "2026-06-18T09:00:00.000Z", "shared_task", "event:2"),
        memory("lt-3", "2026-07-01T09:00:00.000Z", "conversation", "event:3")
      ]
    });
    const fixture = createFixture(() => now, snapshot);
    fixture.model.adjustment = {
      kind: "habit",
      targetFile: "PREFERENCE.md",
      statement: "整理长任务时先确认仍然有效的目标。",
      evidenceMemoryIds: ["lt-1", "lt-2", "lt-3"]
    };
    fixture.persona.error = new Error("revision conflict");

    const completed = await fixture.runtime.tick(now);
    expect(completed).toMatchObject({ status: "completed", personaStatus: "failed" });
    expect(completed?.persona).toMatchObject({ error: "revision conflict" });
  });

  it("maps persisted runs to the memory-management history contract", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const fixture = createFixture(() => now);
    fixture.store.addRun(runRecord({
      id: "history-run",
      localDate: "2026-07-20",
      scheduledFor: "2026-07-20T04:00:00.000Z",
      status: "completed",
      dreamText: dreamText(),
      completedAt: "2026-07-20T04:03:00.000Z",
      personaStatus: "applied",
      result: { schemaVersion: 1, merged: 2, archived: 1, promoted: 3, discarded: 0, retained: 4 }
    }));

    expect(fixture.runtime.listHistory(30, now)).toEqual({
      items: [{
        id: "history-run",
        date: "2026-07-20",
        status: "completed",
        dreamText: dreamText(),
        scheduledFor: "2026-07-20T04:00:00.000Z",
        completedAt: "2026-07-20T04:03:00.000Z",
        personalityChanged: true,
        summary: { merged: 2, archived: 1, promoted: 3 }
      }],
      timeZone: UTC,
      nextScheduledFor: "2026-07-21T04:00:00.000Z"
    });
  });

  it("aborts an in-flight model request on stop without recording a failure", async () => {
    const now = new Date("2026-07-20T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.waitForAbort = true;

    const pending = fixture.runtime.tick(now);
    await vi.waitFor(() => expect(fixture.model.calls).toBe(1));
    fixture.runtime.stop();

    await expect(pending).resolves.toBeUndefined();
    expect(fixture.store.failedCalls).toHaveLength(0);
    expect(fixture.store.getRunByLocalDate("2026-07-20")).toMatchObject({ status: "running" });
  });
});

class FakeStore implements RuntimeDreamStorePort {
  readonly runs = new Map<string, RuntimeDreamRun>();
  readonly claimCalls: Array<Parameters<RuntimeDreamStorePort["claimDailyRun"]>[0]> = [];
  readonly commitCalls: Array<Parameters<RuntimeDreamStorePort["commitConsolidation"]>[0]> = [];
  readonly failedCalls: Array<Parameters<RuntimeDreamStorePort["markFailed"]>[0]> = [];
  commitFailures = 0;

  addRun(run: RuntimeDreamRun) {
    this.runs.set(run.localDate, run);
  }

  getRunByLocalDate(localDate: string) {
    return this.runs.get(localDate);
  }

  listRuns(input: { beforeLocalDate?: string; limit?: number } = {}) {
    return [...this.runs.values()]
      .filter((run) => !input.beforeLocalDate || run.localDate < input.beforeLocalDate)
      .sort((left, right) => right.localDate.localeCompare(left.localDate))
      .slice(0, input.limit ?? 100);
  }

  claimDailyRun(input: Parameters<RuntimeDreamStorePort["claimDailyRun"]>[0]) {
    this.claimCalls.push(input);
    const current = this.runs.get(input.localDate);
    const now = input.now ?? new Date();
    if (!current) {
      const created = runRecord({
        id: input.id ?? `run-${input.localDate}`,
        localDate: input.localDate,
        scheduledFor: input.scheduledFor,
        timeZone: input.timeZone,
        window: input.window,
        status: "running",
        workerId: input.workerId,
        leaseUntil: new Date(now.getTime() + input.leaseMs).toISOString(),
        attemptCount: 1,
        seed: input.seed,
        inputDigest: input.inputDigest,
        input: input.input,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      this.addRun(created);
      return { status: "created" as const, run: created };
    }
    const recovered = updateRun(current, {
      status: current.result ? "consolidated" : current.output ? "generated" : "running",
      workerId: input.workerId,
      leaseUntil: new Date(now.getTime() + input.leaseMs).toISOString(),
      attemptCount: current.attemptCount + 1,
      nextRetryAt: null,
      updatedAt: now.toISOString()
    });
    return { status: "recovered" as const, run: recovered };
  }

  markGenerated(input: Parameters<RuntimeDreamStorePort["markGenerated"]>[0]) {
    const run = this.find(input.runId);
    return updateRun(run, {
      status: "generated",
      output: input.output,
      dreamText: input.dreamText,
      generatedAt: (input.now ?? new Date()).toISOString()
    });
  }

  commitConsolidation(input: Parameters<RuntimeDreamStorePort["commitConsolidation"]>[0]) {
    this.commitCalls.push(input);
    if (this.commitFailures > 0) {
      this.commitFailures -= 1;
      throw new Error("commit interrupted");
    }
    const run = this.find(input.runId);
    return {
      status: "committed" as const,
      run: updateRun(run, {
        status: "consolidated",
        workingMemoryId: input.workingMemoryId,
        result: input.result,
        consolidatedAt: (input.now ?? new Date()).toISOString()
      })
    };
  }

  markPersona(input: Parameters<RuntimeDreamStorePort["markPersona"]>[0]) {
    return updateRun(this.find(input.runId), {
      personaStatus: input.status,
      persona: input.persona ?? null,
      personaUpdatedAt: (input.now ?? new Date()).toISOString()
    });
  }

  markFailed(input: Parameters<RuntimeDreamStorePort["markFailed"]>[0]) {
    this.failedCalls.push(input);
    return updateRun(this.find(input.runId), {
      status: "failed",
      workerId: null,
      leaseUntil: null,
      errorCode: input.errorCode,
      errorText: input.errorText,
      nextRetryAt: input.retryAt?.toISOString() ?? null,
      failedAt: (input.now ?? new Date()).toISOString()
    });
  }

  complete(input: Parameters<RuntimeDreamStorePort["complete"]>[0]) {
    return updateRun(this.find(input.runId), {
      status: "completed",
      workerId: null,
      leaseUntil: null,
      completedAt: (input.now ?? new Date()).toISOString()
    });
  }

  private find(id: string) {
    const run = [...this.runs.values()].find((item) => item.id === id);
    if (!run) throw new Error(`missing run ${id}`);
    return run;
  }
}

class FakeContext implements RuntimeDreamContextPort {
  readonly captureCalls: Array<Parameters<RuntimeDreamContextPort["capture"]>[0]> = [];

  constructor(private readonly snapshot: RuntimeDreamContextSnapshot) {}

  async capture(input: Parameters<RuntimeDreamContextPort["capture"]>[0]) {
    this.captureCalls.push(input);
    return structuredClone(this.snapshot);
  }
}

class FakeModel implements RuntimeDreamModelPort {
  calls = 0;
  readonly requests: unknown[] = [];
  error?: Error;
  response?: string;
  waitForAbort = false;
  adjustment: DreamPersonaAdjustmentV1 | null = null;
  fieldKnowledge: DreamFieldKnowledgeV1 | null = null;
  fieldKnowledgeFactory?: (payload: Record<string, unknown>) => DreamFieldKnowledgeV1 | null;

  async complete(request: unknown, options: Parameters<RuntimeDreamModelPort["complete"]>[1]) {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    if (this.error) throw this.error;
    if (this.response != null) return this.response;
    if (this.waitForAbort) {
      return new Promise<string>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    }
    const variables = request as Record<string, unknown>;
    const payload = variables[DREAM_PAYLOAD_VARIABLE] as Record<string, unknown>;
    const workingIds = promptIds(payload.workingMemories);
    const longTermIds = promptIds(payload.longTermMemories);
    return JSON.stringify({
      schemaVersion: 1,
      dream: { text: dreamText(), factuality: "imagined" },
      longTermReviews: longTermIds.map((id) => ({
        sourceIds: [id],
        action: "retain",
        canonical: null,
        importance: 0.7,
        futureRelevance: 0.5,
        emotionalSalience: 0.4,
        confidence: 0.9,
        reason: "仍有清晰意义"
      })),
      workingReviews: workingIds.map((id) => ({
        sourceIds: [id],
        action: "retain",
        canonical: null,
        confidence: 1,
        reason: "仍有清晰意义"
      })),
      fieldKnowledge: this.fieldKnowledgeFactory?.(payload) ?? this.fieldKnowledge,
      personaAdjustment: this.adjustment
    });
  }
}

class FakePersona implements RuntimeDreamPersonaPort {
  content = "保持清楚、温和的表达。\n";
  readonly writes: Array<Parameters<RuntimeDreamPersonaPort["compareAndSwap"]>[0]> = [];
  error?: Error;

  async read(id: "persona.preference" | "persona.relation") {
    return { content: this.content, revision: id === "persona.preference" ? "preference-r1" : "relation-r1" };
  }

  async compareAndSwap(input: Parameters<RuntimeDreamPersonaPort["compareAndSwap"]>[0]) {
    this.writes.push(input);
    if (this.error) throw this.error;
    this.content = input.content;
  }
}

class FakeWorkingMemory implements RuntimeDreamWorkingMemoryPort {
  readonly calls: Array<Parameters<RuntimeDreamWorkingMemoryPort["compareAndSwap"]>[0]> = [];
  conflict = false;
  rollbacks = 0;

  async compareAndSwap(input: Parameters<RuntimeDreamWorkingMemoryPort["compareAndSwap"]>[0]) {
    this.calls.push(structuredClone(input));
    if (this.conflict) {
      return { status: "conflict" as const, revision: "e".repeat(64) };
    }
    return {
      status: "updated" as const,
      revision: "f".repeat(64),
      rollback: async () => {
        this.rollbacks += 1;
        return true;
      }
    };
  }
}

class FakeFieldKnowledge implements RuntimeDreamFieldKnowledgePort {
  readonly calls: Array<Parameters<RuntimeDreamFieldKnowledgePort["compareAndSwap"]>[0]> = [];
  conflict = false;
  rollbacks = 0;

  async compareAndSwap(input: Parameters<RuntimeDreamFieldKnowledgePort["compareAndSwap"]>[0]) {
    this.calls.push(structuredClone(input));
    if (this.conflict) {
      return { status: "conflict" as const, revision: "f".repeat(64) };
    }
    return {
      status: "updated" as const,
      revision: "1".repeat(64),
      rollback: async () => {
        this.rollbacks += 1;
        return true;
      }
    };
  }
}

function createFixture(
  clock: () => Date,
  snapshot = memorySnapshot(),
  selection?: () => DreamMemorySelectionSettings
) {
  const store = new FakeStore();
  const context = new FakeContext(snapshot);
  const model = new FakeModel();
  const persona = new FakePersona();
  const workingMemory = new FakeWorkingMemory();
  const fieldKnowledge = new FakeFieldKnowledge();
  const prompt = {
    responseFormat: { type: "text" } as Record<string, unknown>,
    async render(_id: string, variables: Readonly<Record<string, unknown>>) {
      return { ...variables, response_format: this.responseFormat };
    }
  };
  const runtime = new RuntimeDreams({
    store,
    context,
    workingMemory,
    fieldKnowledge,
    prompt,
    model,
    persona,
    ...(selection ? { selection } : {}),
    agentId: "plana",
    timeZone: UTC,
    workerId: "dream-worker",
    seedFactory: () => "fixed-random-seed",
    clock,
    retryDelayMs: 15 * 60_000
  });
  return {
    runtime,
    store,
    context,
    model,
    persona,
    workingMemory,
    fieldKnowledge,
    prompt
  };
}

function memorySnapshot(overrides: Partial<RuntimeDreamContextSnapshot> = {}): RuntimeDreamContextSnapshot {
  return {
    workingRecords: [memory("work-1", "2026-07-19T18:00:00.000Z", "conversation", "event:work")],
    longTermRecords: [memory("long-1", "2026-02-01T09:00:00.000Z", "relationship", "event:long")],
    workingDigest: WORKING_DIGEST,
    fieldKnowledgeRevision: "e".repeat(64),
    longTermDigest: LONG_TERM_DIGEST,
    recallStats: [],
    userProfiles: [{ id: "profile-1", fact: "用户喜欢有条理的讨论。" }],
    recentConversations: [{ id: "conversation-1", text: "今天完成了一个长期任务。" }],
    activeTasks: [{ id: "task-1", title: "整理书架" }],
    plannedDailySchedule: { date: "2026-07-19", summary: "阅读与散步" },
    persona: {
      preference: "表达清楚",
      relation: "重视长期相处",
      air: "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n- 发布前需要双人复核。"
    },
    ...overrides
  };
}

function memory(id: string, occurredAt: string, eventType: string, eventKey: string): DreamMemoryRecord {
  return {
    schemaVersion: 2,
    id,
    fact: `${id} 对应的一段真实记忆。`,
    source: "test",
    factuality: "factual",
    realityStatus: "factual",
    occurredAt,
    createdAt: occurredAt,
    eventType,
    eventKey,
    conversationId: `context:${eventType}`,
    subjectKey: id,
    importance: 0.8,
    userIds: []
  };
}

function promptIds(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String((item as { id: string }).id))
    : [];
}

function dreamText() {
  const source = "我梦见清晨的车站漂在安静海面上，昨天讨论过的书架变成一排会发光的门，我沿着旧记忆留下的脚印前行，远处有人把尚未完成的清单折成纸船，潮水把熟悉的声音和久远的场景轻轻推到一起。".repeat(3);
  return [...source].slice(0, 190).join("");
}

function updateRun(run: RuntimeDreamRun, patch: Partial<RuntimeDreamRun>) {
  const next = { ...run, ...patch };
  Object.assign(run, next);
  return run;
}

function runRecord(patch: Partial<RuntimeDreamRun> & Pick<RuntimeDreamRun, "id" | "localDate" | "scheduledFor" | "status">): RuntimeDreamRun {
  return {
    id: patch.id,
    localDate: patch.localDate,
    scheduledFor: patch.scheduledFor,
    timeZone: UTC,
    window: {
      start: new Date(Date.parse(patch.scheduledFor) - 24 * 60 * 60_000).toISOString(),
      end: patch.scheduledFor
    },
    status: patch.status,
    workerId: null,
    leaseUntil: null,
    attemptCount: 1,
    seed: "seed",
    inputDigest: "c".repeat(64),
    input: {},
    output: null,
    dreamText: null,
    workingMemoryId: null,
    persona: null,
    personaStatus: "pending",
    result: null,
    errorCode: null,
    errorText: null,
    nextRetryAt: null,
    createdAt: patch.scheduledFor,
    updatedAt: patch.scheduledFor,
    generatedAt: null,
    consolidatedAt: null,
    personaUpdatedAt: null,
    completedAt: patch.status === "completed" ? patch.scheduledFor : null,
    failedAt: null,
    ...patch
  };
}
