import type { CodexToolInput } from "../../packages/contracts/tools/codex.js";
import type {
  CodexCoordinatorSettings,
  SessionClaimState as ClaimState
} from "./sessionCoordinatorTypes.js";
import { SessionActorTaskTimeoutError } from "./sessionActor.js";
import {
  type ClaimedTurn,
  type EnqueueSessionEventInput,
  type HeldOutboxReplyGateResolver,
  type OutboxDraft,
  SessionStore
} from "./sessionStore.js";

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
      jobId?: string;
      providerCallId: string;
      toolName: string;
      arguments: unknown;
      originalRequest: unknown;
      acknowledgement: OutboxDraft;
      result?: unknown;
    }
  | {
      status: "handoff";
      targetEvent: EnqueueSessionEventInput;
      expectedSourceAvailableAt: number;
      result?: unknown;
    };

interface SessionTurnResultCoordinatorOptions {
  store: SessionStore;
  workerId: string;
  codexSettings: () => CodexCoordinatorSettings;
  isStopped: () => boolean;
  scheduleOutbox: () => void;
  scheduleTools: () => void;
  serializeError: (error: unknown) => unknown;
  resolveHeldReplyGate?: HeldOutboxReplyGateResolver;
}

export class SessionTurnResultCoordinator {
  constructor(private readonly options: SessionTurnResultCoordinatorOptions) {}

  apply(claim: ClaimedTurn, state: ClaimState, result: SessionHandleResult) {
    if (result.status === "handoff") {
      this.applyHandoff(claim, state, result);
      return;
    }
    if (result.status === "deferred") {
      const settings = this.options.codexSettings();
      if (result.toolName === "codex" && !settings.enabled) {
        throw new Error("Codex asynchronous work is disabled.");
      }
      this.options.store.deferTurn({
        turnId: claim.turn.id,
        workerId: this.options.workerId,
        job: {
          ...(result.jobId ? { id: result.jobId } : {}),
          providerCallId: requiredText(result.providerCallId, "providerCallId"),
          toolName: result.toolName,
          ...(result.toolName === "codex" ? {
            taskKind: codexKind(result.arguments as CodexToolInput)
          } : {}),
          originalRequest: result.originalRequest,
          arguments: result.arguments
        },
        acknowledgement: result.acknowledgement,
        result: result.result,
        resolveHeldReplyGate: this.options.resolveHeldReplyGate
      });
      state.finalized = true;
      this.options.scheduleOutbox();
      this.options.scheduleTools();
      return;
    }

    this.options.store.finishTurn({
      turnId: claim.turn.id,
      workerId: this.options.workerId,
      outcome: result.status === "completed" ? "replied" : result.status,
      result: result.result,
      error: result.status === "failed" ? result.error : undefined,
      outbox: result.outbox,
      resolveHeldReplyGate: this.options.resolveHeldReplyGate
    });
    state.finalized = true;
    this.options.scheduleOutbox();
  }

  fail(claim: ClaimedTurn, state: ClaimState, error: unknown, signal: AbortSignal) {
    if (state.finalized || this.options.isStopped()) return;
    this.options.store.finishTurn({
      turnId: claim.turn.id,
      workerId: this.options.workerId,
      outcome: signal.aborted ? "timed_out" : "failed",
      error: this.options.serializeError(error),
      resolveHeldReplyGate: this.options.resolveHeldReplyGate
    });
    state.finalized = true;
    this.options.scheduleOutbox();
  }

  failActorTask(claim: ClaimedTurn, state: ClaimState, error: unknown) {
    if (state.finalized || this.options.isStopped()) return;
    state.finalized = true;
    try {
      this.options.store.finishTurn({
        turnId: claim.turn.id,
        workerId: this.options.workerId,
        outcome: error instanceof SessionActorTaskTimeoutError ? "timed_out" : "failed",
        error: this.options.serializeError(error),
        resolveHeldReplyGate: this.options.resolveHeldReplyGate
      });
      this.options.scheduleOutbox();
    } catch {
      // A late handler may have committed between the actor timeout and here.
    }
  }

  private applyHandoff(
    claim: ClaimedTurn,
    state: ClaimState,
    result: Extract<SessionHandleResult, { status: "handoff" }>
  ) {
    try {
      this.options.store.handoffTurn({
        turnId: claim.turn.id,
        workerId: this.options.workerId,
        targetEvent: result.targetEvent,
        expectedSourceAvailableAt: result.expectedSourceAvailableAt,
        result: result.result,
        resolveHeldReplyGate: this.options.resolveHeldReplyGate
      });
      state.finalized = true;
    } catch (error) {
      this.recoverHandoffFailure(claim, state, error);
    }
  }

  private recoverHandoffFailure(claim: ClaimedTurn, state: ClaimState, error: unknown) {
    if (state.finalized || this.options.isStopped()) return;
    try {
      this.options.store.interruptTurn({
        turnId: claim.turn.id,
        workerId: this.options.workerId,
        error: {
          code: "handoff_failed",
          cause: this.options.serializeError(error)
        },
        resolveHeldReplyGate: this.options.resolveHeldReplyGate
      });
      state.finalized = true;
    } catch {
      if (this.options.store.getTurn(claim.turn.id)?.status !== "running") {
        state.finalized = true;
      }
    }
  }
}

function codexKind(input: CodexToolInput) {
  const kind = input.kind;
  return kind === "local" || kind === "research" || kind === "analysis" ? kind : "analysis";
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
