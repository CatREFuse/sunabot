// @vitest-environment node
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockerMcpStdioLauncher,
  buildMcpDockerInvocation,
  type McpDockerCleanupRunner,
  type McpDockerImageResolver,
  type McpDockerStdioChild,
  type McpDockerStdioSpawn
} from "../../adapters/mcp/dockerStdioLauncher.js";
import { mcpStdioEntrypointSource } from "../../adapters/mcp/stdioEntrypointSource.js";
import { MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256 } from "../../adapters/mcp/approvedExecutableManifest.js";
import type {
  HardenedStdioLaunchHandlers,
  HardenedStdioLaunchSpec
} from "../../adapters/mcp/hardenedStdioTransport.js";
import type { McpSandboxProjection } from "../../adapters/mcp/sandboxProjection.js";
import { testTempRoot } from "./test-temp-root.js";

const testRoot = testTempRoot("mcp-docker-stdio-launcher");
const fixedContainerName = `sunabot-mcp-${"a".repeat(32)}`;
const fixedImage = `sha256:${"c".repeat(64)}`;
const TEST_EXIT_WAIT_MS = 2_000;

function spec(overrides: Partial<HardenedStdioLaunchSpec> = {}): HardenedStdioLaunchSpec {
  return {
    command: "/usr/local/bin/example-mcp",
    args: ["--stdio"],
    cwd: "/workbench",
    env: { MCP_ALPHA: "one", MCP_TOKEN: "secret" },
    inheritEnv: false,
    stderr: "pipe",
    killScope: "process_group",
    ...overrides
  };
}

function mountProjection() {
  return {
    workbench: "/host/agent/workbench",
    skills: "/host/projection/skills",
    config: "/host/projection/extensions/mcp.json"
  };
}

function launchProjection() {
  return { hostDirectory: "/host/projection/launch-secrets/launch-fixture" };
}

class FakeChild extends EventEmitter implements McpDockerStdioChild {
  readonly pid = 321;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly kills: NodeJS.Signals[] = [];
  autoExitOnKill = true;
  stdin = {
    write: (value: string, callback: (error?: Error | null) => void) => {
      this.writes.push(value);
      callback();
      return true;
    },
    end: (callback: () => void) => {
      callback();
    }
  };

  kill(signal: NodeJS.Signals) {
    this.kills.push(signal);
    if (this.autoExitOnKill) queueMicrotask(() => this.emitExit(null, signal));
    return true;
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.emit("exit", code, signal);
  }

  emitError() {
    this.emit("error", new Error("raw host error /Users/admin/token"));
  }
}

async function createProjection(): Promise<McpSandboxProjection> {
  const workbench = path.join(testRoot, "agent", "workbench");
  const skills = path.join(testRoot, "projection", "skills");
  const config = path.join(testRoot, "projection", "extensions", "mcp.json");
  await fs.mkdir(workbench, { recursive: true });
  await fs.mkdir(skills, { recursive: true });
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.chmod(workbench, 0o700);
  await fs.chmod(skills, 0o500);
  const encodedConfig = `${JSON.stringify({
    schemaVersion: 1,
    agentId: "agent-a",
    executableManifestSha256: MCP_BUNDLED_EXECUTABLE_MANIFEST_SHA256,
    server: { id: "server-a" }
  })}\n`;
  await fs.writeFile(config, encodedConfig, { encoding: "utf8", mode: 0o400 });
  await fs.chmod(config, 0o400);
  await fs.chmod(path.dirname(config), 0o500);
  const launchSecrets = path.join(testRoot, "projection", "launch-secrets");
  const runtime = path.join(testRoot, "projection", "runtime");
  const stdioEntrypoint = path.join(runtime, "mcp-stdio-entrypoint");
  await fs.mkdir(launchSecrets, { recursive: true, mode: 0o700 });
  await fs.chmod(launchSecrets, 0o700);
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  await fs.writeFile(stdioEntrypoint, mcpStdioEntrypointSource("/usr/bin/node"), {
    encoding: "utf8",
    mode: 0o500
  });
  await fs.chmod(stdioEntrypoint, 0o500);
  await fs.chmod(runtime, 0o500);
  await fs.chmod(path.join(testRoot, "projection"), 0o500);
  return {
    root: path.join(testRoot, "projection"),
    workbench,
    skills,
    config,
    launchSecrets,
    stdioEntrypoint,
    stdioNodeExecutable: "/usr/bin/node",
    digestSha256: createHash("sha256").update(encodedConfig).digest("hex"),
    dispose: vi.fn(async () => undefined)
  };
}

function createHarness(overrides: {
  projection?: McpSandboxProjection;
  cleanupRunner?: McpDockerCleanupRunner;
  abortSignal?: AbortSignal;
  lifetimeMs?: number;
  cleanupTimeoutMs?: number;
  spawnThrows?: boolean;
  probeFails?: boolean;
  hangOnKill?: boolean;
  image?: string;
  imageResolver?: McpDockerImageResolver;
} = {}) {
  const child = new FakeChild();
  child.autoExitOnKill = !overrides.hangOnKill;
  const spawnCalls: Parameters<McpDockerStdioSpawn>[] = [];
  const spawnProcess: McpDockerStdioSpawn = (file, args, options) => {
    spawnCalls.push([file, args, options]);
    if (overrides.spawnThrows) throw new Error("spawn failed with /Users/admin/path");
    return child;
  };
  const cleanupCalls: Parameters<McpDockerCleanupRunner>[0][] = [];
  const cleanupRunner: McpDockerCleanupRunner = overrides.cleanupRunner ?? (async (input) => {
    cleanupCalls.push(input);
  });
  const stdout = vi.fn();
  const stderr = vi.fn();
  const exit = vi.fn();
  const error = vi.fn();
  const handlers: HardenedStdioLaunchHandlers = { stdout, stderr, exit, error };
  const probeCalls: Parameters<McpDockerCleanupRunner>[0][] = [];
  const launcher = new DockerMcpStdioLauncher(overrides.projection!, {
    dockerExecutable: "/fixture/docker",
    image: overrides.image ?? fixedImage,
    imageResolver: overrides.imageResolver,
    dockerEnvironment: { DOCKER_HOST: "unix:///fixture/docker.sock" },
    effectiveUid: 1_000,
    effectiveGid: 1_001,
    lifetimeMs: overrides.lifetimeMs ?? 5_000,
    cleanupTimeoutMs: overrides.cleanupTimeoutMs ?? 50,
    abortSignal: overrides.abortSignal,
    spawnProcess,
    cleanupRunner,
    probeRunner: async (input) => {
      probeCalls.push(input);
      if (overrides.probeFails) throw new Error("probe leaked secret");
    },
    containerNameFactory: () => fixedContainerName,
    probeContainerNameFactory: () => `sunabot-mcp-probe-${"b".repeat(32)}`
  });
  return { child, cleanupCalls, handlers, launcher, probeCalls, spawnCalls };
}

beforeEach(async () => {
  await makeTestTreeWritable(testRoot);
  await fs.rm(testRoot, { recursive: true, force: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await makeTestTreeWritable(testRoot);
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe("DockerMcpStdioLauncher", () => {
  it("keeps secrets and the approved command out of Docker argv and Config.Env", () => {
    const invocation = buildMcpDockerInvocation({
      spec: spec(),
      projection: mountProjection(),
      launchProjection: launchProjection(),
      dockerExecutable: "/fixture/docker",
      image: fixedImage,
      containerName: fixedContainerName,
      probeContainerName: `sunabot-mcp-probe-${"b".repeat(32)}`,
      dockerEnvironment: { DOCKER_HOST: "unix:///fixture/docker.sock" },
      uid: 1_000,
      gid: 1_001
    });

    expect(invocation.file).toBe("/fixture/docker");
    expect(invocation.env).toEqual({ DOCKER_HOST: "unix:///fixture/docker.sock" });
    expect(invocation.cleanup).toEqual({
      file: "/fixture/docker",
      args: ["rm", "-f", fixedContainerName],
      env: invocation.env
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      "run", "--rm", "--init", "--pull", "never",
      "--name", fixedContainerName,
      "--user", "1000:1001",
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
      "--workdir", "/workbench",
      "--entrypoint", "/usr/local/libexec/sunabot-mcp-stdio-entrypoint", fixedImage
    ]));
    const mounts = invocation.args.flatMap((value, index) => value === "--mount" ? [invocation.args[index + 1]] : []);
    expect(mounts).toEqual([
      "type=bind,src=/host/agent/workbench,dst=/workbench,rw",
      "type=bind,src=/host/projection/skills,dst=/skills,readonly",
      "type=bind,src=/host/projection/extensions/mcp.json,dst=/run/sunabot/extensions/mcp.json,readonly",
      "type=bind,src=/host/projection/launch-secrets/launch-fixture,dst=/run/sunabot/secrets,readonly"
    ]);
    const imageIndex = invocation.args.indexOf(fixedImage);
    expect(invocation.args.slice(imageIndex)).toEqual([fixedImage]);
    expect(invocation.probe.args.slice(invocation.probe.args.indexOf(fixedImage)))
      .toEqual([fixedImage, "--probe"]);
    for (const secretOrCommand of ["secret", "MCP_TOKEN", "MCP_ALPHA", "/usr/local/bin/example-mcp", "--stdio"])
      expect(invocation.args).not.toContain(secretOrCommand);
    expect(invocation.args).not.toContain("--env");
    expect(invocation.args.join(" ")).not.toContain("docker.sock,dst");
    expect(invocation.args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(invocation.args).not.toContain("/bin/sh");
  });

  it("generates a fresh bounded container name", () => {
    const first = buildMcpDockerInvocation({
      spec: spec(), projection: mountProjection(), launchProjection: launchProjection(), image: fixedImage,
      uid: 1_000, gid: 1_000
    });
    const second = buildMcpDockerInvocation({
      spec: spec(), projection: mountProjection(), launchProjection: launchProjection(), image: fixedImage,
      uid: 1_000, gid: 1_000
    });

    expect(first.containerName).toMatch(/^sunabot-mcp-[a-f0-9]{32}$/u);
    expect(second.containerName).toMatch(/^sunabot-mcp-[a-f0-9]{32}$/u);
    expect(first.containerName).not.toBe(second.containerName);
  });

  it.each([
    [spec({ command: "example-mcp" }), mountProjection(), { uid: 1_000, gid: 1_000 }],
    [spec({ command: "/opt/example-mcp" }), mountProjection(), { uid: 1_000, gid: 1_000 }],
    [spec({ command: "/usr/bin/npx" }), mountProjection(), { uid: 1_000, gid: 1_000 }],
    [spec({ command: "/usr/bin/python3", args: ["-m", "pip", "install", "x"] }), mountProjection(), { uid: 1_000, gid: 1_000 }],
    [spec({ env: { HOME: "/host" } }), mountProjection(), { uid: 1_000, gid: 1_000 }],
    [spec(), { ...mountProjection(), skills: "/host/skills,bad" }, { uid: 1_000, gid: 1_000 }],
    [spec(), mountProjection(), { uid: 0, gid: 1_000 }]
  ])("rejects unsafe server or projection configuration %#", (launchSpec, projection, identity) => {
    expect(() => buildMcpDockerInvocation({
      spec: launchSpec,
      projection,
      launchProjection: launchProjection(),
      dockerExecutable: "/fixture/docker",
      image: fixedImage,
      containerName: fixedContainerName,
      ...identity
    })).toThrow();
  });

  it.each([
    { dockerExecutable: "docker" },
    { image: "../unsafe" },
    { image: "sunabot-mcp:test" },
    { containerName: "sunabot-mcp-fixed" },
    { dockerEnvironment: { PATH: "/host/bin" } },
    { dockerEnvironment: { DOCKER_HOST: "tcp://remote.example:2375" } }
  ])("rejects unsafe Docker host configuration %#", (override) => {
    expect(() => buildMcpDockerInvocation({
      spec: spec(),
      projection: mountProjection(),
      launchProjection: launchProjection(),
      dockerExecutable: "/fixture/docker",
      image: fixedImage,
      containerName: fixedContainerName,
      dockerEnvironment: {},
      uid: 1_000,
      gid: 1_000,
      ...override
    })).toThrow("MCP_STDIO_ISOLATION_UNAVAILABLE");
  });

  it("spawns once with pipes, forwards stdio, and rejects launcher reuse", async () => {
    const projection = await createProjection();
    const harness = createHarness({ projection });
    const launchSpec = spec();
    const resolvedEnvironment = launchSpec.env;
    const process = await harness.launcher.launch(launchSpec, harness.handlers);

    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.probeCalls).toHaveLength(1);
    expect(harness.probeCalls[0]?.args.slice(-1)).toEqual(["--probe"]);
    expect(JSON.stringify(harness.probeCalls)).not.toContain('"secret"');
    expect(JSON.stringify(harness.probeCalls)).not.toContain("MCP_TOKEN");
    expect(harness.spawnCalls[0]).toEqual([
      "/fixture/docker",
      expect.arrayContaining(["--name", fixedContainerName, "--network", "none"]),
      {
        cwd: "/",
        detached: true,
        env: { DOCKER_HOST: "unix:///fixture/docker.sock" },
        stdio: ["pipe", "pipe", "pipe"]
      }
    ]);
    harness.child.stdout.emit("data", Buffer.from("stdout"));
    harness.child.stderr.emit("data", Buffer.from("stderr"));
    await process.writeStdin("request\n");
    await process.closeStdin();
    expect(harness.handlers.stdout).toHaveBeenCalledWith(Buffer.from("stdout"));
    expect(harness.handlers.stderr).toHaveBeenCalledWith(Buffer.from("stderr"));
    expect(harness.child.writes).toEqual(["request\n"]);
    expect(resolvedEnvironment).toEqual({});
    expect(JSON.stringify(launchSpec)).not.toContain("secret");
    const secretRoots = await fs.readdir(projection.launchSecrets!);
    expect(secretRoots).toHaveLength(1);
    const secretDirectory = path.join(projection.launchSecrets!, secretRoots[0]!);
    const secretFiles = await fs.readdir(secretDirectory);
    expect(secretFiles).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/u)]);
    const secretFile = path.join(secretDirectory, secretFiles[0]!);
    expect((await fs.stat(secretFile)).mode & 0o777).toBe(0o600);
    const secretEnvelope = await fs.readFile(secretFile, "utf8");
    expect(secretEnvelope).toContain('"agentId":"agent-a"');
    expect(secretEnvelope).toContain('"serverId":"server-a"');
    expect(secretEnvelope).toContain('"MCP_TOKEN":"secret"');
    const reusedSpec = spec();
    await expect(harness.launcher.launch(reusedSpec, harness.handlers)).rejects.toThrow("MCP_STDIO_LAUNCH_REUSED");
    expect(reusedSpec.env).toEqual({});
    harness.child.emitExit();
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);
    expect(projection.dispose).toHaveBeenCalledOnce();
    expect(harness.cleanupCalls).toHaveLength(0);
    await expect(fs.access(secretDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a configured mutable tag once and pins probe and launch to the same image digest", async () => {
    const projection = await createProjection();
    const imageResolver = vi.fn(async () => fixedImage);
    const harness = createHarness({
      projection,
      image: "sunabot-mcp:local",
      imageResolver
    });

    const process = await harness.launcher.launch(spec(), harness.handlers);

    expect(imageResolver).toHaveBeenCalledWith({
      file: "/fixture/docker",
      image: "sunabot-mcp:local",
      env: { DOCKER_HOST: "unix:///fixture/docker.sock" },
      timeoutMs: 10_000
    });
    expect(harness.probeCalls[0]?.args).toContain(fixedImage);
    expect(harness.spawnCalls[0]?.[1]).toContain(fixedImage);
    expect(JSON.stringify([harness.probeCalls, harness.spawnCalls])).not.toContain("sunabot-mcp:local");
    harness.child.emitExit();
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);
  });

  it("rejects unsafe configured image text before Docker resolution and clears resolved secrets", async () => {
    const projection = await createProjection();
    const imageResolver = vi.fn(async () => fixedImage);
    const harness = createHarness({ projection, image: "--help", imageResolver });
    const launchSpec = spec();
    const resolvedEnvironment = launchSpec.env;

    await expect(harness.launcher.launch(launchSpec, harness.handlers))
      .rejects.toThrow("MCP_STDIO_ISOLATION_UNAVAILABLE");

    expect(imageResolver).not.toHaveBeenCalled();
    expect(resolvedEnvironment).toEqual({});
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("uses the same bounded rm cleanup for TERM and KILL", async () => {
    const projection = await createProjection();
    const harness = createHarness({ projection });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    await process.terminateGroup("SIGTERM");
    await process.terminateGroup("SIGKILL");

    expect(harness.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.cleanupCalls).toEqual([{
      file: "/fixture/docker",
      args: ["rm", "-f", fixedContainerName],
      env: { DOCKER_HOST: "unix:///fixture/docker.sock" },
      timeoutMs: 50
    }]);
    expect(projection.dispose).toHaveBeenCalledOnce();
    expect(harness.handlers.exit).toHaveBeenCalledOnce();
    expect(harness.handlers.error).not.toHaveBeenCalled();
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);
  });

  it("cleans the named container on abort without exposing raw errors", async () => {
    const projection = await createProjection();
    const controller = new AbortController();
    const harness = createHarness({ projection, abortSignal: controller.signal });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    controller.abort();
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);

    expect(harness.child.kills).toEqual(["SIGKILL"]);
    expect(harness.cleanupCalls[0]?.args).toEqual(["rm", "-f", fixedContainerName]);
    expect(harness.handlers.error).toHaveBeenCalledWith(expect.objectContaining({ message: "MCP_STDIO_ABORTED" }));
    expect(JSON.stringify(harness.handlers.error.mock.calls)).not.toContain("/Users/");
    expect(projection.dispose).toHaveBeenCalledOnce();
    expect(await fs.readdir(projection.launchSecrets!)).toEqual([]);
  });

  it("enforces a launcher-owned lifetime watchdog and bounded cleanup", async () => {
    vi.useFakeTimers();
    const projection = await createProjection();
    const cleanupRunner = vi.fn(async () => undefined);
    const harness = createHarness({
      projection,
      cleanupRunner,
      lifetimeMs: 20,
      cleanupTimeoutMs: 10
    });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    const waiting = process.waitForExit(100);
    await vi.advanceTimersByTimeAsync(21);

    await expect(waiting).resolves.toBe(true);
    expect(harness.child.kills).toEqual(["SIGKILL"]);
    expect(cleanupRunner).toHaveBeenCalledOnce();
    expect(harness.handlers.error).toHaveBeenCalledWith(expect.objectContaining({ message: "MCP_STDIO_TIMEOUT" }));
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("reports a stable cleanup failure when docker rm -f rejects", async () => {
    const projection = await createProjection();
    const cleanupRunner = vi.fn(async () => { throw new Error("raw docker failure /Users/admin"); });
    const harness = createHarness({ projection, cleanupRunner });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    await expect(process.terminateGroup("SIGKILL")).rejects.toThrow("MCP_STDIO_CLEANUP_FAILED");
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);

    expect(harness.handlers.error).toHaveBeenCalledWith(expect.objectContaining({
      message: "MCP_STDIO_CLEANUP_FAILED"
    }));
    expect(JSON.stringify(harness.handlers.error.mock.calls)).not.toContain("/Users/admin");
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("reports a stable cleanup failure when the host projection cannot be removed", async () => {
    const projection = await createProjection();
    projection.dispose.mockRejectedValue(new Error("EIO /Users/admin/secret-projection"));
    const harness = createHarness({ projection });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    harness.child.emitExit();
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);

    expect(harness.handlers.exit).not.toHaveBeenCalled();
    expect(harness.handlers.error).toHaveBeenCalledWith(expect.objectContaining({
      message: "MCP_STDIO_CLEANUP_FAILED"
    }));
    expect(JSON.stringify(harness.handlers.error.mock.calls)).not.toContain("/Users/admin");
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("requires the final SIGKILL path to observe Docker CLI exit", async () => {
    const projection = await createProjection();
    const harness = createHarness({ projection, cleanupTimeoutMs: 10, hangOnKill: true });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    await expect(process.terminateGroup("SIGKILL")).rejects.toThrow("MCP_STDIO_CLEANUP_FAILED");
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);

    expect(harness.child.kills).toEqual(["SIGKILL"]);
    expect(harness.cleanupCalls[0]?.args).toEqual(["rm", "-f", fixedContainerName]);
    expect(harness.handlers.error).toHaveBeenCalledWith(expect.objectContaining({
      message: "MCP_STDIO_CLEANUP_FAILED"
    }));
  });

  it("cleans up after an asynchronous Docker CLI error", async () => {
    const projection = await createProjection();
    const harness = createHarness({ projection });
    const process = await harness.launcher.launch(spec(), harness.handlers);

    harness.child.emitError();
    await expect(process.waitForExit(TEST_EXIT_WAIT_MS)).resolves.toBe(true);

    expect(harness.cleanupCalls[0]?.args).toEqual(["rm", "-f", fixedContainerName]);
    expect(harness.handlers.error).toHaveBeenCalledWith(expect.objectContaining({ message: "MCP_STDIO_PROCESS_ERROR" }));
    expect(JSON.stringify(harness.handlers.error.mock.calls)).not.toContain("raw host error");
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("attempts same-name cleanup and disposal when spawn throws", async () => {
    const projection = await createProjection();
    const harness = createHarness({ projection, spawnThrows: true });

    await expect(harness.launcher.launch(spec(), harness.handlers)).rejects.toThrow("MCP_STDIO_LAUNCH_FAILED");

    expect(harness.cleanupCalls[0]?.args).toEqual(["rm", "-f", fixedContainerName]);
    expect(projection.dispose).toHaveBeenCalledOnce();
    expect(harness.handlers.error).not.toHaveBeenCalled();
    expect(await fs.readdir(projection.launchSecrets!)).toEqual([]);
  });

  it("fails closed when the fixed image cannot probe the approved executable", async () => {
    const projection = await createProjection();
    const harness = createHarness({ projection, probeFails: true });
    const launchSpec = spec();
    const resolvedEnvironment = launchSpec.env;

    await expect(harness.launcher.launch(launchSpec, harness.handlers))
      .rejects.toThrow("MCP_STDIO_ISOLATION_UNAVAILABLE");

    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.probeCalls).toHaveLength(1);
    expect(harness.cleanupCalls.some((call) => call.args[2].startsWith("sunabot-mcp-probe-"))).toBe(true);
    expect(resolvedEnvironment).toEqual({});
    expect(JSON.stringify(launchSpec)).not.toContain("secret");
    expect(await fs.readdir(projection.launchSecrets!)).toEqual([]);
    expect(projection.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a symlinked projection before spawning Docker", async () => {
    const projection = await createProjection();
    const outside = path.join(testRoot, "outside");
    await fs.mkdir(outside);
    await fs.chmod(projection.root, 0o700);
    await fs.rm(projection.skills, { recursive: true });
    await fs.symlink(outside, projection.skills);
    await fs.chmod(projection.root, 0o500);
    const harness = createHarness({ projection });

    await expect(harness.launcher.launch(spec(), harness.handlers)).rejects.toThrow("MCP_SANDBOX_PROJECTION_INVALID");
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.cleanupCalls).toHaveLength(0);
    expect(projection.dispose).toHaveBeenCalledOnce();
  });
});

async function makeTestTreeWritable(root: string): Promise<void> {
  await fs.chmod(root, 0o700).catch(() => undefined);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTestTreeWritable(target);
    else if (!entry.isSymbolicLink()) await fs.chmod(target, 0o600).catch(() => undefined);
  }));
}
