// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexRunner, CodexToolResult } from "../../adapters/codex/codexTool.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type CodexCoordinatorSettings,
  type SessionHandleResult,
  type SessionTurnContext
} from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type SessionEventRecord } from "../../services/sessions/sessionStore.js";

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
  it("keeps probing a paused partition after remote success followed by settle failure", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    let attempts = 0;
    let remoteSends = 0;
    let failSettle = true;
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxRetryDelayMs: 0,
      outboxDisconnectedProbeDelayMs: 5,
      handleEvent: (event) => ({
        status: "completed",
        outbox: [{
          kind: "onebot.reply",
          deliveryPartition: "qq-probe",
          payload: event.payload
        }]
      }),
      deliverOutbox: async (_outbox, context) => {
        attempts += 1;
        if (attempts === 1) throw new OutboxDisconnectedError();
        if (context.phase === "send") {
          await context.sendRemote(async () => {
            remoteSends += 1;
            return { accepted: true };
          });
        }
        await context.settleStep("projection", () => {
          if (failSettle) {
            failSettle = false;
            throw new Error("settle once");
          }
        });
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:probe:1", kind: "incoming", payload: { text: "first" } });
    coordinator.enqueueEvent({ sessionId: "group:probe:2", kind: "incoming", payload: { text: "second" } });

    await waitUntil(() => store.listOutbox("group:probe:2")[0]?.status === "sent");
    expect(remoteSends).toBe(2);
    expect(store.listOutbox("group:probe:1")[0]).toMatchObject({ status: "sent", settleAttempts: 1 });
  });

  it.each(["delivery_unknown", "pre_remote"] as const)(
    "reschedules a paused partition after a %s probe terminal",
    async (probeTerminal) => {
      const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
      let attempts = 0;
      const coordinator = trackCoordinator(createCoordinator({
        store,
        outboxRetryDelayMs: 0,
        outboxDisconnectedProbeDelayMs: 5,
        handleEvent: (event) => ({
          status: "completed",
          outbox: [{ kind: "onebot.reply", deliveryPartition: "qq-probe-terminal", payload: event.payload }]
        }),
        deliverOutbox: async (outbox, context) => {
          const text = (outbox.payload as { text: string }).text;
          if (text === "first") {
            attempts += 1;
            if (attempts === 1) throw new OutboxDisconnectedError();
            if (attempts === 2 && probeTerminal === "delivery_unknown") {
              await context.sendRemote(() => { throw new Error("transport result unknown"); });
            }
            if (attempts === 2 && probeTerminal === "pre_remote") throw new Error("failed before transport");
          }
          if (context.phase === "send") await context.sendRemote(() => ({ accepted: true }));
        }
      }));

      coordinator.resume();
      coordinator.enqueueEvent({ sessionId: "group:probe-terminal:1", kind: "incoming", payload: { text: "first" } });
      coordinator.enqueueEvent({ sessionId: "group:probe-terminal:2", kind: "incoming", payload: { text: "second" } });

      await waitUntil(() => store.listOutbox("group:probe-terminal:2")[0]?.status === "sent");
      expect(store.listOutbox("group:probe-terminal:1")[0]?.status).toBe(
        probeTerminal === "delivery_unknown" ? "delivery_unknown" : "sent"
      );
    }
  );

  it("isolates disconnected delivery partitions while online accounts keep FIFO progress", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const connected = new Map([["qq-offline", false], ["qq-online", true]]);
    const attempts: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxDisconnectedProbeDelayMs: 500,
      handleEvent: (event) => ({
        status: "completed",
        outbox: [{
          kind: "onebot.reply",
          deliveryPartition: (event.payload as { accountId: string }).accountId,
          payload: event.payload
        }]
      }),
      deliverOutbox: async (outbox, context) => {
        const accountId = outbox.deliveryPartition;
        attempts.push(`${accountId}:${(outbox.payload as { text: string }).text}`);
        if (!connected.get(accountId)) throw new OutboxDisconnectedError();
        await context.sendRemote(async () => ({ accepted: true, messageId: outbox.id }));
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({
      sessionId: "group:offline:1",
      kind: "incoming",
      payload: { accountId: "qq-offline", text: "offline-1" }
    });
    coordinator.enqueueEvent({
      sessionId: "group:offline:2",
      kind: "incoming",
      payload: { accountId: "qq-offline", text: "offline-2" }
    });
    coordinator.enqueueEvent({
      sessionId: "group:online:1",
      kind: "incoming",
      payload: { accountId: "qq-online", text: "online-1" }
    });
    coordinator.enqueueEvent({
      sessionId: "group:online:2",
      kind: "incoming",
      payload: { accountId: "qq-online", text: "online-2" }
    });

    await waitUntil(() => store.listOutbox("group:online:2")[0]?.status === "sent");
    expect(attempts.filter((value) => value.startsWith("qq-online"))).toEqual([
      "qq-online:online-1",
      "qq-online:online-2"
    ]);
    expect(attempts.filter((value) => value.startsWith("qq-offline"))).toEqual([
      "qq-offline:offline-1"
    ]);

    connected.set("qq-offline", true);
    coordinator.resume("qq-offline");
    await waitUntil(() => store.listOutbox("group:offline:2")[0]?.status === "sent");
    expect(attempts.filter((value) => value.startsWith("qq-offline"))).toEqual([
      "qq-offline:offline-1",
      "qq-offline:offline-1",
      "qq-offline:offline-2"
    ]);
  });

  it.each([
    "conversation_projection",
    "request_log",
    "after_reply"
  ])("does not repeat remote delivery when the %s settle step fails", async (failingStep) => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    let remoteSends = 0;
    let injected = false;
    const completedSteps: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxRetryDelayMs: 0,
      handleEvent: () => ({
        status: "completed",
        outbox: [{
          kind: "onebot.reply",
          deliveryPartition: "qq-1",
          payload: { text: "once" }
        }]
      }),
      deliverOutbox: async (_outbox, context) => {
        if (context.phase === "send") {
          await context.sendRemote(async () => {
            remoteSends += 1;
            return { accepted: true, messageId: "remote-1" };
          });
        }
        for (const step of ["conversation_projection", "request_log", "after_reply"]) {
          await context.settleStep(step, async () => {
            if (step === failingStep && !injected) {
              injected = true;
              throw new Error(`injected:${step}`);
            }
            completedSteps.push(step);
          });
        }
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: `group:settle:${failingStep}`, kind: "incoming", payload: {} });
    await waitUntil(() => store.listOutbox(`group:settle:${failingStep}`)[0]?.status === "sent");
    const outbox = store.listOutbox(`group:settle:${failingStep}`)[0]!;
    expect(remoteSends).toBe(1);
    expect(outbox).toMatchObject({
      status: "sent",
      remoteReceipt: { accepted: true, messageId: "remote-1" },
      completedSettleSteps: ["conversation_projection", "request_log", "after_reply"]
    });
    expect(completedSteps).toEqual(["conversation_projection", "request_log", "after_reply"]);
  });

  it("quarantines an unknown transport result without automatic redelivery", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    let remoteSends = 0;
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxRetryDelayMs: 0,
      handleEvent: () => ({
        status: "completed",
        outbox: [{
          kind: "onebot.reply",
          deliveryPartition: "qq-timeout",
          payload: { text: "timeout" }
        }]
      }),
      deliverOutbox: async (_outbox, context) => {
        await context.sendRemote(async () => {
          remoteSends += 1;
          throw new Error("OneBot action timeout");
        });
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:unknown-transport", kind: "incoming", payload: {} });
    await waitUntil(() => store.listOutbox("group:unknown-transport")[0]?.status === "delivery_unknown");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(remoteSends).toBe(1);
    expect(store.listOutbox("group:unknown-transport")[0]).toMatchObject({
      status: "delivery_unknown",
      attempts: 1
    });
  });

  it("restarts a sent_remote item in settle phase without calling the transport again", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-coordinator-settle-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    let remoteSends = 0;

    const beforeStore = trackStore(new SessionStore({ databasePath }));
    const before = trackCoordinator(createCoordinator({
      store: beforeStore,
      outboxRetryDelayMs: 60_000,
      handleEvent: () => ({
        status: "completed",
        outbox: [{
          kind: "onebot.reply",
          deliveryPartition: "qq-restart",
          payload: { text: "restart" }
        }]
      }),
      deliverOutbox: async (_outbox, context) => {
        await context.sendRemote(async () => {
          remoteSends += 1;
          return { accepted: true, messageId: "restart-remote" };
        });
        await context.settleStep("conversation_projection", () => {
          throw new Error("stop before settle");
        });
      }
    }));
    before.resume();
    before.enqueueEvent({ sessionId: "group:settle-restart", kind: "incoming", payload: {} });
    await waitUntil(() => beforeStore.listOutbox("group:settle-restart")[0]?.status === "sent_remote");
    before.stop();
    beforeStore.close();

    const afterStore = trackStore(new SessionStore({ databasePath, recoverOnOpen: "all" }));
    const phases: string[] = [];
    const after = trackCoordinator(createCoordinator({
      store: afterStore,
      deliverOutbox: async (_outbox, context) => {
        phases.push(context.phase);
        if (context.phase === "send") {
          await context.sendRemote(async () => {
            remoteSends += 1;
            return { accepted: true, messageId: "duplicate" };
          });
        }
        await context.settleStep("conversation_projection", () => undefined);
      }
    }));
    after.resume();
    await waitUntil(() => afterStore.listOutbox("group:settle-restart")[0]?.status === "sent");

    expect(remoteSends).toBe(1);
    expect(phases).toEqual(["settle"]);
    expect(afterStore.listOutbox("group:settle-restart")[0]).toMatchObject({
      remoteReceipt: { accepted: true, messageId: "restart-remote" },
      completedSettleSteps: ["conversation_projection"]
    });
  });

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

  it("delivers an emitted outbox while its event handler is still running", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const releaseHandler = deferred<void>();
    const deliveryObserved = deferred<void>();
    let handlerReturned = false;
    const coordinator = trackCoordinator(createCoordinator({
      store,
      handleEvent: async (_event, context) => {
        await context.emitOutbox({
          kind: "reply",
          payload: { text: "dispatch immediately" },
          dedupeFingerprint: "dispatch-immediately"
        });
        deliveryObserved.resolve();
        await releaseHandler.promise;
        handlerReturned = true;
        return { status: "no_reply" };
      },
      deliverOutbox: (outbox) => ({
        messageId: (outbox.payload as { text: string }).text
      })
    }));

    coordinator.resume();
    coordinator.enqueueEvent({
      sessionId: "group:active-delivery",
      kind: "incoming",
      payload: { text: "start" }
    });

    await deliveryObserved.promise;
    await waitUntil(() => store.listOutbox("group:active-delivery")[0]?.status === "sent");
    expect(handlerReturned).toBe(false);
    expect(store.listTurns("group:active-delivery")[0]).toMatchObject({ status: "running" });
    expect(store.listOutbox("group:active-delivery")[0]).toMatchObject({
      status: "sent",
      result: { messageId: "dispatch immediately" }
    });

    releaseHandler.resolve();
    await coordinator.waitForIdle();
    expect(handlerReturned).toBe(true);
  });

  it("continues the turn after durable dispatch while delivery remains in flight", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const dispatchStarted = deferred<void>();
    const releaseDispatch = deferred<void>();
    const handlerContinued = deferred<void>();
    const releaseHandler = deferred<void>();
    const deliveries: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      handleEvent: async (_event, context) => {
        await context.emitOutbox({
          kind: "reply",
          payload: { text: "dispatch now" },
          dedupeFingerprint: "dispatch-now"
        });
        handlerContinued.resolve();
        await releaseHandler.promise;
        return {
          status: "completed",
          outbox: [{ kind: "reply", payload: { text: "final reply" } }]
        };
      },
      deliverOutbox: async (outbox) => {
        const text = (outbox.payload as { text: string }).text;
        if (text === "dispatch now") {
          dispatchStarted.resolve();
          await releaseDispatch.promise;
        }
        deliveries.push(text);
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({
      sessionId: "group:active-tool-gate",
      kind: "incoming",
      payload: { text: "search" }
    });

    await dispatchStarted.promise;
    await handlerContinued.promise;
    expect(store.listTurns("group:active-tool-gate")[0]).toMatchObject({ status: "running" });
    expect(store.listOutbox("group:active-tool-gate")).toEqual([
      expect.objectContaining({ status: "sending", payload: { text: "dispatch now" } })
    ]);

    releaseHandler.resolve();
    await waitUntil(() => store.listOutbox("group:active-tool-gate").length === 2);
    expect(store.listTurns("group:active-tool-gate")[0]).toMatchObject({ status: "replied" });
    expect(store.listOutbox("group:active-tool-gate")[1]).toMatchObject({
      status: "pending",
      payload: { text: "final reply" }
    });
    releaseDispatch.resolve();
    await coordinator.waitForIdle();
    expect(deliveries).toEqual(["dispatch now", "final reply"]);
  });

  it("retries one stable immediate outbox without appending a duplicate", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    let attempts = 0;
    const coordinator = trackCoordinator(createCoordinator({
      store,
      outboxRetryDelayMs: 0,
      handleEvent: async (_event, context) => {
        await context.emitOutbox({
          kind: "reply",
          payload: { text: "retry dispatch" },
          dedupeFingerprint: "retry-dispatch"
        });
        return { status: "no_reply" };
      },
      deliverOutbox: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("retry before transport");
        return { accepted: true };
      }
    }));

    coordinator.resume();
    const enqueued = coordinator.enqueueEvent({
      sessionId: "group:active-retry",
      kind: "incoming",
      payload: { text: "start" }
    });
    await coordinator.waitForIdle();

    expect(attempts).toBe(2);
    expect(store.listOutbox("group:active-retry")).toEqual([
      expect.objectContaining({
        status: "sent",
        attempts: 2,
        dedupeKey: `turn-outbox:${enqueued.event.id}:1:retry-dispatch`
      })
    ]);
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
            toolName: "codex",
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
          toolName: "codex",
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
      schemaVersion: 1,
      type: "runtime.tool_result",
      payload: {
        type: "tool_result",
        toolJobId: job.id,
        outcome: { status: "failed" }
      }
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

  it("observes Codex usage without letting observer failure change the durable terminal state", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const observeCodexToolUsage = vi.fn(async () => {
      throw new Error("log storage unavailable");
    });
    const runner: CodexRunner = {
      async run(_input, context) {
        return {
          ok: false,
          status: "failed",
          jobId: context.jobId,
          kind: "analysis",
          error: { code: "worker_failed", message: "analysis failed" },
          usage: {
            input_tokens: 120,
            cached_input_tokens: 80,
            output_tokens: 15
          }
        };
      }
    };
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runner,
      observeCodexToolUsage,
      handleEvent: (event) => event.kind === "tool_completion"
        ? { status: "no_reply" }
        : {
            status: "deferred",
            providerCallId: "call-observed-codex",
            toolName: "codex",
            arguments: { task: "private task body", kind: "analysis" },
            originalRequest: event.payload,
            acknowledgement: { kind: "reply", payload: { text: "started" } }
          }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:observed", kind: "incoming", payload: { text: "run" } });
    await coordinator.waitForIdle();

    expect(store.listToolJobs("group:observed")[0]?.status).toBe("failed");
    expect(observeCodexToolUsage).toHaveBeenCalledOnce();
    expect(observeCodexToolUsage).toHaveBeenCalledWith({
      jobId: expect.any(String),
      conversationId: "group:observed",
      attempt: 1,
      model: undefined,
      ok: false,
      status: "failed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        output_tokens: 15
      }
    });
    expect(JSON.stringify(observeCodexToolUsage.mock.calls[0]?.[0])).not.toContain("private task body");
  });

  it("observes a started Codex model attempt even when usage is unavailable", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const observeCodexToolUsage = vi.fn();
    const coordinator = trackCoordinator(createCoordinator({
      store,
      observeCodexToolUsage,
      runner: {
        async run(_input, context) {
          context.onProcessStarted?.({
            pid: 12345,
            processGroupId: 12345,
            attempt: 1,
            runToken: String(context.runToken),
            commandMarker: "/tmp/codex-attempt",
            startedAt: Date.now()
          });
          return {
            ok: false,
            status: "failed",
            jobId: context.jobId,
            kind: "analysis",
            error: { code: "codex_turn_failed", message: "failed after start" }
          };
        }
      },
      handleEvent: (event) => event.kind === "tool_completion"
        ? { status: "no_reply" }
        : {
            status: "deferred",
            providerCallId: "call-no-usage",
            toolName: "codex",
            arguments: { task: "inspect", kind: "analysis" },
            originalRequest: event.payload,
            acknowledgement: { kind: "reply", payload: { text: "started" } }
          }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:no-usage", kind: "incoming", payload: { text: "run" } });
    await coordinator.waitForIdle();

    expect(observeCodexToolUsage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "group:no-usage",
      attempt: 1,
      ok: false,
      status: "failed"
    }));
    expect(observeCodexToolUsage.mock.calls[0]?.[0]).not.toHaveProperty("usage");
  });

  it("observes Codex usage independently of terminal completion ownership", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const completeToolJob = store.completeToolJob.bind(store);
    vi.spyOn(store, "completeToolJob").mockImplementation((input) => ({
      ...completeToolJob(input),
      inserted: false
    }));
    const observeCodexToolUsage = vi.fn();
    const coordinator = trackCoordinator(createCoordinator({
      store,
      observeCodexToolUsage,
      runner: {
        async run(_input, context) {
          return {
            ok: true,
            status: "succeeded",
            jobId: context.jobId,
            kind: "analysis",
            content: "done",
            usage: { input_tokens: 50, cached_input_tokens: 25, output_tokens: 5 }
          };
        }
      },
      handleEvent: (event) => event.kind === "tool_completion"
        ? { status: "no_reply" }
        : {
            status: "deferred",
            providerCallId: "call-lost-codex-completion",
            toolName: "codex",
            arguments: { task: "inspect", kind: "analysis" },
            originalRequest: event.payload,
            acknowledgement: { kind: "reply", payload: { text: "started" } }
          }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "group:lost-completion", kind: "incoming", payload: { text: "run" } });
    await coordinator.waitForIdle();

    expect(store.listToolJobs("group:lost-completion")[0]?.status).toBe("succeeded");
    expect(observeCodexToolUsage).toHaveBeenCalledOnce();
    expect(observeCodexToolUsage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "group:lost-completion",
      attempt: 1,
      ok: true,
      status: "succeeded",
      usage: { input_tokens: 50, cached_input_tokens: 25, output_tokens: 5 }
    }));
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
    expect(store.listOutbox("group:unknown")[0]).toMatchObject({ status: "dead", attempts: 3 });

    connected = false;
    coordinator.enqueueEvent({ sessionId: "group:reconnect", kind: "incoming", payload: { text: "reconnect:1" } });
    coordinator.enqueueEvent({ sessionId: "group:reconnect", kind: "incoming", payload: { text: "reconnect:2" } });
    await waitUntil(() => store.listOutbox("group:reconnect")[0]?.status === "pending");
    await coordinator.waitForIdle();
    expect(attempts.get("reconnect:1")).toBe(1);
    expect(attempts.get("reconnect:2")).toBeUndefined();
    expect(store.listOutbox("group:reconnect")[0]).toMatchObject({ status: "pending", attempts: 1 });

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
    const deferredTool = oldStore.deferTurn({
      turnId: toolTurn.turn.id,
      workerId: "old-turn",
      job: {
        providerCallId: "old-call",
        toolName: "codex",
        taskKind: "local",
        originalRequest: toolTurn.event.payload,
        arguments: { task: "recover me", kind: "local" }
      },
      acknowledgement: {
        kind: "reply",
        deliveryPartition: "qq-tool-recovery",
        payload: { text: "old ack" }
      }
    });
    deliverPersistedOutbox(oldStore, deferredTool.acknowledgement.id, "old-ack");
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
    expect(delivered).toEqual(expect.arrayContaining(["recover delivery", "pending turn"]));
    expect(delivered).not.toContain("old ack");
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
    deliverPersistedOutbox(store, deferred.acknowledgement.id, "old-ack");
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
    deliverPersistedOutbox(store, deferred.acknowledgement.id, "old-ack");
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
          toolName: "codex",
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

  it("persists an image dispatch, acknowledges immediately, and completes it through the generic tool runner", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const runDeferredTool = vi.fn(async () => ({
      status: "succeeded" as const,
      result: { ok: true, image: { url: "/generated-images/async.png" } }
    }));
    const deliveries: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runDeferredTool,
      handleEvent: (event) => event.kind === "tool_completion"
        ? completedReply("image completed")
        : {
            status: "deferred",
            providerCallId: "call-image-1",
            toolName: "generate_img",
            arguments: { prompt: "月球基地" },
            originalRequest: event.payload,
            acknowledgement: { kind: "reply", payload: { text: "image queued" } }
          },
      deliverOutbox: (outbox) => deliveries.push((outbox.payload as { text: string }).text)
    }));

    coordinator.resume();
    coordinator.enqueueEvent({ sessionId: "private:image", kind: "incoming", payload: { text: "draw" } });
    await coordinator.waitForIdle();

    expect(deliveries).toEqual(["image queued", "image completed"]);
    expect(runDeferredTool).toHaveBeenCalledOnce();
    expect(store.listToolJobs("private:image")[0]).toMatchObject({
      toolName: "generate_img",
      status: "succeeded"
    });
  });

  it("starts a deferred tool while its dispatch acknowledgement remains in flight", async () => {
    const store = trackStore(new SessionStore({ databasePath: ":memory:" }));
    const dispatchDeliveryStarted = deferred<void>();
    const releaseDispatchDelivery = deferred<void>();
    const toolStarted = deferred<void>();
    const deliveries: string[] = [];
    const coordinator = trackCoordinator(createCoordinator({
      store,
      runDeferredTool: async () => {
        toolStarted.resolve();
        return { status: "succeeded", result: { ok: true } };
      },
      handleEvent: (event) => event.kind === "tool_completion"
        ? completedReply("callback complete")
        : {
            status: "deferred",
            providerCallId: "call-dispatch-before-worker",
            toolName: "generate_img",
            arguments: { prompt: "月球基地" },
            originalRequest: event.payload,
            acknowledgement: { kind: "reply", payload: { text: "dispatch started" } }
          },
      deliverOutbox: async (outbox) => {
        const text = (outbox.payload as { text: string }).text;
        if (text === "dispatch started") {
          dispatchDeliveryStarted.resolve();
          await releaseDispatchDelivery.promise;
        }
        deliveries.push(text);
      }
    }));

    coordinator.resume();
    coordinator.enqueueEvent({
      sessionId: "private:dispatch-before-worker",
      kind: "incoming",
      payload: { text: "draw" }
    });

    await dispatchDeliveryStarted.promise;
    await toolStarted.promise;
    await waitUntil(() => store.listOutbox("private:dispatch-before-worker").length === 2);
    expect(store.listToolJobs("private:dispatch-before-worker")[0]).toMatchObject({ status: "succeeded" });
    expect(store.listOutbox("private:dispatch-before-worker")).toEqual([
      expect.objectContaining({ status: "sending", payload: { text: "dispatch started" } }),
      expect.objectContaining({ status: "pending", payload: { text: "callback complete" } })
    ]);
    expect(deliveries).toEqual([]);

    releaseDispatchDelivery.resolve();
    await coordinator.waitForIdle();

    expect(deliveries).toEqual(["dispatch started", "callback complete"]);
    expect(store.listToolJobs("private:dispatch-before-worker")[0]).toMatchObject({ status: "succeeded" });
  });
});

interface CoordinatorHarnessOptions {
  store: SessionStore;
  handleEvent?: (
    event: SessionEventRecord,
    context: SessionTurnContext
  ) => SessionHandleResult | Promise<SessionHandleResult>;
  deliverOutbox?: ConstructorParameters<typeof SessionCoordinator>[0]["deliverOutbox"];
  runner?: CodexRunner;
  maxOutboxAttempts?: number;
  outboxRetryDelayMs?: number;
  outboxDisconnectedProbeDelayMs?: number;
  codexMaxConcurrency?: number;
  cleanupCodexProcess?: ConstructorParameters<typeof SessionCoordinator>[0]["cleanupCodexProcess"];
  runDeferredTool?: ConstructorParameters<typeof SessionCoordinator>[0]["runDeferredTool"];
  observeCodexToolUsage?: ConstructorParameters<typeof SessionCoordinator>[0]["observeCodexToolUsage"];
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
    runDeferredTool: options.runDeferredTool,
    observeCodexToolUsage: options.observeCodexToolUsage,
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

function deliverPersistedOutbox(store: SessionStore, outboxId: string, workerId: string) {
  const outbox = store.getOutbox(outboxId)!;
  const claimed = store.claimNextOutbox({ workerId, sessionId: outbox.sessionId })!;
  expect(claimed.id).toBe(outboxId);
  store.finishOutbox({ outboxId, workerId, outcome: "sent" });
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
