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
  WORKSPACE_BASH_ISOLATION_ERROR,
  WORKSPACE_BASH_VIRTUAL_ROOT,
  buildWorkspaceBashEnvironment,
  buildWorkspaceBashInvocation,
  ensureWorkspaceBashIsolation,
  type WorkspaceBashInvocation,
  type WorkspaceBashReadOnlyMounts,
  type WorkspaceBashSandboxOptions
} from "./bashSandbox.js";
import {
  isBashConfigurationCurrent,
  normalizeBashCommand,
  normalizeBashTimeout,
  normalizeBashUserRequest,
  validateBasicBashCommand
} from "./bashToolInput.js";
import {
  OUTSIDE_READ_APPROVAL_GUARANTEE,
  blockedResult,
  configurationStaleResult,
  sanitizeAuditResult,
  truncateOutput,
  visibleBashText,
  withOutsideReadApprovalGuarantee,
  type WorkspaceBashResult
} from "./bashToolResult.js";
import {
  BashSkillRepositoryCommandError,
  executeBashSkillRepositoryCommand,
  isBashSkillRepositoryPort,
  parseBashSkillRepositoryCommand,
  type BashSkillRepositoryCommand,
  type BashSkillRepositoryPort
} from "./bashSkillRepository.js";
import { nativeBashTool } from "./bashToolDefinition.js";

export {
  NATIVE_BASH_TOOL_NAME,
  nativeBashTool
} from "./bashToolDefinition.js";

export interface WorkspaceBashInput {
  command?: unknown;
  timeoutMs?: unknown;
}

export type { WorkspaceBashResult } from "./bashToolResult.js";

export interface WorkspaceBashOptions {
  backend?: BashExecutionBackend;
  accessMode?: BashAccessMode;
  strictMode?: boolean;
  isAdmin?: boolean;
  userRequest?: string;
  audit?: BashAuditRunner;
  approvalContext?: BashApprovalContext;
  confirmedApprovalId?: string;
  approvalStore?: BashApprovalStore;
  abortSignal?: AbortSignal;
  isCurrent?: () => boolean;
  sandbox?: WorkspaceBashSandboxOptions;
  skillRepository?: BashSkillRepositoryPort;
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
  isAdmin: boolean;
  userRequest: string;
  isCurrent: () => boolean;
  audit: BashAuditRunner;
  approvalContext: BashApprovalContext;
  confirmedApprovalId?: string;
  skillRepository?: BashSkillRepositoryPort;
}

/** @deprecated Use nativeBashTool. */
export const workspaceBashTool = nativeBashTool;

export function createWorkspaceBashTool() {
  return nativeBashTool;
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
    "isAdmin",
    "userRequest",
    "isCurrent",
    "audit",
    "approvalContext",
    "confirmedApprovalId",
    "skillRepository"
  ]);
  if (Object.keys(options).some((key) => !allowedKeys.has(key))) return false;
  if (
    options.enabled !== true
    || typeof options.workspacePath !== "string"
    || !path.isAbsolute(options.workspacePath)
    || options.backend !== "native"
    || (options.accessMode !== "admin" && options.accessMode !== "isolated" && options.accessMode !== "restricted")
    || (options.accessMode !== "admin" && options.accessMode !== "isolated")
    || typeof options.strictMode !== "boolean"
    || typeof options.isAdmin !== "boolean"
    || typeof options.userRequest !== "string"
    || !options.userRequest.trim()
    || options.userRequest.length > 32_000
    || typeof options.isCurrent !== "function"
    || typeof options.audit !== "function"
    || !approvalContext
    || typeof approvalContext !== "object"
    || Array.isArray(approvalContext)
    || !isValidBashApprovalContext(approvalContext as BashApprovalContext)
    || (approvalContext as BashApprovalContext).backend !== options.backend
  ) return false;
  if (options.skillRepository !== undefined && !isBashSkillRepositoryPort(options.skillRepository)) return false;
  if (options.skillRepository !== undefined && (
    options.backend !== "native" || options.accessMode !== "admin" || options.isAdmin !== true
  )) return false;
  return options.confirmedApprovalId === undefined
    || (typeof options.confirmedApprovalId === "string" && /^bash-[a-f0-9]{24}$/.test(options.confirmedApprovalId));
}
export async function runWorkspaceBash(
  input: WorkspaceBashInput,
  agentWorkspacePath: string,
  options: WorkspaceBashOptions = {}
): Promise<WorkspaceBashResult> {
  const command = normalizeBashCommand(input.command);
  const backend = "native" as const;
  const accessMode = options.accessMode ?? "admin";
  const isAdmin = options.isAdmin ?? accessMode === "admin";
  const userRequest = normalizeBashUserRequest(options.userRequest, command);
  const timeoutMs = normalizeBashTimeout(input.timeoutMs);
  let workbenchRoot = "";
  let addressableWorkbenchRoot = "";
  let readOnlyMounts: WorkspaceBashReadOnlyMounts | undefined;
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
    const bashEnvironment = await resolveAgentBashEnvironment(agentWorkspacePath);
    workbenchRoot = bashEnvironment.workbenchRoot;
    addressableWorkbenchRoot = bashEnvironment.addressableWorkbenchRoot;
    readOnlyMounts = bashEnvironment.readOnlyMounts;
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
  const basicReason = validateBasicBashCommand(command);
  if (basicReason) return blockedResult(command, workbenchRoot, backend, accessMode, basicReason);

  let skillRepositoryCommand: BashSkillRepositoryCommand | undefined;
  try {
    skillRepositoryCommand = parseBashSkillRepositoryCommand(command);
  } catch (error) {
    if (error instanceof BashSkillRepositoryCommandError) {
      return blockedResult(
        command,
        workbenchRoot,
        backend,
        accessMode,
        `${error.code}: ${error.message}`
      );
    }
    throw error;
  }
  if (skillRepositoryCommand && (
    backend !== "native"
    || accessMode !== "admin"
    || !isAdmin
    || !options.approvalContext
    || !isValidBashApprovalContext(options.approvalContext)
    || options.approvalContext.backend !== "native"
    || !options.skillRepository
  )) {
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      "BASH_SKILL_REPOSITORY_NATIVE_ADMIN_REQUIRED: Skill repository commands require Native Bash in an administrator private conversation."
    );
  }

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
      strictMode: options.strictMode !== false,
      isAdmin,
      userRequest
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
    addressableWorkbenches: [{ root: addressableWorkbenchRoot, writable: true }],
    audit
  });
  if (policy.decision === "deny") {
    return blockedResult(command, workbenchRoot, backend, accessMode, policy.reason, audit);
  }
  if (skillRepositoryCommand && policy.decision !== "allow") {
    return blockedResult(
      command,
      workbenchRoot,
      backend,
      accessMode,
      "BASH_SKILL_REPOSITORY_AUDIT_DENIED: managed Skill repository commands require an allow audit decision.",
      audit
    );
  }

  if (skillRepositoryCommand && options.skillRepository && options.approvalContext) {
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
    return executeBashSkillRepositoryCommand({
      command,
      managed: skillRepositoryCommand,
      agentId: options.approvalContext.agentId,
      workbenchRoot,
      backend,
      accessMode,
      audit,
      repository: options.skillRepository,
      abortSignal: options.abortSignal,
      isCurrent: options.isCurrent
    });
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
  try {
    if (!isBashConfigurationCurrent(options.isCurrent)) return stale(audit);
    const sandbox = await ensureWorkspaceBashIsolation(
      backend,
      workbenchRoot,
      environment,
      {
        ...options.sandbox,
        readOnlyMounts
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
    const invocation = buildWorkspaceBashInvocation(
      execution,
      workbenchRoot,
      environment,
      sandbox,
      approvedOutsideAccesses,
      readOnlyMounts
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
      forcedTermination?: "timeout" | "abort"
    ) => {
      if (completionStarted) return;
      completionStarted = true;
      clearTerminationHooks();
      const nodeError = error as ExecFileError | null;
      const timedOut = forcedTermination === "timeout";
      const resultStderr = forcedTermination === "timeout"
        ? "BASH_EXECUTION_TIMEOUT: sandboxed command exceeded the fixed deadline."
        : forcedTermination === "abort"
          ? "BASH_EXECUTION_ABORTED: sandboxed command was aborted."
          : error
            ? "BASH_EXECUTION_FAILED: sandboxed command did not complete."
            : stderr;
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
        audit: sanitizeAuditResult(options.audit, options.workbenchRoot)
      });
    };
    const terminate = (kind: "timeout" | "abort") => {
      try {
        child?.kill("SIGKILL");
      } catch {}
      const error = Object.assign(new Error(kind), { killed: true, signal: "SIGKILL" });
      void finish(error, "", "", kind);
    };
    if (options.signal?.aborted) {
      const error = Object.assign(new Error("aborted"), { killed: true, signal: "SIGKILL" });
      void finish(error, "", "", "abort");
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
