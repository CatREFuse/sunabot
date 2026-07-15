import type {
  CodexProcessCleanupResult,
  CodexProcessIdentity,
  CodexTaskStatus
} from "../../packages/contracts/tools/codex.js";
import type { ToolJobRecord } from "./sessionStore.js";

export interface OutboxDeliveryContext {
  signal: AbortSignal;
  readonly phase: "send" | "settle";
  readonly remoteReceipt: unknown;
  sendRemote<T>(operation: () => T | Promise<T>): Promise<T>;
  settleStep<T>(step: string, operation: (idempotencyKey: string) => T | Promise<T>): Promise<T | undefined>;
  settleEffectStep<T>(step: string, operation: (idempotencyKey: string) => T | Promise<T>): Promise<T | undefined>;
}

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

export interface SessionClaimState {
  readonly controller: AbortController;
  finalized: boolean;
  stopRenewal: () => void;
}

export interface ClaimedToolTask {
  job: ToolJobRecord;
  settings: CodexCoordinatorSettings;
  state: SessionClaimState;
}

export interface DeferredToolRunResult {
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "needs_input" | "unknown";
  result?: unknown;
  error?: unknown;
}

export type DeferredToolRunner = (
  job: ToolJobRecord,
  signal: AbortSignal
) => Promise<DeferredToolRunResult>;

export type CodexProcessCleanup = (
  identity: CodexProcessIdentity
) => Promise<CodexProcessCleanupResult>;

export interface CodexToolUsageObservation {
  jobId: string;
  conversationId: string;
  attempt: number;
  model?: string;
  ok: boolean;
  status: CodexTaskStatus;
  usage?: Record<string, number>;
}

export type CodexToolUsageObserver = (
  observation: CodexToolUsageObservation
) => unknown | Promise<unknown>;
