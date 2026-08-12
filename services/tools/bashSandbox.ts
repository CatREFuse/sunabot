import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BashExecutionBackend, BashPathAccess } from "./bashAudit.js";
import {
  WORKSPACE_BASH_ADMIN_EXECUTABLE,
  WORKSPACE_BASH_RESTRICTED_EXECUTABLES
} from "./bashPolicy.js";

export const WORKSPACE_BASH_ISOLATION_ERROR = "BASH_ISOLATION_UNAVAILABLE";
export const WORKSPACE_BASH_SANDBOX_EXECUTABLE = "/usr/bin/bwrap";
export const WORKSPACE_BASH_RESOURCE_LIMITER = "/usr/bin/prlimit";
export const WORKSPACE_BASH_NATIVE_HOST_EXECUTABLE = "/bin/bash";
export const WORKSPACE_BASH_VIRTUAL_ROOT = "/workbench";
export const WORKSPACE_BASH_SKILLS_ROOT = "/skills";
export const WORKSPACE_BASH_MCP_ROOT = "/mcp";
const WORKSPACE_BASH_TARGET_PATH = "/usr/local/bin:/usr/bin:/bin";
const WORKSPACE_BASH_NATIVE_HOST_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type WorkspaceBashSandboxKind = "bubblewrap" | "host";

export interface WorkspaceBashSandbox {
  kind: WorkspaceBashSandboxKind;
  executable: string;
  resourceLimiter?: string;
  networkAccess?: boolean;
}

export type WorkspaceBashExecution =
  | { kind: "shell"; command: string }
  | { kind: "argv"; executable: string; args: string[] };

export interface WorkspaceBashInvocation {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WorkspaceBashSandboxOptions {
  platform?: NodeJS.Platform;
  executable?: string;
  resourceLimiter?: string;
  nativeHostExecutable?: string;
  effectiveUid?: number;
  access?: (filePath: string, mode: number) => Promise<void>;
  probe?: (file: string, args: string[], options?: { env?: Record<string, string> }) => Promise<void>;
  readOnlyMounts?: WorkspaceBashReadOnlyMounts;
}

export interface WorkspaceBashReadOnlyMounts {
  skills: string;
  mcp: string;
}

export function buildWorkspaceBashEnvironment(): Record<string, string> {
  return {
    PATH: WORKSPACE_BASH_TARGET_PATH,
    HOME: WORKSPACE_BASH_VIRTUAL_ROOT,
    PWD: WORKSPACE_BASH_VIRTUAL_ROOT,
    TMPDIR: "/tmp/",
    TMP: "/tmp",
    TEMP: "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "",
    SHELL: "/bin/bash",
    USER: "sunabot",
    SUNABOT_SKILLS: WORKSPACE_BASH_SKILLS_ROOT,
    SUNABOT_MCP_CONFIG: WORKSPACE_BASH_MCP_ROOT
  };
}

export class WorkspaceBashIsolationError extends Error {
  readonly code = WORKSPACE_BASH_ISOLATION_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBashIsolationError";
  }
}

export function resolveWorkspaceBashSandboxExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = environment.SUNABOT_BWRAP_EXECUTABLE?.trim();
  if (!configured) {
    if (environment.SUNABOT_PACKAGED_RELEASE === "1") {
      throw new WorkspaceBashIsolationError("Packaged Bubblewrap executable was not injected by the runtime launcher.");
    }
    return WORKSPACE_BASH_SANDBOX_EXECUTABLE;
  }
  if (!validAbsoluteLinuxExecutable(configured)) {
    throw new WorkspaceBashIsolationError("Bubblewrap executable path is invalid.");
  }
  return configured;
}

export async function ensureWorkspaceBashIsolation(
  backend: BashExecutionBackend,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  options: WorkspaceBashSandboxOptions = {}
): Promise<WorkspaceBashSandbox> {
  const platform = options.platform ?? process.platform;
  validateReadOnlyMounts(options.readOnlyMounts, workbenchRoot);
  if (backend === "native" && platform === "darwin") {
    return ensureNativeHostBash(options);
  }
  if (platform === "linux") {
    return ensureBubblewrapSandbox(workbenchRoot, environment, options, true);
  }
  throw new WorkspaceBashIsolationError(
    `No strong Native Bash isolation is available for ${platform}.`
  );
}

export function buildWorkspaceBashInvocation(
  execution: WorkspaceBashExecution,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  sandbox: WorkspaceBashSandbox,
  approvedOutsideAccesses: BashPathAccess[] = [],
  readOnlyMounts?: WorkspaceBashReadOnlyMounts
): WorkspaceBashInvocation {
  if (sandbox.kind === "host") {
    return buildHostNativeInvocation(
      execution,
      workbenchRoot,
      environment,
      sandbox.executable,
      approvedOutsideAccesses,
      readOnlyMounts
    );
  }
  if (!sandbox.resourceLimiter) {
    throw new WorkspaceBashIsolationError("bubblewrap resource limiter is unavailable.");
  }
  return buildBubblewrapInvocation(
    execution,
    workbenchRoot,
    environment,
    sandbox.executable,
    approvedOutsideAccesses,
    sandbox.resourceLimiter,
    readOnlyMounts,
    sandbox.networkAccess === true
  );
}

export function buildHostNativeInvocation(
  execution: WorkspaceBashExecution,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  executable = WORKSPACE_BASH_NATIVE_HOST_EXECUTABLE,
  approvedOutsideAccesses: BashPathAccess[] = [],
  readOnlyMounts?: WorkspaceBashReadOnlyMounts
): WorkspaceBashInvocation {
  if (!path.isAbsolute(workbenchRoot) || /[\u0000\r\n]/.test(workbenchRoot)) {
    throw new WorkspaceBashIsolationError("Native Bash workbench path is invalid.");
  }
  if (!path.isAbsolute(executable) || /[\u0000\r\n]/.test(executable)) {
    throw new WorkspaceBashIsolationError("Native Bash executable path is invalid.");
  }
  validateReadOnlyMounts(readOnlyMounts, workbenchRoot);
  for (const access of approvedOutsideAccesses) {
    if (access.access !== "read") {
      throw new WorkspaceBashIsolationError("Approved Native host accesses are read-only.");
    }
    validateOutsideBindPath(access.path, workbenchRoot);
  }
  const hostEnvironment = {
    ...environment,
    PATH: WORKSPACE_BASH_NATIVE_HOST_PATH,
    HOME: workbenchRoot,
    PWD: workbenchRoot,
    ...(readOnlyMounts ? {
      SUNABOT_SKILLS: readOnlyMounts.skills,
      SUNABOT_MCP_CONFIG: readOnlyMounts.mcp
    } : {})
  };
  return execution.kind === "argv"
    ? { file: execution.executable, args: execution.args, env: hostEnvironment }
    : {
        file: executable,
        args: ["--noprofile", "--norc", "-lc", execution.command],
        env: hostEnvironment
      };
}

export function buildBubblewrapInvocation(
  execution: WorkspaceBashExecution,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  executable = WORKSPACE_BASH_SANDBOX_EXECUTABLE,
  approvedOutsideAccesses: BashPathAccess[] = [],
  resourceLimiter = WORKSPACE_BASH_RESOURCE_LIMITER,
  readOnlyMounts?: WorkspaceBashReadOnlyMounts,
  networkAccess = false
): WorkspaceBashInvocation {
  const args = [
    executable,
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-cgroup",
    "--uid", "0",
    "--gid", "0",
    "--cap-drop", "ALL",
    "--tmpfs", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--dir", "/tmp",
    "--dir", "/etc",
    "--dir", WORKSPACE_BASH_VIRTUAL_ROOT,
    "--dir", WORKSPACE_BASH_SKILLS_ROOT,
    "--dir", WORKSPACE_BASH_MCP_ROOT
  ];
  if (!networkAccess) args.splice(args.indexOf("--unshare-cgroup"), 0, "--unshare-net");
  for (const directory of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    args.push("--dir", directory, "--ro-bind-try", directory, directory);
  }
  for (const directory of ["/etc/ssl", "/etc/ca-certificates"]) {
    addParentDirectories(args, directory);
    args.push("--ro-bind-try", directory, directory);
  }
  for (const file of [
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime"
  ]) {
    addParentDirectories(args, file);
    args.push("--ro-bind-try", file, file);
  }
  args.push("--bind", workbenchRoot, WORKSPACE_BASH_VIRTUAL_ROOT);
  addReadOnlySharedBinds(args, readOnlyMounts);
  for (const access of approvedOutsideAccesses) {
    if (access.access !== "read") {
      throw new WorkspaceBashIsolationError("Approved outside binds are read-only.");
    }
    const target = validateOutsideBindPath(access.path, workbenchRoot);
    addParentDirectories(args, target);
    args.push("--ro-bind", target, target);
  }
  args.push("--chdir", WORKSPACE_BASH_VIRTUAL_ROOT, "--clearenv");
  for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);
  args.push("--", ...executionArguments(execution));
  return {
    file: resourceLimiter,
    args: [
      "--nproc=64:64",
      "--as=536870912:536870912",
      "--nofile=128:128",
      "--fsize=268435456:268435456",
      "--core=0:0",
      "--",
      ...args
    ]
  };
}

async function ensureBubblewrapSandbox(
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  options: WorkspaceBashSandboxOptions,
  networkAccess: boolean
) {
  const effectiveUid = options.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (effectiveUid <= 0) {
    throw new WorkspaceBashIsolationError("bubblewrap resource isolation requires a non-root runtime user.");
  }
  const executable = options.executable ?? resolveWorkspaceBashSandboxExecutable();
  const resourceLimiter = options.resourceLimiter ?? WORKSPACE_BASH_RESOURCE_LIMITER;
  if (!validAbsoluteLinuxExecutable(executable) || !validAbsoluteLinuxExecutable(resourceLimiter)) {
    throw new WorkspaceBashIsolationError("bubblewrap and resource limiter must use absolute Linux paths.");
  }
  try {
    const access = options.access ?? fs.access;
    for (const dependency of [
      executable,
      resourceLimiter,
      WORKSPACE_BASH_ADMIN_EXECUTABLE,
      ...WORKSPACE_BASH_RESTRICTED_EXECUTABLES
    ]) {
      await access(dependency, fsConstants.X_OK);
    }
  } catch (error) {
    throw new WorkspaceBashIsolationError(`bubblewrap strong isolation dependency is not executable: ${errorMessage(error)}`);
  }
  const probe = buildBubblewrapInvocation(
    { kind: "argv", executable: "/usr/bin/true", args: [] },
    workbenchRoot,
    environment,
    executable,
    [],
    resourceLimiter,
    options.readOnlyMounts,
    networkAccess
  );
  await executeSandboxProbe(probe.file, probe.args, options, "bubblewrap resource and kernel isolation probe failed");
  return { kind: "bubblewrap", executable, resourceLimiter, networkAccess } as const;
}

function validAbsoluteLinuxExecutable(value: string) {
  return path.posix.isAbsolute(value)
    && !/[\u0000\r\n]/u.test(value)
    && path.posix.resolve(value) === value;
}

async function ensureNativeHostBash(options: WorkspaceBashSandboxOptions) {
  const effectiveUid = options.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (effectiveUid <= 0) {
    throw new WorkspaceBashIsolationError("Native host Bash requires a non-root runtime user.");
  }
  const executable = options.nativeHostExecutable ?? WORKSPACE_BASH_NATIVE_HOST_EXECUTABLE;
  if (!path.isAbsolute(executable) || /[\u0000\r\n]/.test(executable)) {
    throw new WorkspaceBashIsolationError("Native host Bash executable path is invalid.");
  }
  try {
    await (options.access ?? fs.access)(executable, fsConstants.X_OK);
  } catch (error) {
    throw new WorkspaceBashIsolationError(`Native host Bash is not executable: ${errorMessage(error)}`);
  }
  await executeSandboxProbe(
    executable,
    ["--noprofile", "--norc", "-lc", ":"],
    options,
    "Native host Bash probe failed"
  );
  return { kind: "host", executable } as const;
}

async function executeSandboxProbe(
  file: string,
  args: string[],
  options: WorkspaceBashSandboxOptions,
  label: string
) {
  try {
    if (options.probe) await options.probe(file, args);
    else await executeProbe(file, args);
  } catch (error) {
    throw new WorkspaceBashIsolationError(`${label}: ${errorMessage(error)}`);
  }
}

function executeProbe(file: string, args: string[], env?: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    let child: { kill(signal?: NodeJS.Signals | number): boolean } | undefined;
    let completed = false;
    const finish = (error?: Error | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(watchdog);
      if (error) reject(error);
      else resolve();
    };
    const watchdog = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // The hard deadline remains authoritative if launcher termination throws.
      }
      finish(new Error("Bash isolation probe timed out."));
    }, 2_000);
    watchdog.unref();
    try {
      child = execFile(file, args, {
        env,
        timeout: 2_000,
        maxBuffer: 64 * 1_024,
        killSignal: "SIGKILL"
      }, (error) => finish(error));
    } catch (error) {
      finish(error as Error);
    }
  });
}

function executionArguments(execution: WorkspaceBashExecution) {
  return execution.kind === "argv"
    ? [execution.executable, ...execution.args]
    : ["/bin/bash", "--noprofile", "--norc", "-lc", execution.command];
}

function validateOutsideBindPath(candidate: string, workbenchRoot: string) {
  if (!candidate || candidate.includes("\0") || !path.isAbsolute(candidate) || candidate.split(/[\\/]+/).includes("..")) {
    throw new WorkspaceBashIsolationError("Approved outside path must be an absolute normalized path.");
  }
  const resolved = path.resolve(candidate);
  const segments = resolved.split(path.sep).filter(Boolean);
  if (resolved === "/" || segments.length < 2 || isAncestorOrEqual(resolved, workbenchRoot) || isWithin(workbenchRoot, resolved)) {
    throw new WorkspaceBashIsolationError("Approved outside path is root, overbroad, or overlaps the workbench boundary.");
  }
  return resolved;
}

function addReadOnlySharedBinds(args: string[], mounts: WorkspaceBashReadOnlyMounts | undefined) {
  if (!mounts) return;
  validateReadOnlyMounts(mounts);
  args.push(
    "--ro-bind", mounts.skills, WORKSPACE_BASH_SKILLS_ROOT,
    "--ro-bind", mounts.mcp, WORKSPACE_BASH_MCP_ROOT
  );
}

function validateReadOnlyMounts(mounts: WorkspaceBashReadOnlyMounts | undefined, workbenchRoot?: string) {
  if (!mounts) return;
  for (const source of [mounts.skills, mounts.mcp]) {
    if (!path.isAbsolute(source) || /[\u0000\r\n,]/.test(source)) {
      throw new WorkspaceBashIsolationError("Bash shared configuration mount source is invalid.");
    }
    if (workbenchRoot && isWithin(source, workbenchRoot) && path.resolve(source) !== path.resolve(mounts.skills)) {
      throw new WorkspaceBashIsolationError("Bash shared configuration mounts must not overlap the workbench.");
    }
  }
  if (path.resolve(mounts.skills) === path.resolve(mounts.mcp)) {
    throw new WorkspaceBashIsolationError("Bash Skill and MCP mounts must be distinct.");
  }
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isAncestorOrEqual(candidate: string, target: string) {
  const relative = path.relative(path.resolve(candidate), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function addParentDirectories(args: string[], target: string) {
  const parents: string[] = [];
  let current = path.posix.dirname(target.replaceAll(path.sep, "/"));
  while (current !== "/" && current !== ".") {
    parents.push(current);
    current = path.posix.dirname(current);
  }
  for (const parent of parents.reverse()) args.push("--dir", parent);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}
