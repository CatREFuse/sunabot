// @vitest-environment node
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  composeProjectName,
  composeServiceRunning,
  databasePathOverrideConfigured,
  ensureRuntimeSecrets,
  parseComposePs,
  parseLauncherArguments,
  processSignatureMatches,
  resolveCoreMode,
  resolveLauncherContract,
  reverseWebSocketWithHost,
  workspaceIdentity
} from "../../tooling/runtime/launcher-core.mjs";
import {
  assertStartupReportReady,
  bubblewrapProbeArguments,
  command,
  commandTimeoutMs,
  nativeBashImageComposeArguments,
  nativeCoreEnvironment,
  resolveEffectiveDockerSocket,
  shouldCleanupRemovedNapcatAccount,
  startupReportFailures,
  validateWorkspaceBashContainerOwnership
} from "../../tooling/runtime/launcher.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("unified runtime launcher", () => {
  it("probes Docker isolation for Native Core without invoking host Bash", async () => {
    const source = await fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8");
    const nativeCapabilities = source.slice(
      source.indexOf("async function inspectNativeCapabilities"),
      source.indexOf("async function inspectNativeCodex")
    );

    expect(nativeCapabilities).toContain('dockerCommand(context, [');
    expect(nativeCapabilities).toContain('"--network", "none"');
    expect(nativeCapabilities).toContain('"--cap-drop", "ALL"');
    expect(nativeCapabilities).toContain("Docker Bash isolation probe passed");
    expect(nativeCapabilities).not.toContain('command("/bin/bash"');
  });

  it("probes the same isolated network namespace required by the Docker seccomp contract", () => {
    const args = bubblewrapProbeArguments("/srv/sunabot/workspace");

    expect(args).toEqual(expect.arrayContaining([
      "--unshare-user",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--unshare-net",
      "--unshare-cgroup-try"
    ]));
    expect(args.filter((argument) => argument === "--unshare-net")).toHaveLength(1);
    expect(args.indexOf("--unshare-net")).toBeLessThan(args.indexOf("--"));
  });

  it("prepares the dedicated Docker Bash image for Native Core startup", () => {
    expect(nativeBashImageComposeArguments("/srv/sunabot")).toEqual([
      "compose",
      "-f", "/srv/sunabot/deploy/docker/compose.bash.yml",
      "--profile", "build",
      "build", "bash-image"
    ]);
  });

  it("pins Docker command categories to finite default deadlines", () => {
    expect(commandTimeoutMs("docker", ["info"], undefined)).toBe(10_000);
    expect(commandTimeoutMs("docker", ["exec", "core", "true"], undefined)).toBe(45_000);
    expect(commandTimeoutMs("docker", ["compose", "up", "-d", "--build"], undefined)).toBe(15 * 60_000);
    expect(commandTimeoutMs("docker", ["compose", "config"], undefined)).toBe(5 * 60_000);
    expect(commandTimeoutMs("codex", ["login", "status"], undefined)).toBe(30_000);
    expect(commandTimeoutMs("docker", ["info"], 1234)).toBe(1234);
  });

  it("gives graceful Docker stop and first-run credential input explicit longer budgets", async () => {
    const source = await fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8");
    expect(source).toContain("INTERACTIVE_COMMAND_TIMEOUT_MS = 15 * 60_000");
    expect(source).toContain("timeoutMs: INTERACTIVE_COMMAND_TIMEOUT_MS");
    expect(source.match(/context\.contract\.shutdownTimeoutSeconds \+ 5/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("requires complete Bash ownership before the down path can remove a container", () => {
    const invocationId = "b".repeat(32);
    const container = {
      id: "a".repeat(12),
      component: "workspace-bash",
      name: `sunabot-bash-${invocationId}`,
      runtimeId: "sunabot-qq-runtime",
      workspaceId: "c".repeat(32),
      ownerId: "d".repeat(32),
      invocationId,
      expiresAtRaw: "1800000000000"
    };
    expect(() => validateWorkspaceBashContainerOwnership(container, {
      identity: "c".repeat(32),
      runtimeId: "sunabot-qq-runtime"
    })).not.toThrow();
    expect(() => validateWorkspaceBashContainerOwnership({
      ...container,
      name: `sunabot-bash-${"e".repeat(32)}`
    }, {
      identity: "c".repeat(32),
      runtimeId: "sunabot-qq-runtime"
    })).toThrow(/DOCKER_BASH_OWNERSHIP_INVALID/u);
  });

  it("settles a timed-out command after TERM then KILL even without an exit event", async () => {
    vi.useFakeTimers();
    try {
      class FakeChild extends EventEmitter {
        kill = vi.fn(() => true);
        unref = vi.fn();
      }
      const child = new FakeChild();
      const spawnProcess = vi.fn(() => child);
      const pending = command("docker", ["info"], {
        timeoutMs: 100,
        terminateGraceMs: 50,
        spawnProcess
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });

      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(49);
      expect(child.kill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(child.unref).toHaveBeenCalledTimes(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the KILL escalation when a timed-out command exits after TERM", async () => {
    vi.useFakeTimers();
    try {
      class FakeChild extends EventEmitter {
        kill = vi.fn(() => true);
      }
      const child = new FakeChild();
      const pending = command("docker", ["info"], {
        timeoutMs: 100,
        terminateGraceMs: 50,
        spawnProcess: () => child
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });

      await vi.advanceTimersByTimeAsync(100);
      child.emit("exit", null, "SIGTERM");
      await rejection;
      await vi.advanceTimersByTimeAsync(50);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds captured command output and still hard-settles without an exit event", async () => {
    vi.useFakeTimers();
    try {
      class FakeChild extends EventEmitter {
        stdout = new EventEmitter();
        stderr = new EventEmitter();
        kill = vi.fn(() => true);
        unref = vi.fn();
      }
      const child = new FakeChild();
      const pending = command("docker", ["info"], {
        capture: true,
        maxOutputBytes: 4,
        timeoutMs: 10_000,
        terminateGraceMs: 25,
        spawnProcess: () => child
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: "COMMAND_OUTPUT_LIMIT" });

      child.stdout.emit("data", Buffer.from("12345"));
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the effective Docker Unix socket with Docker Context precedence", async () => {
    const runCommand = vi.fn(async () => "unix:///Users/test/.colima/production/docker.sock\n");

    await expect(resolveEffectiveDockerSocket({
      DOCKER_CONTEXT: "production",
      DOCKER_HOST: "unix:///var/run/wrong.sock"
    }, runCommand)).resolves.toBe("/Users/test/.colima/production/docker.sock");
    expect(runCommand).toHaveBeenCalledWith("docker", [
      "context", "inspect",
      "--format", '{{ (index .Endpoints "docker").Host }}',
      "production"
    ], expect.objectContaining({ capture: true, timeoutMs: 10_000 }));

    runCommand.mockClear();
    await expect(resolveEffectiveDockerSocket({
      DOCKER_HOST: "unix:///var/run/docker.sock"
    }, runCommand)).resolves.toBe("/var/run/docker.sock");
    expect(runCommand).not.toHaveBeenCalled();
    await expect(resolveEffectiveDockerSocket({ DOCKER_HOST: "ssh://docker-host" }, runCommand))
      .rejects.toMatchObject({ code: "DOCKER_BASH_ENDPOINT_UNSUPPORTED" });
  });

  it("builds a launcher-owned Native Core identity and Docker endpoint environment", () => {
    const context = {
      environment: {
        PATH: "/usr/bin",
        SUNABOT_RUNTIME_ID: "spoofed-runtime",
        SUNABOT_WORKSPACE_ID: "spoofed-workspace",
        SUNABOT_DOCKER_SOCKET: "/tmp/spoofed.sock"
      },
      runtimeEnvironment: {
        SUNABOT_RUNTIME_ID: "runtime-env-spoof",
        SUNABOT_DOCKER_SOCKET: "/tmp/runtime-env.sock"
      },
      dev: false,
      identity: "bfa0ec2e0882d0fb",
      workspace: "/srv/sunabot/workspace",
      dockerSocket: "/Users/test/.colima/default/docker.sock",
      contract: {
        runtimeId: "sunabot-qq-runtime",
        adminHost: "127.0.0.1",
        adminPort: 8787,
        onebotPort: 8788
      }
    };

    expect(nativeCoreEnvironment(context, "127.0.0.1", "darwin")).toMatchObject({
      SUNABOT_RUNTIME_MODE: "macos",
      SUNABOT_RUNTIME_ID: "sunabot-qq-runtime",
      SUNABOT_WORKSPACE_ID: "bfa0ec2e0882d0fb",
      SUNABOT_DOCKER_SOCKET: "/Users/test/.colima/default/docker.sock"
    });
    expect(nativeCoreEnvironment(context, "172.18.0.1", "linux")).not.toHaveProperty("SUNABOT_DOCKER_SOCKET");
  });

  it("removes the current workspace legacy Voice container before its runtime network", async () => {
    const source = await fs.readFile(
      path.join(root, "tooling/runtime/launcher.mjs"),
      "utf8",
    );
    const down = source.slice(
      source.indexOf("async function down"),
      source.indexOf("async function assertRuntimeEmpty"),
    );

    expect(down.indexOf("await removeLegacyVoiceContainers")).toBeGreaterThan(
      -1,
    );
    expect(down.indexOf("await removeLegacyVoiceContainers")).toBeLessThan(
      down.indexOf("await removeRuntimeNetwork"),
    );
  });

  it("accepts a stable startup while leaving optional capabilities degraded", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process"),
      pass("core-api"),
      pass("onebot-listener"),
      pass("account-reconciler"),
      fail("codex-auth", "CODEX_AUTH_REQUIRED", "Codex 尚未登录", "capability")
    ]);

    expect(startupReportFailures(report)).toEqual([]);
    expect(() => assertStartupReportReady(report)).not.toThrow();
  });

  it("fails startup when any complete readiness check fails", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process", "liveness"),
      pass("core-api", "liveness"),
      pass("onebot-listener"),
      pass("account-reconciler", "capability"),
      fail("provider", "PROVIDER_NOT_READY", "Provider 健康检查超时")
    ]);

    expect(startupReportFailures(report)).toEqual([
      expect.objectContaining({ id: "provider", code: "PROVIDER_NOT_READY" })
    ]);
    expect(() => assertStartupReportReady(report)).toThrowError(/STARTUP_NOT_READY.*PROVIDER_NOT_READY/u);
  });

  it("fails startup when a required component or account reconciliation is unavailable", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process"),
      pass("core-api"),
      fail("onebot-listener", "ONEBOT_LISTENER_UNAVAILABLE", "8788 未监听"),
      fail("account-reconciler", "ACCOUNT_RECONCILER_UNAVAILABLE", "daemon 未运行"),
      fail("account:primary", "ACCOUNT_RECONCILE_FAILED", "NapCat 启动失败")
    ]);

    expect(startupReportFailures(report).map((item) => item.id)).toEqual([
      "onebot-listener",
      "account-reconciler",
      "account:primary"
    ]);
    expect(() => assertStartupReportReady(report)).toThrowError(
      /STARTUP_NOT_READY.*ONEBOT_LISTENER_UNAVAILABLE.*ACCOUNT_RECONCILER_UNAVAILABLE.*ACCOUNT_RECONCILE_FAILED/u
    );
  });

  it("fails closed when the runtime probe omits a required startup check", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process"),
      pass("core-api"),
      pass("onebot-listener")
    ]);

    expect(startupReportFailures(report)).toEqual([
      expect.objectContaining({ id: "account-reconciler", code: "STARTUP_CHECK_MISSING" })
    ]);
  });

  it("keeps a removal-marked NapCat directory until its registry row is gone", () => {
    const registered = new Set(["primary", "qq_pending_removal"]);

    expect(shouldCleanupRemovedNapcatAccount("qq_pending_removal", registered, true)).toBe(false);
    expect(shouldCleanupRemovedNapcatAccount("qq_removed", registered, true)).toBe(true);
    expect(shouldCleanupRemovedNapcatAccount("qq_removed", registered, false)).toBe(false);
  });

  it("uses runtime.env values for workspace capability probes", async () => {
    const source = await fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8");
    expect(source).toMatch(/collectWorkspaceProbeFacts\(\{\s*workspace: context\.workspace,\s*environment: context\.runtimeEnvironment,/u);
  });

  it.each([
    { args: ["up"], invocation: "up" },
    { args: ["start"], invocation: "start" },
    { args: ["restart"], invocation: "restart" },
    { args: ["--core=docker"], invocation: "--core=docker" },
    { args: ["--core", "docker"], invocation: "--core docker" },
    { args: ["--dev"], invocation: "--dev" }
  ])("installs dependencies before starting with $invocation in a clean checkout", async ({ args, invocation }) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-launcher-"));
    try {
      const bin = path.join(fixture, "bin");
      const launcher = path.join(fixture, "tooling/runtime/launcher.mjs");
      const trace = path.join(fixture, "trace.log");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(fixture, "sunabot.sh"));
      await fs.chmod(path.join(fixture, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(fixture, ".node-version"), `${process.versions.node}\n`);
      await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
      await fs.writeFile(launcher, "");
      await fs.writeFile(path.join(bin, "node"), [
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"-p\" ]; then",
        `  printf '%s\\n' '${process.versions.node}'`,
        "  exit 0",
        "fi",
        "printf 'node:%s\\n' \"$*\" >> \"$TRACE_FILE\""
      ].join("\n"), { mode: 0o755 });
      await fs.writeFile(path.join(bin, "npm"), [
        "#!/bin/sh",
        "printf 'npm:%s:%s\\n' \"$PWD\" \"$*\" >> \"$TRACE_FILE\"",
        "mkdir -p node_modules",
        "touch node_modules/.package-lock.json"
      ].join("\n"), { mode: 0o755 });

      const result = spawnSync(path.join(fixture, "sunabot.sh"), args, {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          TRACE_FILE: trace
        }
      });

      expect(result.status, result.stderr).toBe(0);
      await expect(fs.readFile(trace, "utf8")).resolves.toBe([
        `npm:${fixture}:ci`,
        `node:${launcher} ${invocation}`,
        ""
      ].join("\n"));
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  }, 10_000);

  it.each(["status", "doctor", "logs", "down"])("keeps %s read-only when dependencies are missing", async (command) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-launcher-readonly-"));
    try {
      const bin = path.join(fixture, "bin");
      const launcher = path.join(fixture, "tooling/runtime/launcher.mjs");
      const trace = path.join(fixture, "trace.log");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(fixture, "sunabot.sh"));
      await fs.chmod(path.join(fixture, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(fixture, ".node-version"), `${process.versions.node}\n`);
      await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
      await fs.writeFile(launcher, "");
      await fs.writeFile(path.join(bin, "node"), [
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"-p\" ]; then",
        `  printf '%s\\n' '${process.versions.node}'`,
        "  exit 0",
        "fi",
        "printf 'node:%s\\n' \"$*\" >> \"$TRACE_FILE\""
      ].join("\n"), { mode: 0o755 });
      await fs.writeFile(path.join(bin, "npm"), [
        "#!/bin/sh",
        "printf 'npm:%s\\n' \"$*\" >> \"$TRACE_FILE\""
      ].join("\n"), { mode: 0o755 });

      const before = await treeSnapshot(fixture);
      const result = spawnSync(path.join(fixture, "sunabot.sh"), [command], {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TRACE_FILE: trace }
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("DEPENDENCIES_MISSING");
      await expect(fs.access(trace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await treeSnapshot(fixture)).toEqual(before);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("prints help successfully without Node or installed dependencies", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-launcher-help-"));
    try {
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(fixture, "sunabot.sh"));
      await fs.chmod(path.join(fixture, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(fixture, ".node-version"), `${process.versions.node}\n`);
      await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
      const result = spawnSync(path.join(fixture, "sunabot.sh"), ["--help"], {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: { ...process.env, PATH: "/usr/bin:/bin" }
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("./sunabot.sh <命令>");
      await expect(fs.access(path.join(fixture, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("reports the required and current Node versions when they differ", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-launcher-node-version-"));
    try {
      const bin = path.join(fixture, "bin");
      await fs.mkdir(bin, { recursive: true });
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(fixture, "sunabot.sh"));
      await fs.chmod(path.join(fixture, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(fixture, ".node-version"), "24.18.0\n");
      await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
      await fs.writeFile(path.join(bin, "node"), [
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"-p\" ]; then",
        "  printf '%s\\n' '24.14.0'",
        "fi"
      ].join("\n"), { mode: 0o755 });

      const result = spawnSync(path.join(fixture, "sunabot.sh"), ["status"], {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("需要 Node 24.18.0，当前为 24.14.0。可执行：fnm install 24.18.0");
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")("keeps Homebrew Docker and Colima commands available after resolving Node", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-launcher-homebrew-path-"));
    try {
      const bin = path.join(fixture, "bin");
      const launcher = path.join(fixture, "tooling/runtime/launcher.mjs");
      const trace = path.join(fixture, "trace.log");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(fixture, "sunabot.sh"));
      await fs.chmod(path.join(fixture, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(fixture, ".node-version"), `${process.versions.node}\n`);
      await fs.writeFile(path.join(fixture, "package-lock.json"), "{}\n");
      await fs.mkdir(path.join(fixture, "node_modules"));
      await fs.writeFile(path.join(fixture, "node_modules/.package-lock.json"), "");
      await fs.writeFile(launcher, "");
      await fs.writeFile(path.join(bin, "node"), [
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"-p\" ]; then",
        `  printf '%s\\n' '${process.versions.node}'`,
        "  exit 0",
        "fi",
        "printf '%s\\n' \"$PATH\" > \"$TRACE_FILE\""
      ].join("\n"), { mode: 0o755 });

      const result = spawnSync(path.join(fixture, "sunabot.sh"), ["restart"], {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TRACE_FILE: trace }
      });

      expect(result.status, result.stderr).toBe(0);
      const effectivePath = await fs.readFile(trace, "utf8");
      expect(effectivePath.split(":")).toContain("/opt/homebrew/bin");
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it("defaults to up and selects the platform Core mode", () => {
    expect(parseLauncherArguments([], {}).command).toBe("up");
    expect(resolveCoreMode("auto", { platform: "darwin" })).toBe("native");
    expect(resolveCoreMode("auto", { platform: "linux" })).toBe("docker");
    expect(() => resolveCoreMode("auto", { platform: "win32" })).toThrow("WSL2");
  });

  it("accepts explicit Core and development options", () => {
    expect(parseLauncherArguments(["restart", "--core=docker"], {})).toEqual({
      command: "restart",
      requestedMode: "docker",
      dev: false
    });
    expect(parseLauncherArguments(["up", "--core", "native", "--dev"], {})).toEqual({
      command: "up",
      requestedMode: "native",
      dev: true
    });
    expect(parseLauncherArguments(["start"], {}).command).toBe("start");
    expect(parseLauncherArguments(["doctor"], { SUNABOT_DEV: "1" }).dev).toBe(true);
    expect(parseLauncherArguments(["--help"], {}).command).toBe("help");
    expect(parseLauncherArguments(["reconcile-account", "--account=qq_arona"], {})).toMatchObject({
      command: "reconcile-account",
      accountId: "qq_arona"
    });
    expect(parseLauncherArguments(["probe-runtime"], {}).command).toBe("probe-runtime");
  });

  it("detects the retired external main database override from either environment source", () => {
    expect(databasePathOverrideConfigured({}, {})).toBe(false);
    expect(databasePathOverrideConfigured({ SUNABOT_DATABASE_PATH: "/tmp/external.sqlite" }, {})).toBe(true);
    expect(databasePathOverrideConfigured({}, { SUNABOT_DATABASE_PATH: "/tmp/external.sqlite" })).toBe(true);
  });

  it("uses schema v2 network and Docker service fields", async () => {
    const contract = JSON.parse(await fs.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8"));
    const resolved = resolveLauncherContract(contract, {
      root,
      platform: "darwin",
      wsl: false
    });

    expect(contract.schemaVersion).toBe(2);
    expect(resolved.adminPort).toBe(8787);
    expect(resolved.onebotHost).toBe("127.0.0.1");
    expect(resolved.onebotPort).toBe(8788);
    expect(resolved.nativeReverseWebSocket).toBe("ws://host.docker.internal:8788/onebot/v11/ws");
    expect(resolved.dockerReverseWebSocket).toBe("ws://core:8788/onebot/v11/ws");
    expect(resolved.coreService).toBe("core");
    expect(resolved.coreProfile).toBe("core-docker");
    expect(resolved.napcatService).toBe("napcat");
    expect(contract.docker.labels).toEqual({
      runtimeId: "io.sunabot.runtime-id",
      workspaceId: "io.sunabot.workspace-id",
      component: "io.sunabot.component",
      ownerId: "io.sunabot.owner-id",
      invocationId: "io.sunabot.invocation-id",
      expiresAtMs: "io.sunabot.expires-at-ms"
    });
    expect(resolved.codexCli).toEqual({
      version: "0.139.0",
      executable: "/usr/local/bin/codex",
      authFile: "secrets/codex/auth.json"
    });
    expect(resolved.coreReadyTimeoutSeconds).toBe(60);
    expect(resolved.napcatReadyTimeoutSeconds).toBe(120);

    const linux = resolveLauncherContract(contract, {
      root,
      platform: "linux",
      wsl: false
    });
    expect(linux.onebotHost).toBe("docker-network-gateway");
  });

  it("generates missing tokens once and never replaces configured values", () => {
    let sequence = 0;
    const first = ensureRuntimeSecrets(
      "ONEBOT_ACCESS_TOKEN=existing\nWEBUI_TOKEN=\nTAVILY_API_KEY=next-setting\n",
      () => `generated-${++sequence}`
    );
    expect(first.values).toEqual({
      ONEBOT_ACCESS_TOKEN: "existing",
      WEBUI_TOKEN: "generated-1"
    });
    const second = ensureRuntimeSecrets(first.content, () => `generated-${++sequence}`);
    expect(second.content).toBe(first.content);
    expect(second.values).toEqual(first.values);
  });

  it("rejects duplicate launcher-owned runtime settings", () => {
    expect(() => ensureRuntimeSecrets(
      "ONEBOT_ACCESS_TOKEN=first\nONEBOT_ACCESS_TOKEN=second\nWEBUI_TOKEN=webui\n",
      () => "generated"
    )).toThrow("duplicate ONEBOT_ACCESS_TOKEN");
    expect(() => ensureRuntimeSecrets(
      "ONEBOT_ACCESS_TOKEN=onebot\nWEBUI_TOKEN=webui\nNAPCAT_ACCOUNT=1\nNAPCAT_ACCOUNT=2\n",
      () => "generated"
    )).toThrow("duplicate NAPCAT_ACCOUNT");
  });

  it("derives stable isolated Compose ownership from workspace", () => {
    const identity = workspaceIdentity("/srv/sunabot-a");
    expect(identity).toHaveLength(16);
    expect(composeProjectName("Sunabot QQ Runtime", identity)).toBe(`sunabot-qq-runtime-${identity.slice(0, 12)}`);
    expect(workspaceIdentity("/srv/sunabot-a")).toBe(identity);
    expect(workspaceIdentity("/srv/sunabot-b")).not.toBe(identity);
  });

  it("parses Compose status and validates native process ownership", () => {
    const items = parseComposePs([
      JSON.stringify({ Service: "core", State: "running" }),
      JSON.stringify({ Service: "napcat", State: "exited" })
    ].join("\n"));
    expect(composeServiceRunning(items, "core")).toBe(true);
    expect(composeServiceRunning(items, "napcat")).toBe(false);
    expect(processSignatureMatches(
      { pid: 10, signature: "start", entry: "/project/main.js" },
      { signature: "start", command: "node /project/main.js" }
    )).toBe(true);
    expect(processSignatureMatches(
      { pid: 10, signature: "start", entry: "/project/main.js" },
      { signature: "other", command: "node /project/main.js" }
    )).toBe(false);
  });

  it("rewrites only the advertised host after a successful container probe", () => {
    expect(reverseWebSocketWithHost(
      "ws://host.docker.internal:8788/onebot/v11/ws",
      "172.18.0.1"
    )).toBe("ws://172.18.0.1:8788/onebot/v11/ws");
  });
});

function pass(id: string, kind = "readiness") {
  return { id, kind, status: "pass", code: null, detail: "ready", action: null };
}

function fail(id: string, code: string, detail: string, kind = "readiness") {
  return { id, kind, status: "fail", code, detail, action: "./sunabot.sh doctor" };
}

function runtimeReport(checks: Array<{
  id: string;
  kind: string;
  status: string;
  code: string | null;
  detail: string;
  action: string | null;
}>) {
  return { checks };
}

async function treeSnapshot(directory: string) {
  const entries: string[] = [];
  async function walk(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      entries.push(`${path.relative(directory, target)}:${entry.isDirectory() ? "dir" : "file"}`);
      if (entry.isDirectory()) await walk(target);
    }
  }
  await walk(directory);
  return entries.sort();
}
