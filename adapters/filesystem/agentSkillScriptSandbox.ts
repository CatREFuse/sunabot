import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { safeRelativeResourcePath } from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import {
  assertPinnedProjectedSkillScript,
  verifyAgentSkillScriptProjection,
  type AgentSkillScriptProjection
} from "./agentSkillScriptProjection.js";
import {
  SKILL_SCRIPT_BASH_INTERPRETER,
  SKILL_SCRIPT_NODE_INTERPRETER,
  auditAgentSkillScript
} from "./agentSkillScriptAudit.js";

export const SKILL_SCRIPT_DOCKER_ENTRYPOINT = "/usr/local/libexec/sunabot-skill-script-entrypoint";
export const SKILL_SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;
export const SKILL_SCRIPT_MAX_TIMEOUT_MS = 300_000;
export const SKILL_SCRIPT_MAX_OUTPUT_BYTES = 64 * 1024;

const BWRAP = "/usr/bin/bwrap";
const PRLIMIT = "/usr/bin/prlimit";
const DOCKER = "/usr/local/bin/docker";
const FIXED_PATH = "/usr/local/bin:/usr/bin:/bin";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface AgentSkillScriptSandboxInput {
  agentId: string;
  conversationId: string;
  skillId: string;
  expectedDigestSha256: string;
  resourcePath: string;
  resourceSha256: string;
  resourceBytes: number;
  interpreter: typeof SKILL_SCRIPT_BASH_INTERPRETER | typeof SKILL_SCRIPT_NODE_INTERPRETER;
  preflightFingerprintSha256: string;
  auditFingerprintSha256: string;
  args: readonly string[];
  projection: AgentSkillScriptProjection;
  timeoutMs?: number;
  outputBudgetBytes?: number;
  signal?: AbortSignal;
}

export interface AgentSkillScriptSandboxResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface AgentSkillScriptSandboxPort {
  run(input: AgentSkillScriptSandboxInput): Promise<AgentSkillScriptSandboxResult>;
}

export interface SkillScriptInvocation {
  kind: "bubblewrap" | "docker";
  file: string;
  args: string[];
  env: Readonly<Record<string, string>>;
  cleanup?: {
    file: string;
    args: ["rm", "-f", string];
    env: Readonly<Record<string, string>>;
  };
}

export interface SkillScriptChild {
  readonly pid?: number;
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type SkillScriptSpawn = (
  file: string,
  args: readonly string[],
  options: {
    cwd: "/";
    detached: true;
    env: Readonly<Record<string, string>>;
    stdio: ["ignore", "pipe", "pipe"];
  }
) => SkillScriptChild;

export type SkillScriptCleanupRunner = (input: {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) => Promise<void>;

export class StrongIsolatedAgentSkillScriptSandbox implements AgentSkillScriptSandboxPort {
  constructor(private readonly options: {
    backend?: "auto" | "bubblewrap" | "docker";
    platform?: NodeJS.Platform;
    bwrapExecutable?: string;
    prlimitExecutable?: string;
    dockerExecutable?: string;
    dockerImage?: string;
    dockerEnvironment?: Readonly<Record<string, string>>;
    effectiveUid?: number;
    effectiveGid?: number;
    cleanupTimeoutMs?: number;
    spawnProcess?: SkillScriptSpawn;
    cleanupRunner?: SkillScriptCleanupRunner;
    containerNameFactory?: () => string;
    beforeSpawn?: () => Promise<void> | void;
    killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  } = {}) {}

  async run(input: AgentSkillScriptSandboxInput): Promise<AgentSkillScriptSandboxResult> {
    validateSandboxInput(input);
    const outputBudgetBytes = boundedInteger(
      input.outputBudgetBytes,
      SKILL_SCRIPT_MAX_OUTPUT_BYTES,
      1,
      SKILL_SCRIPT_MAX_OUTPUT_BYTES
    );
    requireSandboxResultBudget(outputBudgetBytes);
    if (input.signal?.aborted) throw stableError("SKILL_SCRIPT_ABORTED");
    const effectiveUid = this.options.effectiveUid ??
      (typeof process.getuid === "function" ? process.getuid() : -1);
    if (!Number.isSafeInteger(effectiveUid) || effectiveUid <= 0) {
      throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
    }
    await verifyAgentSkillScriptProjection(input.projection);
    await revalidateSandboxAudit(input);
    const backend = this.options.backend === "auto" || !this.options.backend
      ? (this.options.platform ?? process.platform) === "darwin" ? "docker" : "bubblewrap"
      : this.options.backend;
    const invocation = backend === "docker"
      ? buildSkillScriptDockerInvocation(input, {
          dockerExecutable: this.options.dockerExecutable,
          image: this.options.dockerImage,
          dockerEnvironment: this.options.dockerEnvironment,
          uid: this.options.effectiveUid,
          gid: this.options.effectiveGid,
          containerName: this.options.containerNameFactory?.()
        })
      : buildSkillScriptBubblewrapInvocation(input, {
          platform: this.options.platform,
          bwrapExecutable: this.options.bwrapExecutable,
          prlimitExecutable: this.options.prlimitExecutable
        });
    if (invocation.kind === "bubblewrap") {
      await Promise.all([
        assertExecutable(invocation.file),
        assertExecutable(this.options.bwrapExecutable ?? BWRAP),
        assertExecutable(input.interpreter)
      ]);
    } else {
      await assertExecutable(invocation.file);
    }
    await this.options.beforeSpawn?.();
    await verifyAgentSkillScriptProjection(input.projection);
    await revalidateSandboxAudit(input);
    if (input.signal?.aborted) throw stableError("SKILL_SCRIPT_ABORTED");
    return executeInvocation(invocation, input, {
      cleanupTimeoutMs: boundedInteger(this.options.cleanupTimeoutMs, 10_000, 1, 30_000),
      spawnProcess: this.options.spawnProcess ?? defaultSpawn,
      cleanupRunner: this.options.cleanupRunner ?? defaultCleanupRunner,
      killProcessGroup: this.options.killProcessGroup ?? ((pid, signal) => process.kill(-pid, signal))
    });
  }
}

export function buildSkillScriptBubblewrapInvocation(
  input: AgentSkillScriptSandboxInput,
  options: {
    platform?: NodeJS.Platform;
    bwrapExecutable?: string;
    prlimitExecutable?: string;
  } = {}
): SkillScriptInvocation {
  validateSandboxInput(input);
  if ((options.platform ?? process.platform) !== "linux") throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  const bwrap = validateAbsoluteExecutable(options.bwrapExecutable ?? BWRAP);
  const prlimit = validateAbsoluteExecutable(options.prlimitExecutable ?? PRLIMIT);
  const args = [
    "--nproc=64:64",
    "--as=536870912:536870912",
    "--nofile=128:128",
    "--fsize=268435456:268435456",
    "--core=0:0",
    "--",
    bwrap,
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
    "--dir", "/workbench",
    "--dir", "/skills"
  ];
  for (const directory of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    args.push("--dir", directory, "--ro-bind-try", directory, directory);
  }
  for (const file of ["/etc/passwd", "/etc/group", "/etc/localtime"]) {
    addVirtualParents(args, file);
    args.push("--ro-bind-try", file, file);
  }
  args.push(
    "--ro-bind", validateMountSource(input.projection.workbench), "/workbench",
    "--ro-bind", validateMountSource(input.projection.skills), "/skills",
    "--chdir", "/workbench",
    "--clearenv",
    "--setenv", "HOME", "/workbench",
    "--setenv", "PWD", "/workbench",
    "--setenv", "PATH", FIXED_PATH,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp",
    "--",
    input.interpreter,
    input.projection.virtualScript,
    ...input.args
  );
  return { kind: "bubblewrap", file: prlimit, args, env: {} };
}

export function buildSkillScriptDockerInvocation(
  input: AgentSkillScriptSandboxInput,
  options: {
    dockerExecutable?: string;
    image?: string;
    dockerEnvironment?: Readonly<Record<string, string>>;
    uid?: number;
    gid?: number;
    containerName?: string;
  } = {}
): SkillScriptInvocation {
  validateSandboxInput(input);
  const file = validateAbsoluteExecutable(options.dockerExecutable ?? DOCKER);
  const image = validateImmutableImage(options.image);
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const gid = options.gid ?? (typeof process.getgid === "function" ? process.getgid() : uid);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {
    throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  }
  const containerName = options.containerName ?? `sunabot-skill-script-${randomBytes(16).toString("hex")}`;
  if (!/^sunabot-skill-script-[a-f0-9]{32}$/u.test(containerName)) {
    throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  }
  const env = validateDockerEnvironment(options.dockerEnvironment ?? {});
  const args = [
    "run", "--rm", "--init", "--pull", "never",
    "--name", containerName,
    "--user", `${uid}:${gid}`,
    "--network", "none",
    "--ipc", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64",
    "--memory", "512m",
    "--memory-swap", "512m",
    "--cpus", "1",
    "--ulimit", "nofile=128:128",
    "--ulimit", "fsize=268435456:268435456",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--mount", `type=bind,src=${validateMountSource(input.projection.workbench)},dst=/workbench,readonly`,
    "--mount", `type=bind,src=${validateMountSource(input.projection.skills)},dst=/skills,readonly`,
    "--workdir", "/workbench",
    "--entrypoint", SKILL_SCRIPT_DOCKER_ENTRYPOINT,
    image,
    "--skill", input.skillId,
    "--digest", input.expectedDigestSha256,
    "--resource", input.resourcePath,
    "--resource-sha256", input.resourceSha256,
    "--resource-bytes", String(input.resourceBytes),
    "--audit", input.auditFingerprintSha256,
    "--interpreter", input.interpreter,
    "--",
    ...input.args
  ];
  return {
    kind: "docker",
    file,
    args,
    env,
    cleanup: { file, args: ["rm", "-f", containerName], env }
  };
}

async function executeInvocation(
  invocation: SkillScriptInvocation,
  input: AgentSkillScriptSandboxInput,
  options: {
    cleanupTimeoutMs: number;
    spawnProcess: SkillScriptSpawn;
    cleanupRunner: SkillScriptCleanupRunner;
    killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  }
) {
  const timeoutMs = boundedInteger(input.timeoutMs, SKILL_SCRIPT_DEFAULT_TIMEOUT_MS, 1, SKILL_SCRIPT_MAX_TIMEOUT_MS);
  const outputBudgetBytes = boundedInteger(input.outputBudgetBytes, SKILL_SCRIPT_MAX_OUTPUT_BYTES, 1, SKILL_SCRIPT_MAX_OUTPUT_BYTES);
  const output = new BoundedOutput(outputBudgetBytes);
  let child: SkillScriptChild;
  try {
    child = options.spawnProcess(invocation.file, invocation.args, {
      cwd: "/",
      detached: true,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    if (invocation.cleanup) {
      await runCleanup(invocation.cleanup, options).catch(() => { throw stableError("SKILL_SCRIPT_CLEANUP_FAILED"); });
    }
    throw stableError("SKILL_SCRIPT_LAUNCH_FAILED");
  }
  let settled = false;
  let forced: "abort" | "timeout" | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    resolveExit = resolve;
  });
  const settle = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
    if (settled) return;
    settled = true;
    resolveExit(value);
  };
  child.stdout.on("data", (chunk: Buffer | Uint8Array | string) => output.append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer | Uint8Array | string) => output.append("stderr", chunk));
  child.once("error", (error) => settle({ code: null, signal: null, error }));
  child.once("exit", (code, signal) => settle({ code, signal }));
  const cleanup = () => cleanupPromise ??= invocation.cleanup
    ? runCleanup(invocation.cleanup, options)
    : Promise.resolve();
  let forcedGuardTimer: NodeJS.Timeout | undefined;
  let rejectForcedGuard!: (error: Error) => void;
  const forcedGuard = new Promise<never>((_resolve, reject) => {
    rejectForcedGuard = reject;
  });
  const watchForcedStop = () => {
    if (forcedGuardTimer) return;
    forcedGuardTimer = setTimeout(
      () => rejectForcedGuard(stableError("SKILL_SCRIPT_CLEANUP_FAILED")),
      options.cleanupTimeoutMs
    );
    forcedGuardTimer.unref?.();
  };
  const forceStop = (kind: "abort" | "timeout") => {
    if (forced || settled) return;
    forced = kind;
    watchForcedStop();
    try {
      if (invocation.kind === "bubblewrap" && child.pid) options.killProcessGroup(child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        cleanupPromise = Promise.reject(error);
      }
    }
    if (invocation.cleanup) cleanupPromise = cleanup();
    void cleanupPromise?.catch(() => rejectForcedGuard(stableError("SKILL_SCRIPT_CLEANUP_FAILED")));
  };
  const abortListener = () => forceStop("abort");
  input.signal?.addEventListener("abort", abortListener, { once: true });
  const timer = setTimeout(() => forceStop("timeout"), timeoutMs);
  timer.unref?.();
  if (input.signal?.aborted) forceStop("abort");
  let result: Awaited<typeof exited>;
  try {
    result = await Promise.race([exited, forcedGuard]);
    if (result.error && invocation.cleanup) cleanupPromise = cleanup();
    if (cleanupPromise) await cleanupPromise.catch(() => { throw stableError("SKILL_SCRIPT_CLEANUP_FAILED"); });
  } finally {
    clearTimeout(timer);
    if (forcedGuardTimer) clearTimeout(forcedGuardTimer);
    input.signal?.removeEventListener("abort", abortListener);
  }
  if (forced === "abort") throw stableError("SKILL_SCRIPT_ABORTED");
  if (forced === "timeout") throw stableError("SKILL_SCRIPT_TIMEOUT");
  if (result.error) throw stableError("SKILL_SCRIPT_PROCESS_ERROR");
  const code = result.code ?? 1;
  if (!Number.isSafeInteger(code) || code < 0 || code > 255) throw stableError("SKILL_SCRIPT_PROCESS_ERROR");
  return fitSandboxResultToBudget({
    ok: code === 0 && result.signal === null,
    exitCode: code,
    ...output.result()
  }, outputBudgetBytes);
}

class BoundedOutput {
  private remaining: number;
  private readonly maximumBytes: number;
  private readonly stdout: Buffer[] = [];
  private readonly stderr: Buffer[] = [];
  private stdoutTruncated = false;
  private stderrTruncated = false;

  constructor(maximumBytes: number) {
    this.remaining = maximumBytes;
    this.maximumBytes = maximumBytes;
  }

  append(kind: "stdout" | "stderr", value: Buffer | Uint8Array | string) {
    const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const used = Math.min(source.byteLength, this.remaining);
    if (used > 0) (kind === "stdout" ? this.stdout : this.stderr).push(Buffer.from(source.subarray(0, used)));
    this.remaining -= used;
    if (used < source.byteLength) {
      if (kind === "stdout") this.stdoutTruncated = true;
      else this.stderrTruncated = true;
    }
  }

  result() {
    const stdout = sanitizeOutput(Buffer.concat(this.stdout));
    const stderr = sanitizeOutput(Buffer.concat(this.stderr));
    const fittedStdout = truncateOutputText(stdout.text, this.maximumBytes);
    const remaining = this.maximumBytes - Buffer.byteLength(fittedStdout, "utf8");
    const fittedStderr = truncateOutputText(stderr.text, remaining);
    return {
      stdout: fittedStdout,
      stderr: fittedStderr,
      stdoutTruncated: this.stdoutTruncated || stdout.changed || fittedStdout !== stdout.text,
      stderrTruncated: this.stderrTruncated || stderr.changed || fittedStderr !== stderr.text
    };
  }
}

async function revalidateSandboxAudit(input: AgentSkillScriptSandboxInput) {
  let script: Buffer | undefined;
  try {
    script = await assertPinnedProjectedSkillScript({
      projection: input.projection,
      expectedDigestSha256: input.expectedDigestSha256,
      expectedSkillId: input.skillId,
      expectedResourcePath: input.resourcePath,
      expectedBytes: input.resourceBytes,
      expectedResourceSha256: input.resourceSha256
    });
    const audit = auditAgentSkillScript({
      agentId: input.agentId,
      conversationId: input.conversationId,
      skillId: input.skillId,
      expectedDigestSha256: input.expectedDigestSha256,
      resource: {
        path: input.resourcePath,
        bytes: input.resourceBytes,
        sha256: input.resourceSha256
      },
      args: input.args,
      bytes: script
    });
    if (audit.interpreter !== input.interpreter ||
        audit.fingerprintSha256 !== input.preflightFingerprintSha256 ||
        audit.scriptSha256 !== input.resourceSha256) {
      throw stableError("SKILL_SCRIPT_AUDIT_MISMATCH");
    }
  } finally {
    script?.fill(0);
  }
}

function sanitizeOutput(source: Buffer) {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
  } catch {
    return { text: "[INVALID_UTF8]", changed: true };
  }
  const controlsRemoved = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
  const fileUrlsRemoved = controlsRemoved.replace(/file:\/\/[^\s"'`)}\]]+/giu, "[HOST_PATH]");
  const windowsRemoved = fileUrlsRemoved
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'`)}\]]+/gu, "[HOST_PATH]");
  const pathsRemoved = windowsRemoved.replace(
    /(^|[\s("'`=:])\/[^\s"'`)}\]]+/gu,
    (match, prefix: string) => {
      const candidate = match.slice(prefix.length);
      if (candidate === "/workbench" || candidate.startsWith("/workbench/") ||
          candidate === "/skills" || candidate.startsWith("/skills/")) {
        return match;
      }
      return `${prefix}[HOST_PATH]`;
    }
  );
  return { text: pathsRemoved, changed: pathsRemoved !== value };
}

function truncateOutputText(value: string, maximumBytes: number) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return value;
  let end = Math.max(0, maximumBytes);
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function validateSandboxInput(input: AgentSkillScriptSandboxInput) {
  if (!SAFE_ID.test(input.agentId) || !SAFE_ID.test(input.skillId) || !input.conversationId ||
      input.conversationId.length > 512 || /[\u0000\r\n]/u.test(input.conversationId) ||
      !SHA256.test(input.expectedDigestSha256) ||
      !SHA256.test(input.resourceSha256) || !SHA256.test(input.preflightFingerprintSha256) ||
      !SHA256.test(input.auditFingerprintSha256) ||
      !safeRelativeResourcePath(input.resourcePath) || !input.resourcePath.startsWith("scripts/") ||
      input.projection.digestSha256 !== input.expectedDigestSha256 ||
      input.projection.virtualScript !== `/skills/${input.skillId}/${input.resourcePath}` ||
      !Number.isSafeInteger(input.resourceBytes) || input.resourceBytes < 1 ||
      (input.interpreter !== SKILL_SCRIPT_BASH_INTERPRETER && input.interpreter !== SKILL_SCRIPT_NODE_INTERPRETER) ||
      !Array.isArray(input.args) ||
      input.args.some((value) => typeof value !== "string" || /[\u0000\r\n]/u.test(value))) {
    throw stableError("SKILL_SCRIPT_SANDBOX_INPUT_INVALID");
  }
}

function validateMountSource(value: string) {
  if (!path.isAbsolute(value) || /[\u0000\r\n,]/u.test(value)) throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  const resolved = path.resolve(value);
  if (resolved !== value) throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  return resolved;
}

function validateAbsoluteExecutable(value: string) {
  if (!path.isAbsolute(value) || /[\u0000\r\n]/u.test(value)) throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  const resolved = path.resolve(value);
  if (resolved !== value) throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  return resolved;
}

function validateImmutableImage(value: string | undefined) {
  if (!value || (!/^sha256:[a-f0-9]{64}$/u.test(value) &&
      !/^[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(value))) {
    throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  }
  return value;
}

function validateDockerEnvironment(input: Readonly<Record<string, string>>) {
  if (Object.keys(input).some((key) => key !== "DOCKER_HOST") ||
      Object.values(input).some((value) => /[\u0000\r\n]/u.test(value) || value.length > 4_096)) {
    throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE");
  }
  return { ...input };
}

async function assertExecutable(file: string) {
  await fs.access(file, 1).catch(() => { throw stableError("SKILL_SCRIPT_ISOLATION_UNAVAILABLE"); });
}

function addVirtualParents(args: string[], target: string) {
  const segments = path.posix.dirname(target).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    args.push("--dir", current);
  }
}

async function runCleanup(
  cleanup: NonNullable<SkillScriptInvocation["cleanup"]>,
  options: { cleanupTimeoutMs: number; cleanupRunner: SkillScriptCleanupRunner }
) {
  await withDeadline(Promise.resolve().then(() => options.cleanupRunner({
    ...cleanup,
    timeoutMs: options.cleanupTimeoutMs
  })), options.cleanupTimeoutMs);
}

function defaultSpawn(file: string, args: readonly string[], options: Parameters<SkillScriptSpawn>[2]) {
  return spawn(file, [...args], options) as unknown as SkillScriptChild;
}

function defaultCleanupRunner(input: {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) {
  return new Promise<void>((resolve, reject) => {
    execFile(input.file, [...input.args], {
      cwd: "/",
      env: { ...input.env },
      timeout: input.timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true
    }, (error) => error ? reject(error) : resolve());
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(stableError("SKILL_SCRIPT_CLEANUP_FAILED")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw stableError("SKILL_SCRIPT_LIMIT_INVALID");
  }
  return resolved;
}

function requireSandboxResultBudget(maximumBytes: number) {
  const minimum = {
    ok: false,
    exitCode: 255,
    stdout: "",
    stderr: "",
    stdoutTruncated: true,
    stderrTruncated: true
  } satisfies AgentSkillScriptSandboxResult;
  if (Buffer.byteLength(JSON.stringify(minimum), "utf8") > maximumBytes) {
    throw stableError("SKILL_SCRIPT_LIMIT_INVALID");
  }
}

function fitSandboxResultToBudget(result: AgentSkillScriptSandboxResult, maximumBytes: number) {
  const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes(result) <= maximumBytes) return result;
  const empty: AgentSkillScriptSandboxResult = {
    ...result,
    stdout: "",
    stderr: "",
    stdoutTruncated: true,
    stderrTruncated: true
  };
  if (serializedBytes(empty) > maximumBytes) throw stableError("SKILL_SCRIPT_LIMIT_INVALID");
  let lower = 0;
  let upper = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
  let accepted = empty;
  while (lower <= upper) {
    const allowed = Math.floor((lower + upper) / 2);
    const stdout = truncateOutputText(result.stdout, allowed);
    const used = Buffer.byteLength(stdout, "utf8");
    const stderr = truncateOutputText(result.stderr, Math.max(0, allowed - used));
    const candidate: AgentSkillScriptSandboxResult = {
      ...result,
      stdout,
      stderr,
      stdoutTruncated: result.stdoutTruncated || stdout !== result.stdout,
      stderrTruncated: result.stderrTruncated || stderr !== result.stderr
    };
    if (serializedBytes(candidate) <= maximumBytes) {
      accepted = candidate;
      lower = allowed + 1;
    } else {
      upper = allowed - 1;
    }
  }
  return accepted;
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "SkillScriptError";
  return error;
}
