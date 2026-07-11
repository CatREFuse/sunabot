const DEFAULT_TASK_TIMEOUT_MS = 300_000;

export interface SessionActorTaskContext<TSessionId extends string = string> {
  sessionId: TSessionId;
  signal: AbortSignal;
}

export type SessionActorTaskHandler<TPayload, TResult, TSessionId extends string = string> = (
  payload: TPayload,
  context: SessionActorTaskContext<TSessionId>
) => TResult | Promise<TResult>;

export interface SessionActorTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SessionActorSchedulerOptions<TPayload, TResult, TSessionId extends string = string> {
  handler: SessionActorTaskHandler<TPayload, TResult, TSessionId>;
  maxConcurrency: number;
  timeoutMs?: number;
  timers?: SessionActorTimers;
}

export interface SessionActorEnqueueOptions {
  timeoutMs?: number;
}

export class SessionActorTaskTimeoutError extends Error {
  readonly sessionId: string;
  readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`Session task timed out after ${timeoutMs}ms: ${sessionId}`);
    this.name = "SessionActorTaskTimeoutError";
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }
}

interface QueuedTask<TPayload, TResult> {
  payload: TPayload;
  timeoutMs: number;
  resolve: (result: TResult | PromiseLike<TResult>) => void;
  reject: (error: unknown) => void;
}

interface SessionState<TPayload, TResult> {
  active: boolean;
  ready: boolean;
  queue: Array<QueuedTask<TPayload, TResult>>;
}

type TaskOutcome<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error: unknown };

const defaultTimers: SessionActorTimers = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  }
};

/**
 * Runs at most one task per session while sharing a fair global concurrency cap.
 * Persistence and replay remain the responsibility of the caller.
 *
 * A timed-out handler receives an aborted signal and its scheduler lease is
 * released immediately. Handlers must honor that signal to stop underlying
 * side effects after the timeout.
 */
export class SessionActorScheduler<
  TPayload,
  TResult = void,
  TSessionId extends string = string
> {
  private readonly handler: SessionActorTaskHandler<TPayload, TResult, TSessionId>;
  private readonly maxConcurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly timers: SessionActorTimers;
  private readonly sessions = new Map<TSessionId, SessionState<TPayload, TResult>>();
  private readonly readySessions: TSessionId[] = [];
  private readonly sessionIdleWaiters = new Map<TSessionId, Set<() => void>>();
  private readonly drainWaiters = new Set<() => void>();
  private activeCount = 0;

  constructor(options: SessionActorSchedulerOptions<TPayload, TResult, TSessionId>) {
    if (typeof options.handler !== "function") {
      throw new TypeError("Session actor handler must be a function.");
    }
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new RangeError("Session actor maxConcurrency must be a positive integer.");
    }

    this.handler = options.handler;
    this.maxConcurrency = options.maxConcurrency;
    this.defaultTimeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
    this.timers = options.timers ?? defaultTimers;
  }

  enqueue(
    sessionId: TSessionId,
    payload: TPayload,
    options: SessionActorEnqueueOptions = {}
  ): Promise<TResult> {
    const timeoutMs = validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs);
    const state = this.sessions.get(sessionId) ?? this.createSession(sessionId);
    const result = new Promise<TResult>((resolve, reject) => {
      state.queue.push({ payload, timeoutMs, resolve, reject });
    });

    if (!state.active) this.markReady(sessionId, state);
    this.pump();
    return result;
  }

  whenIdle(sessionId: TSessionId): Promise<void> {
    if (!this.sessions.has(sessionId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.sessionIdleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.sessionIdleWaiters.set(sessionId, waiters);
    });
  }

  drain(): Promise<void> {
    if (this.sessions.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  private createSession(sessionId: TSessionId) {
    const state: SessionState<TPayload, TResult> = {
      active: false,
      ready: false,
      queue: []
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private markReady(sessionId: TSessionId, state: SessionState<TPayload, TResult>) {
    if (state.active || state.ready || state.queue.length === 0) return;
    state.ready = true;
    this.readySessions.push(sessionId);
  }

  private pump() {
    while (this.activeCount < this.maxConcurrency && this.readySessions.length > 0) {
      const sessionId = this.readySessions.shift()!;
      const state = this.sessions.get(sessionId);
      if (!state) continue;
      state.ready = false;
      if (state.active) continue;

      const task = state.queue.shift();
      if (!task) {
        this.sessions.delete(sessionId);
        this.resolveSessionIdle(sessionId);
        continue;
      }

      state.active = true;
      this.activeCount += 1;
      void this.runTask(sessionId, task).then(
        (result) => this.finishTask(sessionId, state, task, { ok: true, result }),
        (error) => this.finishTask(sessionId, state, task, { ok: false, error })
      );
    }
    this.resolveDrainIfIdle();
  }

  private runTask(sessionId: TSessionId, task: QueuedTask<TPayload, TResult>): Promise<TResult> {
    const controller = new AbortController();
    let handlerResult: Promise<TResult>;
    try {
      handlerResult = Promise.resolve(this.handler(task.payload, {
        sessionId,
        signal: controller.signal
      }));
    } catch (error) {
      handlerResult = Promise.reject(error);
    }

    return new Promise<TResult>((resolve, reject) => {
      let settled = false;
      const timer = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new SessionActorTaskTimeoutError(sessionId, task.timeoutMs);
        controller.abort(error);
        reject(error);
      }, task.timeoutMs);

      handlerResult.then(
        (result) => {
          if (settled) return;
          settled = true;
          this.timers.clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.timers.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private finishTask(
    sessionId: TSessionId,
    state: SessionState<TPayload, TResult>,
    task: QueuedTask<TPayload, TResult>,
    outcome: TaskOutcome<TResult>
  ) {
    state.active = false;
    this.activeCount -= 1;

    if (state.queue.length > 0) {
      this.markReady(sessionId, state);
    } else if (this.sessions.get(sessionId) === state) {
      this.sessions.delete(sessionId);
    }

    if (outcome.ok) task.resolve(outcome.result);
    else task.reject(outcome.error);

    this.pump();

    if (!this.sessions.has(sessionId)) this.resolveSessionIdle(sessionId);
    this.resolveDrainIfIdle();
  }

  private resolveSessionIdle(sessionId: TSessionId) {
    const waiters = this.sessionIdleWaiters.get(sessionId);
    if (!waiters) return;
    this.sessionIdleWaiters.delete(sessionId);
    for (const resolve of waiters) resolve();
  }

  private resolveDrainIfIdle() {
    if (this.sessions.size > 0 || this.activeCount > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function validateTimeout(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Session actor timeoutMs must be a positive finite number.");
  }
  return value;
}
