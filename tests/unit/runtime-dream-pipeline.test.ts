// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DREAM_PAYLOAD_VARIABLE,
  type DreamMemoryRecord
} from "../../services/memory/dream/public.js";
import {
  RuntimeDreams,
  type RuntimeDreamContextPort,
  type RuntimeDreamContextSnapshot,
  type RuntimeDreamLogPort,
  type RuntimeDreamModelPort,
  type RuntimeDreamRun,
  type RuntimeDreamStorePort,
  type RuntimeDreamWorkingMemoryPort
} from "../../src/runtime/dreamPipeline.js";

const UTC = "UTC";
const WORKING_DIGEST = "a".repeat(64);
const LONG_TERM_DIGEST = "b".repeat(64);

describe("RuntimeDreams minimal pipeline", () => {
  afterEach(() => vi.useRealTimers());

  it("runs the three ordered stages and completes without archive, AIR, or persona output", async () => {
    const now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({ status: "completed", personaStatus: "none" });
    expect(fixture.model.calls).toBe(1);
    expect(fixture.store.generatedCalls).toHaveLength(1);
    expect(Object.keys(fixture.store.generatedCalls[0]!.output)).toEqual([
      "workingMemoryCompression",
      "longTermMemoryAdditions",
      "dreamDescription"
    ]);
    expect(fixture.workingMemory.calls).toHaveLength(1);
    expect(fixture.workingMemory.calls[0]!.content)
      .toBe("自动回归全部通过后才能确认发布完成。");
    expect(fixture.store.commitCalls).toHaveLength(1);
    expect(fixture.store.commitCalls[0]).toMatchObject({
      archives: [],
      recallLineages: [],
      reviews: [],
      externalWorkingMemory: true,
      workingMemoryId: null
    });
    expect(fixture.store.commitCalls[0]!.longTerm).toEqual(expect.arrayContaining([
      {
        id: "long_existing",
        fact: "发布必须保留可回滚版本。",
        source: "admin",
        factuality: "fact"
      },
      expect.objectContaining({
        fact: "每次发布都必须等自动回归全部通过后才能确认完成。",
        sourceWorkingMemoryIds: []
      })
    ]));
    expect(fixture.store.commitCalls[0]!.result).toMatchObject({
      workingMemoryCompression: { reducedBy: 1 },
      longTermMemoryAdditions: { added: 1 }
    });
    expect(fixture.store.commitCalls[0]!.result.longTermMemoryAdditions).not.toHaveProperty("reason");
    expect(fixture.store.commitCalls[0]!.result.longTermMemoryAdditions).not.toHaveProperty("reasonCode");
  });

  it("allows zero additions without persisting visible decision metadata", async () => {
    const now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.zeroAddition = true;

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({ status: "completed" });
    expect(fixture.store.commitCalls[0]!.longTerm).toEqual([
      expect.objectContaining({ id: "long_existing" })
    ]);
    expect(fixture.store.commitCalls[0]!.result).toMatchObject({
      longTermMemoryAdditions: {
        requested: 0,
        added: 0
      }
    });
    expect(fixture.store.commitCalls[0]!.result.longTermMemoryAdditions).not.toHaveProperty("reason");
    expect(fixture.store.commitCalls[0]!.result.longTermMemoryAdditions).not.toHaveProperty("reasonCode");
  });

  it("manually reruns a completed Dream on the same local date with a fresh snapshot", async () => {
    let now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);

    await expect(fixture.runtime.tick(now)).resolves.toMatchObject({ status: "completed" });
    now = new Date("2026-08-04T12:30:00.000Z");
    const accepted: RuntimeDreamRun[] = [];

    await expect(fixture.runtime.force(now, (run) => {
      accepted.push(structuredClone(run));
    })).resolves.toMatchObject({ status: "completed", scheduledFor: now.toISOString() });

    expect(fixture.context.calls).toBe(2);
    expect(fixture.model.calls).toBe(2);
    expect(fixture.store.claimCalls).toHaveLength(2);
    expect(fixture.store.claimCalls[1]).toMatchObject({
      force: true,
      localDate: "2026-08-04",
      scheduledFor: now.toISOString()
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ status: "running", attemptCount: 1 });
  });

  it("keeps an active Dream lease protected from a concurrent manual trigger", async () => {
    const now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.waitForAbort = true;

    const pending = fixture.runtime.tick(now);
    await vi.waitFor(() => expect(fixture.model.calls).toBe(1));

    await expect(fixture.runtime.force(now)).rejects.toMatchObject({ code: "DREAM_BUSY" });
    fixture.runtime.stop();
    await expect(pending).resolves.toBeUndefined();
  });

  it("treats working-memory revision drift as a soft link and still commits add-only SQLite data", async () => {
    const now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.workingMemory.conflict = true;

    const completed = await fixture.runtime.tick(now);

    expect(completed).toMatchObject({ status: "completed" });
    expect(fixture.store.commitCalls).toHaveLength(1);
    expect(fixture.store.commitCalls[0]!.externalWorkingMemory).toBe(true);
    expect(fixture.workingMemory.rollbacks).toBe(0);
  });

  it("rolls back the working-memory write when the long-term snapshot conflicts", async () => {
    const now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.store.commitResult = "snapshot_conflict";

    const failed = await fixture.runtime.tick(now);

    expect(failed).toMatchObject({ status: "failed", errorCode: "DREAM_SNAPSHOT_CONFLICT" });
    expect(fixture.workingMemory.rollbacks).toBe(1);
  });

  it("rejects malformed output before markGenerated and stops automatic retry after three attempts", async () => {
    let now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.response = "not-json";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await fixture.runtime.tick(now);
      expect(failed).toMatchObject({
        status: "failed",
        attemptCount: attempt,
        errorCode: "DREAM_OUTPUT_CONTRACT_INVALID"
      });
      now = new Date(now.getTime() + 15 * 60_000 + 1);
    }

    expect(fixture.model.calls).toBe(3);
    expect(fixture.store.generatedCalls).toHaveLength(0);
    expect(fixture.store.commitCalls).toHaveLength(0);
    expect(fixture.store.failedCalls.at(-1)?.retryAt).toBeNull();
  });

  it("aborts an in-flight model request on stop without recording a failure", async () => {
    const now = new Date("2026-08-04T04:05:00.000Z");
    const fixture = createFixture(() => now);
    fixture.model.waitForAbort = true;

    const pending = fixture.runtime.tick(now);
    await vi.waitFor(() => expect(fixture.model.calls).toBe(1));
    fixture.runtime.stop();

    await expect(pending).resolves.toBeUndefined();
    expect(fixture.model.lastSignal?.aborted).toBe(true);
    expect(fixture.store.failedCalls).toHaveLength(0);
    expect(fixture.store.commitCalls).toHaveLength(0);
  });
});

class FakeStore implements RuntimeDreamStorePort {
  readonly runs = new Map<string, RuntimeDreamRun>();
  readonly claimCalls: Array<Parameters<RuntimeDreamStorePort["claimDailyRun"]>[0]> = [];
  readonly generatedCalls: Array<Parameters<RuntimeDreamStorePort["markGenerated"]>[0]> = [];
  readonly commitCalls: Array<Parameters<RuntimeDreamStorePort["commitConsolidation"]>[0]> = [];
  readonly failedCalls: Array<Parameters<RuntimeDreamStorePort["markFailed"]>[0]> = [];
  commitResult: "committed" | "snapshot_conflict" = "committed";

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
      this.runs.set(created.localDate, created);
      return { status: "created" as const, run: created };
    }
    if (current.status === "completed" && input.force) {
      const restarted = updateRun(current, {
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
        output: null,
        dreamText: null,
        workingMemoryId: null,
        persona: null,
        personaStatus: "pending",
        result: null,
        errorCode: null,
        errorText: null,
        nextRetryAt: null,
        generatedAt: null,
        consolidatedAt: null,
        personaUpdatedAt: null,
        completedAt: null,
        failedAt: null,
        updatedAt: now.toISOString()
      });
      return { status: "recovered" as const, run: restarted };
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
    this.generatedCalls.push(structuredClone(input));
    return updateRun(this.find(input.runId), {
      status: "generated",
      output: input.output,
      dreamText: input.dreamText,
      generatedAt: (input.now ?? new Date()).toISOString()
    });
  }

  commitConsolidation(input: Parameters<RuntimeDreamStorePort["commitConsolidation"]>[0]) {
    this.commitCalls.push(structuredClone(input));
    if (this.commitResult === "snapshot_conflict") {
      return {
        status: "snapshot_conflict" as const,
        sources: ["long_term" as const]
      };
    }
    return {
      status: "committed" as const,
      run: updateRun(this.find(input.runId), {
        status: "consolidated",
        personaStatus: "none",
        persona: null,
        workingMemoryId: input.workingMemoryId,
        result: input.result,
        consolidatedAt: (input.now ?? new Date()).toISOString()
      })
    };
  }

  markFailed(input: Parameters<RuntimeDreamStorePort["markFailed"]>[0]) {
    this.failedCalls.push(input);
    return updateRun(this.find(input.runId), {
      status: "failed",
      workerId: null,
      leaseUntil: null,
      ...(input.resetGeneratedOutput ? {
        output: null,
        dreamText: null,
        generatedAt: null
      } : {}),
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
  calls = 0;

  constructor(private readonly snapshot: RuntimeDreamContextSnapshot) {}

  async capture() {
    this.calls += 1;
    return structuredClone(this.snapshot);
  }
}

class FakeModel implements RuntimeDreamModelPort {
  calls = 0;
  response?: string;
  zeroAddition = false;
  waitForAbort = false;
  lastSignal?: AbortSignal;

  async complete(request: unknown, options: Parameters<RuntimeDreamModelPort["complete"]>[1]) {
    this.calls += 1;
    this.lastSignal = options.signal;
    if (this.response != null) return this.response;
    if (this.waitForAbort) {
      return new Promise<string>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("The operation was aborted"), {
          name: "AbortError"
        }));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      });
    }
    const payload = (request as Record<string, unknown>)[DREAM_PAYLOAD_VARIABLE] as Record<string, unknown>;
    const workingMemory = typeof payload.workingMemory === "string" ? payload.workingMemory : "";
    return JSON.stringify({
      workingMemoryCompression: workingMemory
        ? "自动回归全部通过后才能确认发布完成。"
        : "",
      longTermMemoryAdditions: this.zeroAddition || !workingMemory
        ? []
        : ["每次发布都必须等自动回归全部通过后才能确认完成。"],
      dreamDescription: "我梦见测试灯逐盏亮起，最后一盏亮起后，写着完成的门才打开。"
    });
  }
}

class FakeWorkingMemory implements RuntimeDreamWorkingMemoryPort {
  readonly calls: Array<Parameters<RuntimeDreamWorkingMemoryPort["compareAndSwap"]>[0]> = [];
  conflict = false;
  rollbacks = 0;

  async compareAndSwap(input: Parameters<RuntimeDreamWorkingMemoryPort["compareAndSwap"]>[0]) {
    this.calls.push(structuredClone(input));
    if (this.conflict) return { status: "conflict" as const, revision: "e".repeat(64) };
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

function createFixture(clock: () => Date) {
  const store = new FakeStore();
  const context = new FakeContext(memorySnapshot());
  const model = new FakeModel();
  const workingMemory = new FakeWorkingMemory();
  const logs: Array<Parameters<RuntimeDreamLogPort["write"]>[0]> = [];
  const runtime = new RuntimeDreams({
    store,
    context,
    workingMemory,
    prompt: {
      async render(_id, variables) {
        return { ...variables, response_format: { type: "text" } };
      }
    },
    model,
    log: { write: (event) => logs.push(structuredClone(event)) },
    agentId: "plana",
    timeZone: UTC,
    workerId: "dream-worker",
    seedFactory: () => "fixed-random-seed",
    clock,
    retryDelayMs: 15 * 60_000
  });
  return { runtime, store, context, model, workingMemory, logs };
}

function memorySnapshot(): RuntimeDreamContextSnapshot {
  return {
    workingMemory: [
      "自动回归未全部通过时不能确认发布完成。",
      "只有自动回归全部通过，发布才能标记完成。"
    ].join("\n\n"),
    workingRecords: [
      memory("working_a", "自动回归未全部通过时不能确认发布完成。"),
      memory("working_b", "只有自动回归全部通过，发布才能标记完成。")
    ],
    longTermRecords: [{
      ...memory("long_existing", "发布必须保留可回滚版本。"),
      source: "admin"
    }],
    storedLongTermRecords: [{
      id: "long_existing",
      fact: "发布必须保留可回滚版本。",
      source: "admin",
      factuality: "fact"
    }],
    workingDigest: WORKING_DIGEST,
    workingRevision: "d".repeat(64),
    longTermDigest: LONG_TERM_DIGEST,
    recallStats: [],
    userProfiles: [],
    recentConversations: [],
    activeTasks: [],
    plannedDailySchedule: null,
    persona: { soul: "保持事实和梦境边界。" }
  };
}

function memory(id: string, fact: string): DreamMemoryRecord {
  return {
    schemaVersion: 2,
    id,
    fact,
    source: "test",
    factuality: "factual",
    realityStatus: "factual",
    occurredAt: "2026-08-03T08:00:00.000Z",
    createdAt: "2026-08-03T08:00:00.000Z",
    eventType: "release_rule",
    eventKey: "release:completion-gate",
    causalChainKey: "causal:release-tests",
    conversationId: "private:99112233",
    subjectKey: "release",
    userIds: ["99112233"],
    addressNames: ["老师"]
  };
}

function updateRun(run: RuntimeDreamRun, patch: Partial<RuntimeDreamRun>) {
  Object.assign(run, patch);
  return run;
}

function runRecord(
  patch: Partial<RuntimeDreamRun>
    & Pick<RuntimeDreamRun, "id" | "localDate" | "scheduledFor" | "status">
): RuntimeDreamRun {
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
