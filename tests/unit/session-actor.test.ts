// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  SessionActorScheduler,
  SessionActorTaskTimeoutError,
  type SessionActorTimers
} from "../../services/sessions/sessionActor.js";

describe("SessionActorScheduler", () => {
  it("runs one task at a time in FIFO order within a session", async () => {
    const gates = new Map([
      ["first", deferred<void>()],
      ["second", deferred<void>()],
      ["third", deferred<void>()]
    ]);
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new SessionActorScheduler<string, string>({
      maxConcurrency: 4,
      handler: async (payload) => {
        starts.push(payload);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gates.get(payload)!.promise;
          return payload;
        } finally {
          active -= 1;
        }
      }
    });

    const first = scheduler.enqueue("group:1", "first");
    const second = scheduler.enqueue("group:1", "second");
    const third = scheduler.enqueue("group:1", "third");

    expect(starts).toEqual(["first"]);
    gates.get("first")!.resolve();
    await expect(first).resolves.toBe("first");
    expect(starts).toEqual(["first", "second"]);

    gates.get("second")!.resolve();
    await expect(second).resolves.toBe("second");
    expect(starts).toEqual(["first", "second", "third"]);

    gates.get("third")!.resolve();
    await expect(third).resolves.toBe("third");
    await scheduler.whenIdle("group:1");
    await scheduler.drain();
    expect(maximumActive).toBe(1);
  });

  it("runs different sessions in parallel up to the global limit", async () => {
    const gates = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
      ["c", deferred<void>()]
    ]);
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new SessionActorScheduler<string>({
      maxConcurrency: 2,
      handler: async (payload) => {
        starts.push(payload);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gates.get(payload)!.promise;
        } finally {
          active -= 1;
        }
      }
    });

    const a = scheduler.enqueue("group:a", "a");
    const b = scheduler.enqueue("group:b", "b");
    const c = scheduler.enqueue("group:c", "c");

    expect(starts).toEqual(["a", "b"]);
    gates.get("a")!.resolve();
    await a;
    expect(starts).toEqual(["a", "b", "c"]);

    gates.get("b")!.resolve();
    gates.get("c")!.resolve();
    await Promise.all([b, c]);
    expect(maximumActive).toBe(2);
  });

  it("round-robins ready sessions instead of letting one backlog monopolize the limit", async () => {
    const gates = new Map([
      ["a1", deferred<void>()],
      ["a2", deferred<void>()],
      ["b1", deferred<void>()],
      ["c1", deferred<void>()]
    ]);
    const starts: string[] = [];
    const scheduler = new SessionActorScheduler<string>({
      maxConcurrency: 1,
      handler: async (payload) => {
        starts.push(payload);
        await gates.get(payload)!.promise;
      }
    });

    const a1 = scheduler.enqueue("group:a", "a1");
    const a2 = scheduler.enqueue("group:a", "a2");
    const b1 = scheduler.enqueue("group:b", "b1");
    const c1 = scheduler.enqueue("group:c", "c1");

    gates.get("a1")!.resolve();
    await a1;
    expect(starts).toEqual(["a1", "b1"]);

    gates.get("b1")!.resolve();
    await b1;
    expect(starts).toEqual(["a1", "b1", "c1"]);

    gates.get("c1")!.resolve();
    await c1;
    expect(starts).toEqual(["a1", "b1", "c1", "a2"]);

    gates.get("a2")!.resolve();
    await a2;
  });

  it("does not cancel an active task when a later task is submitted", async () => {
    const firstGate = deferred<void>();
    let firstSignal: AbortSignal | undefined;
    const starts: string[] = [];
    const scheduler = new SessionActorScheduler<string>({
      maxConcurrency: 1,
      handler: async (payload, context) => {
        starts.push(payload);
        if (payload === "first") {
          firstSignal = context.signal;
          await firstGate.promise;
        }
      }
    });

    const first = scheduler.enqueue("group:1", "first");
    const second = scheduler.enqueue("group:1", "second");

    expect(firstSignal?.aborted).toBe(false);
    expect(starts).toEqual(["first"]);
    firstGate.resolve();
    await first;
    await second;
    expect(firstSignal?.aborted).toBe(false);
    expect(starts).toEqual(["first", "second"]);
  });

  it("continues a session queue after a handler failure", async () => {
    const starts: string[] = [];
    const scheduler = new SessionActorScheduler<string, string>({
      maxConcurrency: 1,
      handler: (payload) => {
        starts.push(payload);
        if (payload === "bad") throw new Error("boom");
        return `ok:${payload}`;
      }
    });

    const failed = scheduler.enqueue("group:1", "bad");
    const recovered = scheduler.enqueue("group:1", "good");

    await expect(failed).rejects.toThrow("boom");
    await expect(recovered).resolves.toBe("ok:good");
    expect(starts).toEqual(["bad", "good"]);
    await scheduler.drain();
  });

  it("aborts a timed-out task and continues with the next queued task", async () => {
    const manual = createManualTimers();
    const starts: string[] = [];
    let timedOutSignal: AbortSignal | undefined;
    const scheduler = new SessionActorScheduler<string>({
      maxConcurrency: 1,
      timeoutMs: 1_000,
      timers: manual.timers,
      handler: async (payload, context) => {
        starts.push(payload);
        if (payload !== "stuck") return;
        timedOutSignal = context.signal;
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      }
    });

    const stuck = scheduler.enqueue("group:1", "stuck", { timeoutMs: 50 });
    const next = scheduler.enqueue("group:1", "next");
    const rejection = expect(stuck).rejects.toMatchObject({
      name: "SessionActorTaskTimeoutError",
      sessionId: "group:1",
      timeoutMs: 50
    });

    manual.advance(49);
    await flushMicrotasks();
    expect(starts).toEqual(["stuck"]);
    manual.advance(1);
    await rejection;
    await next;

    expect(timedOutSignal?.aborted).toBe(true);
    expect(timedOutSignal?.reason).toBeInstanceOf(SessionActorTaskTimeoutError);
    expect(starts).toEqual(["stuck", "next"]);
    await scheduler.drain();
  });

  it("exposes per-session idle and global drain waiters", async () => {
    const aGate = deferred<void>();
    const bGate = deferred<void>();
    const scheduler = new SessionActorScheduler<string>({
      maxConcurrency: 2,
      handler: (payload) => payload === "a" ? aGate.promise : bGate.promise
    });
    const a = scheduler.enqueue("group:a", "a");
    const b = scheduler.enqueue("group:b", "b");
    let aIdle = false;
    let allIdle = false;
    const idlePromise = scheduler.whenIdle("group:a").then(() => { aIdle = true; });
    const drainPromise = scheduler.drain().then(() => { allIdle = true; });

    aGate.resolve();
    await a;
    await idlePromise;
    expect(aIdle).toBe(true);
    expect(allIdle).toBe(false);

    bGate.resolve();
    await b;
    await drainPromise;
    expect(allIdle).toBe(true);
    await expect(scheduler.whenIdle("missing")).resolves.toBeUndefined();
  });

  it("rejects invalid concurrency and timeout configuration", () => {
    expect(() => new SessionActorScheduler({
      maxConcurrency: 0,
      handler: vi.fn()
    })).toThrow("maxConcurrency");
    expect(() => new SessionActorScheduler({
      maxConcurrency: 1,
      timeoutMs: 0,
      handler: vi.fn()
    })).toThrow("timeoutMs");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createManualTimers() {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  const timers: SessionActorTimers = {
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout(handle) {
      scheduled.delete(Number(handle));
    }
  };

  return {
    timers,
    advance(delayMs: number) {
      now += delayMs;
      while (true) {
        const due = [...scheduled.entries()]
          .filter(([, task]) => task.at <= now)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        scheduled.delete(due[0]);
        due[1].callback();
      }
    }
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
