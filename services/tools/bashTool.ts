import { execFile } from "node:child_process";
import path from "node:path";
import { resolveAgentBashEnvironment } from "../agents/public.js";
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
  captureWorkbenchIdentities,
  prepareOutsideApprovalAccesses,
  prepareRestrictedPaths,
  verifyApprovalAccesses,
  verifyWorkbenchIdentities,
  verifyRestrictedPaths,
  type FrozenWorkbenchIdentities,
  type FrozenRestrictedPath
} from "./bashFilesystemGuard.js";
import { evaluateBashPolicy } from "./bashPolicy.js";
import { runBashAuditWithDeadline } from "./bashAuditDeadline.js";
import {
  WORKSPACE_BASH_DOCKER_PROJECTION_ROOT,
  WORKSPACE_BASH_ISOLATION_ERROR,
  WORKSPACE_BASH_NATIVE_PROJECTION_ROOT,
  WORKSPACE_BASH_VIRTUAL_ROOT,
  buildWorkspaceBashEnvironment,
  buildWorkspaceBashInvocation,
  ensureWorkspaceBashIsolation,
  type WorkspaceBashInvocation,
  type WorkspaceBashResourceMounts,
  type WorkspaceBashReadOnlyMounts,
  type WorkspaceBashSandboxOptions
} from "./bashSandbox.js";
import {
  WORKSPACE_BASH_EXECUTION_TIMEOUT_MS,
  type WorkspaceBashRuntimeErrorCode,
  type WorkspaceBashRuntimeExecutionResult,
  type WorkspaceBashRuntimePort
} from "./bashRuntime.js";
import {
  dockerBashTool,
  nativeBashTool
} from "./bashToolDefinition.js";

export {
  DOCKER_BASH_TOOL_NAME,
  NATIVE_BASH_TOOL_NAME,
  dockerBashTool,
  nativeBashTool
} from "./bashToolDefinition.js";

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
  errorCode?: WorkspaceBashRuntimeErrorCode;
  retryAfterMs?: number;
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
  isCurrent?: () => boolean;
  sandbox?: WorkspaceBashSandboxOptions;
  runtime?: WorkspaceBashRuntimePort;
  /** @deprecated Retained until the runtime configuration migration is committed. */
  workspaceOnly?: boolean;
  /** @deprecated Deterministic policy and the audit agent replace keyword matching. */
  blockedKeywords?: string[];
}

export interface WorkspaceBashProviderOptions {
  enabled: true;
  workspacePath: string;
  backend: BashExecutionBackend;
  accessMode: BashAccessMode;
  strictMode: boolean;
  isCurrent: () => boolean;
  audit: BashAuditRunner;
  approvalContext: BashApprovalContext;
  confirmedApprovalId?: string;
  runtime?: WorkspaceBashRuntimePort;
}

/** @deprecated Use dockerBashTool. */
export const workspaceBashTool = dockerBashTool;

export function createWorkspaceBashTool(options: WorkspaceBashOptions = {}) {
  return options.backend === "native" ? nativeBashTool : dockerBashTool;
}
export function isWorkspaceBashProviderOptions(value: unknown): value is WorkspaceBashProviderOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  const approvalContext = options.approvalContext;
  const allowedKeys = new Set([
    "enabled",
    "workspacePath",
    "backend",
    "accessMode",
    "strictMode",
    "isCurrent",
    "audit",
    "approvalContext",
    "confirmedApprovalId",
    "runtime"
  ]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) return false;
  if (
    options.enabled !== true
    || typeof options.workspacePath !== "string"
    || !path.isAbsolute(options.workspacePath)
    || (options.backend !== "native" && options.backend !== "docker")
    || (options.accessMode !== "admin" && options.accessMode !== "isolated" && options.accessMode !== "restricted")
    || !(
      (options.backend === "native" && options.accessMode === "admin")
      || (options.backend === "docker" && options.accessMode === "isolated")
    )
    || typeof options.strictMode !== "boolean"
    || typeof options.isCurrent !== "function"
    || typeof options.audit !== "function"
    || !approvalContext
    || typeof approvalContext !== "object"
    || Array.isArray(approvalContext)
    || !isValidBashApprovalContext(approvalContext as BashApprovalContext)
    || (approvalContext as BashApprovalContext).backend !== options.backend
  ) return false;
  if (options.runtime !== undefined && (
    !options.runtime
    || typeof options.runtime !== "object"
    || typeof (options.runtime as WorkspaceBashRuntimePort).execute !== "function"
  )) return false;
  return options.confirmedApprovalId === undefined
    || (typeof options.confirmedApprovalId === "string" && /^bash-[a-f0-9]{24}$/.test(options.confirmedApprovalId));
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
  let addressableWorkbenchRoot = "";
  let readOnlyMounts: WorkspaceBashReadOnlyMounts | undefined;
  let resourceMounts: WorkspaceBashResourceMounts | undefined;
  const stale = (audit?: BashAuditResult) => configurationStaleResult(
    command,
    workbenchRoot,
    backend,
    accessMode,
    audit
  );
  if (!isBashConfigurationCurrent(options.isCurrent)) return stale();
  let workbenchIdentities: FrozenWorkbenchIdentities;
  try {
    const bashEnvironment = await resolveAgentBashEnvironment(agentWorkspacePath, backend);
    workbenchRoot = bashEnvironment.workbenchRoot;
    addressableWorkbenchRoot = bashEnvironment.addressableWorkbenchRoot;
    readOnlyMounts = bashEnvironment.readOnlyMounts;
    resourceMounts = bashEnvironment.projectionMounts;
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale();
    workbenchIdentities = await captureWorkbenchIdentities(workbenchRoot, addressableWorkbenchRoot);
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale();
  } catch {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale();
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
  if (!isBashConfigurationCurrent(options.isCurrent)) return stale();
  try {
    audit = await runBashAuditWithDeadline(options.audit, {
      command,
      backend,
      accessMode,
      strictMode: options.strictMode !== false
    }, options.abortSignal);
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
  } catch {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale();
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
    addressableWorkbenches: [{ root: backend === "native"
      ? (process.platform === "linux" ? WORKSPACE_BASH_DOCKER_PROJECTION_ROOT : addressableWorkbenchRoot)
      : WORKSPACE_BASH_NATIVE_PROJECTION_ROOT, writable: backend === "native" }],
    audit
  });
  if (policy.decision === "deny") {
    return blockedResult(command, workbenchRoot, backend, accessMode, policy.reason, audit);
  }

  let frozenRestrictedPaths: FrozenRestrictedPath[] = [];
  if (policy.restrictedInvocation?.pathOperands.length) {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    try {
      frozenRestrictedPaths = await prepareRestrictedPaths(policy.restrictedInvocation.pathOperands, workbenchRoot);
    } catch {
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
      return blockedResult(
        command,
        workbenchRoot,
        backend,
        accessMode,
        "BASH_RESTRICTED_PATH_INVALID: restricted file operands must remain inside workbench without symlinks.",
        audit
      );
    }
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
  }

  let approvedOutsideAccesses: BashPathAccess[] = policy.outsideAccesses;
  let frozenApprovalAccesses: BashApprovalAccess[] = [];
  if (policy.decision === "confirm") {
    if (!options.approvalContext
      || !isValidBashApprovalContext(options.approvalContext)
      || options.approvalContext.backend !== backend) {
      return blockedResult(command, workbenchRoot, backend, accessMode, "BASH_APPROVAL_CONTEXT_UNAVAILABLE", audit);
    }
    const store = options.approvalStore ?? bashApprovalStore;
    let consumed: BashApprovalAccess[] | undefined;
    if (options.confirmedApprovalId) {
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
      const inspected = store.inspect(options.confirmedApprovalId, command, options.approvalContext);
      if (inspected) {
        if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        try {
          await verifyApprovalAccesses(inspected, workbenchRoot);
        } catch {
          if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
          return blockedResult(
            command,
            workbenchRoot,
            backend,
            accessMode,
            "BASH_APPROVAL_PATH_CHANGED: an approved outside path changed before execution.",
            audit
          );
        }
        if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        consumed = store.consume(options.confirmedApprovalId, command, options.approvalContext);
        if (!consumed) {
          return blockedResult(
            command,
            workbenchRoot,
            backend,
            accessMode,
            "BASH_APPROVAL_PATH_CHANGED: an approved outside path changed before execution.",
            audit
          );
        }
      } else {
        if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        consumed = store.consume(options.confirmedApprovalId, command, options.approvalContext);
        if (consumed) {
          try {
            await verifyApprovalAccesses(consumed, workbenchRoot);
          } catch {
            if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
            return blockedResult(
              command,
              workbenchRoot,
              backend,
              accessMode,
              "BASH_APPROVAL_PATH_CHANGED: an approved outside path changed before execution.",
              audit
            );
          }
          if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        }
      }
    }
    if (!consumed) {
      let prepared: BashApprovalAccess[];
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
      try {
        prepared = await prepareOutsideApprovalAccesses(policy.outsideAccesses, workbenchRoot);
      } catch {
        if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        return blockedResult(
          command,
          workbenchRoot,
          backend,
          accessMode,
          "BASH_APPROVAL_PATH_INVALID: approved outside paths must already exist without symlinks or root aliases.",
          audit
        );
      }
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
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
    frozenApprovalAccesses = consumed;
    approvedOutsideAccesses = consumed.map(({ path: approvedPath, access }) => ({ path: approvedPath, access }));
    audit = withOutsideReadApprovalGuarantee(audit);
  }

  if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
  try {
    await verifyWorkbenchIdentities(workbenchIdentities);
  } catch {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      "BASH_WORKBENCH_CHANGED: current Agent workbench changed before execution.",
      audit
    );
  }
  if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
  const environment = buildWorkspaceBashEnvironment();
  environment.SUNABOT_DOCKER_WORKBENCH = backend === "native"
    ? (process.platform === "linux" ? WORKSPACE_BASH_DOCKER_PROJECTION_ROOT : addressableWorkbenchRoot)
    : WORKSPACE_BASH_VIRTUAL_ROOT;
  environment.SUNABOT_NATIVE_WORKBENCH = backend === "docker"
    ? WORKSPACE_BASH_NATIVE_PROJECTION_ROOT
    : workbenchRoot;
  try {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    const sandbox = await ensureWorkspaceBashIsolation(
      backend,
      workbenchRoot,
      environment,
      {
        ...options.sandbox,
        readOnlyMounts,
        resourceMounts,
        skipDockerProbe: Boolean(options.runtime)
      }
    );
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    try {
      await verifyWorkbenchIdentities(workbenchIdentities);
    } catch {
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
      return blockedResult(
        command,
        workbenchRoot,
        backend,
        accessMode,
        "BASH_WORKBENCH_CHANGED: current Agent workbench changed before execution.",
        audit
      );
    }
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    if (frozenApprovalAccesses.length) {
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
      try {
        await verifyApprovalAccesses(frozenApprovalAccesses, workbenchRoot);
      } catch {
        if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        return blockedResult(
          command,
          workbenchRoot,
          backend,
          accessMode,
          "BASH_APPROVAL_PATH_CHANGED: an approved outside path changed before execution.",
          audit
        );
      }
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    }
    if (frozenRestrictedPaths.length) {
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
      try {
        await verifyRestrictedPaths(frozenRestrictedPaths);
      } catch {
        if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
        return blockedResult(
          command,
          workbenchRoot,
          backend,
          accessMode,
          "BASH_RESTRICTED_PATH_CHANGED: a restricted file operand changed before execution.",
          audit
        );
      }
      if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    }
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    const execution = policy.restrictedInvocation
      ? { kind: "argv" as const, ...policy.restrictedInvocation }
      : { kind: "shell" as const, command };
    if (sandbox.kind === "docker" && options.runtime) {
      const runtimeResult = await options.runtime.execute({
        execution,
        workbenchRoot,
        image: sandbox.image ?? "sunabot-bash:local",
        readOnlyMounts,
        resourceMounts,
        dockerEnvironment: sandbox.launcherEnvironment,
        effectiveUid: options.sandbox?.effectiveUid,
        timeoutMs,
        signal: options.abortSignal,
        isCurrent: options.isCurrent
      });
      return runtimeExecutionResult(runtimeResult, {
        command,
        workbenchRoot,
        backend,
        accessMode,
        audit
      });
    }
    const invocation = buildWorkspaceBashInvocation(
      execution,
      workbenchRoot,
      environment,
      sandbox,
      approvedOutsideAccesses,
      readOnlyMounts,
      resourceMounts
    );
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    return await executeCommand(invocation, {
      command,
      workbenchRoot,
      backend,
      accessMode,
      exposeHostPaths: sandbox.kind === "host",
      timeoutMs,
      environment,
      audit,
      isCurrent: options.isCurrent,
      signal: options.abortSignal
    });
  } catch (error) {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      `${WORKSPACE_BASH_ISOLATION_ERROR}: Bash execution capability check failed.`,
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
  exposeHostPaths: boolean;
  timeoutMs: number;
  environment: Record<string, string>;
  audit: BashAuditResult;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
}

function executeCommand(invocation: WorkspaceBashInvocation, options: ExecuteCommandOptions) {
  return new Promise<WorkspaceBashResult>((resolve) => {
    if (!isBashConfigurationCurrent(options.isCurrent)) {
      resolve(configurationStaleResult(
        options.command,
        options.workbenchRoot,
        options.backend,
        options.accessMode,
        options.audit
      ));
      return;
    }
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
        command: visibleBashText(options.command, options),
        cwd: options.exposeHostPaths ? options.workbenchRoot : WORKSPACE_BASH_VIRTUAL_ROOT,
        backend: options.backend,
        accessMode: options.accessMode,
        exitCode: typeof nodeError?.code === "number" ? nodeError.code : error ? 1 : 0,
        signal: typeof nodeError?.signal === "string" ? nodeError.signal : null,
        timedOut,
        stdout: truncateOutput(visibleBashText(stdout, options)),
        stderr: truncateOutput(visibleBashText(resultStderr, options)),
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
  return WORKSPACE_BASH_EXECUTION_TIMEOUT_MS;
}

function runtimeExecutionResult(
  result: WorkspaceBashRuntimeExecutionResult,
  options: Pick<ExecuteCommandOptions, "command" | "workbenchRoot" | "backend" | "accessMode" | "audit">
): WorkspaceBashResult {
  const cleanupFailed = result.cleanupAttempted === true && result.cleanupSucceeded === false;
  const stderr = cleanupFailed && !result.stderr.includes("BASH_DOCKER_CLEANUP_FAILED")
    ? [result.stderr, "BASH_DOCKER_CLEANUP_FAILED: Docker container cleanup could not be verified."].filter(Boolean).join("\n")
    : result.stderr;
  return {
    ok: result.ok,
    command: sanitizeHostText(options.command, options.workbenchRoot),
    cwd: WORKSPACE_BASH_VIRTUAL_ROOT,
    backend: options.backend,
    accessMode: options.accessMode,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: truncateOutput(sanitizeHostText(result.stdout, options.workbenchRoot)),
    stderr: truncateOutput(sanitizeHostText(stderr, options.workbenchRoot)),
    audit: sanitizeAuditResult(options.audit, options.workbenchRoot),
    cleanupAttempted: result.cleanupAttempted,
    cleanupSucceeded: result.cleanupSucceeded,
    cleanupError: cleanupFailed ? "BASH_DOCKER_CLEANUP_FAILED" : undefined,
    errorCode: result.errorCode,
    retryAfterMs: result.retryAfterMs
  };
}

function validateBasicCommand(command: string) {
  if (!command) return "Empty bash command.";
  if (command.length > MAX_COMMAND_LENGTH) return `Command is too long. Maximum length is ${MAX_COMMAND_LENGTH} characters.`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(command)) return "Control characters are not allowed.";
  return "";
}

function isBashConfigurationCurrent(isCurrent?: () => boolean) {
  if (!isCurrent) return true;
  try {
    return isCurrent() === true;
  } catch {
    return false;
  }
}

function configurationStaleResult(
  command: string,
  workbenchRoot: string,
  backend: BashExecutionBackend,
  accessMode: BashAccessMode,
  audit?: BashAuditResult
) {
  return blockedResult(
    command,
    workbenchRoot,
    backend,
    accessMode,
    "BASH_CONFIGURATION_STALE: Bash configuration changed before execution.",
    audit
  );
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

function visibleBashText(value: string, options: Pick<ExecuteCommandOptions, "exposeHostPaths" | "workbenchRoot">) {
  return options.exposeHostPaths ? value : sanitizeHostText(value, options.workbenchRoot);
}

function truncateOutput(value: string) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}
