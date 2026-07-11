import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_BASH_ISOLATION = "bubblewrap";
export const WORKSPACE_BASH_SANDBOX_EXECUTABLE = "/usr/bin/bwrap";
export const WORKSPACE_BASH_ISOLATION_ERROR = "BASH_ISOLATION_UNAVAILABLE";

export interface WorkspaceBashSandboxOptions {
  platform?: NodeJS.Platform;
  executable?: string;
  access?: (filePath: string, mode: number) => Promise<void>;
  probe?: (file: string, args: string[]) => Promise<void>;
}

export class WorkspaceBashIsolationError extends Error {
  readonly code = WORKSPACE_BASH_ISOLATION_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBashIsolationError";
  }
}

export async function ensureWorkspaceBashIsolation(
  workspaceRoot: string,
  environment: Readonly<Record<string, string>>,
  options: WorkspaceBashSandboxOptions = {}
) {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? WORKSPACE_BASH_SANDBOX_EXECUTABLE;
  if (platform !== "linux") {
    throw new WorkspaceBashIsolationError(`bubblewrap requires Linux; current platform is ${platform}.`);
  }
  if (!path.posix.isAbsolute(executable)) {
    throw new WorkspaceBashIsolationError("bubblewrap executable must be an absolute Linux path.");
  }

  try {
    await (options.access ?? fs.access)(executable, fsConstants.X_OK);
  } catch (error) {
    throw new WorkspaceBashIsolationError(`bubblewrap is not executable: ${errorMessage(error)}`);
  }

  const probe = buildBubblewrapInvocation(":", workspaceRoot, environment, executable);
  try {
    if (options.probe) await options.probe(probe.file, probe.args);
    else await executeProbe(probe.file, probe.args);
  } catch (error) {
    throw new WorkspaceBashIsolationError(`bubblewrap kernel isolation probe failed: ${errorMessage(error)}`);
  }
  return executable;
}

export function buildBubblewrapInvocation(
  command: string,
  workspaceRoot: string,
  environment: Readonly<Record<string, string>>,
  executable = WORKSPACE_BASH_SANDBOX_EXECUTABLE
) {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-cgroup-try",
    "--uid", "0",
    "--gid", "0",
    "--cap-drop", "ALL",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--bind", workspaceRoot, workspaceRoot,
    "--proc", "/proc",
    "--chdir", workspaceRoot,
    "--clearenv"
  ];
  for (const [key, value] of Object.entries(environment)) {
    args.push("--setenv", key, value);
  }
  args.push("--", "/bin/bash", "--noprofile", "--norc", "-lc", command);
  return { file: executable, args };
}

function executeProbe(file: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(file, args, {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      killSignal: "SIGKILL"
    }, (error) => error ? reject(error) : resolve());
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}
