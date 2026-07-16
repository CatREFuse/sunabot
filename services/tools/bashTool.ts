import { execFile } from "node:child_process";
import path from "node:path";
import { resolveAgentWorkbench } from "../agents/public.js";
import {
  bashApprovalStore,
  isValidBashApprovalContext,
  type BashAccessMode,
  type BashApprovalAccess,
  type BashApprovalContext,
  type BashApprovalStore,
  type BashAuditResult,
  type BashAuditRunner,
  type BashExecutionBackend,
  type BashPathAccess
} from "./bashAudit.js";
import {
  captureWorkbenchIdentity,
  prepareOutsideApprovalAccesses,
  prepareRestrictedPaths,
  verifyApprovalAccesses,
  verifyFrozenFilesystemIdentity,
  verifyRestrictedPaths,
  type FrozenFilesystemIdentity,
  type FrozenRestrictedPath
} from "./bashFilesystemGuard.js";
import {
  WORKSPACE_BASH_ISOLATION_ERROR,
  WORKSPACE_BASH_VIRTUAL_ROOT,
  buildWorkspaceBashInvocation,
  ensureWorkspaceBashIsolation,
  type WorkspaceBashInvocation,
  type WorkspaceBashSandboxOptions
} from "./bashSandbox.js";
import { evaluateBashPolicy } from "./bashPolicy.js";
import { TOOL_CALL_TIMEOUT_MS } from "./toolConstants.js";

export const WORKSPACE_BASH_TOOL_NAME = "workspace_bash";

const MAX_COMMAND_LENGTH = 4_000;
const MAX_OUTPUT_CHARS = 24_000;
const OUTSIDE_READ_APPROVAL_GUARANTEE = "仅授权读取既存 canonical regular file；完整父链身份已冻结，并会在只读 bind 前复验。";

export interface WorkspaceBashInput {
  command?: unknown;
  timeoutMs?: unknown;
}

export interface WorkspaceBashResult {
  ok: boolean;
  command: string;
  cwd: string;
  backend: BashExecutionBackend;
  accessMode: BashAccessMode;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  audit?: BashAuditResult;
  approvalRequired?: boolean;
  approvalId?: string;
  approvalExpiresAt?: string;
  confirmationText?: string;
  approvalSummary?: string;
  approvalAccesses?: Array<{ path: string; access: "read" | "write" | "delete" }>;
  cleanupAttempted?: boolean;
  cleanupSucceeded?: boolean;
  cleanupError?: "BASH_DOCKER_CLEANUP_FAILED";
}

export interface WorkspaceBashOptions {
  backend?: BashExecutionBackend;
  accessMode?: BashAccessMode;
  strictMode?: boolean;
  audit?: BashAuditRunner;
  approvalContext?: BashApprovalContext;
  confirmedApprovalId?: string;
  approvalStore?: BashApprovalStore;
  abortSignal?: AbortSignal;
  sandbox?: WorkspaceBashSandboxOptions;
  /** @deprecated Retained until the runtime configuration migration is committed. */
  workspaceOnly?: boolean;
  /** @deprecated Deterministic policy and the audit agent replace keyword matching. */
  blockedKeywords?: string[];
}

export const workspaceBashTool = {
  type: "function",
  name: WORKSPACE_BASH_TOOL_NAME,
  description: "Run an independently audited command from the current Agent workbench. Restricted conversations accept one fixed local file-operation argv without shell syntax or network access. Administrator Bash remains strongly sandboxed; external access is denied or requires an exact one-time confirmation.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "Bash command to run from the current Agent workbench."
      },
      timeoutMs: {
        type: ["integer", "null"],
        enum: [TOOL_CALL_TIMEOUT_MS, null],
        description: "Tool timeout is fixed at 300000 milliseconds. Use null to apply it."
      }
    },
    required: ["command", "timeoutMs"]
  },
  strict: true
};

export function createWorkspaceBashTool(_options: WorkspaceBashOptions = {}) {
  return workspaceBashTool;
}

export async function runWorkspaceBash(
  input: WorkspaceBashInput,
  agentWorkspacePath: string,
  options: WorkspaceBashOptions = {}
): Promise<WorkspaceBashResult> {
  const command = normalizeCommand(input.command);
  const backend = options.backend ?? "native";
  const accessMode = options.accessMode ?? "admin";
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  let workbenchRoot = "";
  let workbenchIdentity: FrozenFilesystemIdentity;
  try {
    workbenchRoot = await resolveAgentWorkbench(agentWorkspacePath);
    workbenchIdentity = await captureWorkbenchIdentity(workbenchRoot);
  } catch {
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      "BASH_WORKBENCH_INVALID: current Agent workbench is unavailable."
    );
  }
  const basicReason = validateBasicCommand(command);
  if (basicReason) return blockedResult(command, workbenchRoot, backend, accessMode, basicReason);

  if (!options.audit) {
    return blockedResult(command, workbenchRoot, backend, accessMode, "BASH_AUDIT_UNAVAILABLE: no independent audit runner is configured.");
  }

  let audit: BashAuditResult;
  try {
    audit = await options.audit({
      command,
      backend,
      accessMode,
      strictMode: options.strictMode !== false
    });
  } catch (error) {
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      "BASH_AUDIT_UNAVAILABLE: independent audit failed."
    );
  }

  const policy = evaluateBashPolicy({
    command,
    backend,
    accessMode,
    strictMode: options.strictMode !== false,
    workbenchRoot,
    audit
  });
  if (policy.decision === "deny") {
    return blockedResult(command, workbenchRoot, backend, accessMode, policy.reason, audit);
  }

  let frozenRestrictedPaths: FrozenRestrictedPath[] = [];
  if (policy.restrictedInvocation?.pathOperands.length) {
    try {
      frozenRestrictedPaths = await prepareRestrictedPaths(policy.restrictedInvocation.pathOperands, workbenchRoot);
    } catch {
      return blockedResult(
        command,
        workbenchRoot,
        backend,
        accessMode,
        "BASH_RESTRICTED_PATH_INVALID: restricted file operands must remain inside workbench without symlinks.",
        audit
      );
    }
  }

  let approvedOutsideAccesses: BashPathAccess[] = policy.outsideAccesses;
  let frozenApprovalAccesses: BashApprovalAccess[] = [];
  if (policy.decision === "confirm") {
    if (!options.approvalContext || !isValidBashApprovalContext(options.approvalContext)) {
      return blockedResult(command, workbenchRoot, backend, accessMode, "BASH_APPROVAL_CONTEXT_UNAVAILABLE", audit);
    }
    const store = options.approvalStore ?? bashApprovalStore;
    const consumed = store.consume(
      options.confirmedApprovalId,
      command,
      options.approvalContext
    );
    if (!consumed) {
      let prepared: BashApprovalAccess[];
      try {
        prepared = await prepareOutsideApprovalAccesses(policy.outsideAccesses, workbenchRoot);
      } catch {
        return blockedResult(
          command,
          workbenchRoot,
          backend,
          accessMode,
          "BASH_APPROVAL_PATH_INVALID: approved outside paths must already exist without symlinks or root aliases.",
          audit
        );
      }
      const approval = store.issue(command, options.approvalContext, prepared);
      const approvalAudit = withOutsideReadApprovalGuarantee(audit);
      return {
        ...blockedResult(command, workbenchRoot, backend, accessMode, policy.reason, approvalAudit),
        approvalRequired: true,
        approvalId: approval.id,
        approvalExpiresAt: approval.expiresAt,
        confirmationText: approval.confirmationText,
        approvalSummary: `${approval.accessSummary}\n${OUTSIDE_READ_APPROVAL_GUARANTEE}`,
        approvalAccesses: approval.accesses
      };
    }
    try {
      await verifyApprovalAccesses(consumed, workbenchRoot);
    } catch {
      return blockedResult(
        command,
        workbenchRoot,
        backend,
        accessMode,
        "BASH_APPROVAL_PATH_CHANGED: an approved outside path changed before execution.",
        audit
      );
    }
    frozenApprovalAccesses = consumed;
    approvedOutsideAccesses = consumed.map(({ path: approvedPath, access }) => ({ path: approvedPath, access }));
    audit = withOutsideReadApprovalGuarantee(audit);
  }

  try {
    await verifyFrozenFilesystemIdentity(workbenchIdentity, "directory");
  } catch {
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      "BASH_WORKBENCH_CHANGED: current Agent workbench changed before execution.",
      audit
    );
  }
  const environment = buildWorkbenchEnv();
  try {
    const sandbox = await ensureWorkspaceBashIsolation(
      backend,
      workbenchRoot,
      environment,
      options.sandbox
    );
    try {
      await verifyFrozenFilesystemIdentity(workbenchIdentity, "directory");
    } catch {
      return blockedResult(
        command,
        workbenchRoot,
        backend,
        accessMode,
        "BASH_WORKBENCH_CHANGED: current Agent workbench changed before execution.",
        audit
      );
    }
    if (frozenApprovalAccesses.length) {
      try {
        await verifyApprovalAccesses(frozenApprovalAccesses, workbenchRoot);
      } catch {
        return blockedResult(
          command,
          workbenchRoot,
          backend,
          accessMode,
          "BASH_APPROVAL_PATH_CHANGED: an approved outside path changed before execution.",
          audit
        );
      }
    }
    if (frozenRestrictedPaths.length) {
      try {
        await verifyRestrictedPaths(frozenRestrictedPaths);
      } catch {
        return blockedResult(
          command,
          workbenchRoot,
          backend,
          accessMode,
          "BASH_RESTRICTED_PATH_CHANGED: a restricted file operand changed before execution.",
          audit
        );
      }
    }
    const invocation = buildWorkspaceBashInvocation(
      policy.restrictedInvocation
        ? { kind: "argv", ...policy.restrictedInvocation }
        : { kind: "shell", command },
      workbenchRoot,
      environment,
      sandbox,
      approvedOutsideAccesses
    );
    return await executeCommand(invocation, {
      command,
      workbenchRoot,
      backend,
      accessMode,
      timeoutMs,
      environment,
      audit,
      signal: options.abortSignal
    });
  } catch (error) {
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      `${WORKSPACE_BASH_ISOLATION_ERROR}: strong sandbox capability check failed.`,
      audit
    );
  }
}

interface ExecFileError extends Error {
  code?: number | string | null;
  signal?: string;
  killed?: boolean;
}

interface ExecuteCommandOptions {
  command: string;
  workbenchRoot: string;
  backend: BashExecutionBackend;
  accessMode: BashAccessMode;
  timeoutMs: number;
  environment: Record<string, string>;
  audit: BashAuditResult;
  signal?: AbortSignal;
}

function executeCommand(invocation: WorkspaceBashInvocation, options: ExecuteCommandOptions) {
  return new Promise<WorkspaceBashResult>((resolve) => {
    let child: { kill(signal?: NodeJS.Signals | number): boolean } | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let completionStarted = false;
    const clearTerminationHooks = () => {
      if (watchdog) clearTimeout(watchdog);
      if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
    };
    const finish = async (
      error: ExecFileError | null,
      stdout: string,
      stderr: string,
      forcedTermination?: "timeout" | "abort",
      cleanupEligible = true
    ) => {
      if (completionStarted) return;
      completionStarted = true;
      clearTerminationHooks();
      const nodeError = error as ExecFileError | null;
      const cleanup = error && cleanupEligible && invocation.cleanup
        ? await cleanupInvocation(invocation.cleanup)
        : undefined;
      const timedOut = forcedTermination === "timeout";
      let resultStderr = forcedTermination === "timeout"
        ? "BASH_EXECUTION_TIMEOUT: sandboxed command exceeded the fixed deadline."
        : forcedTermination === "abort"
          ? "BASH_EXECUTION_ABORTED: sandboxed command was aborted."
          : error
            ? "BASH_EXECUTION_FAILED: sandboxed command did not complete."
            : stderr;
      if (cleanup && !cleanup.succeeded) {
        resultStderr = [
          resultStderr,
          "BASH_DOCKER_CLEANUP_FAILED: Docker container cleanup could not be verified."
        ].filter(Boolean).join("\n");
      }
      resolve({
        ok: !error,
        command: sanitizeHostText(options.command, options.workbenchRoot),
        cwd: WORKSPACE_BASH_VIRTUAL_ROOT,
        backend: options.backend,
        accessMode: options.accessMode,
        exitCode: typeof nodeError?.code === "number" ? nodeError.code : error ? 1 : 0,
        signal: typeof nodeError?.signal === "string" ? nodeError.signal : null,
        timedOut,
        stdout: truncateOutput(sanitizeHostText(stdout, options.workbenchRoot)),
        stderr: truncateOutput(sanitizeHostText(resultStderr, options.workbenchRoot)),
        audit: sanitizeAuditResult(options.audit, options.workbenchRoot),
        cleanupAttempted: cleanup?.attempted,
        cleanupSucceeded: cleanup?.succeeded,
        cleanupError: cleanup && !cleanup.succeeded ? "BASH_DOCKER_CLEANUP_FAILED" : undefined
      });
    };
    const terminate = (kind: "timeout" | "abort") => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Cleanup below remains the authoritative Docker container termination path.
      }
      const error = Object.assign(new Error(kind), { killed: true, signal: "SIGKILL" });
      void finish(error, "", "", kind);
    };
    if (options.signal?.aborted) {
      const error = Object.assign(new Error("aborted"), { killed: true, signal: "SIGKILL" });
      void finish(error, "", "", "abort", false);
      return;
    }
    try {
      child = execFile(invocation.file, invocation.args, {
        cwd: options.workbenchRoot,
        env: invocation.env ?? options.environment,
        maxBuffer: 256 * 1_024,
        killSignal: "SIGKILL"
      }, (error, stdout, stderr) => void finish(error, stdout, stderr));
      watchdog = setTimeout(() => terminate("timeout"), options.timeoutMs);
      watchdog.unref();
      if (options.signal) {
        abortListener = () => terminate("abort");
        options.signal.addEventListener("abort", abortListener, { once: true });
        if (options.signal.aborted) terminate("abort");
      }
    } catch (error) {
      void finish(error as ExecFileError, "", "");
    }
  });
}

function cleanupInvocation(cleanup: NonNullable<WorkspaceBashInvocation["cleanup"]>) {
  return new Promise<{ attempted: true; succeeded: boolean }>((resolve) => {
    let child: { kill(signal?: NodeJS.Signals | number): boolean } | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let completed = false;
    const finish = (succeeded: boolean) => {
      if (completed) return;
      completed = true;
      if (watchdog) clearTimeout(watchdog);
      resolve({ attempted: true, succeeded });
    };
    try {
      child = execFile(cleanup.file, cleanup.args, {
        env: cleanup.env,
        timeout: 10_000,
        maxBuffer: 64 * 1_024,
        killSignal: "SIGKILL"
      }, (error, _stdout, stderr) => {
        const alreadyAbsent = /no such container/i.test(`${stderr}\n${error?.message ?? ""}`);
        finish(!error || alreadyAbsent);
      });
      watchdog = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // The bounded cleanup result remains failed even if launcher termination throws.
        }
        finish(false);
      }, 10_000);
      watchdog.unref();
    } catch {
      finish(false);
    }
  });
}

function normalizeCommand(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeTimeout(_value: unknown) {
  return TOOL_CALL_TIMEOUT_MS;
}

function validateBasicCommand(command: string) {
  if (!command) return "Empty bash command.";
  if (command.length > MAX_COMMAND_LENGTH) return `Command is too long. Maximum length is ${MAX_COMMAND_LENGTH} characters.`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(command)) return "Control characters are not allowed.";
  return "";
}

function buildWorkbenchEnv(): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: WORKSPACE_BASH_VIRTUAL_ROOT,
    PWD: WORKSPACE_BASH_VIRTUAL_ROOT,
    TMPDIR: "/tmp/",
    TMP: "/tmp",
    TEMP: "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "",
    SHELL: "/bin/bash",
    USER: "sunabot"
  };
}

function blockedResult(
  command: string,
  workbenchRoot: string,
  backend: BashExecutionBackend,
  accessMode: BashAccessMode,
  reason: string,
  audit?: BashAuditResult
): WorkspaceBashResult {
  return {
    ok: false,
    command: sanitizeHostText(command, workbenchRoot),
    cwd: WORKSPACE_BASH_VIRTUAL_ROOT,
    backend,
    accessMode,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: sanitizeHostText(reason, workbenchRoot),
    audit: audit ? sanitizeAuditResult(audit, workbenchRoot) : undefined
  };
}

function sanitizeAuditResult(audit: BashAuditResult, workbenchRoot: string): BashAuditResult {
  return {
    ...audit,
    outsideAccesses: audit.outsideAccesses.map((access) => ({
      ...access,
      path: sanitizeHostText(access.path, workbenchRoot)
    })),
    violations: audit.violations.map((violation) => sanitizeHostText(violation, workbenchRoot)),
    summary: sanitizeHostText(audit.summary, workbenchRoot)
  };
}

function withOutsideReadApprovalGuarantee(audit: BashAuditResult): BashAuditResult {
  if (audit.summary.includes(OUTSIDE_READ_APPROVAL_GUARANTEE)) return audit;
  return { ...audit, summary: `${audit.summary} ${OUTSIDE_READ_APPROVAL_GUARANTEE}` };
}

function sanitizeHostText(value: string, workbenchRoot: string) {
  if (!workbenchRoot) return value;
  const agentWorkspace = path.dirname(workbenchRoot);
  return [
    [workbenchRoot, WORKSPACE_BASH_VIRTUAL_ROOT],
    [agentWorkspace, "/agent-workspace"]
  ].reduce((text, [hostPath, virtualPath]) => hostPath && hostPath !== "/"
    ? text.split(hostPath).join(virtualPath)
    : text, value);
}

function truncateOutput(value: string) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}
