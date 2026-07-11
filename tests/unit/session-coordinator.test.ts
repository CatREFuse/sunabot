// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunner, CodexToolResult } from "../../src/codexTool.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type CodexCoordinatorSettings,
  type SessionHandleResult
} from "../../src/sessionCoordinator.js";
import { SessionStore, type SessionEventRecord } from "../../src/sessionStore.js";

const stores: SessionStore[] = [];
const coordinators: SessionCoordinator[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const coordinator of coordinators.splice(0)) coordinator.stop();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("SessionCoordinator", () => {
  it("keeps committed turns and outbound replies FIFO per Session while other Sessions progress", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const firstGate = deferred<void>();
    const starts: string[] = [];
    const activeBySession = new Map<string, number>();
    const deliveries: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      handleEvent: async (event) => {
        const payload = event.payload as { text: string };
        starts.push(`${event.sessionId}:${payload.text}`);
        activeBySession.set(event.sessionId, (activeBySession.get(event.sessionId) ?? 0) + 1);
        expect(activeBySession.get(event.sessionId)).toBe(1);
        try {
          if (payload.text === "first") await firstGate.promise;
          return completedReply(payload.text);
        } finally {
          activeBySession.set(event.sessionId, activeBySession.get(event.sessionId)! - 1);
        }
      },
      deliverOutbox: (outbox) => {
        deliveries.push((outbox.payload as { text: string }).text);
        return { messageId: deliveries.length };
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:a", kind: "incoming", payload: { text: "first" } });
    coordinator.enqueueEvent({ sessionId: "group:a", kind: "incoming", payload: { text: "second" } });
    coordinator.enqueueEvent({ sessionId: "group:a", kind: "incoming", payload: { text: "third" } });
    coordinator.enqueueEvent({ sessionId: "group:b", kind: "incoming", payload: { text: "parallel" } });

    await waitUntil(() => starts.includes("group:b:parallel"));
    expect(starts).toEqual(["group:a:first", "group:b:parallel"]);
    expect(deliveries).toEqual(["parallel"]);

    firstGate.resolve();
    await coordinator.waitForIdle();
    expect(starts).toEqual([
      "group:a:first",
      "group:b:parallel",
      "group:a:second",
      "group:a:third"
    ]);
    expect(deliveries.filter((value) => value !== "parallel")).toEqual(["first", "second", "third"]);
    expect(store.listEvents("group:a").map((event) => event.status)).toEqual([
      "completed",
      "completed",
      "completed"
    ]);
  });

  it("can durably commit an event without exposing it to a worker until post-commit state is ready", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const handled: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      handleEvent: (event) => {
        handled.push((event.payload as { text: string }).text);
        return { status: "no_reply" };
      }
    }));

    const committed = coordinator.enqueueEvent({
      sessionId: "group:commit-boundary",
      kind: "incoming",
      payload: { text: "durable first" }
    }, { schedule: false });

    expect(committed.inserted).toBe(true);
    expect(store.listEvents("group:commit-boundary")[0]).toMatchObject({ status: "pending" });
    expect(handled).toEqual([]);

    coordinator.resume();
    await coordinator.waitForIdle();
    expect(handled).toEqual(["durable first"]);
  });

  it("atomically acknowledges a deferred Codex job, releases the Session, and appends completion at the tail", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const toolGate = deferred<void>();
    const toolStarted = deferred<void>();
    const seen: string[] = [];
    const deliveries: string[] = [];
    let laterRanWhileToolPending = false;
    let toolFinished = false;
    const runner: CodexRunner = {
      async run(_input, context) {
        toolStarted.resolve();
        await toolGate.promise;
        toolFinished = true;
        return successfulCodex(context.jobId, "research", "deep result");
      }
    };
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runner,
      handleEvent: (event) => {
        if (event.kind === "tool_completion") {
          seen.push("tool_completion");
          return completedReply("tool result delivered");
        }
        const text = (event.payload as { text: string }).text;
        seen.push(text);
        if (text === "delegate") {
          return {
            status: "deferred",
            providerCallId: "call-codex-1",
            arguments: { task: "perform deep research", kind: "research" },
            originalRequest: event.payload,
            acknowledgement: { kind: "reply", payload: { text: "task started" } }
          } satisfies SessionHandleResult;
        }
        laterRanWhileToolPending = !toolFinished;
        return completedReply(text);
      },
      deliverOutbox: (outbox) => {
        deliveries.push((outbox.payload as { text: string }).text);
      }
    }));

    coordinator.resume();
    const first = coordinator.enqueueEvent({
      sessionId: "group:defer",
      kind: "incoming",
      dedupeKey: "message:1",
      payload: { text: "delegate" }
    });
    const duplicate = coordinator.enqueueEvent({
      sessionId: "group:defer",
      kind: "incoming",
      dedupeKey: "message:1",
      payload: { text: "duplicate must not run" }
    });
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.event.id).toBe(first.event.id);

    await toolStarted.promise;
    await waitUntil(() => deliveries.includes("task started"));
    coordinator.enqueueEvent({
      sessionId: "group:defer",
      kind: "incoming",
      payload: { text: "later" }
    });
    await waitUntil(() => seen.includes("later"));
    expect(laterRanWhileToolPending).toBe(true);
    expect(seen).toEqual(["delegate", "later"]);

    toolGate.resolve();
    await coordinator.waitForIdle();
    expect(seen).toEqual(["delegate", "later", "tool_completion"]);
    expect(deliveries).toEqual(["task started", "later", "tool result delivered"]);
    expect(store.listEvents("group:defer").map((event) => [event.sequence, event.kind])).toEqual([
      [1, "incoming"],
      [2, "incoming"],
      [3, "tool_completion"]
    ]);
    expect(store.listTurns("group:defer").map((turn) => turn.status)).toEqual([
      "deferred",
      "replied",
      "replied"
    ]);
  });

  it("turns Codex failures into one idempotent completion event", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const completions: unknown[] = [];
    const runner: CodexRunner = {
      async run(_input, context) {
        return {
          ok: false,
          status: "failed",
          jobId: context.jobId,
          kind: "analysis",
          error: { code: "worker_failed", message: "analysis failed" }
        };
      }
    };
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runner,
      handleEvent: (event) => {
        if (event.kind === "tool_completion") {
          completions.push(event.payload);
          return { status: "no_reply" };
        }
        return {
          status: "deferred",
          providerCallId: "call-failure",
          arguments: { task: "long analysis", kind: "analysis" },
          originalRequest: event.payload,
          acknowledgement: { kind: "reply", payload: { text: "started" } }
        };
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:failure", kind: "incoming", payload: { text: "analyze" } });
    await coordinator.waitForIdle();

    const job = store.listToolJobs("group:failure")[0]!;
    expect(job.status).toBe("failed");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      type: "tool_result",
      toolJobId: job.id,
      outcome: { status: "failed" }
    });
    const duplicate = store.completeToolJob({
      jobId: job.id,
      status: "succeeded",
      result: { content: "must not overwrite" }
    });
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.job.status).toBe("failed");
    expect(store.listEvents("group:failure").filter((event) => event.kind === "tool_completion")).toHaveLength(1);
  });

  it("retries outbound delivery finitely and probes disconnected delivery without external resume", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const attempts = new Map<string, number>();
    const successfulDeliveries: string[] = [];
    let connected = true;
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxRetryDelayMs: 0,
      outboxDisconnectedProbeDelayMs: 20,
      maxOutboxAttempts: 3,
      handleEvent: (event) => completedReply((event.payload as { text: string }).text),
      deliverOutbox: (outbox) => {
        const text = (outbox.payload as { text: string }).text;
        const attempt = (attempts.get(text) ?? 0) + 1;
        attempts.set(text, attempt);
        if (text === "eventual" && attempt < 3) throw new Error("temporary failure");
        if (text === "unknown") throw new Error("permanent failure");
        if (text.startsWith("reconnect") && !connected) throw new OutboxDisconnectedError();
        successfulDeliveries.push(text);
        return { delivered: text };
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:retry", kind: "incoming", payload: { text: "eventual" } });
    coordinator.enqueueEvent({ sessionId: "group:unknown", kind: "incoming", payload: { text: "unknown" } });
    await coordinator.waitForIdle();
    expect(store.listOutbox("group:retry")[0]).toMatchObject({ status: "sent", attempts: 3 });
    expect(store.listOutbox("group:unknown")[0]).toMatchObject({ status: "unknown", attempts: 3 });

    connected = false;
    coordinator.enqueueEvent({ sessionId: "group:reconnect", kind: "incoming", payload: { text: "reconnect:1" } });
    coordinator.enqueueEvent({ sessionId: "group:reconnect", kind: "incoming", payload: { text: "reconnect:2" } });
    await waitUntil(() => store.listOutbox("group:reconnect")[0]?.status === "pending");
    await coordinator.waitForIdle();
    expect(attempts.get("reconnect:1")).toBe(1);
    expect(attempts.get("reconnect:2")).toBeUndefined();
    expect(store.listOutbox("group:reconnect")[0]).toMatchObject({ status: "pending", attempts: 1 });
    await new Promise<void>((resolve) => setTimeout(resolve, 8));
    expect(attempts.get("reconnect:1")).toBe(1);

    connected = true;
    await waitUntil(() => store.listOutbox("group:reconnect").every((outbox) => outbox.status === "sent"));
    await coordinator.waitForIdle();
    expect(attempts.get("reconnect:1")).toBe(2);
    expect(attempts.get("reconnect:2")).toBe(1);
    expect(successfulDeliveries.filter((text) => text.startsWith("reconnect"))).toEqual([
      "reconnect:1",
      "reconnect:2"
    ]);
  });

  it("stops the disconnected outbox probe timer", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    let attempts = 0;
    let connected = false;
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxDisconnectedProbeDelayMs: 20,
      handleEvent: () => completedReply("queued"),
      deliverOutbox: () => {
        attempts += 1;
        if (!connected) throw new OutboxDisconnectedError();
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:stop", kind: "incoming", payload: { text: "queued" } });
    await waitUntil(() => store.listOutbox("group:stop")[0]?.status === "pending");
    expect(attempts).toBe(1);

    const clearsBeforeStop = clearTimeoutSpy.mock.calls.length;
    coordinator.stop();
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearsBeforeStop);
    connected = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(attempts).toBe(1);
    expect(store.listOutbox("group:stop")[0]).toMatchObject({ status: "pending", attempts: 1 });
    clearTimeoutSpy.mockRestore();
  });

  it("recovers pending turns, sending outbox, and running Codex jobs after restart", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-coordinator-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const oldStore = trackStore(new SessionStore({ databasePath }));

    oldStore.enqueueEvent({ sessionId: "group:turn", kind: "incoming", payload: { text: "pending turn" } });
    oldStore.enqueueEvent({ sessionId: "group:outbox", kind: "incoming", payload: { text: "old outbox" } });
    const outboxTurn = oldStore.claimNextTurn({ workerId: "old-turn", sessionId: "group:outbox" })!;
    oldStore.finishTurn({
      turnId: outboxTurn.turn.id,
      workerId: "old-turn",
      outcome: "replied",
      outbox: [{ kind: "reply", payload: { text: "recover delivery" } }]
    });
    oldStore.claimNextOutbox({ workerId: "old-outbox", sessionId: "group:outbox" });

    oldStore.enqueueEvent({ sessionId: "group:tool", kind: "incoming", payload: { text: "old tool" } });
    const toolTurn = oldStore.claimNextTurn({ workerId: "old-turn", sessionId: "group:tool" })!;
    oldStore.deferTurn({
      turnId: toolTurn.turn.id,
      workerId: "old-turn",
      job: {
        providerCallId: "old-call",
        toolName: "codex",
        taskKind: "local",
        originalRequest: toolTurn.event.payload,
        arguments: { task: "recover me", kind: "local" }
      },
      acknowledgement: { kind: "reply", payload: { text: "old ack" } }
    });
    oldStore.claimNextToolJob({ workerId: "old-tool", sessionId: "group:tool" });
    oldStore.close();
    stores.splice(stores.indexOf(oldStore), 1);

    const store = trackStore(new SessionStore({ databasePath }));
    const seen: string[] = [];
    const delivered: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      handleEvent: (event) => {
        seen.push(event.kind === "tool_completion"
          ? "tool_completion"
          : (event.payload as { text: string }).text);
        return event.kind === "tool_completion"
          ? { status: "no_reply" }
          : completedReply((event.payload as { text: string }).text);
      },
      deliverOutbox: (outbox) => {
        delivered.push((outbox.payload as { text: string }).text);
      },
      runner: {
        async run(input, context) {
          return successfulCodex(context.jobId, input.kind === "local" ? "local" : "analysis", "recovered");
        }
      }
    }));

    coordinator.resume();
    await coordinator.waitForIdle();
    expect(seen).toEqual(expect.arrayContaining(["pending turn", "tool_completion"]));
    expect(delivered).toEqual(expect.arrayContaining(["recover delivery", "old ack", "pending turn"]));
    expect(store.listOutbox("group:outbox")[0]?.status).toBe("sent");
    expect(store.listToolJobs("group:tool")[0]?.status).toBe("succeeded");
    expect(store.listEvents("group:tool").map((event) => event.kind)).toEqual([
      "incoming",
      "tool_completion"
    ]);
  });

  it("cleans a verified orphan process before starting an isolated recovered attempt", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    store.enqueueEvent({ sessionId: "group:orphan", kind: "incoming", payload: { text: "old tool" } });
    const turn = store.claimNextTurn({ workerId: "old-turn" })!;
    const deferred = store.deferTurn({
      turnId: turn.turn.id,
      workerId: "old-turn",
      job: {
        providerCallId: "old-call",
        toolName: "codex",
        taskKind: "analysis",
        originalRequest: turn.event.payload,
        arguments: { task: "recover me", kind: "analysis" }
      },
      acknowledgement: { kind: "reply", payload: { text: "old ack" } }
    });
    const oldClaim = store.claimNextToolJob({ workerId: "old-tool" })!;
    const oldIdentity = {
      pid: 4242,
      processGroupId: 4242,
      attempt: oldClaim.attempts,
      runToken: oldClaim.attemptToken!,
      commandMarker: `/jobs/${oldClaim.id}/attempt-${oldClaim.attempts}-${oldClaim.attemptToken}`,
      startedAt: 100
    };
    store.recordToolJobProcess(
      oldClaim.id,
      "old-tool",
      oldClaim.attempts,
      oldClaim.attemptToken!,
      oldIdentity
    );

    const cleanup = vi.fn(async () => ({ status: "terminated" as const }));
    const starts: Array<{ attempt?: number; runToken?: string }> = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      cleanupCodexProcess: cleanup,
      handleEvent: (event) => event.kind === "tool_completion" ? { status: "no_reply" } : { status: "no_reply" },
      runner: {
        async run(_input, context) {
          starts.push({ attempt: context.attempt, runToken: context.runToken });
          context.onProcessStarted?.({
            pid: 5252,
            processGroupId: 5252,
            attempt: context.attempt!,
            runToken: context.runToken!,
            commandMarker: `${context.jobDir}/.codex-worker/attempt-${context.attempt}-${context.runToken}`,
            startedAt: 200
          });
          return successfulCodex(context.jobId, "analysis", "recovered");
        }
      }
    }));

    coordinator.resume();
    await coordinator.waitForIdle();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(oldIdentity);
    expect(starts).toEqual([{ attempt: 2, runToken: expect.any(String) }]);
    expect(starts[0]!.runToken).not.toBe(oldClaim.attemptToken);
    expect(store.getToolJob(deferred.job.id)).toMatchObject({
      status: "succeeded",
      attempts: 2,
      processIdentity: undefined
    });
  });

  it("does not start a new attempt when an orphan PID cannot be verified", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    store.enqueueEvent({ sessionId: "group:pid-reuse", kind: "incoming", payload: {} });
    const turn = store.claimNextTurn({ workerId: "old-turn" })!;
    const deferred = store.deferTurn({
      turnId: turn.turn.id,
      workerId: "old-turn",
      job: {
        providerCallId: "pid-reuse",
        toolName: "codex",
        originalRequest: {},
        arguments: { task: "recover", kind: "analysis" }
      },
      acknowledgement: { kind: "reply", payload: {} }
    });
    const oldClaim = store.claimNextToolJob({ workerId: "old-tool" })!;
    store.recordToolJobProcess(oldClaim.id, "old-tool", oldClaim.attempts, oldClaim.attemptToken!, {
      pid: 4242,
      processGroupId: 4242,
      attempt: oldClaim.attempts,
      runToken: oldClaim.attemptToken!,
      commandMarker: "/old-attempt-marker",
      startedAt: 100
    });
    const runner = { run: vi.fn() };
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runner,
      cleanupCodexProcess: async () => ({ status: "unverified", message: "PID was reused." }),
      handleEvent: () => ({ status: "no_reply" })
    }));

    coordinator.resume();
    await coordinator.waitForIdle();

    expect(runner.run).not.toHaveBeenCalled();
    expect(store.getToolJob(deferred.job.id)).toMatchObject({
      status: "unknown",
      error: { code: "orphan_process_unverified", message: "PID was reused." }
    });
    expect(store.listEvents("group:pid-reuse").map((event) => event.kind)).toEqual([
      "incoming",
      "tool_completion"
    ]);
  });

  it("serializes local Codex work for one workspace while research can run in parallel", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const gates = new Map([
      ["local one", deferred<void>()],
      ["local two", deferred<void>()],
      ["research", deferred<void>()]
    ]);
    const starts: string[] = [];
    const runner: CodexRunner = {
      async run(input, context) {
        const task = String(input.task);
        starts.push(task);
        await gates.get(task)!.promise;
        return successfulCodex(
          context.jobId,
          input.kind === "local" || input.kind === "research" ? input.kind : "analysis",
          task
        );
      }
    };
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runner,
      codexMaxConcurrency: 2,
      handleEvent: (event) => {
        if (event.kind === "tool_completion") return { status: "no_reply" };
        const payload = event.payload as { task: string; kind: "local" | "research" };
        return {
          status: "deferred",
          providerCallId: `call:${payload.task}`,
          arguments: payload,
          originalRequest: payload,
          acknowledgement: { kind: "reply", payload: { text: `started:${payload.task}` } }
        };
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:l1", kind: "incoming", payload: { task: "local one", kind: "local" } });
    coordinator.enqueueEvent({ sessionId: "group:l2", kind: "incoming", payload: { task: "local two", kind: "local" } });
    coordinator.enqueueEvent({ sessionId: "group:r", kind: "incoming", payload: { task: "research", kind: "research" } });

    await waitUntil(() => starts.length === 2);
    expect(starts).toContain("local one");
    expect(starts).toContain("research");
    expect(starts).not.toContain("local two");
    gates.get("research")!.resolve();
    await waitUntil(() => store.listToolJobs("group:r")[0]?.status === "succeeded");
    expect(starts).not.toContain("local two");

    gates.get("local one")!.resolve();
    await waitUntil(() => starts.includes("local two"));
    gates.get("local two")!.resolve();
    await coordinator.waitForIdle();
    expect(starts).toEqual(["local one", "research", "local two"]);
  });
});

interface CoordinatorHarnessOptions {
  store: SessionStore;
  handleEvent?: (event: SessionEventRecord) => SessionHandleResult | Promise<SessionHandleResult>;
  deliverOutbox?: (outbox: Parameters<ConstructorParameters<typeof SessionCoordinator>[0]["deliverOutbox"]>[0]) => unknown;
  runner?: CodexRunner;
  maxOutboxAttempts?: number;
  outboxRetryDelayMs?: number;
  outboxDisconnectedProbeDelayMs?: number;
  codexMaxConcurrency?: number;
  cleanupCodexProcess?: ConstructorParameters<typeof SessionCoordinator>[0]["cleanupCodexProcess"];
}

function createCoordinator(options: CoordinatorHarnessOptions) {
  const settings: CodexCoordinatorSettings = {
    enabled: true,
    timeoutMs: 5_000,
    maxConcurrency: options.codexMaxConcurrency ?? 4,
    workspacePath: process.cwd(),
    jobRoot: path.join(os.tmpdir(), "sunabot-codex-test-jobs")
  };
  return new SessionCoordinator({
    store: options.store,
    handleEvent: options.handleEvent ?? (() => ({ status: "no_reply" })),
    deliverOutbox: options.deliverOutbox ?? (() => undefined),
    codexRunner: options.runner ?? {
      run: vi.fn(async (_input, context) => successfulCodex(context.jobId, "analysis", "ok"))
    },
    codexSettings: () => settings,
    turnTimeoutMs: 2_000,
    outboxTimeoutMs: 2_000,
    outboxRetryDelayMs: options.outboxRetryDelayMs,
    outboxDisconnectedProbeDelayMs: options.outboxDisconnectedProbeDelayMs,
    maxOutboxAttempts: options.maxOutboxAttempts,
    cleanupCodexProcess: options.cleanupCodexProcess,
    leaseMs: 1_000
  });
}

function completedReply(text: string): SessionHandleResult {
  return {
    status: "completed",
    outbox: [{ kind: "reply", payload: { text } }]
  };
}

function successfulCodex(
  jobId: string,
  kind: "local" | "research" | "analysis",
  content: string
): CodexToolResult {
  return { ok: true, status: "succeeded", jobId, kind, content };
}

function trackStore(store: SessionStore) {
  stores.push(store);
  return store;
}

function trackCoordinator(coordinator: SessionCoordinator) {
  coordinators.push(coordinator);
  return coordinator;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout.");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
