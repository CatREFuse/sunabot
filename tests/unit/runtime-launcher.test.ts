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
  bubblewrapExecutable,
  bubblewrapProbeArguments,
  command,
  commandTimeoutMs,
  firstRunCompletionReadiness,
  nativeCoreEnvironment,
  napcatAccountUpArguments,
  selectNativeOnebotListenHost,
  shouldCleanupRemovedNapcatAccount,
  startupReportFailures
} from "../../tooling/runtime/launcher.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("Native Core runtime launcher", () => {
  it("probes bundled bubblewrap isolation for Linux Native Core", async () => {
    const source = await fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8");
    const nativeCapabilities = source.slice(
      source.indexOf("async function inspectNativeCapabilities"),
      source.indexOf("async function inspectNativeCodex")
    );

    expect(nativeCapabilities).toContain(
      "command(bubblewrapExecutable(context), bubblewrapProbeArguments(context.workspace, true)"
    );
    expect(nativeCapabilities).toContain("bubblewrap namespace probe passed");
  });

  it("probes the isolated namespace used by Linux workspace Bash", () => {
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
    expect(bubblewrapProbeArguments("/srv/sunabot/workspace", true)).not.toContain("--unshare-net");
  });

  it("selects bundled Bubblewrap for releases and the system binary for source checkouts", async () => {
    const base = {
      root: "/opt/sunabot/current",
      runtimeEnvironment: {}
    };
    expect(bubblewrapExecutable({ ...base, packaged: true }))
      .toBe("/opt/sunabot/current/runtime/bubblewrap/bwrap");
    expect(bubblewrapExecutable({ ...base, packaged: false })).toBe("/usr/bin/bwrap");
    expect(bubblewrapExecutable({
      ...base,
      packaged: true,
      runtimeEnvironment: { SUNABOT_BWRAP_EXECUTABLE: "/srv/tools/bwrap" }
    })).toBe("/opt/sunabot/current/runtime/bubblewrap/bwrap");

    const rendererSource = await fs.readFile(
      path.join(root, "tooling/runtime/native-webfetch-renderer.mjs"),
      "utf8"
    );
    expect(rendererSource).toContain("validatedBubblewrapExecutable(context.bubblewrapExecutable)");
    expect(rendererSource).not.toContain("context.runtimeEnvironment?.SUNABOT_BWRAP_EXECUTABLE");
  });

  it("locks a self-contained Bubblewrap runtime for both release architectures", async () => {
    const componentLock = JSON.parse(await fs.readFile(
      path.join(root, "components/component.lock.json"),
      "utf8"
    ));
    const bubblewrap = componentLock.components.bubblewrap;
    for (const platform of ["linux/amd64", "linux/arm64"]) {
      const runtime = bubblewrap.runtimeDependencies[platform];
      expect(runtime.loader).toMatch(/^ld-linux-/u);
      expect(runtime.needed).toEqual(expect.arrayContaining([
        "libc.so.6",
        "libcap.so.2",
        "libselinux.so.1",
        "libpcre2-8.so.0"
      ]));
      expect(runtime.libraryPaths.map((value: string) => path.basename(value)))
        .toEqual(expect.arrayContaining([runtime.loader, ...runtime.needed]));
      expect(runtime.archives.map((item: { package: string }) => item.package)).toEqual([
        "libc6",
        "libcap2",
        "libselinux1",
        "libpcre2-8-0"
      ]);
      expect(runtime.archives.every((item: { sha256: string }) => /^[a-f0-9]{64}$/u.test(item.sha256)))
        .toBe(true);
    }
    expect(bubblewrap.runtimeSourceArchives).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: "glibc" }),
      expect.objectContaining({ package: "libcap2" }),
      expect.objectContaining({ package: "libselinux" }),
      expect.objectContaining({ package: "pcre2" })
    ]));
  });

  it("builds and bootstraps with library resolution plus real namespace probes", async () => {
    const [builder, launcher] = await Promise.all([
      fs.readFile(path.join(root, "tooling/runtime/build-release.mjs"), "utf8"),
      fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8")
    ]);
    expect(builder).toContain('"--inhibit-cache"');
    expect(builder).toContain('"--list", binary');
    expect(builder).toContain("bubblewrapNamespaceProbeArguments()");
    expect(builder).toContain('"--unshare-user"');
    expect(launcher).toContain("await verifyNativeWebfetchRendererIsolation(context, launch, command)");
    expect(launcher).toContain('"WEBFETCH_DYNAMIC_ISOLATION_UNAVAILABLE"');
    expect(launcher).toContain('"BUBBLEWRAP_NAMESPACE_UNAVAILABLE"');
    const restart = launcher.slice(
      launcher.indexOf("async function restartRuntime"),
      launcher.indexOf("async function upNative")
    );
    expect(restart.indexOf("await assertLinuxBubblewrapNamespace(context)"))
      .toBeLessThan(restart.indexOf("await down(context)"));
    expect(restart.indexOf("await assertNativeWebfetchRendererCapability(context)"))
      .toBeLessThan(restart.indexOf("await down(context)"));
  });

  it("pins NapCat Docker and native command categories to finite default deadlines", () => {
    expect(commandTimeoutMs("docker", ["info"], undefined)).toBe(10_000);
    expect(commandTimeoutMs("docker", ["exec", "napcat", "true"], undefined)).toBe(45_000);
    expect(commandTimeoutMs("docker", ["compose", "up", "-d", "--no-build"], undefined)).toBe(5 * 60_000);
    expect(commandTimeoutMs("docker", ["compose", "config"], undefined)).toBe(5 * 60_000);
    expect(commandTimeoutMs("codex", ["login", "status"], undefined)).toBe(30_000);
    expect(commandTimeoutMs("docker", ["info"], 1234)).toBe(1234);
  });

  it("force recreates only the selected NapCat account during login recovery", () => {
    expect(napcatAccountUpArguments("start", "napcat")).toEqual([
      "up", "-d", "--no-build", "--pull", "never", "napcat"
    ]);
    expect(napcatAccountUpArguments("restart", "napcat")).toEqual([
      "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "napcat"
    ]);
  });

  it("gives graceful NapCat stop and first-run credential input explicit longer budgets", async () => {
    const source = await fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8");
    expect(source).toContain("INTERACTIVE_COMMAND_TIMEOUT_MS = 15 * 60_000");
    expect(source).toContain("timeoutMs: INTERACTIVE_COMMAND_TIMEOUT_MS");
    expect(source.match(/context\.contract\.shutdownTimeoutSeconds \+ 5/gu)?.length).toBeGreaterThanOrEqual(2);
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
      const pending = command("fixture-command", ["probe"], {
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
      const pending = command("fixture-command", ["probe"], {
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
      const pending = command("fixture-command", ["probe"], {
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

  it("builds a launcher-owned Native Core identity without a Docker socket", () => {
    const context = {
      root: "/opt/sunabot/current",
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
      packaged: true,
      identity: "bfa0ec2e0882d0fb",
      workspace: "/srv/sunabot/workspace",
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
      SUNABOT_BWRAP_EXECUTABLE: "/opt/sunabot/current/runtime/bubblewrap/bwrap",
      SUNABOT_PACKAGED_RELEASE: "1"
    });
    expect(nativeCoreEnvironment(context, "127.0.0.1", "darwin"))
      .not.toHaveProperty("SUNABOT_DOCKER_SOCKET");
    expect(nativeCoreEnvironment(context, "172.18.0.1", "linux")).not.toHaveProperty("SUNABOT_DOCKER_SOCKET");
  });

  it("binds WSL Docker Desktop OneBot to loopback when the Docker VM bridge gateway is not local", () => {
    expect(selectNativeOnebotListenHost({
      configuredHost: "docker-network-gateway-or-loopback",
      dockerGateway: "172.31.0.1",
      wsl: true,
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "172.28.96.42", family: "IPv4", internal: false }]
      }
    })).toBe("127.0.0.1");
  });

  it("binds WSL distro Docker Engine OneBot to its local bridge gateway", () => {
    expect(selectNativeOnebotListenHost({
      configuredHost: "docker-network-gateway-or-loopback",
      dockerGateway: "172.31.0.1",
      wsl: true,
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        brSunabot: [{ address: "172.31.0.1", family: "IPv4", internal: false }]
      }
    })).toBe("172.31.0.1");
  });

  it("fails closed instead of binding a non-local Docker gateway on native Linux", () => {
    expect(() => selectNativeOnebotListenHost({
      configuredHost: "docker-network-gateway",
      dockerGateway: "172.31.0.1",
      wsl: false,
      networkInterfaces: {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }]
      }
    })).toThrow("ONEBOT_DOCKER_GATEWAY_NOT_LOCAL");
  });

  it("rejects an invalid Docker bridge gateway before selecting a OneBot listener", () => {
    expect(() => selectNativeOnebotListenHost({
      configuredHost: "docker-network-gateway-or-loopback",
      dockerGateway: "not-an-ip",
      wsl: true,
      networkInterfaces: {}
    })).toThrow("ONEBOT_DOCKER_GATEWAY_INVALID");
  });

  it("stops NapCat before removing its runtime network", async () => {
    const source = await fs.readFile(
      path.join(root, "tooling/runtime/launcher.mjs"),
      "utf8",
    );
    const down = source.slice(
      source.indexOf("async function down"),
      source.indexOf("async function assertRuntimeEmpty"),
    );

    expect(down.indexOf("await stopNapcatContainers")).toBeGreaterThan(-1);
    expect(down.indexOf("await stopNapcatContainers"))
      .toBeLessThan(down.indexOf("await removeRuntimeNetwork"));
  });

  it("accepts a stable startup while leaving optional capabilities degraded", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process"),
      pass("core-api"),
      pass("onebot-listener"),
      pass("account-reconciler"),
      pass("webfetch-dynamic-renderer", "capability"),
      fail("codex-auth", "CODEX_AUTH_REQUIRED", "Codex 尚未登录", "capability")
    ]);

    expect(startupReportFailures(report)).toEqual([]);
    expect(() => assertStartupReportReady(report)).not.toThrow();
  });

  it("builds first-run completion proof only from a stable full runtime and running NapCat", () => {
    const report = {
      ...runtimeReport([
        pass("workspace"),
        pass("core-process", "liveness"),
        pass("core-api", "liveness"),
        pass("onebot-listener"),
        pass("account-reconciler", "capability"),
        pass("webfetch-dynamic-renderer", "capability")
      ]),
      accounts: [{
        id: "primary",
        desiredState: "running",
        observedState: "running",
        reconcileRequired: false
      }]
    };

    expect(firstRunCompletionReadiness(report, 3_000)).toEqual({
      coreListening: true,
      onebotListening: true,
      accountRuntimeReady: true,
      napcatReady: true,
      runtimeReady: true,
      stable: true
    });
    expect(() => firstRunCompletionReadiness({
      ...report,
      accounts: [{
        id: "primary",
        desiredState: "running",
        observedState: "stopped",
        reconcileRequired: false
      }]
    }, 3_000)).toThrowError(/FIRST_RUN_NAPCAT_NOT_READY/u);
    expect(() => firstRunCompletionReadiness(report, 2_999))
      .toThrowError(/FIRST_RUN_RUNTIME_NOT_STABLE/u);
  });

  it("leaves first-run completion as the final fallible startup commit", async () => {
    const source = await fs.readFile(path.join(root, "tooling/runtime/launcher.mjs"), "utf8");
    const restart = source.slice(
      source.indexOf("async function restartRuntime"),
      source.indexOf("async function upNative")
    );

    expect(restart.indexOf("await waitForStableStartup(context)"))
      .toBeLessThan(restart.indexOf("await completeFirstRunBootstrap(context.workspace"));
    expect(restart.indexOf("printRuntimeReport(context, report)"))
      .toBeLessThan(restart.indexOf("await completeFirstRunBootstrap(context.workspace"));
  });

  it("fails startup when any complete readiness check fails", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process", "liveness"),
      pass("core-api", "liveness"),
      pass("onebot-listener"),
      pass("account-reconciler", "capability"),
      pass("webfetch-dynamic-renderer", "capability"),
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
      pass("webfetch-dynamic-renderer", "capability"),
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

  it("requires dynamic WebFetch on Linux while accepting its declared macOS unavailability", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process"),
      pass("core-api"),
      pass("onebot-listener"),
      pass("account-reconciler"),
      fail(
        "webfetch-dynamic-renderer",
        "WEBFETCH_RENDERER_UNAVAILABLE",
        "Bubblewrap namespace probe failed",
        "capability"
      )
    ]);

    expect(startupReportFailures(report, "linux")).toEqual([
      expect.objectContaining({
        id: "webfetch-dynamic-renderer",
        code: "WEBFETCH_RENDERER_UNAVAILABLE"
      })
    ]);
    expect(() => assertStartupReportReady(report, "linux"))
      .toThrowError(/STARTUP_NOT_READY.*WEBFETCH_RENDERER_UNAVAILABLE/u);
    expect(startupReportFailures(report, "darwin")).toEqual([]);
    expect(() => assertStartupReportReady(report, "darwin")).not.toThrow();
  });

  it("fails closed when the runtime probe omits a required startup check", () => {
    const report = runtimeReport([
      pass("workspace"),
      pass("core-process"),
      pass("core-api"),
      pass("onebot-listener"),
      pass("webfetch-dynamic-renderer", "capability")
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
    { args: ["bootstrap"], invocation: "bootstrap" },
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

  it("uses only bundled Node and installed dependencies in a packaged release", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-packaged-launcher-"));
    try {
      const prefix = path.join(fixture, "prefix");
      const releaseRoot = path.join(prefix, "versions", "0.3.0");
      const bundledNode = path.join(releaseRoot, "runtime/node/bin/node");
      const launcher = path.join(releaseRoot, "tooling/runtime/launcher.mjs");
      const trace = path.join(fixture, "trace.log");
      const bin = path.join(fixture, "bin");
      await Promise.all([
        fs.mkdir(path.dirname(bundledNode), { recursive: true }),
        fs.mkdir(path.dirname(launcher), { recursive: true }),
        fs.mkdir(path.join(releaseRoot, "node_modules/.bin"), { recursive: true }),
        fs.mkdir(bin, { recursive: true })
      ]);
      await fs.copyFile(path.join(root, "sunabot.sh"), path.join(releaseRoot, "sunabot.sh"));
      await fs.chmod(path.join(releaseRoot, "sunabot.sh"), 0o755);
      await fs.writeFile(path.join(releaseRoot, ".node-version"), `${process.versions.node}\n`);
      await fs.writeFile(path.join(releaseRoot, "package-lock.json"), "{}\n");
      await fs.writeFile(path.join(releaseRoot, "release-manifest.json"), "{}\n");
      await fs.writeFile(path.join(releaseRoot, "node_modules/.package-lock.json"), "{}\n");
      await fs.writeFile(launcher, "");
      await fs.writeFile(bundledNode, [
        "#!/bin/sh",
        "if [ \"${1:-}\" = \"-p\" ]; then",
        `  printf '%s\\n' '${process.versions.node}'`,
        "  exit 0",
        "fi",
        "case \"$*\" in",
        "  *validateReleaseManifest*) printf 'node:integrity:path=%s\\n' \"$PATH\" >> \"$TRACE_FILE\"; exit 0 ;;",
        "esac",
        "printf 'node:%s:workspace=%s\\n' \"$*\" \"$SUNABOT_WORKSPACE\" >> \"$TRACE_FILE\""
      ].join("\n"), { mode: 0o755 });
      await fs.writeFile(path.join(releaseRoot, "node_modules/.bin/docker"), [
        "#!/bin/sh",
        "printf 'shadow-docker:%s\\n' \"$*\" >> \"$TRACE_FILE\"",
        "exit 97"
      ].join("\n"), { mode: 0o755 });
      await fs.writeFile(path.join(bin, "npm"), [
        "#!/bin/sh",
        "printf 'npm:%s\\n' \"$*\" >> \"$TRACE_FILE\"",
        "exit 91"
      ].join("\n"), { mode: 0o755 });

      const result = spawnSync(path.join(releaseRoot, "sunabot.sh"), ["status"], {
        cwd: path.parse(fixture).root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          TRACE_FILE: trace
        }
      });

      expect(result.status, result.stderr).toBe(0);
      const traceLines = (await fs.readFile(trace, "utf8")).trim().split("\n");
      expect(traceLines).toHaveLength(2);
      expect(traceLines[0]).toBe(
        `node:integrity:path=${path.join(releaseRoot, "runtime/node/bin")}:${bin}:/usr/bin:/bin`
      );
      expect(traceLines[0]).not.toContain("node_modules/.bin");
      expect(traceLines[1]).toBe(
        `node:${launcher} status:workspace=${path.join(prefix, "workspace")}`
      );
      expect(traceLines.some((line) => line.startsWith("shadow-docker:"))).toBe(false);
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

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

  it("defaults to up and fixes Core to Native on supported platforms", () => {
    expect(parseLauncherArguments([], {}).command).toBe("up");
    expect(resolveCoreMode("auto", { platform: "darwin" })).toBe("native");
    expect(resolveCoreMode("auto", { platform: "linux" })).toBe("native");
    expect(() => resolveCoreMode("auto", { platform: "win32" })).toThrow("WSL2");
  });

  it("accepts development options and rejects removed Core selectors", () => {
    expect(parseLauncherArguments(["up", "--dev"], {})).toEqual({
      command: "up",
      requestedMode: "native",
      dev: true
    });
    expect(() => parseLauncherArguments(["restart", "--core=docker"], {})).toThrow("--core 已移除");
    expect(() => parseLauncherArguments(["up"], { SUNABOT_CORE_MODE: "native" }))
      .toThrow("SUNABOT_CORE_MODE 已移除");
    expect(parseLauncherArguments(["start"], {}).command).toBe("start");
    expect(parseLauncherArguments(["doctor"], { SUNABOT_DEV: "1" }).dev).toBe(true);
    expect(parseLauncherArguments(["--help"], {}).command).toBe("help");
    expect(parseLauncherArguments(["reconcile-account", "--account=qq_arona"], {})).toMatchObject({
      command: "reconcile-account",
      accountId: "qq_arona"
    });
    expect(parseLauncherArguments(["reconcile-account", "--account=qq_arona", "--force-restart"], {})).toMatchObject({
      command: "reconcile-account",
      accountId: "qq_arona",
      forceRestart: true
    });
    expect(() => parseLauncherArguments(["status", "--force-restart"], {})).toThrow("--force-restart");
    expect(parseLauncherArguments(["probe-runtime"], {}).command).toBe("probe-runtime");
  });

  it("detects the retired external main database override from either environment source", () => {
    expect(databasePathOverrideConfigured({}, {})).toBe(false);
    expect(databasePathOverrideConfigured({ SUNABOT_DATABASE_PATH: "/tmp/external.sqlite" }, {})).toBe(true);
    expect(databasePathOverrideConfigured({}, { SUNABOT_DATABASE_PATH: "/tmp/external.sqlite" })).toBe(true);
  });

  it("uses schema v3 Native Core and NapCat-only Docker fields", async () => {
    const [contract, schema] = await Promise.all([
      fs.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(root, "deploy/runtime-contract.schema.json"), "utf8").then(JSON.parse)
    ]);
    const resolved = resolveLauncherContract(contract, {
      root,
      platform: "darwin",
      wsl: false
    });

    expect(contract.schemaVersion).toBe(3);
    expect(resolved.releaseVersion).toBe("0.3.0");
    expect(resolved.adminPort).toBe(8787);
    expect(resolved.onebotHost).toBe("127.0.0.1");
    expect(resolved.onebotPort).toBe(8788);
    expect(resolved.nativeReverseWebSocket).toBe("ws://host.docker.internal:8788/onebot/v11/ws");
    expect(resolved).not.toHaveProperty("dockerReverseWebSocket");
    expect(resolved).not.toHaveProperty("coreService");
    expect(resolved).not.toHaveProperty("coreProfile");
    expect(resolved.napcatService).toBe("napcat");
    expect(resolved.composeFile).toBe(path.join(root, "deploy/napcat/compose.yml"));
    expect(resolved.napcatImage).toBe(`${contract.napcat.image}@${contract.napcat.digest}`);
    expect(contract.napcat.labels).toEqual({
      runtimeId: "io.sunabot.runtime-id",
      workspaceId: "io.sunabot.workspace-id",
      component: "io.sunabot.component",
      accountId: "io.sunabot.account-id"
    });
    expect(resolved.codexCli).toEqual({
      version: "0.139.0",
      executable: "node_modules/@openai/codex/bin/codex.js",
      authFile: "secrets/codex/auth.json"
    });
    expect(resolved.coreReadyTimeoutSeconds).toBe(60);
    expect(resolved.napcatReadyTimeoutSeconds).toBe(120);
    expect(contract.native.bubblewrap).toEqual({
      managedBy: "launcher",
      releaseExecutable: "runtime/bubblewrap/bwrap",
      executableEnvironment: "SUNABOT_BWRAP_EXECUTABLE",
      packagedFallback: false,
      verifiedByLauncher: true,
      consumers: ["native-bash", "mcp-stdio", "skill-script", "webfetch-renderer"]
    });
    expect(schema.properties.native.required).toContain("bubblewrap");

    const linux = resolveLauncherContract(contract, {
      root,
      platform: "linux",
      wsl: false
    });
    expect(linux.onebotHost).toBe("docker-network-gateway");

    const wsl = resolveLauncherContract(contract, {
      root,
      platform: "linux",
      wsl: true
    });
    expect(wsl.onebotHost).toBe("docker-network-gateway-or-loopback");
    expect(schema.properties.network.properties.onebot.properties.nativeListenerHosts.properties)
      .toMatchObject({
        macos: { const: "127.0.0.1" },
        wsl: { const: "docker-network-gateway-or-loopback" },
        linux: { const: "docker-network-gateway" }
      });
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
      JSON.stringify({ Service: "napcat", State: "running" }),
      JSON.stringify({ Service: "unrelated", State: "exited" })
    ].join("\n"));
    expect(composeServiceRunning(items, "napcat")).toBe(true);
    expect(composeServiceRunning(items, "unrelated")).toBe(false);
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
