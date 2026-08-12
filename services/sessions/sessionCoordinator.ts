import { randomUUID } from "node:crypto";
import path from "node:path";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import {
  type CodexRunner,
  type CodexProcessCleanupResult,
  type CodexProcessIdentity,
  type CodexToolInput
} from "../../packages/contracts/tools/codex.js";
import { SessionActorScheduler } from "./sessionActor.js";
import { createOutboxDeliveryContext } from "./outboxDeliveryContext.js";
import { OutboxPartitionScheduler } from "./outboxPartitionScheduler.js";
import { SessionPersistenceMonitor } from "./sessionPersistenceMonitor.js";
import { SessionToolJobProcessor } from "./sessionToolJobProcessor.js";
import {
  type SessionHandleResult
} from "./sessionTurnResultCoordinator.js";
import {
  createSessionTurnServices,
  type SessionTurnServices
} from "./sessionTurnServices.js";
import {
  createDeferredTurnOutboxEmitter,
  emitTurnHeldOutbox,
  emitTurnOutbox,
  type TurnHeldOutboxHandle
} from "./turnOutboxEmitter.js";
import type {
  ClaimedToolTask,
  CodexCoordinatorSettings,
  CodexResultFinalizer,
  CodexToolUsageObserver,
  DeferredToolRunner,
  OutboxDeliveryContext,
  SessionClaimState as ClaimState
} from "./sessionCoordinatorTypes.js";
import {
  type ClaimedTurn,
  type EnqueueSessionEventInput,
  type EnqueueSessionEventResult,
  type HeldOutboxAppendOptions,
  type HeldOutboxReplyGateResolver,
  type OutboxDraft,
  type OutboxRecord,
  SessionStore,
  type SessionEventRecord,
  type ToolJobRecord,
  type TurnRecord,
  type UpdateActiveSessionEventInput
} from "./sessionStore.js";

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_OUTBOX_TIMEOUT_MS = 30_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_SESSION_CONCURRENCY = 16;
const DEFAULT_OUTBOX_CONCURRENCY = 8;
const DEFAULT_OUTBOX_ATTEMPTS = 3;
const DEFAULT_OUTBOX_RETRY_DELAY_MS = 250;
const DEFAULT_OUTBOX_DISCONNECTED_PROBE_DELAY_MS = 5_000;
const TOOL_ACTOR_SETTLEMENT_GRACE_MS = 5_000;
const IDLE_POLL_MS = 2;

export type { CodexCoordinatorSettings, OutboxDeliveryContext } from "./sessionCoordinatorTypes.js";
export type { SessionHandleResult } from "./sessionTurnResultCoordinator.js";

export interface SessionTurnContext {
  signal: AbortSignal;
  turn: TurnRecord;
  emitOutbox(draft: OutboxDraft): Promise<OutboxRecord>;
  emitDeferredOutbox(draft: OutboxDraft): Promise<OutboxRecord>;
  appendHeldOutbox(
    draft: OutboxDraft,
    hold: HeldOutboxAppendOptions
  ): Promise<TurnHeldOutboxHandle>;
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
  runDeferredTool?: DeferredToolRunner;
  finalizeCodexResult?: CodexResultFinalizer;
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
  observeCodexToolUsage?: CodexToolUsageObserver;
  resolveHeldReplyGate?: HeldOutboxReplyGateResolver;
  onPersistenceError?: (error: unknown, context: { code: string; recordId: string }) => void;
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

interface ClaimedTurnTask {
  claim: ClaimedTurn;
  state: ClaimState;
}

interface ClaimedOutboxTask {
  outbox: OutboxRecord;
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
  private readonly codexSettings: SessionCoordinatorOptions["codexSettings"];
  private readonly turnTimeoutMs: number;
  private readonly outboxTimeoutMs: number;
  private readonly maxOutboxAttempts: number;
  private readonly outboxRetryDelayMs: number;
  private readonly outboxDisconnectedProbeDelayMs: number;
  private readonly outboxPartitions: OutboxPartitionScheduler;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private readonly clock: () => number;
  private readonly disconnectedError: (error: unknown) => boolean;
  private readonly resolveHeldReplyGate?: HeldOutboxReplyGateResolver;
  private readonly persistenceMonitor: SessionPersistenceMonitor;
  private readonly toolJobProcessor: SessionToolJobProcessor;
  private readonly turnServices: SessionTurnServices;
  private readonly turnActor: SessionActorScheduler<ClaimedTurnTask>;
  private readonly outboxActor: SessionActorScheduler<ClaimedOutboxTask>;
  private readonly toolActor: SessionActorScheduler<ClaimedToolTask>;
  private readonly turnClaims = new Map<string, ClaimState>();
  private readonly outboxClaims = new Map<string, ClaimState>();
  private readonly outboxClaimPartitions = new Map<string, string>();
  private readonly toolClaims = new Map<string, ClaimState>();
  private readonly wakeTimers = new Set<ReturnType<typeof setTimeout>>();
  private scanningOutbox = false;
  private scanningTools = false;
  private started = false;
  private stopped = false;

  constructor(options: SessionCoordinatorOptions) {
    this.store = options.store;
    this.handleEvent = options.handleEvent;
    this.deliverOutbox = options.deliverOutbox;
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
    this.outboxPartitions = new OutboxPartitionScheduler(
      this.outboxDisconnectedProbeDelayMs,
      () => !this.started || this.stopped,
      () => this.scheduleOutbox()
    );
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
    this.workerId = options.workerId?.trim() || `session-coordinator:${randomUUID()}`;
    this.clock = options.clock ?? Date.now;
    this.disconnectedError = options.isDisconnectedError ?? isDefaultDisconnectedError;
    this.resolveHeldReplyGate = options.resolveHeldReplyGate;
    this.persistenceMonitor = new SessionPersistenceMonitor(this.leaseMs, this.clock, options.onPersistenceError);
    this.turnServices = createSessionTurnServices({
      store: this.store,
      workerId: this.workerId,
      codexSettings: this.codexSettings,
      clock: this.clock,
      ensureStarted: () => this.ensureStarted(),
      isActive: () => this.started && !this.stopped,
      isStopped: () => this.stopped,
      scheduleTurns: () => this.scheduleTurns(),
      scheduleOutbox: () => this.scheduleOutbox(),
      scheduleTools: () => this.scheduleTools(),
      serializeError,
      resolveHeldReplyGate: this.resolveHeldReplyGate
    });
    this.toolJobProcessor = new SessionToolJobProcessor({
      store: this.store,
      codexRunner: options.codexRunner,
      cleanupCodexProcess: options.cleanupCodexProcess ?? (async () => ({
        status: "unverified",
        message: "Codex process cleanup port is not configured."
      })),
      runDeferredTool: options.runDeferredTool,
      finalizeCodexResult: options.finalizeCodexResult,
      observeCodexToolUsage: options.observeCodexToolUsage,
      workerId: this.workerId,
      isStopped: () => this.stopped,
      assertClaimUsable: (state, signal) => this.assertClaimUsable(state, signal),
      scheduleTurns: () => this.scheduleTurns(),
      deferTurns: () => this.deferScan(() => this.scheduleTurns())
    });

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
      handler: (task, context) => this.toolJobProcessor.process(task, context.signal)
    });
  }

  enqueueEvent(input: EnqueueSessionEventInput, options: SessionEnqueueOptions = {}): EnqueueSessionEventResult {
    return this.turnServices.wake.enqueueEvent(input, options.schedule !== false);
  }

  listActiveEvents(kind: string) {
    return this.turnServices.wake.listActiveEvents(kind);
  }

  reschedulePendingEvent(eventId: string, availableAt: number) {
    return this.turnServices.wake.reschedulePendingEvent(eventId, availableAt);
  }

  bumpActiveEventAvailableAt(eventId: string, kind: string, availableAt: number) {
    return this.turnServices.wake.bumpActiveEventAvailableAt(eventId, kind, availableAt);
  }

  updateActiveEvent(input: UpdateActiveSessionEventInput) {
    return this.turnServices.wake.updateActiveEvent(input);
  }

  /** Recover abandoned work on startup, or resume one outbound transport partition after reconnect. */
  resume(deliveryPartition?: string) {
    this.ensureStarted();
    if (deliveryPartition != null) this.outboxPartitions.resume(requiredText(deliveryPartition, "deliveryPartition"));
    this.scheduleAll();
  }

  /**
   * Stops new scheduling and abandons active leases for recovery by the next
   * coordinator. The persistent store itself remains owned by the caller.
   */
  stop() {
    this.stopped = true;
    this.outboxPartitions.stop();
    this.turnServices.wake.clear();
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
      (includeTurns && (this.turnClaims.size > 0 || this.turnServices.wake.scanning)) ||
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
    this.store.recoverAllLeases(this.resolveHeldReplyGate);
  }

  private scheduleAll() {
    if (!this.started || this.stopped) return;
    this.scheduleTurns();
    this.scheduleOutbox();
    this.scheduleTools();
  }

  private scheduleTurns() {
    this.turnServices.wake.scan(() => {
      while (!this.stopped) {
        const claim = this.store.claimNextTurn({ workerId: this.workerId, leaseMs: this.leaseMs });
        if (!claim) break;
        const state = this.persistenceMonitor.claim(
          () => this.store.renewTurnLease(claim.turn.id, this.workerId, this.leaseMs),
          claim.turn.id
        );
        this.turnClaims.set(claim.turn.id, state);
        void this.turnActor.enqueue(claim.event.sessionId, { claim, state }, {
          timeoutMs: sessionEventTimeoutMs(claim.event.kind, this.turnTimeoutMs)
        }).catch((error) => this.turnServices.results.failActorTask(claim, state, error)).finally(() => {
          state.stopRenewal();
          this.turnClaims.delete(claim.turn.id);
          this.deferScan(() => this.scheduleTurns());
        });
      }
    });
  }

  private async processTurn(task: ClaimedTurnTask, actorSignal: AbortSignal) {
    const { claim, state } = task;
    const signal = combineSignals(actorSignal, state.controller.signal);
    let outboxOrdinal = 0;
    const deferredOutbox = createDeferredTurnOutboxEmitter(
      this.store, claim, () => ++outboxOrdinal, () => this.scheduleOutbox()
    );
    const rejectDeferredOutbox = () => deferredOutbox.reject(
      signal.reason ?? new Error("Session turn ended before it became deferred.")
    );
    signal.addEventListener("abort", rejectDeferredOutbox, { once: true });
    try {
      const emitOutbox = (draft: OutboxDraft) => emitTurnOutbox(
        this.store, claim, this.workerId, ++outboxOrdinal, draft,
        () => this.assertClaimUsable(state, signal), () => this.scheduleOutbox());
      const appendHeldOutbox = (draft: OutboxDraft, hold: HeldOutboxAppendOptions) =>
        this.resolveHeldReplyGate
          ? emitTurnHeldOutbox(
              this.store, claim, this.workerId, ++outboxOrdinal, draft, hold,
              () => this.assertClaimUsable(state, signal), () => this.scheduleOutbox()
            )
          : Promise.reject(new Error("Held outbox reply gate resolver is unavailable."));
      const result = await this.handleEvent(claim.event, {
        signal,
        turn: claim.turn,
        emitOutbox,
        emitDeferredOutbox: deferredOutbox.emit,
        appendHeldOutbox
      });
      this.assertClaimUsable(state, signal);
      this.turnServices.results.apply(claim, state, result);
      if (result.status === "deferred") deferredOutbox.release(result.providerCallId);
      else deferredOutbox.reject(new Error(`Session turn completed as ${result.status}, not deferred.`));
    } catch (error) {
      deferredOutbox.reject(error);
      this.turnServices.results.fail(claim, state, error, signal);
    } finally {
      signal.removeEventListener("abort", rejectDeferredOutbox);
      deferredOutbox.reject(new Error("Session turn ended before it became deferred."));
      this.deferScan(() => this.scheduleTurns());
    }
  }

  private scheduleOutbox() {
    if (!this.started || this.stopped || this.scanningOutbox) return;
    this.scanningOutbox = true;
    try {
      while (!this.stopped) {
        let probePartition: string | undefined;
        let outbox = this.store.claimNextOutbox({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          excludedDeliveryPartitions: this.outboxPartitions.excluded(this.outboxClaimPartitions.values())
        });
        if (!outbox) {
          probePartition = this.outboxPartitions.takeReady();
          if (probePartition) {
            outbox = this.store.claimNextOutbox({
              workerId: this.workerId,
              leaseMs: this.leaseMs,
              deliveryPartition: probePartition,
              excludedDeliveryPartitions: [...this.outboxClaimPartitions.values()]
            });
            if (!outbox) this.outboxPartitions.retry(probePartition);
          }
        }
        if (!outbox) break;
        const state = this.persistenceMonitor.claim(
          () => this.store.renewOutboxLease(outbox.id, this.workerId, this.leaseMs),
          outbox.id
        );
        this.outboxClaims.set(outbox.id, state);
        this.outboxClaimPartitions.set(outbox.id, outbox.deliveryPartition);
        void this.outboxActor.enqueue(outbox.sessionId, { outbox, state }, {
          timeoutMs: this.outboxTimeoutMs
        }).catch((error) => this.failOutboxTask(outbox, state, error)).finally(() => {
          state.stopRenewal();
          this.outboxClaims.delete(outbox.id);
          this.outboxClaimPartitions.delete(outbox.id);
          this.deferScan(() => this.scheduleOutbox());
        });
      }
    } finally {
      this.scanningOutbox = false;
    }
  }

  private async processOutbox(task: ClaimedOutboxTask, actorSignal: AbortSignal) {
    const { outbox, state } = task;
    const signal = combineSignals(actorSignal, state.controller.signal);
    const delivery = createOutboxDeliveryContext({
      outbox,
      store: this.store,
      workerId: this.workerId,
      signal,
      assertUsable: () => this.assertClaimUsable(state, signal)
    });
    try {
      const result = await this.deliverOutbox(outbox, delivery.context);
      this.assertClaimUsable(state, signal);
      this.store.finishOutbox({
        outboxId: outbox.id,
        workerId: this.workerId,
        outcome: "sent",
        result
      });
      state.finalized = true;
      this.scheduleTools();
      if (delivery.remoteSucceeded() || outbox.status === "sending") {
        this.outboxPartitions.resume(outbox.deliveryPartition);
      }
      this.deferScan(() => this.scheduleOutbox());
    } catch (error) {
      this.finishOutboxFailure(outbox, state, error);
    } finally {
      this.outboxPartitions.completeAttempt(outbox.deliveryPartition, delivery.remoteSucceeded());
    }
  }

  private failOutboxTask(outbox: OutboxRecord, state: ClaimState, error: unknown) {
    this.finishOutboxFailure(outbox, state, error);
  }

  private finishOutboxFailure(outbox: OutboxRecord, state: ClaimState, error: unknown) {
    if (state.finalized || state.finalizationAttempted || this.stopped) return;
    state.finalizationAttempted = true;
    try {
      const current = this.store.getOutbox(outbox.id);
      if (!current || current.status === "sent" || current.status === "dead" || current.status === "delivery_unknown") {
        state.finalized = true;
        return;
      }
      if (current.uncertainSettleStep) {
        this.store.finishOutbox({
          outboxId: outbox.id,
          workerId: this.workerId,
          outcome: "delivery_unknown",
          error: serializeError(error)
        });
        state.finalized = true;
        return;
      }
      if (current.status === "sent_remote") {
        const availableAt = this.clock() + this.outboxRetryDelayMs;
        this.store.finishOutbox({
          outboxId: outbox.id,
          workerId: this.workerId,
          outcome: "retry",
          error: serializeError(error),
          availableAt
        });
        this.wakeAt(availableAt, () => this.scheduleOutbox());
        state.finalized = true;
        return;
      }
      if (current.transportStartedAt != null) {
        this.store.finishOutbox({
          outboxId: outbox.id,
          workerId: this.workerId,
          outcome: "delivery_unknown",
          error: serializeError(error)
        });
        state.finalized = true;
        return;
      }
      if (this.disconnectedError(error)) {
        this.store.finishOutbox({
          outboxId: outbox.id,
          workerId: this.workerId,
          outcome: "retry",
          error: serializeError(error),
          availableAt: this.clock()
        });
        this.outboxPartitions.pause(outbox.deliveryPartition);
        state.finalized = true;
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
        state.finalized = true;
        return;
      }
      this.store.finishOutbox({
        outboxId: outbox.id,
        workerId: this.workerId,
        outcome: "dead",
        error: serializeError(error)
      });
      state.finalized = true;
    } catch (persistenceError) {
      this.persistenceMonitor.record(persistenceError, "OUTBOX_FINALIZATION_PERSIST_FAILED", outbox.id);
      state.controller.abort(persistenceError);
      this.wakeAt(this.clock() + this.leaseMs, () => this.scheduleOutbox());
    }
  }

  private scheduleTools() {
    if (!this.started || this.stopped || this.scanningTools) return;
    this.scanningTools = true;
    try {
      while (!this.stopped) {
        const job = this.store.claimNextToolJob({ workerId: this.workerId, leaseMs: this.leaseMs });
        if (!job) break;
        const jobSettings = this.codexSettings();
        const state = this.persistenceMonitor.claim(
          () => this.store.renewToolJobLease(
            job.id,
            this.workerId,
            this.leaseMs,
            job.attempts,
            job.attemptToken
          ),
          job.id
        );
        this.toolClaims.set(job.id, state);
        const actorKey = toolActorKey(job, jobSettings.workspacePath);
        void this.toolActor.enqueue(actorKey, { job, settings: jobSettings, state }, {
          timeoutMs: toolJobActorTimeoutMs(job, jobSettings)
        }).catch((error) => this.toolJobProcessor.fail(job, state, error)).finally(() => {
          state.stopRenewal();
          this.toolClaims.delete(job.id);
          this.deferScan(() => this.scheduleTools());
        });
      }
    } finally {
      this.scanningTools = false;
    }
  }

  getPersistenceHealth() {
    return this.persistenceMonitor.health();
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

  private deferScan(callback: () => void) {
    queueMicrotask(callback);
  }
}

function sessionEventTimeoutMs(kind: string, regularTimeoutMs: number) {
  return kind === "tool_completion" || kind === "scheduled_callback_delivery"
    ? AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS + TOOL_ACTOR_SETTLEMENT_GRACE_MS
    : regularTimeoutMs;
}

function toolJobActorTimeoutMs(job: ToolJobRecord, settings: CodexCoordinatorSettings) {
  const taskTimeoutMs = job.toolName === "codex"
    ? positiveInteger(settings.timeoutMs, DEFAULT_TURN_TIMEOUT_MS, "codex.timeoutMs")
    : AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS;
  return taskTimeoutMs + TOOL_ACTOR_SETTLEMENT_GRACE_MS;
}

function toolActorKey(job: ToolJobRecord, workspacePath: string) {
  if (job.toolName !== "codex") return `tool:${job.toolName}:${job.id}`;
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
