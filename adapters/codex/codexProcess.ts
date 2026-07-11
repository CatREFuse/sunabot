import { execFile, type ChildProcess } from "node:child_process";
import type {
  CodexProcessCleanupResult,
  CodexProcessIdentity
} from "../../packages/contracts/tools/codex.js";

export const CODEX_DEFAULT_TERMINATION_GRACE_MS = 3_000;

export function signalCodexProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code !== "EPERM") throw error;
    child.kill(signal);
  }
}

export interface CodexProcessObservation {
  processGroupId: number;
  command: string;
}

export interface CodexProcessCleanupOptions {
  inspectProcess?: (pid: number) => Promise<CodexProcessObservation | null>;
  signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  isProcessGroupAlive?: (processGroupId: number) => boolean;
  graceMs?: number;
  pollMs?: number;
}

/**
 * Terminates a persisted detached Codex process only after both its process
 * group and unique attempt directory marker match. This prevents PID reuse
 * from turning crash recovery into an unrelated-process kill.
 */
export async function cleanupPersistedCodexProcess(
  identity: CodexProcessIdentity,
  options: CodexProcessCleanupOptions = {}
): Promise<CodexProcessCleanupResult> {
  const inspect = options.inspectProcess ?? inspectCodexProcess;
  const observed = await inspect(identity.pid);
  if (!observed) return { status: "not_found" };
  if (
    observed.processGroupId !== identity.processGroupId
    || !observed.command.includes(identity.commandMarker)
  ) {
    return {
      status: "unverified",
      message: "Persisted Codex process identity no longer matches the live process."
    };
  }

  const signalGroup = options.signalProcessGroup ?? signalNumericProcessGroup;
  const isAlive = options.isProcessGroupAlive ?? isNumericProcessGroupAlive;
  const graceMs = positiveInteger(options.graceMs, CODEX_DEFAULT_TERMINATION_GRACE_MS);
  const pollMs = positiveInteger(options.pollMs, 25);
  signalGroup(identity.processGroupId, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (isAlive(identity.processGroupId) && Date.now() < deadline) {
    await waitForCleanup(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  if (isAlive(identity.processGroupId)) {
    signalGroup(identity.processGroupId, "SIGKILL");
    const killDeadline = Date.now() + graceMs;
    while (isAlive(identity.processGroupId) && Date.now() < killDeadline) {
      await waitForCleanup(Math.min(pollMs, Math.max(1, killDeadline - Date.now())));
    }
    if (isAlive(identity.processGroupId)) {
      return {
        status: "unverified",
        message: "Recovered Codex process group remained alive after SIGKILL."
      };
    }
  }
  return { status: "terminated" };
}

async function inspectCodexProcess(pid: number): Promise<CodexProcessObservation | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      codexProcessInspectionArguments(pid),
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = String((error as { code?: unknown }).code ?? "");
          if (code === "1" || code === "ESRCH") {
            resolve(null);
            return;
          }
          reject(error);
          return;
        }
        const match = String(stdout).trim().match(/^(\d+)\s+([\s\S]+)$/u);
        if (!match) {
          resolve(null);
          return;
        }
        resolve({ processGroupId: Number(match[1]), command: match[2]! });
      }
    );
  });
}

export function codexProcessInspectionArguments(pid: number) {
  return ["-ww", "-p", String(pid), "-o", "pgid=", "-o", "command="];
}

function signalNumericProcessGroup(processGroupId: number, signal: NodeJS.Signals) {
  try {
    process.kill(process.platform === "win32" ? processGroupId : -processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isNumericProcessGroupAlive(processGroupId: number) {
  try {
    process.kill(process.platform === "win32" ? processGroupId : -processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function waitForCleanup(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
