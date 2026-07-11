import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  cleanupPersistedCodexProcess,
  type CodexRunner,
  type CodexProcessCleanupResult,
  type CodexProcessIdentity,
  type CodexToolInput,
  type CodexToolResult
} from "./codexTool.js";
import { SessionActorScheduler, SessionActorTaskTimeoutError } from "./sessionActor.js";
import {
  type ClaimedTurn,
  type EnqueueSessionEventInput,
  type EnqueueSessionEventResult,
  type OutboxDraft,
  type OutboxRecord,
  SessionStore,
  type SessionEventRecord,
  type ToolJobRecord,
  type TurnRecord
} from "./sessionStore.js";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_OUTBOX_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_SESSION_CONCURRENCY = 16;
const DEFAULT_OUTBOX_CONCURRENCY = 8;
const DEFAULT_OUTBOX_ATTEMPTS = 3;
const DEFAULT_OUTBOX_RETRY_DELAY_MS = 250;
const DEFAULT_OUTBOX_DISCONNECTED_PROBE_DELAY_MS = 5_000;
const IDLE_POLL_MS = 2;

export interface CodexCoordinatorSettings {
  enabled: boolean;
  model?: string;
  executable?: string;
  timeoutMs: number;
  maxConcurrency: number;
  workspacePath: string;
  jobRoot: string;
  authFile?: string;
}

export interface SessionTurnContext {
  signal: AbortSignal;
  turn: TurnRecord;
}

export type SessionHandleResult =
  | {
      status: "completed" | "no_reply";
      result?: unknown;
      outbox?: OutboxDraft[];
    }
  | {
      status: "failed";
      result?: unknown;
      error?: unknown;
      outbox?: OutboxDraft[];
    }
  | {
      status: "deferred";
      providerCallId: string;
      arguments: CodexToolInput;
      originalRequest: unknown;
      acknowledgement: OutboxDraft;
      result?: unknown;
    };

export interface OutboxDeliveryContext {
  signal: AbortSignal;
}

export interface SessionCoordinatorOptions {
  store: SessionStore;
  handleEvent(
    event: SessionEventRecord,
    context: SessionTurnContext
  ): SessionHandleResult | Promise<SessionHandleResult>;
  deliverOutbox(
    outbox: OutboxRecord,
    context: OutboxDeliveryContext
  ): unknown | Promise<unknown>;
  codexRunner: CodexRunner;
  codexSettings(): CodexCoordinatorSettings;
  turnTimeoutMs?: number;
  outboxTimeoutMs?: number;
  maxSessionConcurrency?: number;
  maxOutboxConcurrency?: number;
  maxOutboxAttempts?: number;
  outboxRetryDelayMs?: number;
  outboxDisconnectedProbeDelayMs?: number;
  leaseMs?: number;
  workerId?: string;
  clock?: () => number;
  isDisconnectedError?: (error: unknown) => boolean;
  cleanupCodexProcess?: (identity: CodexProcessIdentity) => Promise<CodexProcessCleanupResult>;
}

export interface SessionCoordinatorIdleOptions {
  includeTurns?: boolean;
  includeOutbox?: boolean;
  includeTools?: boolean;
  timeoutMs?: number;
}

export interface SessionEnqueueOptions {
  schedule?: boolean;
}

interface ClaimState {
  readonly controller: AbortController;
  finalized: boolean;
  stopRenewal: () => void;
}

interface ClaimedTurnTask {
  claim: ClaimedTurn;
  state: ClaimState;
}

interface ClaimedOutboxTask {
  outbox: OutboxRecord;
  state: ClaimState;
}

interface ClaimedToolTask {
  job: ToolJobRecord;
  settings: CodexCoordinatorSettings;
  state: ClaimState;
}

/** An explicit signal that outbound delivery must wait for the transport to reconnect. */
export class OutboxDisconnectedError extends Error {
  readonly code = "OUTBOX_DISCONNECTED";

  constructor(message = "Outbound transport is disconnected.") {
    super(message);
    this.name = "OutboxDisconnectedError";
  }
}

/**
 * Durable coordinator for Session turns, asynchronous Codex jobs, and outbound
 * delivery. SessionStore owns ordering and atomic state transitions; the actor
 * schedulers only provide bounded, fair in-process execution.
 */
export class SessionCoordinator {
  private readonly store: SessionStore;
  private readonly handleEvent: SessionCoordinatorOptions["handleEvent"];
  private readonly deliverOutbox: SessionCoordinatorOptions["deliverOutbox"];
  private readonly codexRunner: CodexRunner;
  private readonly codexSettings: SessionCoordinatorOptions["codexSettings"];
  private readonly turnTimeoutMs: number;
  private readonly outboxTimeoutMs: number;
  private readonly maxOutboxAttempts: number;
  private readonly outboxRetryDelayMs: number;
  private readonly outboxDisconnectedProbeDelayMs: number;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private readonly clock: () => number;
  private readonly disconnectedError: (error: unknown) => boolean;
  private readonly cleanupCodexProcess: (identity: CodexProcessIdentity) => Promise<CodexProcessCleanupResult>;
  private readonly turnActor: SessionActorScheduler<ClaimedTurnTask>;
  private readonly outboxActor: SessionActorScheduler<ClaimedOutboxTask>;
  private readonly toolActor: SessionActorScheduler<ClaimedToolTask>;
  private readonly turnClaims = new Map<string, ClaimState>();
  private readonly outboxClaims = new Map<string, ClaimState>();
  private readonly toolClaims = new Map<string, ClaimState>();
  private readonly wakeTimers = new Set<ReturnType<typeof setTimeout>>();
  private scanningTurns = false;
  private scanningOutbox = false;
  private scanningTools = false;
  private started = false;
  private stopped = false;
  // A disconnected transport admits one canary delivery per probe interval.
  // Any successful delivery clears this mode and releases the normal pump.
  private outboxPaused = false;
  private outboxProbeReady = false;
  private outboxProbeTimer?: ReturnType<typeof setTimeout>;

  constructor(options: SessionCoordinatorOptions) {
    this.store = options.store;
    this.handleEvent = options.handleEvent;
    this.deliverOutbox = options.deliverOutbox;
    this.codexRunner = options.codexRunner;
    this.codexSettings = options.codexSettings;
    this.turnTimeoutMs = positiveInteger(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS, "turnTimeoutMs");
    this.outboxTimeoutMs = positiveInteger(options.outboxTimeoutMs, DEFAULT_OUTBOX_TIMEOUT_MS, "outboxTimeoutMs");
    this.maxOutboxAttempts = positiveInteger(
      options.maxOutboxAttempts,
      DEFAULT_OUTBOX_ATTEMPTS,
      "maxOutboxAttempts"
    );
    this.outboxRetryDelayMs = nonNegativeInteger(
      options.outboxRetryDelayMs,
      DEFAULT_OUTBOX_RETRY_DELAY_MS,
      "outboxRetryDelayMs"
    );
    this.outboxDisconnectedProbeDelayMs = positiveInteger(
      options.outboxDisconnectedProbeDelayMs,
      DEFAULT_OUTBOX_DISCONNECTED_PROBE_DELAY_MS,
      "outboxDisconnectedProbeDelayMs"
    );
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
    this.workerId = options.workerId?.trim() || `session-coordinator:${randomUUID()}`;
    this.clock = options.clock ?? Date.now;
    this.disconnectedError = options.isDisconnectedError ?? isDefaultDisconnectedError;
    this.cleanupCodexProcess = options.cleanupCodexProcess ?? cleanupPersistedCodexProcess;

    this.turnActor = new SessionActorScheduler({
      maxConcurrency: positiveInteger(
        options.maxSessionConcurrency,
        DEFAULT_SESSION_CONCURRENCY,
        "maxSessionConcurrency"
      ),
      timeoutMs: this.turnTimeoutMs,
      handler: (task, context) => this.processTurn(task, context.signal)
    });
    this.outboxActor = new SessionActorScheduler({
      maxConcurrency: positiveInteger(
        options.maxOutboxConcurrency,
        DEFAULT_OUTBOX_CONCURRENCY,
        "maxOutboxConcurrency"
      ),
      timeoutMs: this.outboxTimeoutMs,
      handler: (task, context) => this.processOutbox(task, context.signal)
    });

    const initialCodex = this.codexSettings();
    this.toolActor = new SessionActorScheduler({
      maxConcurrency: positiveInteger(initialCodex.maxConcurrency, 1, "codex.maxConcurrency"),
      timeoutMs: positiveInteger(initialCodex.timeoutMs, DEFAULT_TURN_TIMEOUT_MS, "codex.timeoutMs") + 5_000,
      handler: (task, context) => this.processToolJob(task, context.signal)
    });
  }

  enqueueEvent(
    input: EnqueueSessionEventInput,
    options: SessionEnqueueOptions = {}
  ): EnqueueSessionEventResult {
    this.ensureStarted();
    const result = this.store.enqueueEvent(input);
    if (options.schedule !== false) this.scheduleTurns();
    return result;
  }

  /** Recover abandoned work on startup, or resume outbound delivery after reconnect. */
  resume() {
    this.ensureStarted();
    this.outboxPaused = false;
    this.outboxProbeReady = false;
    this.clearOutboxProbe();
    this.scheduleAll();
  }

  /**
   * Stops new scheduling and abandons active leases for recovery by the next
   * coordinator. The persistent store itself remains owned by the caller.
   */
  stop() {
    this.stopped = true;
    this.clearOutboxProbe();
    for (const timer of this.wakeTimers) clearTimeout(timer);
    this.wakeTimers.clear();
    for (const state of [...this.turnClaims.values(), ...this.outboxClaims.values(), ...this.toolClaims.values()]) {
      state.stopRenewal();
      state.controller.abort(new Error("Session coordinator stopped."));
    }
  }

  async waitForSessionIdle(sessionId: string, timeoutMs = 5_000) {
    const deadline = this.clock() + timeoutMs;
    while (this.hasSessionTurn(sessionId)) {
      if (this.clock() >= deadline) throw new Error(`Timed out waiting for Session ${sessionId} to become idle.`);
      await delay(IDLE_POLL_MS);
    }
    await this.turnActor.whenIdle(sessionId);
  }

  async waitForIdle(options: SessionCoordinatorIdleOptions = {}) {
    const includeTurns = options.includeTurns ?? true;
    const includeOutbox = options.includeOutbox ?? true;
    const includeTools = options.includeTools ?? true;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = this.clock() + timeoutMs;
    this.scheduleAll();
    while (
      (includeTurns && (this.turnClaims.size > 0 || this.scanningTurns)) ||
      (includeOutbox && (this.outboxClaims.size > 0 || this.scanningOutbox)) ||
      (includeTools && (this.toolClaims.size > 0 || this.scanningTools))
    ) {
      if (this.clock() >= deadline) throw new Error("Timed out waiting for SessionCoordinator to become idle.");
      await delay(IDLE_POLL_MS);
    }
  }

  private ensureStarted() {
    if (this.started && !this.stopped) return;
    if (this.stopped) throw new Error("SessionCoordinator has been stopped.");
    this.started = true;
    // The bot is single-owner. Reclaiming every lease gives immediate restart
    // recovery instead of waiting for an old process lease to expire.
    this.store.recoverAllLeases();
  }

  private scheduleAll() {
    if (!this.started || this.stopped) return;
    this.scheduleTurns();
    this.scheduleOutbox();
    this.scheduleTools();
  }

  private scheduleTurns() {
    if (!this.started || this.stopped || this.scanningTurns) return;
    this.scanningTurns = true;
    try {
      while (!this.stopped) {
        const claim = this.store.claimNextTurn({ workerId: this.workerId, leaseMs: this.leaseMs });
        if (!claim) break;
        const state = this.createClaimState(
          () => this.store.renewTurnLease(claim.turn.id, this.workerId, this.leaseMs)
        );
        this.turnClaims.set(claim.turn.id, state);
        void this.turnActor.enqueue(claim.event.sessionId, { claim, state }, {
          timeoutMs: this.turnTimeoutMs
        }).catch((error) => this.failTurnTask(claim, state, error)).finally(() => {
          state.stopRenewal();
          this.turnClaims.delete(claim.turn.id);
          this.deferScan(() => this.scheduleTurns());
        });
      }
    } finally {
      this.scanningTurns = false;
    }
  }

  private async processTurn(task: ClaimedTurnTask, actorSignal: AbortSignal) {
    const { claim, state } = task;
    const signal = combineSignals(actorSignal, state.controller.signal);
    try {
      const result = await this.handleEvent(claim.event, { signal, turn: claim.turn });
      this.assertClaimUsable(state, signal);
      if (result.status === "deferred") {
        const settings = this.codexSettings();
        if (!settings.enabled) throw new Error("Codex asynchronous work is disabled.");
        this.store.deferTurn({
          turnId: claim.turn.id,
          workerId: this.workerId,
          job: {
            providerCallId: requiredText(result.providerCallId, "providerCallId"),
            toolName: "codex",
            taskKind: codexKind(result.arguments),
            originalRequest: result.originalRequest,
            arguments: result.arguments
          },
          acknowledgement: result.acknowledgement,
          result: result.result
        });
        state.finalized = true;
        this.scheduleOutbox();
        this.scheduleTools();
        return;
      }

      this.store.finishTurn({
        turnId: claim.turn.id,
        workerId: this.workerId,
        outcome: result.status === "completed" ? "replied" : result.status,
        result: result.result,
        error: result.status === "failed" ? result.error : undefined,
        outbox: result.outbox
      });
      state.finalized = true;
      this.scheduleOutbox();
    } catch (error) {
      if (!state.finalized && !this.stopped) {
        this.store.finishTurn({
          turnId: claim.turn.id,
          workerId: this.workerId,
          outcome: signal.aborted ? "timed_out" : "failed",
          error: serializeError(error)
        });
        state.finalized = true;
      }
    } finally {
      this.deferScan(() => this.scheduleTurns());
    }
  }

  private failTurnTask(claim: ClaimedTurn, state: ClaimState, error: unknown) {
    if (state.finalized || this.stopped) return;
    state.finalized = true;
    try {
      this.store.finishTurn({
        turnId: claim.turn.id,
        workerId: this.workerId,
        outcome: error instanceof SessionActorTaskTimeoutError ? "timed_out" : "failed",
        error: serializeError(error)
      });
    } catch {
      // A late handler may have committed between the actor timeout and here.
    }
  }

  private scheduleOutbox() {
    if (
      !this.started ||
      this.stopped ||
      (this.outboxPaused && !this.outboxProbeReady) ||
      this.scanningOutbox
    ) return;
    this.scanningOutbox = true;
    try {
      while (!this.stopped && (!this.outboxPaused || this.outboxProbeReady)) {
        const outbox = this.store.claimNextOutbox({ workerId: this.workerId, leaseMs: this.leaseMs });
        if (!outbox) {
          if (this.outboxPaused) {
            this.outboxProbeReady = false;
            this.scheduleOutboxProbe();
          }
          break;
        }
        const isProbe = this.outboxPaused;
        if (isProbe) this.outboxProbeReady = false;
        const state = this.createClaimState(
          () => this.store.renewOutboxLease(outbox.id, this.workerId, this.leaseMs)
        );
        this.outboxClaims.set(outbox.id, state);
        void this.outboxActor.enqueue(outbox.sessionId, { outbox, state }, {
          timeoutMs: this.outboxTimeoutMs
        }).catch((error) => this.failOutboxTask(outbox, state, error)).finally(() => {
          state.stopRenewal();
          this.outboxClaims.delete(outbox.id);
          this.deferScan(() => this.scheduleOutbox());
        });
        if (isProbe) break;
      }
    } finally {
      this.scanningOutbox = false;
    }
  }

  private async processOutbox(task: ClaimedOutboxTask, actorSignal: AbortSignal) {
    const { outbox, state } = task;
    const signal = combineSignals(actorSignal, state.controller.signal);
    try {
      const result = await this.deliverOutbox(outbox, { signal });
      this.assertClaimUsable(state, signal);
      this.store.finishOutbox({
        outboxId: outbox.id,
        workerId: this.workerId,
        outcome: "sent",
        result
      });
      state.finalized = true;
      if (this.outboxPaused) {
        this.outboxPaused = false;
        this.outboxProbeReady = false;
        this.clearOutboxProbe();
        this.deferScan(() => this.scheduleOutbox());
      }
    } catch (error) {
      this.finishOutboxFailure(outbox, state, error);
    }
  }

  private failOutboxTask(outbox: OutboxRecord, state: ClaimState, error: unknown) {
    this.finishOutboxFailure(outbox, state, error);
  }

  private finishOutboxFailure(outbox: OutboxRecord, state: ClaimState, error: unknown) {
    if (state.finalized || this.stopped) return;
    state.finalized = true;
    try {
      if (this.disconnectedError(error)) {
        this.store.finishOutbox({
          outboxId: outbox.id,
          workerId: this.workerId,
          outcome: "retry",
          error: serializeError(error),
          availableAt: this.clock()
        });
        this.pauseOutboxUntilProbe();
        return;
      }
      if (outbox.attempts < this.maxOutboxAttempts) {
        const availableAt = this.clock() + this.outboxRetryDelayMs;
        this.store.finishOutbox({
          outboxId: outbox.id,
          workerId: this.workerId,
          outcome: "retry",
          error: serializeError(error),
          availableAt
        });
        this.wakeAt(availableAt, () => this.scheduleOutbox());
        if (this.outboxPaused) this.scheduleOutboxProbe();
        return;
      }
      this.store.finishOutbox({
        outboxId: outbox.id,
        workerId: this.workerId,
        outcome: "unknown",
        error: serializeError(error)
      });
      if (this.outboxPaused) this.scheduleOutboxProbe();
    } catch {
      // Recovery will reclaim the lease if persistence itself is unavailable.
    }
  }

  private scheduleTools() {
    if (!this.started || this.stopped || this.scanningTools) return;
    const settings = this.codexSettings();
    if (!settings.enabled) return;
    this.scanningTools = true;
    try {
      while (!this.stopped) {
        const job = this.store.claimNextToolJob({ workerId: this.workerId, leaseMs: this.leaseMs });
        if (!job) break;
        const jobSettings = this.codexSettings();
        const state = this.createClaimState(
          () => this.store.renewToolJobLease(
            job.id,
            this.workerId,
            this.leaseMs,
            job.attempts,
            job.attemptToken
          )
        );
        this.toolClaims.set(job.id, state);
        const actorKey = toolActorKey(job, jobSettings.workspacePath);
        void this.toolActor.enqueue(actorKey, { job, settings: jobSettings, state }, {
          timeoutMs: positiveInteger(jobSettings.timeoutMs, DEFAULT_TURN_TIMEOUT_MS, "codex.timeoutMs") + 5_000
        }).catch((error) => this.failToolTask(job, state, error)).finally(() => {
          state.stopRenewal();
          this.toolClaims.delete(job.id);
          this.deferScan(() => this.scheduleTools());
        });
      }
    } finally {
      this.scanningTools = false;
    }
  }

  private async processToolJob(task: ClaimedToolTask, actorSignal: AbortSignal) {
    const { job, settings, state } = task;
    const signal = combineSignals(actorSignal, state.controller.signal);
    const attemptToken = requiredText(job.attemptToken, "tool job attemptToken");
    let result: CodexToolResult;
    try {
      if (job.processIdentity) {
        const cleanup = await this.cleanupCodexProcess(job.processIdentity);
        this.assertClaimUsable(state, signal);
        if (cleanup.status === "unverified") {
          this.store.completeToolJob({
            jobId: job.id,
            workerId: this.workerId,
            attempt: job.attempts,
            attemptToken,
            status: "unknown",
            error: {
              code: "orphan_process_unverified",
              message: cleanup.message ?? "Recovered Codex process identity could not be verified."
            }
          });
          state.finalized = true;
          return;
        }
        this.store.clearRecoveredToolJobProcess(
          job.id,
          this.workerId,
          job.attempts,
          attemptToken,
          job.processIdentity.runToken
        );
      }
      result = await this.codexRunner.run(job.arguments as CodexToolInput, {
        jobId: job.id,
        jobDir: path.join(settings.jobRoot, job.id),
        workspacePath: settings.workspacePath,
        executable: settings.executable,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        authFile: settings.authFile,
        signal,
        attempt: job.attempts,
        runToken: attemptToken,
        onProcessStarted: (identity) => {
          this.store.recordToolJobProcess(
            job.id,
            this.workerId,
            job.attempts,
            attemptToken,
            identity
          );
        }
      });
      this.assertClaimUsable(state, signal);
      this.store.completeToolJob({
        jobId: job.id,
        workerId: this.workerId,
        attempt: job.attempts,
        attemptToken,
        status: result.status,
        result,
        error: result.ok ? undefined : result.error
      });
      state.finalized = true;
    } catch (error) {
      if (state.finalized || this.stopped) return;
      this.store.completeToolJob({
        jobId: job.id,
        workerId: this.workerId,
        attempt: job.attempts,
        attemptToken,
        status: signal.aborted ? "timed_out" : "failed",
        error: serializeError(error)
      });
      state.finalized = true;
    } finally {
      this.deferScan(() => this.scheduleTurns());
    }
  }

  private failToolTask(job: ToolJobRecord, state: ClaimState, error: unknown) {
    if (state.finalized || this.stopped) return;
    state.finalized = true;
    try {
      this.store.completeToolJob({
        jobId: job.id,
        workerId: this.workerId,
        attempt: job.attempts,
        attemptToken: requiredText(job.attemptToken, "tool job attemptToken"),
        status: error instanceof SessionActorTaskTimeoutError ? "timed_out" : "failed",
        error: serializeError(error)
      });
      this.scheduleTurns();
    } catch {
      // A concurrent terminal write or recovery owns the final state.
    }
  }

  private createClaimState(renew: () => boolean): ClaimState {
    const controller = new AbortController();
    const interval = setInterval(() => {
      if (!renew() && !controller.signal.aborted) {
        controller.abort(new Error("Persistent lease ownership was lost."));
      }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
    interval.unref?.();
    return {
      controller,
      finalized: false,
      stopRenewal: () => clearInterval(interval)
    };
  }

  private assertClaimUsable(state: ClaimState, signal: AbortSignal) {
    if (state.finalized) throw new Error("Persistent claim is already finalized.");
    if (signal.aborted) throw signal.reason ?? new Error("Persistent claim was aborted.");
    if (this.stopped) throw new Error("Session coordinator stopped.");
  }

  private hasSessionTurn(sessionId: string) {
    for (const turnId of this.turnClaims.keys()) {
      if (this.store.getTurn(turnId)?.sessionId === sessionId) return true;
    }
    return false;
  }

  private wakeAt(availableAt: number, callback: () => void) {
    const timer = setTimeout(() => {
      this.wakeTimers.delete(timer);
      callback();
    }, Math.max(0, availableAt - this.clock()));
    timer.unref?.();
    this.wakeTimers.add(timer);
  }

  private pauseOutboxUntilProbe() {
    this.outboxPaused = true;
    this.outboxProbeReady = false;
    this.scheduleOutboxProbe();
  }

  private scheduleOutboxProbe() {
    if (this.outboxProbeTimer) return;
    const timer = setTimeout(() => {
      if (this.outboxProbeTimer !== timer) return;
      this.outboxProbeTimer = undefined;
      if (!this.started || this.stopped || !this.outboxPaused) return;
      this.outboxProbeReady = true;
      this.scheduleOutbox();
    }, this.outboxDisconnectedProbeDelayMs);
    timer.unref?.();
    this.outboxProbeTimer = timer;
  }

  private clearOutboxProbe() {
    if (!this.outboxProbeTimer) return;
    clearTimeout(this.outboxProbeTimer);
    this.outboxProbeTimer = undefined;
  }

  private deferScan(callback: () => void) {
    queueMicrotask(callback);
  }
}

function toolActorKey(job: ToolJobRecord, workspacePath: string) {
  const kind = job.taskKind ?? codexKind(job.arguments as CodexToolInput);
  return kind === "local" ? `local:${path.resolve(workspacePath)}` : `${kind}:${job.id}`;
}

function codexKind(input: CodexToolInput) {
  const kind = input.kind;
  return kind === "local" || kind === "research" || kind === "analysis" ? kind : "analysis";
}

function combineSignals(...signals: AbortSignal[]) {
  if (signals.length === 1) return signals[0]!;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function isDefaultDisconnectedError(error: unknown) {
  if (error instanceof OutboxDisconnectedError) return true;
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = String(value?.code ?? "").toLowerCase();
  if (["outbox_disconnected", "enotconn", "econnreset", "econnrefused"].includes(code)) return true;
  const message = String(value?.message ?? error ?? "").toLowerCase();
  return /(?:onebot|websocket|transport|gateway).*(?:disconnect|not connected|closed)/u.test(message);
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof (error as NodeJS.ErrnoException).code === "string"
        ? { code: (error as NodeJS.ErrnoException).code }
        : {})
    };
  }
  return { message: String(error) };
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) throw new Error(`${name} must be a positive integer.`);
  return selected;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error(`${name} must be a non-negative integer.`);
  return selected;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
