import type {
  CodexProcessCleanupResult,
  CodexProcessIdentity
} from "../../packages/contracts/tools/codex.js";
import type { ToolJobRecord } from "./sessionStore.js";

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
