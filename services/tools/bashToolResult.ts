import path from "node:path";
import type {
  BashAccessMode,
  BashAuditResult,
  BashExecutionBackend
} from "./bashAudit.js";
import { WORKSPACE_BASH_VIRTUAL_ROOT } from "./bashSandbox.js";

const MAX_OUTPUT_CHARS = 24_000;
export const OUTSIDE_READ_APPROVAL_GUARANTEE = "仅授权读取既存 canonical regular file；完整父链身份已冻结，并会在只读 bind 前复验。";

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
}

export function configurationStaleResult(
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

export function blockedResult(
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

export function sanitizeAuditResult(audit: BashAuditResult, workbenchRoot: string): BashAuditResult {
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

export function withOutsideReadApprovalGuarantee(audit: BashAuditResult): BashAuditResult {
  if (audit.summary.includes(OUTSIDE_READ_APPROVAL_GUARANTEE)) return audit;
  return { ...audit, summary: `${audit.summary} ${OUTSIDE_READ_APPROVAL_GUARANTEE}` };
}

export function visibleBashText(
  value: string,
  options: { exposeHostPaths: boolean; workbenchRoot: string }
) {
  return options.exposeHostPaths ? value : sanitizeHostText(value, options.workbenchRoot);
}

export function truncateOutput(value: string) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
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
