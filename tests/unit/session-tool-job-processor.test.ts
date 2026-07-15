// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import { SessionActorTaskTimeoutError } from "../../services/sessions/sessionActor.js";
import type {
  CodexCoordinatorSettings,
  CodexToolUsageObserver,
  SessionClaimState
} from "../../services/sessions/sessionCoordinatorTypes.js";
import { SessionStore, type ToolJobRecord } from "../../services/sessions/sessionStore.js";
import { SessionToolJobProcessor } from "../../services/sessions/sessionToolJobProcessor.js";

const TOOL_WORKER_ID = "tool-worker";
const stores: SessionStore[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

describe("SessionToolJobProcessor Codex usage observation", () => {
  it("commits the terminal result before waiting for the usage observer", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const job = claimCodexJob(store, "group:slow-observer");
    const observerStarted = deferred<void>();
    const releaseObserver = deferred<void>();
    const observeCodexToolUsage = vi.fn(async () => {
      observerStarted.resolve();
      await releaseObserver.promise;
    });
    const harness = createProcessorHarness(store, {
      async run(_input, context) {
        return {
          ok: true,
          status: "succeeded",
          jobId: context.jobId,
          kind: "analysis",
          content: "done",
          usage: { input_tokens: 24, output_tokens: 4 }
        };
      }
    }, observeCodexToolUsage);

    const processing = harness.processor.process(
      { job, settings: harness.settings, state: harness.state },
      harness.actor.signal
    );
    await observerStarted.promise;

    expect(store.getToolJob(job.id)?.status).toBe("succeeded");
    releaseObserver.resolve();
    await processing;
    expect(observeCodexToolUsage).toHaveBeenCalledOnce();
  });

  it("records a returned result after the actor already finalized the job", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const job = claimCodexJob(store, "group:late-result");
    const started = deferred<void>();
    const finish = deferred<void>();
    const observeCodexToolUsage = vi.fn();
    const runner: CodexRunner = {
      async run(_input, context) {
        context.onProcessStarted?.({
          pid: 101,
          processGroupId: 101,
          attempt: context.attempt!,
          runToken: context.runToken!,
          commandMarker: path.join(context.jobDir, "late-result"),
          startedAt: Date.now()
        });
        started.resolve();
        await finish.promise;
        return {
          ok: true,
          status: "succeeded",
          jobId: context.jobId,
          kind: "analysis",
          content: "done",
          usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 12 }
        };
      }
    };
    const harness = createProcessorHarness(store, runner, observeCodexToolUsage);

    const processing = harness.processor.process({ job, settings: harness.settings, state: harness.state }, harness.actor.signal);
    await started.promise;
    const timeout = new SessionActorTaskTimeoutError(job.sessionId, 25);
    harness.actor.abort(timeout);
    harness.processor.fail(job, harness.state, timeout);
    expect(store.getToolJob(job.id)?.status).toBe("timed_out");

    finish.resolve();
    await processing;

    expect(observeCodexToolUsage).toHaveBeenCalledOnce();
    expect(observeCodexToolUsage).toHaveBeenCalledWith({
      jobId: job.id,
      conversationId: job.sessionId,
      attempt: job.attempts,
      model: "gpt-5-codex",
      ok: true,
      status: "succeeded",
      usage: { input_tokens: 90, cached_input_tokens: 60, output_tokens: 12 }
    });
    expect(store.getToolJob(job.id)?.status).toBe("timed_out");
  });

  it("records returned usage once when completeToolJob throws after committing", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const job = claimCodexJob(store, "group:completion-throw");
    const observeCodexToolUsage = vi.fn();
    const completeToolJob = store.completeToolJob.bind(store);
    const completionSpy = vi.spyOn(store, "completeToolJob")
      .mockImplementationOnce((input) => {
        completeToolJob(input);
        throw new Error("completion acknowledgement failed");
      })
      .mockImplementation((input) => completeToolJob(input));
    const harness = createProcessorHarness(store, {
      async run(_input, context) {
        return {
          ok: true,
          status: "succeeded",
          jobId: context.jobId,
          kind: "analysis",
          content: "done",
          usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 7 }
        };
      }
    }, observeCodexToolUsage);

    await harness.processor.process({ job, settings: harness.settings, state: harness.state }, harness.actor.signal);

    expect(completionSpy).toHaveBeenCalledTimes(2);
    expect(observeCodexToolUsage).toHaveBeenCalledOnce();
    expect(observeCodexToolUsage).toHaveBeenCalledWith(expect.objectContaining({
      jobId: job.id,
      attempt: job.attempts,
      ok: true,
      status: "succeeded",
      usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 7 }
    }));
    expect(store.getToolJob(job.id)?.status).toBe("succeeded");
    expect(store.listEvents(job.sessionId).filter((event) => event.kind === "tool_completion")).toHaveLength(1);
  });

  it("records one timed-out attempt when the runner throws after actor finalization", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const job = claimCodexJob(store, "group:late-throw");
    const started = deferred<void>();
    const finish = deferred<void>();
    const observeCodexToolUsage = vi.fn();
    const harness = createProcessorHarness(store, {
      async run(_input, context) {
        context.onProcessStarted?.({
          pid: 202,
          processGroupId: 202,
          attempt: context.attempt!,
          runToken: context.runToken!,
          commandMarker: path.join(context.jobDir, "late-throw"),
          startedAt: Date.now()
        });
        started.resolve();
        await finish.promise;
        throw new Error("late runner failure");
      }
    }, observeCodexToolUsage);

    const processing = harness.processor.process({ job, settings: harness.settings, state: harness.state }, harness.actor.signal);
    await started.promise;
    const timeout = new SessionActorTaskTimeoutError(job.sessionId, 25);
    harness.actor.abort(timeout);
    harness.processor.fail(job, harness.state, timeout);
    finish.resolve();
    await processing;

    expect(observeCodexToolUsage).toHaveBeenCalledOnce();
    expect(observeCodexToolUsage).toHaveBeenCalledWith({
      jobId: job.id,
      conversationId: job.sessionId,
      attempt: job.attempts,
      model: "gpt-5-codex",
      ok: false,
      status: "timed_out"
    });
    expect(store.getToolJob(job.id)?.status).toBe("timed_out");
  });
});

function createProcessorHarness(
  store: SessionStore,
  codexRunner: CodexRunner,
  observeCodexToolUsage: CodexToolUsageObserver
) {
  const state: SessionClaimState = {
    controller: new AbortController(),
    finalized: false,
    stopRenewal: () => undefined
  };
  const actor = new AbortController();
  const settings: CodexCoordinatorSettings = {
    enabled: true,
    model: "gpt-5-codex",
    timeoutMs: 5_000,
    maxConcurrency: 1,
    workspacePath: process.cwd(),
    jobRoot: path.join(os.tmpdir(), "sunabot-session-tool-job-processor")
  };
  const processor = new SessionToolJobProcessor({
    store,
    codexRunner,
    cleanupCodexProcess: async () => ({ status: "terminated" }),
    observeCodexToolUsage,
    workerId: TOOL_WORKER_ID,
    isStopped: () => false,
    assertClaimUsable(claim, signal) {
      if (claim.finalized) throw new Error("Persistent claim is already finalized.");
      if (signal.aborted) throw signal.reason ?? new Error("Persistent claim was aborted.");
    },
    scheduleTurns: () => undefined,
    deferTurns: () => undefined
  });
  return { actor, processor, settings, state };
}

function claimCodexJob(store: SessionStore, sessionId: string): ToolJobRecord {
  store.enqueueEvent({ sessionId, kind: "incoming", payload: { text: "run" } });
  const turn = store.claimNextTurn({ workerId: "turn-worker", sessionId })!;
  store.deferTurn({
    turnId: turn.turn.id,
    workerId: "turn-worker",
    job: {
      providerCallId: `call:${sessionId}`,
      toolName: "codex",
      taskKind: "analysis",
      originalRequest: turn.event.payload,
      arguments: { task: "inspect", kind: "analysis" }
    },
    acknowledgement: { kind: "reply", payload: { text: "started" } }
  });
  const acknowledgement = store.claimNextOutbox({ workerId: "ack-worker", sessionId })!;
  store.finishOutbox({ outboxId: acknowledgement.id, workerId: "ack-worker", outcome: "sent" });
  return store.claimNextToolJob({ workerId: TOOL_WORKER_ID, sessionId })!;
}

function trackStore(store: SessionStore) {
  stores.push(store);
  return store;
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
