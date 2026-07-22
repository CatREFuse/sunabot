import type {
  WorkspaceBashExecution,
  WorkspaceBashReadOnlyMounts
} from "./bashSandbox.js";

export const WORKSPACE_BASH_EXECUTION_TIMEOUT_MS = 30_000;

export type WorkspaceBashRuntimeErrorCode =
  | "BASH_BUSY"
  | "BASH_DOCKER_CIRCUIT_OPEN"
  | "BASH_DOCKER_UNAVAILABLE"
  | "BASH_DOCKER_START_TIMEOUT"
  | "BASH_EXECUTION_ABORTED"
  | "BASH_EXECUTION_TIMEOUT"
  | "BASH_EXECUTION_UNKNOWN"
  | "BASH_OUTPUT_LIMIT"
  | "BASH_DOCKER_CLEANUP_FAILED";

export interface WorkspaceBashRuntimeCapabilityInput {
  workbenchRoot: string;
  image: string;
  readOnlyMounts?: WorkspaceBashReadOnlyMounts;
  dockerEnvironment?: Readonly<NodeJS.ProcessEnv>;
  effectiveUid?: number;
  effectiveGid?: number;
}

export interface WorkspaceBashRuntimeExecutionInput
  extends WorkspaceBashRuntimeCapabilityInput {
  execution: WorkspaceBashExecution;
  timeoutMs: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface WorkspaceBashRuntimeCapabilityResult {
  available: boolean;
  retryAfterMs?: number;
}

export interface WorkspaceBashRuntimeExecutionResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  errorCode?: WorkspaceBashRuntimeErrorCode;
  retryAfterMs?: number;
  cleanupAttempted?: boolean;
  cleanupSucceeded?: boolean;
}

export interface WorkspaceBashRuntimePort {
  capability(
    input: WorkspaceBashRuntimeCapabilityInput
  ): Promise<WorkspaceBashRuntimeCapabilityResult>;
  execute(
    input: WorkspaceBashRuntimeExecutionInput
  ): Promise<WorkspaceBashRuntimeExecutionResult>;
}
