import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  HardenedStdioLaunchHandlers,
  HardenedStdioLaunchSpec,
  HardenedStdioProcess,
  HardenedStdioProcessLauncher
} from "./hardenedStdioTransport.js";
import type { McpSandboxProjection } from "./sandboxProjection.js";
import {
  MCP_STDIO_LAUNCH_DIRECTORY_VIRTUAL_PATH
} from "./stdioEntrypointSource.js";
import {
  assertMcpStdioLaunchProjectionIdentity,
  createMcpStdioLaunchProjection,
  type McpStdioLaunchProjection
} from "./stdioLaunchProjection.js";
import {
  assertMcpSandboxProjectionIdentity,
  captureMcpSandboxProjectionIdentity
} from "./sandboxProjectionIdentity.js";
import {
  clearMcpStdioResolvedEnvironment,
  invalidMcpStdioText,
  validateMcpStdioLaunchSpec
} from "./stdioLaunchPolicy.js";

export const MCP_STDIO_DOCKER_IMAGE = "sunabot-mcp:local";
export const MCP_STDIO_DOCKER_EXECUTABLE = "/usr/local/bin/docker";
export const MCP_STDIO_DOCKER_ENTRYPOINT = "/usr/local/libexec/sunabot-mcp-stdio-entrypoint";

const DEFAULT_LIFETIME_MS = 300_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface McpDockerInvocation {
  file: string;
  args: string[];
  env: Readonly<Record<string, string>>;
  containerName: string;
  cleanup: {
    file: string;
    args: ["rm", "-f", string];
    env: Readonly<Record<string, string>>;
  };
  probe: {
    file: string;
    args: string[];
    env: Readonly<Record<string, string>>;
    containerName: string;
    cleanup: {
      file: string;
      args: ["rm", "-f", string];
      env: Readonly<Record<string, string>>;
    };
  };
}

export interface McpDockerStdioChild {
  readonly pid?: number;
  readonly stdin: {
    write(value: string, callback: (error?: Error | null) => void): boolean;
    end(callback: () => void): unknown;
  };
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type McpDockerStdioSpawn = (
  file: string,
  args: readonly string[],
  options: {
    cwd: "/";
    detached: true;
    env: Readonly<Record<string, string>>;
    stdio: readonly ["pipe", "pipe", "pipe"];
  }
) => McpDockerStdioChild;

export type McpDockerCleanupRunner = (input: {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) => Promise<void>;

export type McpDockerImageResolver = (input: {
  file: string;
  image: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) => Promise<string>;

export interface DockerMcpStdioLauncherOptions {
  dockerExecutable?: string;
  image?: string;
  dockerImage?: string;
  dockerEnvironment?: Readonly<Record<string, string>>;
  effectiveUid?: number;
  effectiveGid?: number;
  lifetimeMs?: number;
  cleanupTimeoutMs?: number;
  probeTimeoutMs?: number;
  abortSignal?: AbortSignal;
  spawnProcess?: McpDockerStdioSpawn;
  cleanupRunner?: McpDockerCleanupRunner;
  probeRunner?: McpDockerCleanupRunner;
  imageResolver?: McpDockerImageResolver;
  containerNameFactory?: () => string;
  probeContainerNameFactory?: () => string;
}

export class DockerMcpStdioLauncher implements HardenedStdioProcessLauncher {
  private launched = false;

  constructor(
    private readonly projection: McpSandboxProjection,
    private readonly options: DockerMcpStdioLauncherOptions = {}
  ) {}

  async launch(spec: HardenedStdioLaunchSpec, handlers: HardenedStdioLaunchHandlers) {
    if (this.launched) {
      clearMcpStdioResolvedEnvironment(spec.env);
      throw stableError("MCP_STDIO_LAUNCH_REUSED");
    }
    this.launched = true;
    let cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS;
    let invocation: McpDockerInvocation | undefined;
    let launchProjection: McpStdioLaunchProjection | undefined;
    try {
      cleanupTimeoutMs = boundedDuration(this.options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, 30_000);
      const lifetimeMs = boundedDuration(this.options.lifetimeMs, DEFAULT_LIFETIME_MS, 24 * 60 * 60 * 1_000);
      const probeTimeoutMs = boundedDuration(this.options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 30_000);
      const dockerExecutable = this.options.dockerExecutable ?? MCP_STDIO_DOCKER_EXECUTABLE;
      const configuredImage = this.options.image ?? this.options.dockerImage ?? MCP_STDIO_DOCKER_IMAGE;
      validateConfiguredDockerImage(configuredImage);
      const dockerEnvironment = validateDockerEnvironment(this.options.dockerEnvironment ?? {});
      const uid = this.options.effectiveUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
      const gid = this.options.effectiveGid ?? (typeof process.getgid === "function" ? process.getgid() : uid);
      const containerName = (this.options.containerNameFactory ?? createContainerName)();
      const probeContainerName = (this.options.probeContainerNameFactory ?? createProbeContainerName)();
      validateMcpStdioLaunchSpec(spec);
      if (this.options.abortSignal?.aborted) throw stableError("MCP_STDIO_ABORTED");
      const projectionIdentity = await captureMcpSandboxProjectionIdentity(this.projection, {
        requireExecutableManifest: false
      });
      const image = isImmutableMcpDockerImage(configuredImage)
        ? configuredImage
        : await withDeadline(Promise.resolve().then(() => (
          this.options.imageResolver ?? defaultImageResolver
        )({
          file: dockerExecutable,
          image: configuredImage,
          env: dockerEnvironment,
          timeoutMs: probeTimeoutMs
        })), probeTimeoutMs, "MCP_STDIO_ISOLATION_UNAVAILABLE");
      if (!isImmutableMcpDockerImage(image)) throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
      launchProjection = await createMcpStdioLaunchProjection({ projection: this.projection, spec });
      await Promise.all([
        assertMcpSandboxProjectionIdentity(this.projection, projectionIdentity, {
          requireExecutableManifest: false
        }),
        assertMcpStdioLaunchProjectionIdentity(launchProjection)
      ]);
      invocation = buildMcpDockerInvocation({
        spec,
        projection: this.projection,
        launchProjection,
        dockerExecutable,
        image,
        containerName,
        probeContainerName,
        dockerEnvironment,
        uid,
        gid
      });
      try {
        await withDeadline(Promise.resolve().then(() => (this.options.probeRunner ?? defaultCommandRunner)({
          file: invocation!.probe.file,
          args: invocation!.probe.args,
          env: invocation!.probe.env,
          timeoutMs: probeTimeoutMs
        })), probeTimeoutMs);
      } catch {
        await cleanupInvocation(invocation.probe.cleanup, this.options.cleanupRunner, cleanupTimeoutMs);
        throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
      }
      await Promise.all([
        assertMcpSandboxProjectionIdentity(this.projection, projectionIdentity, {
          requireExecutableManifest: false
        }),
        assertMcpStdioLaunchProjectionIdentity(launchProjection)
      ]);
      const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
      const child = spawnProcess(invocation.file, invocation.args, {
        cwd: "/",
        detached: true,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return bindDockerProcess({
        child,
        handlers,
        invocation,
        dispose: async () => {
          await disposeAll([launchProjection?.dispose.bind(launchProjection), this.projection.dispose.bind(this.projection)]);
        },
        cleanupTimeoutMs,
        lifetimeMs,
        abortSignal: this.options.abortSignal,
        cleanupRunner: this.options.cleanupRunner ?? defaultCleanupRunner
      });
    } catch (error) {
      let cleanupFailed = false;
      let secretClearFailed = false;
      if (invocation) {
        const failedInvocation = invocation;
        const cleanup = await Promise.allSettled([
          cleanupInvocation(failedInvocation.cleanup, this.options.cleanupRunner, cleanupTimeoutMs),
          cleanupInvocation(failedInvocation.probe.cleanup, this.options.cleanupRunner, cleanupTimeoutMs)
        ]);
        cleanupFailed = cleanup.some((result) => result.status === "rejected");
      }
      try {
        clearMcpStdioResolvedEnvironment(spec.env);
      } catch {
        secretClearFailed = true;
      }
      const projectionCleanupFailed = await disposeAll([
        launchProjection?.dispose.bind(launchProjection),
        this.projection.dispose.bind(this.projection)
      ]).then(() => false, () => true);
      if (cleanupFailed) throw stableError("MCP_STDIO_CLEANUP_FAILED");
      if (projectionCleanupFailed) throw stableError("MCP_STDIO_CLEANUP_FAILED");
      if (secretClearFailed) throw stableError("MCP_STDIO_SECRET_CLEAR_FAILED");
      if (error instanceof Error && error.name === "McpAdapterError") throw error;
      throw stableError("MCP_STDIO_LAUNCH_FAILED");
    }
  }
}

export function buildMcpDockerInvocation(input: {
  spec: HardenedStdioLaunchSpec;
  projection: Pick<McpSandboxProjection, "workbench" | "skills" | "config">;
  launchProjection: Pick<McpStdioLaunchProjection, "hostDirectory">;
  dockerExecutable?: string;
  image?: string;
  containerName?: string;
  probeContainerName?: string;
  dockerEnvironment?: Readonly<Record<string, string>>;
  uid?: number;
  gid?: number;
}): McpDockerInvocation {
  validateMcpStdioLaunchSpec(input.spec);
  const dockerExecutable = input.dockerExecutable ?? MCP_STDIO_DOCKER_EXECUTABLE;
  const image = input.image ?? MCP_STDIO_DOCKER_IMAGE;
  const containerName = input.containerName ?? createContainerName();
  const probeContainerName = input.probeContainerName ?? createProbeContainerName();
  const uid = input.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const gid = input.gid ?? (typeof process.getgid === "function" ? process.getgid() : uid);
  validateDockerConfiguration({ dockerExecutable, image, containerName, probeContainerName, uid, gid });
  const dockerEnvironment = validateDockerEnvironment(input.dockerEnvironment ?? {});
  const workbench = validateMountSource(input.projection.workbench);
  const skills = validateMountSource(input.projection.skills);
  const config = validateMountSource(input.projection.config);
  const launchDirectory = validateMountSource(input.launchProjection.hostDirectory);
  const common = [
    "run", "--rm", "--init", "--pull", "never",
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
    "--mount", `type=bind,src=${workbench},dst=/workbench,rw`,
    "--mount", `type=bind,src=${skills},dst=/skills,readonly`,
    "--mount", `type=bind,src=${config},dst=/run/sunabot/extensions/mcp.json,readonly`,
    "--mount", `type=bind,src=${launchDirectory},dst=${MCP_STDIO_LAUNCH_DIRECTORY_VIRTUAL_PATH},readonly`,
    "--workdir", "/workbench",
    "--entrypoint", MCP_STDIO_DOCKER_ENTRYPOINT,
    image
  ];
  const args = [common[0]!, "--name", containerName, ...common.slice(1)];
  const probeArgs = [common[0]!, "--name", probeContainerName, ...common.slice(1), "--probe"];
  return {
    file: dockerExecutable,
    args,
    env: dockerEnvironment,
    containerName,
    cleanup: {
      file: dockerExecutable,
      args: ["rm", "-f", containerName],
      env: dockerEnvironment
    },
    probe: {
      file: dockerExecutable,
      args: probeArgs,
      env: dockerEnvironment,
      containerName: probeContainerName,
      cleanup: {
        file: dockerExecutable,
        args: ["rm", "-f", probeContainerName],
        env: dockerEnvironment
      }
    }
  };
}

function bindDockerProcess(input: {
  child: McpDockerStdioChild;
  handlers: HardenedStdioLaunchHandlers;
  invocation: McpDockerInvocation;
  dispose: () => Promise<void>;
  cleanupTimeoutMs: number;
  lifetimeMs: number;
  abortSignal?: AbortSignal;
  cleanupRunner: McpDockerCleanupRunner;
}): HardenedStdioProcess {
  let finished = false;
  let disposePromise: Promise<void> | undefined;
  let terminationExpected = false;
  let rawFinished = false;
  let cleanupPromise: Promise<void> | undefined;
  let resolveExit!: () => void;
  let resolveRawExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const rawExited = new Promise<void>((resolve) => { resolveRawExit = resolve; });
  const disposeOnce = async () => {
    disposePromise ??= input.dispose().catch(() => {
      disposePromise = undefined;
      throw stableError("MCP_STDIO_CLEANUP_FAILED");
    });
    await disposePromise;
  };
  const cleanupOnce = () => cleanupPromise ??= withDeadline(Promise.resolve().then(() => input.cleanupRunner({
    ...input.invocation.cleanup,
    timeoutMs: input.cleanupTimeoutMs
  })), input.cleanupTimeoutMs).catch(() => { throw stableError("MCP_STDIO_CLEANUP_FAILED"); });
  const clearHooks = () => {
    clearTimeout(watchdog);
    if (input.abortSignal) input.abortSignal.removeEventListener("abort", abortListener);
  };
  const finish = async (kind: "exit" | "error" | "abort" | "timeout" | "cleanup", error?: unknown) => {
    if (finished) return;
    finished = true;
    clearHooks();
    let cleanupFailed = kind === "cleanup";
    if (kind !== "exit" && kind !== "cleanup") {
      const cleanup = await Promise.allSettled([cleanupOnce(), disposeOnce()]);
      cleanupFailed ||= cleanup.some((result) => result.status === "rejected");
    } else {
      try {
        await disposeOnce();
      } catch {
        cleanupFailed = true;
      }
    }
    if (kind === "exit" && !cleanupFailed) input.handlers.exit();
    else input.handlers.error(stableError(cleanupFailed
      ? "MCP_STDIO_CLEANUP_FAILED"
      : kind === "abort"
      ? "MCP_STDIO_ABORTED"
      : kind === "timeout"
        ? "MCP_STDIO_TIMEOUT"
        : error instanceof Error && error.name === "McpAdapterError"
          ? error.message
          : "MCP_STDIO_PROCESS_ERROR"));
    resolveExit();
  };
  const forceStop = async (kind: "abort" | "timeout") => {
    terminationExpected = true;
    try { input.child.kill("SIGKILL"); } catch { /* docker rm remains authoritative */ }
    try {
      await cleanupOnce();
      if (!await waitForRawExit(rawExited, input.cleanupTimeoutMs)) {
        await finish("cleanup");
        return;
      }
      await finish(kind);
    } catch {
      await finish("cleanup");
    }
  };
  const abortListener = () => { void forceStop("abort"); };
  const watchdog = setTimeout(() => { void forceStop("timeout"); }, input.lifetimeMs);
  watchdog.unref?.();
  input.child.stdout.on("data", (chunk: Buffer) => input.handlers.stdout(chunk));
  input.child.stderr.on("data", (chunk: Buffer) => input.handlers.stderr(chunk));
  input.child.once("error", (error) => {
    rawFinished = true;
    resolveRawExit();
    if (!terminationExpected) void finish("error", error);
  });
  input.child.once("exit", (code, signal) => {
    rawFinished = true;
    resolveRawExit();
    if (terminationExpected) return;
    if (code === 0 && signal === null) void finish("exit");
    else void finish("error");
  });
  if (input.abortSignal) {
    input.abortSignal.addEventListener("abort", abortListener, { once: true });
    if (input.abortSignal.aborted) abortListener();
  }
  return {
    writeStdin(value) {
      return new Promise<void>((resolve, reject) => {
        input.child.stdin.write(value, (error) => error ? reject(error) : resolve());
      });
    },
    closeStdin() {
      return new Promise<void>((resolve) => { input.child.stdin.end(resolve); });
    },
    async waitForExit(timeoutMs) {
      return waitForExit(exited, timeoutMs);
    },
    async terminateGroup(signal) {
      terminationExpected = true;
      try { input.child.kill(signal); } catch { /* docker rm remains authoritative */ }
      try {
        await cleanupOnce();
      } catch {
        await finish("cleanup");
        throw stableError("MCP_STDIO_CLEANUP_FAILED");
      }
      await disposeOnce();
      if (signal === "SIGKILL") {
        if (!await waitForRawExit(rawExited, input.cleanupTimeoutMs)) {
          await finish("cleanup");
          throw stableError("MCP_STDIO_CLEANUP_FAILED");
        }
        if (!finished) await finish("exit");
      } else if (rawFinished) {
        if (!finished) await finish("exit");
      }
    }
  };
}

async function disposeAll(operations: Array<(() => Promise<void>) | undefined>) {
  const settled = await Promise.allSettled(operations.filter((operation): operation is () => Promise<void> =>
    operation !== undefined).map((operation) => operation()));
  if (settled.some((result) => result.status === "rejected")) throw stableError("MCP_STDIO_CLEANUP_FAILED");
}

function validateDockerConfiguration(input: {
  dockerExecutable: string;
  image: string;
  containerName: string;
  probeContainerName: string;
  uid: number;
  gid: number;
}) {
  if (!path.isAbsolute(input.dockerExecutable) || invalidMcpStdioText(input.dockerExecutable) ||
      !isImmutableMcpDockerImage(input.image) || !/^sunabot-mcp-[a-f0-9]{32}$/u.test(input.containerName) ||
      !/^sunabot-mcp-probe-[a-f0-9]{32}$/u.test(input.probeContainerName) ||
      !Number.isSafeInteger(input.uid) || input.uid <= 0 || !Number.isSafeInteger(input.gid) || input.gid <= 0) {
    throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
  }
}

function isImmutableMcpDockerImage(image: string) {
  return /^(?:[A-Za-z0-9][A-Za-z0-9._/:+-]{0,190}@)?sha256:[a-f0-9]{64}$/u.test(image) &&
    !image.includes("..") && !image.includes("//");
}

function validateConfiguredDockerImage(image: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,255}$/u.test(image) || image.includes("..") || image.includes("//")) {
    throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
  }
}

function validateDockerEnvironment(input: Readonly<Record<string, string>>) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "DOCKER_HOST" || !/^unix:\/\/[A-Za-z0-9_./+-]+$/u.test(value) || value.includes("..") ||
        invalidMcpStdioText(value)) {
      throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
    }
    environment[key] = value;
  }
  return environment;
}

function validateMountSource(value: string) {
  if (!path.isAbsolute(value) || /[\u0000\r\n,]/u.test(value) || value.split(path.sep).includes("..")) {
    throw stableError("MCP_SANDBOX_PROJECTION_INVALID");
  }
  return path.resolve(value);
}

function createContainerName() {
  return `sunabot-mcp-${randomBytes(16).toString("hex")}`;
}

function createProbeContainerName() {
  return `sunabot-mcp-probe-${randomBytes(16).toString("hex")}`;
}

function boundedDuration(value: number | undefined, fallback: number, maximum: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw stableError("MCP_STDIO_CONFIG_INVALID");
  }
  return resolved;
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: Parameters<McpDockerStdioSpawn>[2]
) {
  return spawn(file, [...args], {
    cwd: options.cwd,
    detached: options.detached,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"]
  }) as unknown as McpDockerStdioChild;
}

function defaultCleanupRunner(input: {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) {
  return new Promise<void>((resolve, reject) => {
    let completed = false;
    let child: ReturnType<typeof execFile> | undefined;
    const finish = (error?: unknown) => {
      if (completed) return;
      completed = true;
      clearTimeout(watchdog);
      if (error) reject(error);
      else resolve();
    };
    const watchdog = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* bounded failure below */ }
      finish(stableError("MCP_STDIO_CLEANUP_FAILED"));
    }, input.timeoutMs);
    watchdog.unref?.();
    try {
      child = execFile(input.file, [...input.args], {
        cwd: "/",
        env: { ...input.env },
        timeout: input.timeoutMs,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL"
      }, (error, _stdout, stderr) => {
        const absent = /no such container/iu.test(`${stderr}\n${error?.message ?? ""}`);
        finish(error && !absent ? error : undefined);
      });
    } catch (error) {
      finish(error);
    }
  });
}

function defaultCommandRunner(input: {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) {
  return new Promise<void>((resolve, reject) => {
    let completed = false;
    let child: ReturnType<typeof execFile> | undefined;
    const finish = (error?: unknown) => {
      if (completed) return;
      completed = true;
      clearTimeout(watchdog);
      if (error) reject(stableError("MCP_STDIO_ISOLATION_UNAVAILABLE"));
      else resolve();
    };
    const watchdog = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* bounded failure below */ }
      finish(stableError("MCP_STDIO_ISOLATION_UNAVAILABLE"));
    }, input.timeoutMs);
    watchdog.unref?.();
    try {
      child = execFile(input.file, [...input.args], {
        cwd: "/",
        env: { ...input.env },
        timeout: input.timeoutMs,
        maxBuffer: 64 * 1024,
        killSignal: "SIGKILL"
      }, (error) => finish(error ?? undefined));
    } catch (error) {
      finish(error);
    }
  });
}

function defaultImageResolver(input: {
  file: string;
  image: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}) {
  return new Promise<string>((resolve, reject) => {
    try {
      execFile(input.file, ["image", "inspect", "--format={{.Id}}", input.image], {
        cwd: "/",
        env: { ...input.env },
        timeout: input.timeoutMs,
        maxBuffer: 4 * 1024,
        killSignal: "SIGKILL"
      }, (error, stdout) => {
        const digest = stdout.trim();
        if (error || !isImmutableMcpDockerImage(digest)) {
          reject(stableError("MCP_STDIO_ISOLATION_UNAVAILABLE"));
          return;
        }
        resolve(digest);
      });
    } catch {
      reject(stableError("MCP_STDIO_ISOLATION_UNAVAILABLE"));
    }
  });
}

function cleanupInvocation(
  cleanup: McpDockerInvocation["cleanup"],
  runner: McpDockerCleanupRunner | undefined,
  timeoutMs: number
) {
  return withDeadline(Promise.resolve().then(() => (runner ?? defaultCleanupRunner)({
    ...cleanup,
    timeoutMs
  })), timeoutMs).catch(() => { throw stableError("MCP_STDIO_CLEANUP_FAILED"); });
}

function waitForExit(exited: Promise<void>, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function waitForRawExit(exited: Promise<void>, timeoutMs: number) {
  return waitForExit(exited, timeoutMs);
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, code = "MCP_STDIO_CLEANUP_FAILED") {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(stableError(code)), timeoutMs);
    timer.unref?.();
    operation.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
