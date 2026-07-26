export type CodexTaskKind = "local" | "research" | "analysis";
export type CodexTaskStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "needs_input" | "unknown";

export interface CodexToolInput {
  task?: unknown;
  kind?: unknown;
  action?: unknown;
  ssh_host?: unknown;
  workspace_path?: unknown;
  thread_id?: unknown;
  query?: unknown;
  limit?: unknown;
  __sunabot_admin_authorized?: unknown;
  __sunabot_control_authorized?: unknown;
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
