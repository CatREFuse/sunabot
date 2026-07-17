// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SkillActivationService } from "../../services/extensions/skillActivation.js";
import type { AgentSkillRecord } from "../../packages/contracts/extensions/agentExtensions.js";

describe("Skill activation", () => {
  it("returns instructions and a bounded resource listing without reading resources, then de-duplicates", async () => {
    const record = skill();
    const reader = { read: vi.fn(async () => ({
      digestSha256: record.digestSha256,
      instructions: "Follow the protected workflow.",
      resources: [{ path: "references/guide.md", bytes: 12, sha256: "b".repeat(64) }]
    })) };
    const service = new SkillActivationService(reader);
    const first = await service.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, skills: [record]
    });
    const second = await service.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: record.id, skills: [record]
    });
    expect(first).toMatchObject({
      virtualDirectory: "/skills/test-skill",
      instructions: "Follow the protected workflow.",
      alreadyActivated: false
    });
    expect(first.resources).toEqual([{ path: "references/guide.md", bytes: 12, sha256: "b".repeat(64) }]);
    expect(second.alreadyActivated).toBe(true);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(service.protectedInstructions("agent-a", "private:1")).toEqual([
      expect.objectContaining({ protected: true, skillId: "test-skill" })
    ]);
  });

  it("singleflights concurrent activation of the same Skill", async () => {
    const record = namedSkill("single-skill", 1);
    const gate = deferred<ReturnType<typeof activationRead>>();
    const reader = { read: vi.fn(() => gate.promise) };
    const service = new SkillActivationService(reader);
    const request = {
      agentId: "agent-a", conversationId: "private:single", skillId: record.id, skills: [record]
    };
    const first = service.activate(request);
    const second = service.activate(request);
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1));
    gate.resolve(activationRead(record, "Singleflight instructions."));
    await expect(first).resolves.toMatchObject({ skillId: record.id, alreadyActivated: false });
    await expect(second).resolves.toMatchObject({ skillId: record.id, alreadyActivated: true });
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(service.protectedInstructions("agent-a", "private:single")).toHaveLength(1);
  });

  it("serializes different Skill activation reads within one conversation", async () => {
    const firstRecord = namedSkill("first-skill", 2);
    const secondRecord = namedSkill("second-skill", 3);
    const firstGate = deferred<ReturnType<typeof activationRead>>();
    const secondGate = deferred<ReturnType<typeof activationRead>>();
    const reader = { read: vi.fn((input: { skillId: string }) =>
      input.skillId === firstRecord.id ? firstGate.promise : secondGate.promise) };
    const service = new SkillActivationService(reader);
    const first = service.activate({
      agentId: "agent-a", conversationId: "private:serialized",
      skillId: firstRecord.id, skills: [firstRecord, secondRecord]
    });
    const second = service.activate({
      agentId: "agent-a", conversationId: "private:serialized",
      skillId: secondRecord.id, skills: [firstRecord, secondRecord]
    });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1));
    expect(reader.read).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: firstRecord.id }));
    firstGate.resolve(activationRead(firstRecord, "First instructions."));
    await expect(first).resolves.toMatchObject({ skillId: firstRecord.id });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    expect(reader.read).toHaveBeenLastCalledWith(expect.objectContaining({ skillId: secondRecord.id }));
    secondGate.resolve(activationRead(secondRecord, "Second instructions."));
    await expect(second).resolves.toMatchObject({ skillId: secondRecord.id });
    expect(service.protectedInstructions("agent-a", "private:serialized").map((entry) => entry.skillId))
      .toEqual([firstRecord.id, secondRecord.id]);
  });

  it("does not let a slow activation reader block another Agent or conversation", async () => {
    const slowRecord = namedSkill("slow-skill", 4);
    const fastRecord = namedSkill("fast-skill", 5);
    const slowGate = deferred<ReturnType<typeof activationRead>>();
    const fastGate = deferred<ReturnType<typeof activationRead>>();
    const reader = { read: vi.fn((input: { skillId: string }) =>
      input.skillId === slowRecord.id ? slowGate.promise : fastGate.promise) };
    const service = new SkillActivationService(reader);
    const slow = service.activate({
      agentId: "agent-a", conversationId: "private:slow",
      skillId: slowRecord.id, skills: [slowRecord]
    });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1));

    const fast = service.activate({
      agentId: "agent-b", conversationId: "private:fast",
      skillId: fastRecord.id, skills: [fastRecord]
    });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    fastGate.resolve(activationRead(fastRecord, "Fast instructions."));
    await expect(fast).resolves.toMatchObject({ skillId: fastRecord.id });

    slowGate.resolve(activationRead(slowRecord, "Slow instructions."));
    await expect(slow).resolves.toMatchObject({ skillId: slowRecord.id });
  });

  it("cannot cross the 32-Skill limit with concurrent activation", async () => {
    const records = Array.from({ length: 33 }, (_, index) => namedSkill(`limit-${index}`, index + 10));
    const reader = { read: vi.fn(async (input: { skillId: string; expectedDigestSha256: string }) => ({
      digestSha256: input.expectedDigestSha256,
      instructions: `Instructions for ${input.skillId}.`,
      resources: []
    })) };
    const service = new SkillActivationService(reader);
    for (const record of records.slice(0, 31)) {
      await service.activate({
        agentId: "agent-a", conversationId: "private:limit", skillId: record.id, skills: records
      });
    }
    const [accepted, rejected] = await Promise.allSettled(records.slice(31).map((record) => service.activate({
      agentId: "agent-a", conversationId: "private:limit", skillId: record.id, skills: records
    })));
    expect(accepted.status).toBe("fulfilled");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "SKILL_SESSION_LIMIT" }) });
    expect(reader.read).toHaveBeenCalledTimes(32);
    expect(service.protectedInstructions("agent-a", "private:limit")).toHaveLength(32);
  });

  it("cannot cross the 256 KiB context budget with concurrent activation", async () => {
    const records = Array.from({ length: 5 }, (_, index) => namedSkill(`budget-${index}`, index + 100));
    const instructions = new Map(records.map((record, index) => [
      record.id,
      "x".repeat(index < 3 ? 55_000 : 50_000)
    ]));
    const reader = { read: vi.fn(async (input: { skillId: string; expectedDigestSha256: string }) => ({
      digestSha256: input.expectedDigestSha256,
      instructions: instructions.get(input.skillId)!,
      resources: []
    })) };
    const service = new SkillActivationService(reader);
    for (const record of records.slice(0, 3)) {
      await service.activate({
        agentId: "agent-a", conversationId: "private:budget", skillId: record.id, skills: records
      });
    }
    const [accepted, rejected] = await Promise.allSettled(records.slice(3).map((record) => service.activate({
      agentId: "agent-a", conversationId: "private:budget", skillId: record.id, skills: records
    })));
    expect(accepted.status).toBe("fulfilled");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "SKILL_CONTEXT_BUDGET_EXCEEDED" })
    });
    expect(service.protectedInstructions("agent-a", "private:budget")).toHaveLength(4);
  });

  it("admits only one of two concurrent conversations at the 128-session boundary", async () => {
    const record = namedSkill("capacity-skill", 200);
    const reader = { read: vi.fn(async () => activationRead(record, "Capacity instructions.")) };
    const service = new SkillActivationService(reader);
    for (let index = 0; index < 127; index += 1) {
      await service.activate({
        agentId: "agent-a", conversationId: `private:capacity-${index}`,
        skillId: record.id, skills: [record]
      });
    }
    const results = await Promise.allSettled([127, 128].map((index) => service.activate({
      agentId: "agent-a", conversationId: `private:capacity-${index}`,
      skillId: record.id, skills: [record]
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ message: "SKILL_CONVERSATION_LIMIT" }) })
    ]);
    expect(reader.read).toHaveBeenCalledTimes(128);
    expect(service.protectedInstructions("agent-a", "private:capacity-0")).toHaveLength(1);
  });

  it("counts an in-flight placeholder toward capacity and recycles it after activation failure", async () => {
    const successRecord = namedSkill("recycle-success", 201);
    const failureRecord = namedSkill("recycle-failure", 202);
    const failureGate = deferred<ReturnType<typeof activationRead>>();
    const reader = { read: vi.fn((input: { skillId: string }) => {
      if (input.skillId === failureRecord.id) return failureGate.promise;
      return Promise.resolve(activationRead(successRecord, "Recyclable instructions."));
    }) };
    const service = new SkillActivationService(reader);
    for (let index = 0; index < 127; index += 1) {
      await service.activate({
        agentId: "agent-a", conversationId: `private:recycle-${index}`,
        skillId: successRecord.id, skills: [successRecord]
      });
    }

    const failing = service.activate({
      agentId: "agent-a", conversationId: "private:recycle-failing",
      skillId: failureRecord.id, skills: [failureRecord]
    });
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(128));
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:recycle-after",
      skillId: successRecord.id, skills: [successRecord]
    })).rejects.toThrow("SKILL_CONVERSATION_LIMIT");
    expect(reader.read).toHaveBeenCalledTimes(128);

    failureGate.resolve({
      ...activationRead(failureRecord, "Invalid instructions."),
      digestSha256: "f".repeat(64)
    });
    await expect(failing).rejects.toThrow("SKILL_RUNTIME_INVALID");
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:recycle-after",
      skillId: successRecord.id, skills: [successRecord]
    })).resolves.toMatchObject({ skillId: successRecord.id });
    expect(reader.read).toHaveBeenCalledTimes(129);
  });

  it("fails closed for forged, disabled, unreviewed, digest-changed and unsafe resource inputs", async () => {
    const approved = skill();
    const reader = { read: vi.fn(async () => ({
      digestSha256: "f".repeat(64),
      instructions: "unsafe",
      resources: []
    })) };
    const service = new SkillActivationService(reader);
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: "forged", skills: [approved]
    })).rejects.toThrow("SKILL_UNAVAILABLE");
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: approved.id,
      skills: [{ ...approved, enabled: false }]
    })).rejects.toThrow("SKILL_UNAVAILABLE");
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:1", skillId: approved.id,
      skills: [{ ...approved, riskEvidence: { ...approved.riskEvidence, reviewStatus: "unreviewed", reviewedDigestSha256: null } }]
    })).rejects.toThrow("SKILL_UNAVAILABLE");
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:2", skillId: approved.id, skills: [approved]
    })).rejects.toThrow("SKILL_RUNTIME_INVALID");
  });

  it("fails closed at conversation capacity without evicting protected state or an active script", async () => {
    const record = scriptSkill();
    const reader = { read: vi.fn(async () => ({
      digestSha256: record.digestSha256,
      instructions: "Run the audited helper.",
      resources: [{ path: "scripts/run.sh", bytes: 8, sha256: "b".repeat(64) }]
    })) };
    const execution = deferred<unknown>();
    let executionSignal: AbortSignal | undefined;
    const executor = { run: vi.fn((input: { signal?: AbortSignal }) => {
      executionSignal = input.signal;
      return execution.promise;
    }) };
    const service = new SkillActivationService(reader, executor);
    await service.activate({
      agentId: "agent-a", conversationId: "private:0", skillId: record.id, skills: [record]
    });
    const running = service.runScript({
      agentId: "agent-a",
      conversationId: "private:0",
      skillId: record.id,
      path: "scripts/run.sh",
      args: ["--safe"]
    });
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    expect(executor.run).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-a",
      conversationId: "private:0",
      expectedDigestSha256: record.digestSha256,
      resource: { path: "scripts/run.sh", bytes: 8, sha256: "b".repeat(64) },
      args: ["--safe"]
    }));

    for (let index = 1; index < 128; index += 1) {
      await service.activate({
        agentId: "agent-a", conversationId: `private:${index}`, skillId: record.id, skills: [record]
      });
    }
    await expect(service.activate({
      agentId: "agent-a", conversationId: "private:128", skillId: record.id, skills: [record]
    })).rejects.toThrow("SKILL_CONVERSATION_LIMIT");
    expect(executionSignal?.aborted).toBe(false);
    expect(service.protectedInstructions("agent-a", "private:0")).toEqual([
      expect.objectContaining({ protected: true, skillId: record.id })
    ]);
    execution.resolve({ ok: true, stdout: "done" });
    await expect(running).resolves.toEqual({ ok: true, stdout: "done" });
    await service.clearConversation("agent-a", "private:127");
    expect(service.protectedInstructions("agent-a", "private:127")).toEqual([]);
  });

  it("aborts and awaits only matching active scripts before clearing lifecycle state", async () => {
    const record = scriptSkill();
    const reader = scriptReader(record);
    const signals = new Map<string, AbortSignal>();
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    const executor = { run: vi.fn((input: { conversationId: string; signal?: AbortSignal }) => {
      signals.set(input.conversationId, input.signal!);
      const gate = deferred<unknown>();
      gates.set(input.conversationId, gate);
      input.signal?.addEventListener("abort", () => gate.reject(new Error("SKILL_SCRIPT_ABORTED")), { once: true });
      return gate.promise;
    }) };
    const service = new SkillActivationService(reader, executor);
    await Promise.all([
      service.activate({ agentId: "agent-a", conversationId: "private:a", skillId: record.id, skills: [record] }),
      service.activate({ agentId: "agent-b", conversationId: "private:b", skillId: record.id, skills: [record] })
    ]);
    const runA = service.runScript({
      agentId: "agent-a", conversationId: "private:a", skillId: record.id,
      path: "scripts/run.sh", args: []
    });
    const runB = service.runScript({
      agentId: "agent-b", conversationId: "private:b", skillId: record.id,
      path: "scripts/run.sh", args: []
    });
    await vi.waitFor(() => expect(signals.size).toBe(2));

    await expect(service.clearAgent("agent-a")).resolves.toBeUndefined();
    await expect(runA).rejects.toThrow("SKILL_SCRIPT_ABORTED");
    expect(signals.get("private:a")?.aborted).toBe(true);
    expect(signals.get("private:b")?.aborted).toBe(false);
    gates.get("private:b")?.resolve({ ok: true });
    await expect(runB).resolves.toEqual({ ok: true });
  });

  it("drops a late successful script result after conversation close aborts the execution", async () => {
    const record = scriptSkill();
    const gate = deferred<unknown>();
    let executionSignal: AbortSignal | undefined;
    const service = new SkillActivationService(scriptReader(record), {
      run: vi.fn((input: { signal?: AbortSignal }) => {
        executionSignal = input.signal;
        return gate.promise;
      })
    });
    await service.activate({
      agentId: "agent-a", conversationId: "private:late", skillId: record.id, skills: [record]
    });
    const running = service.runScript({
      agentId: "agent-a", conversationId: "private:late", skillId: record.id,
      path: "scripts/run.sh", args: []
    });
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    const closing = service.clearConversation("agent-a", "private:late");
    expect(executionSignal?.aborted).toBe(true);
    gate.resolve({ ok: true, stdout: "late" });
    await expect(closing).resolves.toBeUndefined();
    await expect(running).rejects.toThrow("SKILL_SCRIPT_ABORTED");
    expect(service.protectedInstructions("agent-a", "private:late")).toEqual([]);
  });
});

function scriptReader(record: AgentSkillRecord) {
  return { read: vi.fn(async () => ({
    digestSha256: record.digestSha256,
    instructions: "Run the audited helper.",
    resources: [{ path: "scripts/run.sh", bytes: 8, sha256: "b".repeat(64) }]
  })) };
}

function activationRead(record: AgentSkillRecord, instructions: string) {
  return {
    digestSha256: record.digestSha256,
    instructions,
    resources: []
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function skill(): AgentSkillRecord {
  const digest = "a".repeat(64);
  return {
    id: "test-skill", name: "test-skill", description: "Use for tests.", license: null,
    compatibility: null, metadata: {}, allowedTools: [], enabled: true, entry: "SKILL.md",
    digestSha256: digest, fileCount: 2, unpackedBytes: 24,
    installedAt: "2026-07-17T00:00:00.000Z", source: { kind: "upload" },
    approval: {
      status: "approved", digestSha256: digest, approvedAt: "2026-07-17T00:01:00.000Z"
    },
    riskEvidence: {
      reviewVersion: 1, reviewStatus: "approved", reviewedDigestSha256: digest,
      classification: "instruction-only", hasScripts: false, hasExternalUrls: false,
      mcpDependencies: [], declaredFileAccess: [], allowImplicitInvocation: true
    }
  };
}

function namedSkill(id: string, ordinal: number): AgentSkillRecord {
  const base = skill();
  const digestSha256 = ordinal.toString(16).padStart(64, "0");
  return {
    ...base,
    id,
    name: id,
    digestSha256,
    approval: {
      status: "approved",
      digestSha256,
      approvedAt: base.approval?.approvedAt ?? "2026-07-17T00:01:00.000Z"
    },
    riskEvidence: {
      ...base.riskEvidence,
      reviewStatus: "approved",
      reviewedDigestSha256: digestSha256
    }
  };
}

function scriptSkill(): AgentSkillRecord {
  const base = skill();
  return {
    ...base,
    riskEvidence: {
      ...base.riskEvidence,
      reviewStatus: "approved",
      reviewedDigestSha256: base.digestSha256,
      classification: "script-bearing",
      hasScripts: true,
      declaredFileAccess: ["shell"]
    }
  };
}
