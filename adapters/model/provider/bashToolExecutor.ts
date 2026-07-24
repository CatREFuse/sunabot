import {
  DOCKER_BASH_TOOL_NAME,
  NATIVE_BASH_TOOL_NAME,
  isWorkspaceBashProviderOptions,
  runWorkspaceBash,
  type WorkspaceBashInput
} from "../../../services/tools/bashTool.js";
import { WORKSPACE_BASH_EXECUTION_TIMEOUT_MS } from "../../../services/tools/bashRuntime.js";
import type { ProviderCompleteOptions } from "./contracts.js";

export async function executeProviderBash(
  toolName: typeof NATIVE_BASH_TOOL_NAME | typeof DOCKER_BASH_TOOL_NAME,
  args: Record<string, unknown>,
  options: ProviderCompleteOptions
) {
  const bash = toolName === NATIVE_BASH_TOOL_NAME ? options.bash?.native : options.bash?.docker;
  if (!isWorkspaceBashProviderOptions(bash)) return { ok: false, error: "Bash is not enabled." };
  try {
    if (!bash.isCurrent()) return { ok: false, error: "Bash is not enabled." };
  } catch {
    return { ok: false, error: "Bash is not enabled." };
  }
  const input = readWorkspaceBashInput(args);
  if (!input) return { ok: false, error: "Invalid Bash arguments." };
  return runWorkspaceBash(input, bash.workspacePath, {
    backend: bash.backend,
    accessMode: bash.accessMode,
    strictMode: bash.strictMode,
    isCurrent: bash.isCurrent,
    audit: bash.audit,
    approvalContext: bash.approvalContext,
    runtime: bash.runtime,
    ...(bash.confirmedApprovalId ? { confirmedApprovalId: bash.confirmedApprovalId } : {}),
    ...(options.signal ? { abortSignal: options.signal } : {})
  });
}

function readWorkspaceBashInput(args: Record<string, unknown>): WorkspaceBashInput | undefined {
  const keys = Object.keys(args);
  if (
    keys.length !== 2
    || !keys.includes("command")
    || !keys.includes("timeoutMs")
    || typeof args.command !== "string"
    || (args.timeoutMs !== null && args.timeoutMs !== WORKSPACE_BASH_EXECUTION_TIMEOUT_MS)
  ) return undefined;
  return { command: args.command, timeoutMs: args.timeoutMs };
}
