import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
export const WORKSPACE_BASH_DOCKER_IMAGE = "sunabot-bash:local";
export const WORKSPACE_BASH_VIRTUAL_ROOT = "/workbench";
const WORKSPACE_BASH_DOCKER_ENV_EXECUTABLE = "/usr/bin/env";
const WORKSPACE_BASH_DOCKER_TEST_EXECUTABLE = "/usr/bin/test";
const WORKSPACE_BASH_TARGET_PATH = "/usr/local/bin:/usr/bin:/bin";
const WORKSPACE_BASH_TARGET_ENVIRONMENT = [
  "HOME=/workbench",
  "PWD=/workbench",
  `PATH=${WORKSPACE_BASH_TARGET_PATH}`,
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "TMPDIR=/tmp",
  "TMP=/tmp",
  "TEMP=/tmp",
  "SHELL=/bin/bash",
  "USER=sunabot"
] as const;
const WORKSPACE_BASH_PROXY_VARIABLES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy"
] as const;

export type WorkspaceBashSandboxKind = "bubblewrap" | "docker";

export interface WorkspaceBashSandbox {
  kind: WorkspaceBashSandboxKind;
  executable: string;
  resourceLimiter?: string;
  image?: string;
  launcherEnvironment?: Record<string, string>;
}

export type WorkspaceBashExecution =
  | { kind: "shell"; command: string }
  | { kind: "argv"; executable: string; args: string[] };

export interface WorkspaceBashInvocation {
  file: string;
  args: string[];
  env?: Record<string, string>;
  cleanup?: {
    file: string;
    args: string[];
    env?: Record<string, string>;
  };
}

export interface WorkspaceBashSandboxOptions {
  platform?: NodeJS.Platform;
  runtimeMode?: string;
  executable?: string;
  resourceLimiter?: string;
  dockerExecutable?: string;
  dockerImage?: string;
  dockerEnvironment?: Readonly<NodeJS.ProcessEnv>;
  effectiveUid?: number;
  access?: (filePath: string, mode: number) => Promise<void>;
  probe?: (file: string, args: string[], options?: { env?: Record<string, string> }) => Promise<void>;
}

export class WorkspaceBashIsolationError extends Error {
  readonly code = WORKSPACE_BASH_ISOLATION_ERROR;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBashIsolationError";
  }
}

export async function ensureWorkspaceBashIsolation(
  backend: BashExecutionBackend,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  options: WorkspaceBashSandboxOptions = {}
): Promise<WorkspaceBashSandbox> {
  const platform = options.platform ?? process.platform;
  const runtimeMode = options.runtimeMode ?? process.env.SUNABOT_RUNTIME_MODE ?? "native";
  if (backend === "docker" && runtimeMode !== "docker") {
    return ensureDockerSandbox(options);
  }
  if (platform === "linux") {
    return ensureBubblewrapSandbox(workbenchRoot, environment, options);
  }
  throw new WorkspaceBashIsolationError(
    `No strong ${backend} Bash isolation is available for ${platform}/${runtimeMode}. Use the Docker backend.`
  );
}

export function buildWorkspaceBashInvocation(
  execution: WorkspaceBashExecution,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  sandbox: WorkspaceBashSandbox,
  approvedOutsideAccesses: BashPathAccess[] = []
): WorkspaceBashInvocation {
  if (sandbox.kind === "docker") {
    return buildDockerInvocation(
      execution,
      workbenchRoot,
      sandbox.executable,
      sandbox.image ?? WORKSPACE_BASH_DOCKER_IMAGE,
      undefined,
      sandbox.launcherEnvironment
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
    sandbox.resourceLimiter
  );
}

export function buildBubblewrapInvocation(
  execution: WorkspaceBashExecution,
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  executable = WORKSPACE_BASH_SANDBOX_EXECUTABLE,
  approvedOutsideAccesses: BashPathAccess[] = [],
  resourceLimiter = WORKSPACE_BASH_RESOURCE_LIMITER
): WorkspaceBashInvocation {
  const args = [
    executable,
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-net",
    "--unshare-cgroup",
    "--uid", "0",
    "--gid", "0",
    "--cap-drop", "ALL",
    "--tmpfs", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--dir", "/tmp",
    "--dir", "/etc",
    "--dir", WORKSPACE_BASH_VIRTUAL_ROOT
  ];
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

export function buildDockerInvocation(
  execution: WorkspaceBashExecution,
  workbenchRoot: string,
  executable = "docker",
  image = WORKSPACE_BASH_DOCKER_IMAGE,
  containerName = createBashContainerName(),
  launcherEnvironment = buildDockerCliEnvironment()
): WorkspaceBashInvocation {
  if (!path.isAbsolute(workbenchRoot) || /[\u0000\r\n,]/.test(workbenchRoot)) {
    throw new WorkspaceBashIsolationError("Docker Bash workbench mount source is invalid.");
  }
  validateDockerImage(image);
  if (!/^sunabot-bash-[a-f0-9]{32}$/.test(containerName)) {
    throw new WorkspaceBashIsolationError("Docker Bash container name is invalid.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 65_534;
  const gid = typeof process.getgid === "function" ? process.getgid() : 65_534;
  const [entrypoint, ...entrypointArgs] = executionArguments(execution);
  const args = [
    "run", "--rm", "--init", "--pull", "never",
    "--name", containerName,
    "--user", `${uid}:${gid}`,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64",
    "--memory", "256m",
    "--cpus", "1",
    "--ulimit", "fsize=268435456:268435456",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--mount", `type=bind,src=${workbenchRoot},dst=/workbench,rw`,
    "--workdir", "/workbench"
  ];
  addClearedDockerProxyEnvironment(args);
  args.push(
    "--entrypoint", WORKSPACE_BASH_DOCKER_ENV_EXECUTABLE,
    image,
    "-i",
    ...WORKSPACE_BASH_TARGET_ENVIRONMENT,
    entrypoint!,
    ...entrypointArgs
  );
  return {
    file: executable,
    args,
    env: launcherEnvironment,
    cleanup: { file: executable, args: ["rm", "-f", containerName], env: launcherEnvironment }
  };
}

function createBashContainerName() {
  return `sunabot-bash-${randomBytes(16).toString("hex")}`;
}

async function ensureBubblewrapSandbox(
  workbenchRoot: string,
  environment: Readonly<Record<string, string>>,
  options: WorkspaceBashSandboxOptions
) {
  const effectiveUid = options.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (effectiveUid <= 0) {
    throw new WorkspaceBashIsolationError("bubblewrap resource isolation requires a non-root runtime user.");
  }
  const executable = options.executable ?? WORKSPACE_BASH_SANDBOX_EXECUTABLE;
  const resourceLimiter = options.resourceLimiter ?? WORKSPACE_BASH_RESOURCE_LIMITER;
  if (!path.posix.isAbsolute(executable) || !path.posix.isAbsolute(resourceLimiter)) {
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
    resourceLimiter
  );
  await executeSandboxProbe(probe.file, probe.args, options, "bubblewrap resource and kernel isolation probe failed");
  return { kind: "bubblewrap", executable, resourceLimiter } as const;
}

async function ensureDockerSandbox(options: WorkspaceBashSandboxOptions) {
  const effectiveUid = options.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  if (effectiveUid <= 0) {
    throw new WorkspaceBashIsolationError("Docker Bash isolation requires a non-root runtime user.");
  }
  const executable = options.dockerExecutable ?? "docker";
  const image = options.dockerImage ?? (process.env.SUNABOT_BASH_IMAGE?.trim() || WORKSPACE_BASH_DOCKER_IMAGE);
  const launcherEnvironment = buildDockerCliEnvironment(options.dockerEnvironment ?? process.env);
  validateDockerImage(image);
  try {
    if (path.isAbsolute(executable)) await (options.access ?? fs.access)(executable, fsConstants.X_OK);
    const probeName = createBashProbeContainerName();
    const effectiveGid = typeof process.getgid === "function" ? process.getgid() : effectiveUid;
    const args = [
      "run", "--rm", "--name", probeName, "--pull", "never",
      "--user", `${effectiveUid}:${effectiveGid}`,
      "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--pids-limit", "16",
      "--memory", "64m", "--cpus", "0.25"
    ];
    addClearedDockerProxyEnvironment(args);
    args.push(
      "--entrypoint", WORKSPACE_BASH_DOCKER_ENV_EXECUTABLE,
      image,
      "-i", `PATH=${WORKSPACE_BASH_TARGET_PATH}`,
      WORKSPACE_BASH_ADMIN_EXECUTABLE,
      "--noprofile", "--norc", "-ec",
      buildDockerCapabilityProbeScript()
    );
    if (options.probe) await options.probe(executable, args, { env: launcherEnvironment });
    else await executeDockerCapabilityProbe(executable, args, probeName, launcherEnvironment);
  } catch (error) {
    throw new WorkspaceBashIsolationError(`Docker Bash image is unavailable: ${errorMessage(error)}`);
  }
  return { kind: "docker", executable, image, launcherEnvironment } as const;
}

function buildDockerCapabilityProbeScript() {
  const dependencies = [...new Set([
    WORKSPACE_BASH_DOCKER_ENV_EXECUTABLE,
    WORKSPACE_BASH_DOCKER_TEST_EXECUTABLE,
    WORKSPACE_BASH_ADMIN_EXECUTABLE,
    ...WORKSPACE_BASH_RESTRICTED_EXECUTABLES
  ])];
  if (dependencies.some((dependency) => !/^\/[A-Za-z0-9_./+-]+$/.test(dependency))) {
    throw new WorkspaceBashIsolationError("Docker Bash dependency path is invalid.");
  }
  return `for executable in ${dependencies.join(" ")}; do ${WORKSPACE_BASH_DOCKER_TEST_EXECUTABLE} -x "$executable" || exit 1; done`;
}

function createBashProbeContainerName() {
  return `sunabot-bash-probe-${randomBytes(16).toString("hex")}`;
}

function addClearedDockerProxyEnvironment(args: string[]) {
  for (const variable of WORKSPACE_BASH_PROXY_VARIABLES) args.push("--env", `${variable}=`);
}

async function executeDockerCapabilityProbe(
  executable: string,
  args: string[],
  containerName: string,
  environment: Record<string, string>
) {
  try {
    await executeProbe(executable, args, environment);
  } catch (error) {
    try {
      await executeProbe(executable, ["rm", "-f", containerName], environment);
    } catch {
      throw new WorkspaceBashIsolationError("Docker Bash capability probe cleanup could not be verified.");
    }
    throw error;
  }
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
    execFile(file, args, {
      env,
      timeout: 5_000,
      maxBuffer: 64 * 1_024,
      killSignal: "SIGKILL"
    }, (error) => error ? reject(error) : resolve());
  });
}

function buildDockerCliEnvironment(source: Readonly<NodeJS.ProcessEnv> = process.env) {
  const environment: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION"
  ]) {
    const value = source[key];
    if (typeof value === "string" && value) environment[key] = value;
  }
  return environment;
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

function validateDockerImage(image: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image) || image.includes("..") || image.includes("//")) {
    throw new WorkspaceBashIsolationError("Docker Bash image reference is invalid.");
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
