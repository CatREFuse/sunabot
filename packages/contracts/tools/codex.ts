export type CodexTaskKind = "local" | "research" | "analysis";
export type CodexTaskStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "needs_input" | "unknown";

export interface CodexToolInput {
  task?: unknown;
  kind?: unknown;
  inputHandles?: unknown;
  action?: unknown;
  ssh_host?: unknown;
  workspace_path?: unknown;
  thread_id?: unknown;
  query?: unknown;
  limit?: unknown;
  __sunabot_admin_authorized?: unknown;
  __sunabot_control_authorized?: unknown;
  __sunabot_frozen_inputs?: unknown;
  __sunabot_artifact_backend?: unknown;
}

export interface FrozenCodexInputV1 {
  schemaVersion: 1;
  handle: string;
  kind: "file" | "image";
  relativePath: string;
  displayName: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string;
  textProjection?: FrozenCodexTextProjectionV1;
}

export interface FrozenCodexTextProjectionV1 {
  schemaVersion: 1;
  source: "parsed_text" | "raw_text";
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  characterCount: number;
  truncated: boolean;
}

export interface CodexResultArtifactV1 {
  schemaVersion: 1;
  relativePath: string;
  displayName: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string;
  handle?: string;
}

export interface CodexToolError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface CodexToolResult {
  ok: boolean;
  status: CodexTaskStatus;
  jobId: string;
  kind: CodexTaskKind;
  content?: string;
  question?: string;
  error?: CodexToolError;
  threadId?: string;
  resultFile?: string;
  outputTruncated?: boolean;
  outputBytes?: number;
  usage?: Record<string, number>;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
  stderr?: string;
  artifacts?: CodexResultArtifactV1[];
}

export type CodexAuthStrategy = "copy" | "symlink";

export interface CodexProcessIdentity {
  pid: number;
  processGroupId: number;
  attempt: number;
  runToken: string;
  commandMarker: string;
  startedAt: number;
}

export interface CodexProcessCleanupResult {
  status: "terminated" | "not_found" | "unverified";
  message?: string;
}

export interface CodexToolExecutionContext {
  jobId: string;
  jobDir: string;
  workspacePath?: string;
  executable?: string;
  model?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  resumeThreadId?: string;
  attempt?: number;
  runToken?: string;
  onProcessStarted?: (identity: CodexProcessIdentity) => void;
  ephemeral?: boolean;
  authFile?: string;
  authStrategy?: CodexAuthStrategy;
}

export interface CodexSupervisorRequest extends CodexToolExecutionContext {
  task: string;
  kind: CodexTaskKind;
  inputHandles?: string[];
  frozenInputs?: FrozenCodexInputV1[];
}

export interface CodexSupervisor {
  run(request: CodexSupervisorRequest): Promise<CodexToolResult>;
}

export interface CodexRunner {
  run(input: CodexToolInput, context: CodexToolExecutionContext): Promise<CodexToolResult>;
}

export interface CodexControlRunner {
  run(input: CodexToolInput, context: CodexToolExecutionContext): Promise<CodexToolResult>;
}
