import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  MCP_STDIO_ENTRYPOINT_VIRTUAL_PATH,
  MCP_STDIO_LAUNCH_DIRECTORY_VIRTUAL_PATH
} from "./stdioEntrypointSource.js";
import {
  assertMcpStdioLaunchProjectionIdentity,
  createMcpStdioLaunchProjection,
  type McpStdioLaunchProjection
} from "./stdioLaunchProjection.js";
import {
  clearMcpStdioResolvedEnvironment,
  isMcpRuntimeDownloaderCommand,
  validateMcpStdioLaunchSpec
} from "./stdioLaunchPolicy.js";
import {
  MCP_APPROVED_EXECUTABLE_MANIFEST_PATH,
  verifyMcpApprovedExecutable
} from "./approvedExecutableManifest.js";
import {
  assertMcpSandboxProjectionIdentity,
  captureMcpSandboxProjectionIdentity
} from "./sandboxProjectionIdentity.js";

const BWRAP = "/usr/bin/bwrap";
const PRLIMIT = "/usr/bin/prlimit";
const FIXED_PATH = "/usr/local/bin:/usr/bin:/bin";

export function resolveMcpBubblewrapExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configured = environment.SUNABOT_BWRAP_EXECUTABLE?.trim();
  if (!configured) {
    if (environment.SUNABOT_PACKAGED_RELEASE === "1") {
      throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
    }
    return BWRAP;
  }
  return validateBubblewrapExecutable(configured);
}

export class BubblewrapMcpStdioLauncher implements HardenedStdioProcessLauncher {
  private launched = false;

  constructor(
    private readonly projection: McpSandboxProjection,
    private readonly options: { platform?: NodeJS.Platform; bwrap?: string; prlimit?: string } = {}
  ) {}

  async launch(spec: HardenedStdioLaunchSpec, handlers: HardenedStdioLaunchHandlers) {
    if (this.launched) {
      clearMcpStdioResolvedEnvironment(spec.env);
      throw stableError("MCP_STDIO_LAUNCH_REUSED");
    }
    this.launched = true;
    const platform = this.options.platform ?? process.platform;
    if (platform !== "linux") {
      let clearError: unknown;
      try {
        clearMcpStdioResolvedEnvironment(spec.env);
      } catch (error) {
        clearError = error;
      }
      await this.projection.dispose().catch(() => { throw stableError("MCP_STDIO_CLEANUP_FAILED"); });
      if (clearError) throw clearError;
      throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
    }
    const bwrap = this.options.bwrap ?? resolveMcpBubblewrapExecutable();
    const prlimit = this.options.prlimit ?? PRLIMIT;
    let launchProjection: McpStdioLaunchProjection | undefined;
    try {
      validateMcpStdioLaunchSpec(spec);
      await Promise.all([
        assertExecutable(bwrap),
        assertExecutable(prlimit),
        assertExecutable(spec.command)
      ]);
      const projectionIdentity = await captureMcpSandboxProjectionIdentity(this.projection, {
        requireExecutableManifest: true
      });
      const canonicalCommand = await fs.realpath(spec.command);
      if (isMcpRuntimeDownloaderCommand(canonicalCommand, spec.args)) {
        throw stableError("MCP_STDIO_CONFIG_INVALID");
      }
      launchProjection = await createMcpStdioLaunchProjection({ projection: this.projection, spec });
      await assertMcpSandboxProjectionIdentity(this.projection, projectionIdentity, {
        requireExecutableManifest: true
      });
      await verifyMcpApprovedExecutable({
        manifestFile: requiredExecutableManifest(this.projection),
        command: spec.command,
        expectedManifestUid: typeof process.getuid === "function" ? process.getuid() : 0,
        expectedExecutableUid: 0
      });
      await assertMcpStdioLaunchProjectionIdentity(launchProjection);
      const invocation = buildMcpBubblewrapInvocation(spec, this.projection, {
        bwrap,
        prlimit,
        launchProjection
      });
      const child = spawn(invocation.file, invocation.args, {
        cwd: "/",
        detached: true,
        env: {},
        stdio: ["pipe", "pipe", "pipe"]
      });
      return bindProcess(child, handlers, async () => {
        await disposeAll([launchProjection?.dispose.bind(launchProjection), this.projection.dispose.bind(this.projection)]);
      });
    } catch (error) {
      let resolvedError = error;
      try {
        clearMcpStdioResolvedEnvironment(spec.env);
      } catch (clearError) {
        resolvedError = clearError;
      }
      const cleanupFailed = await disposeAll([
        launchProjection?.dispose.bind(launchProjection),
        this.projection.dispose.bind(this.projection)
      ]).then(() => false, () => true);
      if (cleanupFailed) throw stableError("MCP_STDIO_CLEANUP_FAILED");
      if (resolvedError instanceof Error && resolvedError.name === "McpAdapterError") throw resolvedError;
      throw stableError("MCP_STDIO_LAUNCH_FAILED");
    }
  }
}

export function buildMcpBubblewrapInvocation(
  spec: HardenedStdioLaunchSpec,
  projection: Pick<McpSandboxProjection, "workbench" | "skills" | "config" | "executableManifest">,
  executables: {
    bwrap?: string;
    prlimit?: string;
    launchProjection?: Pick<McpStdioLaunchProjection, "hostDirectory" | "hostEntrypoint">;
  } = {}
) {
  validateMcpStdioLaunchSpec(spec);
  if (!executables.launchProjection) throw stableError("MCP_STDIO_SECRET_PROJECTION_INVALID");
  const bwrap = executables.bwrap ?? BWRAP;
  const prlimit = executables.prlimit ?? PRLIMIT;
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
    "--dir", "/etc",
    "--dir", "/run",
    "--dir", "/run/sunabot",
    "--dir", "/run/sunabot/bin",
    "--dir", "/run/sunabot/extensions",
    "--dir", "/run/sunabot/secrets",
    "--dir", "/opt",
    "--dir", "/opt/sunabot",
    "--dir", "/opt/sunabot/mcp",
    "--dir", "/workbench",
    "--dir", "/skills"
  ];
  for (const directory of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    args.push("--dir", directory, "--ro-bind-try", directory, directory);
  }
  for (const directory of ["/etc/ssl", "/etc/ca-certificates"]) {
    addVirtualParents(args, directory);
    args.push("--ro-bind-try", directory, directory);
  }
  for (const file of ["/etc/passwd", "/etc/group", "/etc/localtime"]) {
    addVirtualParents(args, file);
    args.push("--ro-bind-try", file, file);
  }
  args.push(
    "--bind", projection.workbench, "/workbench",
    "--ro-bind", projection.skills, "/skills",
    "--ro-bind", projection.config, "/run/sunabot/extensions/mcp.json",
    "--ro-bind", requiredExecutableManifest(projection), MCP_APPROVED_EXECUTABLE_MANIFEST_PATH,
    "--ro-bind", executables.launchProjection.hostDirectory, MCP_STDIO_LAUNCH_DIRECTORY_VIRTUAL_PATH,
    "--ro-bind", executables.launchProjection.hostEntrypoint, MCP_STDIO_ENTRYPOINT_VIRTUAL_PATH,
    "--chdir", "/workbench",
    "--clearenv",
    "--setenv", "HOME", "/workbench",
    "--setenv", "PWD", "/workbench",
    "--setenv", "PATH", FIXED_PATH,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp"
  );
  args.push("--", MCP_STDIO_ENTRYPOINT_VIRTUAL_PATH);
  return { file: prlimit, args };
}

async function assertExecutable(file: string) {
  validateBubblewrapExecutable(file);
  await fs.access(file, 1).catch(() => { throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE"); });
}

function validateBubblewrapExecutable(file: string) {
  if (!path.isAbsolute(file) || /[\u0000\r\n]/u.test(file) || path.resolve(file) !== file) {
    throw stableError("MCP_STDIO_ISOLATION_UNAVAILABLE");
  }
  return file;
}

function requiredExecutableManifest(projection: Pick<McpSandboxProjection, "executableManifest">) {
  const manifest = projection.executableManifest;
  if (!manifest || !path.isAbsolute(manifest) || /[\u0000\r\n]/u.test(manifest)) {
    throw stableError("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");
  }
  return path.resolve(manifest);
}

function bindProcess(
  child: ChildProcessWithoutNullStreams,
  handlers: HardenedStdioLaunchHandlers,
  dispose: () => Promise<void>
): HardenedStdioProcess {
  let done = false;
  let disposePromise: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const disposeOnce = async () => {
    disposePromise ??= dispose().catch(() => {
      disposePromise = undefined;
      throw stableError("MCP_STDIO_CLEANUP_FAILED");
    });
    await disposePromise;
  };
  const finish = async (error?: unknown) => {
    if (done) return;
    done = true;
    let cleanupFailed = false;
    try {
      await disposeOnce();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) handlers.error(stableError("MCP_STDIO_CLEANUP_FAILED"));
    else if (error) handlers.error(error);
    else handlers.exit();
    resolveExit();
  };
  child.stdout.on("data", (chunk: Buffer) => handlers.stdout(chunk));
  child.stderr.on("data", (chunk: Buffer) => handlers.stderr(chunk));
  child.once("error", (error) => { void finish(error); });
  child.once("exit", () => { void finish(); });
  return {
    writeStdin(value) {
      return new Promise<void>((resolve, reject) => child.stdin.write(value, (error) => error ? reject(error) : resolve()));
    },
    closeStdin() {
      return new Promise<void>((resolve) => child.stdin.end(resolve));
    },
    async waitForExit(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
      const result = await Promise.race([exited.then(() => true as const), timeout]);
      if (timer) clearTimeout(timer);
      return result;
    },
    async terminateGroup(signal) {
      if (!child.pid || done) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      if (signal === "SIGKILL") await disposeOnce();
    }
  };
}

async function disposeAll(operations: Array<(() => Promise<void>) | undefined>) {
  const settled = await Promise.allSettled(operations.filter((operation): operation is () => Promise<void> =>
    operation !== undefined).map((operation) => operation()));
  if (settled.some((result) => result.status === "rejected")) throw stableError("MCP_STDIO_CLEANUP_FAILED");
}

function addVirtualParents(args: string[], target: string) {
  const parent = path.posix.dirname(target);
  if (parent === "/") return;
  const segments = parent.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    args.push("--dir", current);
  }
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
