#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import { installGlobalProxyDispatcher } from "../../packages/platform/proxy.mjs";
import { validateMultiAgentWorkspacePath } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import {
  listNativeCoreProcessGroups,
  stopNativeCoreProcessGroups
} from "./native-core-process.mjs";
import {
  createNativeWebfetchRendererLaunch,
  prepareNativeWebfetchRendererInstallation,
  verifyNativeWebfetchRendererIsolation
} from "./native-webfetch-renderer.mjs";
import {
  listNativeWebfetchRendererProcessGroups,
  stopNativeWebfetchRendererProcessGroups
} from "./native-webfetch-renderer-process.mjs";
import { buildRuntimeProbe, collectWorkspaceProbeFacts } from "./probe.mjs";
import { accountRuntimeState, planAccountReconciliation } from "./account-reconciler.mjs";
import {
  inspectAccountRuntimeOwner,
  listAccountRuntimeProcesses,
  quarantineInvalidAccountRuntimeOwner,
  removeStaleAccountRuntimeOwner,
  stopAccountRuntimeProcesses
} from "./account-runtime-daemon.mjs";
import {
  beginFirstRunBootstrap,
  completeFirstRunBootstrap,
  rollbackFirstRunBootstrap
} from "./first-run-state.mjs";
import { validateReleaseManifest } from "./release-integrity.mjs";
import {
  composeProjectName,
  databasePathOverrideConfigured,
  ensureRuntimeSecrets,
  envValue,
  isWslRuntime,
  parseLauncherArguments,
  processSignatureMatches,
  resolveCoreMode,
  resolveLauncherContract,
  reverseWebSocketWithHost,
  workspaceIdentity
} from "./launcher-core.mjs";

const root = resolveProjectRoot(import.meta.url);
const STARTUP_REQUIRED_CHECK_IDS = new Set([
  "workspace",
  "core-process",
  "core-api",
  "onebot-listener",
  "account-reconciler",
  "webfetch-dynamic-renderer"
]);
const STARTUP_STABILITY_WINDOW_MS = 3_000;
const STARTUP_STABILITY_POLL_MS = 250;
const STARTUP_STABILITY_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DOCKER_CONTROL_TIMEOUT_MS = 10_000;
const DOCKER_EXEC_TIMEOUT_MS = 45_000;
const DOCKER_COMPOSE_TIMEOUT_MS = 5 * 60_000;
const BUILD_COMMAND_TIMEOUT_MS = 15 * 60_000;
const INTERACTIVE_COMMAND_TIMEOUT_MS = 15 * 60_000;
const COMMAND_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_COMMAND_OUTPUT_BYTES = 1 * 1024 * 1024;

export async function runLauncher(argv = process.argv.slice(2), environment = process.env) {
  const parsed = parseLauncherArguments(argv, environment);
  const rawContract = await readJson(path.join(root, "deploy/runtime-contract.json"));
  const workspace = resolveWorkspace(root);
  if (!new Set(["help", "bootstrap"]).has(parsed.command)) {
    await validateMultiAgentWorkspacePath(workspace);
  }
  const wsl = isWslRuntime({ platform: process.platform, environment });
  const mode = resolveCoreMode(parsed.requestedMode, { platform: process.platform });
  const contract = resolveLauncherContract(rawContract, {
    root,
    platform: process.platform,
    wsl
  });
  const identity = workspaceIdentity(workspace);
  const project = composeProjectName(contract.composeBase, identity);
  const context = {
    root,
    workspace,
    wsl,
    mode,
    dev: parsed.dev,
    contract,
    identity,
    project,
    environment,
    runtimeEnv: path.join(workspace, contract.paths.secrets ?? "secrets/runtime.env"),
    statePath: path.join(workspace, "runtime/launcher-state.json"),
    coreLog: path.join(workspace, contract.paths.logs ?? "runtime/logs", parsed.dev ? "core-dev.log" : "core.log"),
    reconcilerLog: path.join(workspace, contract.paths.logs ?? "runtime/logs", "account-reconciler.log"),
    apiEntry: path.join(root, "dist/apps/api/main.js"),
    webEntry: path.join(root, "apps/admin-web/dist/index.html"),
    packaged: await exists(path.join(root, "release-manifest.json"))
  };
  context.runtimeEnvironment = await readRuntimeEnvironment(context.runtimeEnv);
  context.bubblewrapExecutable = bubblewrapExecutable(context);
  context.composeOverrides = {};
  await installGlobalProxyDispatcher({
    env: nativeProcessEnvironment(context),
    platform: process.platform
  });

  switch (parsed.command) {
    case "up":
    case "start":
    case "restart":
      await restartRuntime(context);
      break;
    case "down":
      await down(context);
      break;
    case "status":
      await printStatus(context);
      break;
    case "logs":
      await logs(context);
      break;
    case "doctor":
      await doctor(context);
      break;
    case "help":
      printHelp();
      break;
    case "bootstrap":
      await bootstrapRuntime(context);
      break;
    case "reconcile-account":
      await reconcileAccount(context, parsed.accountId, parsed.forceRestart);
      break;
    case "probe-runtime": {
      const facts = await collectRuntimeProbeFacts(context);
      console.log(`SUNABOT_RUNTIME_PROBE_FACTS=${JSON.stringify(facts)}`);
      break;
    }
    case "rollback-first-run": {
      const result = await rollbackFirstRunBootstrap(context.workspace);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
  }
}

export function napcatAccountUpArguments(action, service) {
  return [
    "up", "-d", "--no-build", "--pull", "never",
    ...(action === "restart" ? ["--force-recreate"] : []),
    service
  ];
}

async function restartRuntime(context) {
  if (databasePathOverrideConfigured(context.environment, context.runtimeEnvironment)) {
    throw new Error("SUNABOT_DATABASE_PATH 已停止支持；主库固定为 workspace/business/data/sunabot.sqlite。");
  }
  assertNonRootRuntimeUser();
  await assertDockerAvailable(context);
  assertExpectedProject(context, await inspectRuntime(context));
  await validatePackagedRelease(context);
  await assertLinuxBubblewrapNamespace(context);
  if (context.packaged) await assertNativeWebfetchRendererCapability(context);
  await assertNapcatImageAvailable(context);
  await initializeWorkspace(context);
  const firstRunBootstrap = await beginFirstRunBootstrap(context.workspace);
  const secrets = await prepareSecrets(context);
  await ensureAdminCredentials(context);
  await assertComposeServices(context);
  await down(context);
  const baseline = await assertRuntimeEmpty(context);
  await waitForRuntimePortsClosed(context, { dev: context.dev });
  await ensureRuntimeNetwork(context);
  await upNative(context, baseline, secrets.values);
  try {
    await startAccountRuntimeDaemon(context);
    const stableStartup = await waitForStableStartup(context);
    const report = stableStartup.report;
    const readiness = firstRunCompletionReadiness(report, stableStartup.stableForMs);
    printRuntimeReport(context, report);
    const firstRun = await completeFirstRunBootstrap(context.workspace, { readiness });
    if (firstRunBootstrap.state === "active" && firstRun.state !== "completed") {
      const missing = firstRun.state === "pending" ? firstRun.missing.join(",") : firstRun.state;
      throw new Error(`FIRST_RUN_INCOMPLETE:${missing}`);
    }
  } catch (error) {
    await down(context).catch(() => {});
    throw error;
  }
}

async function upNative(context, before, secrets) {
  let native = before.native;
  if (native.alive && !native.running) {
    throw new Error(`记录中的 Native PID ${native.pid} 已被其他进程复用；拒绝覆盖或终止该进程。`);
  }
  if (await tcpOpen("127.0.0.1", context.contract.adminPort)) {
    throw new Error(`127.0.0.1:${context.contract.adminPort} 已被非当前 launcher 管理的进程占用。`);
  }
  if (context.dev && await tcpOpen("127.0.0.1", 5173)) {
    throw new Error("127.0.0.1:5173 已被非当前 launcher 管理的进程占用。");
  }
  await ensureNativeDependencies(context);
  if (!context.dev) await ensureNativeBuild(context);
  const renderer = await prepareNativeWebfetchRenderer(context);
  const onebotListenHost = await resolveNativeOnebotListenHost(context);
  if (await tcpOpen(onebotListenHost, context.contract.onebotPort)) {
    throw new Error(`${onebotListenHost}:${context.contract.onebotPort} 已被非当前 launcher 管理的进程占用。`);
  }
  try {
    native = await startNativeCore(context, onebotListenHost, renderer?.token);
    await waitForHttp(
      `http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`,
      context.contract.coreReadyTimeoutSeconds * 1_000
    );
    await waitForHttp(
      `http://${onebotListenHost}:${context.contract.onebotPort}${context.contract.onebotHealthPath}`,
      context.contract.coreReadyTimeoutSeconds * 1_000
    );
    if (context.dev) {
      await waitForHttp("http://127.0.0.1:5173/", context.contract.coreReadyTimeoutSeconds * 1_000);
    }

    const reverseWebSocket = await probeNativeOneBot(context);
    const accounts = await loadNapcatAccounts(context);
    await startNapcatAccounts(context, accounts, reverseWebSocket, secrets);
    await writeState(context, {
      ...withoutUpdatedAt(await readState(context.statePath)),
      mode: "native",
      dev: context.dev,
      reverseWebSocket,
      accounts: accounts.map(({ id, webuiPort }) => ({ id, webuiPort })),
      onebotListenHost,
      core: native.record
    });
  } catch (error) {
    await stopNapcatContainers(context).catch(() => {});
    await stopNativeCore(context, native.record, { removeState: true }).catch(() => {});
    const rendererGroups = await listNativeWebfetchRendererProcessGroups({
      workspaceId: context.identity
    }).catch(() => []);
    if (rendererGroups.length > 0) {
      await stopNativeWebfetchRendererProcessGroups({
        workspaceId: context.identity,
        groups: rendererGroups,
        timeoutMs: context.contract.shutdownTimeoutSeconds * 1_000
      }).catch(() => {});
    }
    if (renderer?.record?.runRoot) {
      await fs.rm(renderer.record.runRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function bootstrapRuntime(context) {
  assertNonRootRuntimeUser();
  await validatePackagedRelease(context);
  await assertLinuxBubblewrapNamespace(context);
  await ensureNativeDependencies(context);
  await ensureNativeBuild(context);
  await assertDockerAvailable(context);
  await assertNapcatImageAvailable(context);
  await assertNativeWebfetchRendererCapability(context);
  console.log("Native Core、Bubblewrap namespace、Lightpanda 与 NapCat 锁定镜像已就绪。");
}

async function assertLinuxBubblewrapNamespace(context) {
  if (process.platform !== "linux") return;
  try {
    await command(
      bubblewrapExecutable(context),
      bubblewrapProbeArguments(context.workspace, true),
      { capture: true }
    );
  } catch (error) {
    throw runtimeError(
      "BUBBLEWRAP_NAMESPACE_UNAVAILABLE",
      `Bubblewrap namespace 隔离不可用：${message(error)}`
    );
  }
}

async function assertNativeWebfetchRendererCapability(context) {
  if (process.platform !== "linux") return;
  const installation = await prepareNativeWebfetchRendererInstallation(context, { command });
  const launch = await createNativeWebfetchRendererLaunch(context, installation);
  try {
    await verifyNativeWebfetchRendererIsolation(context, launch, command);
  } catch (error) {
    throw runtimeError(
      "WEBFETCH_DYNAMIC_ISOLATION_UNAVAILABLE",
      `Lightpanda 动态抓取隔离不可用：${message(error)}`
    );
  } finally {
    await fs.rm(launch.runRoot, { recursive: true, force: true });
  }
}

async function validatePackagedRelease(context) {
  if (!context.packaged) return;
  const manifest = await readJson(path.join(context.root, "release-manifest.json"));
  await validateReleaseManifest({ root: context.root, manifest });
}

async function assertNapcatImageAvailable(context) {
  try {
    await dockerCommand(context, ["image", "inspect", context.contract.napcatImage], {
      capture: true,
      timeoutMs: DOCKER_CONTROL_TIMEOUT_MS
    });
  } catch {
    throw runtimeError(
      "NAPCAT_IMAGE_MISSING",
      "锁定的 NapCat 镜像未安装；请重新执行发行版 install.sh，启动过程不会下载镜像。"
    );
  }
}

async function prepareNativeWebfetchRenderer(context) {
  const token = crypto.randomBytes(32).toString("base64url");
  let launch;
  let child;
  try {
    const installation = await prepareNativeWebfetchRendererInstallation(context, { command });
    launch = await createNativeWebfetchRendererLaunch(context, installation);
    await verifyNativeWebfetchRendererIsolation(context, launch, command);
    const log = await fs.open(launch.logPath, "a", 0o600);
    child = spawn(launch.executable, launch.args, {
      cwd: launch.runRoot,
      detached: true,
      env: launch.environment,
      stdio: ["ignore", log.fd, log.fd, "pipe"]
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.stdio[3].end(token);
    child.unref();
    await log.close();
    const observed = await waitForProcessObservation(child.pid, 3_000);
    const record = {
      pid: child.pid,
      signature: observed.signature,
      entry: installation.supervisorEntry,
      processGroup: child.pid,
      startedAt: new Date().toISOString(),
      isolation: launch.runtimeIsolation,
      logPath: launch.logPath,
      runRoot: launch.runRoot
    };
    const state = await readState(context.statePath);
    await writeState(context, {
      ...withoutUpdatedAt(state),
      mode: "native",
      dev: context.dev,
      webfetchRenderer: record
    });
    const health = await waitForRendererHealth(
      `http://127.0.0.1:${context.contract.webfetchRendererPort}/healthz`,
      context.contract.coreReadyTimeoutSeconds * 1_000
    );
    if (health.engine !== "lightpanda" || health.runtimeIsolation !== launch.runtimeIsolation) {
      throw new Error("WEBFETCH_RENDERER_ISOLATION_UNVERIFIED");
    }
    return { record, token };
  } catch (error) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    if (launch?.runRoot) await fs.rm(launch.runRoot, { recursive: true, force: true }).catch(() => {});
    if (process.platform === "linux") {
      throw runtimeError(
        "WEBFETCH_DYNAMIC_ISOLATION_UNAVAILABLE",
        `Lightpanda 动态抓取隔离不可用：${message(error)}`
      );
    }
    console.warn(`WebFetch Native 动态渲染服务准备失败，静态抓取保持可用：${message(error)}`);
    return undefined;
  }
}

export function nativeWebfetchRendererDeployment(platform = process.platform) {
  return platform === "linux" ? "native" : "unavailable";
}

async function down(context) {
  await assertDockerAvailable(context);
  const runtime = await inspectRuntime(context);
  if (runtime.reconciler.owner.status === "running"
    && !runtime.reconciler.processes.some((item) => item.pid === runtime.reconciler.owner.record.pid)) {
    throw new Error("账号调和 owner 与进程清单不一致；未发送停止信号。");
  }
  if (runtime.reconciler.processes.length > 0) {
    await stopAccountRuntimeProcesses({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry: accountRuntimeDaemonEntry(context),
      processes: runtime.reconciler.processes,
      timeoutMs: Math.min(context.contract.shutdownTimeoutSeconds * 1_000, 5_000)
    });
  }
  if (runtime.reconciler.owner.status !== "missing" && runtime.reconciler.owner.status !== "invalid") {
    await removeStaleAccountRuntimeOwner({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry: accountRuntimeDaemonEntry(context)
    });
  }
  if (runtime.nativeProcessGroups.length > 0) {
    await stopNativeCoreProcessGroups({
      root: context.root,
      workspace: context.workspace,
      groups: runtime.nativeProcessGroups,
      timeoutMs: context.contract.shutdownTimeoutSeconds * 1_000
    });
  }
  if (runtime.nativeWebfetchRendererGroups.length > 0) {
    await stopNativeWebfetchRendererProcessGroups({
      workspaceId: context.identity,
      groups: runtime.nativeWebfetchRendererGroups,
      timeoutMs: context.contract.shutdownTimeoutSeconds * 1_000
    });
  }
  if (runtime.state?.webfetchRenderer?.runRoot) {
    await fs.rm(runtime.state.webfetchRenderer.runRoot, { recursive: true, force: true });
  }
  await stopNapcatContainers(context);
  await removeRuntimeNetwork(context);
  if (runtime.state || runtime.nativeProcessGroups.length > 0) {
    await waitForRuntimePortsClosed(context, runtime.state);
  }
  await cleanupRemovedNapcatAccounts(context);
  if (runtime.reconciler.owner.status === "invalid") {
    const quarantinePath = await quarantineInvalidAccountRuntimeOwner({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry: accountRuntimeDaemonEntry(context)
    });
    if (quarantinePath) console.log(`无效账号调和 owner 已隔离保留：${quarantinePath}`);
  }
  await fs.rm(context.statePath, { force: true });
  console.log("Sunabot Core 与 NapCat 已停止。");
}

async function assertRuntimeEmpty(context) {
  const runtime = await inspectRuntime(context, { includeOneoffs: true });
  const residuals = [];
  if (runtime.state) residuals.push("launcher state");
  if (runtime.nativeProcessGroups.length > 0) {
    residuals.push(`Native Core 进程组 ${runtime.nativeProcessGroups.map((item) => item.processGroup).join(", ")}`);
  }
  if (runtime.nativeWebfetchRendererGroups.length > 0) {
    residuals.push(`Native Renderer 进程组 ${runtime.nativeWebfetchRendererGroups.map((item) => item.processGroup).join(", ")}`);
  }
  if (runtime.reconciler.processes.length > 0) {
    residuals.push(`账号调和进程 ${runtime.reconciler.processes.map((item) => item.pid).join(", ")}`);
  }
  if (runtime.reconciler.owner.status !== "missing") {
    residuals.push(`账号调和 owner ${runtime.reconciler.owner.status}`);
  }
  if (runtime.napcat.matches.length > 0) {
    residuals.push(`NapCat 容器 ${runtime.napcat.matches.map((item) => item.id).join(", ")}`);
  }
  const unsupportedContainers = runtime.containers.filter((item) => item.component !== "napcat");
  if (unsupportedContainers.length > 0) {
    residuals.push(`已移除组件的旧容器 ${unsupportedContainers.map((item) => item.id).join(", ")}`);
  }
  if (await runtimeNetworkExists(context)) residuals.push(`NapCat 网络 ${context.project}-runtime`);
  if (residuals.length > 0) {
    throw runtimeError("RUNTIME_NOT_EMPTY", `当前 workspace 未清空：${residuals.join("；")}。`);
  }
  return runtime;
}

async function printStatus(context) {
  const report = buildRuntimeProbe(await collectRuntimeProbeFacts(context));
  printRuntimeReport(context, report);
}

function printRuntimeReport(context, report) {
  console.log(`Probe schema: ${report.schemaVersion}`);
  console.log(`Workspace: ${context.workspace}`);
  console.log(`Liveness: ${report.summary.liveness}`);
  console.log(`Readiness: ${report.summary.readiness}`);
  console.log(`Capabilities: ${report.summary.capability}`);
  for (const account of report.accounts) {
    console.log(`NapCat ${account.id}: desired=${account.desiredState} observed=${account.observedState} connected=${account.connected ?? "unknown"}`);
  }
  for (const item of report.checks.filter((check) => check.status === "fail")) {
    console.log(`[${item.code}] ${item.detail}${item.path ? ` (${item.path})` : ""}; 修复：${item.action}`);
  }
}

export function startupReportFailures(report) {
  const checks = new Map((report?.checks ?? []).map((item) => [item.id, item]));
  const failures = [];
  const seen = new Set();
  const add = (check) => {
    if (seen.has(check.id)) return;
    seen.add(check.id);
    failures.push(check);
  };
  for (const id of STARTUP_REQUIRED_CHECK_IDS) {
    const check = checks.get(id);
    if (!check || check.status !== "pass") {
      add(check ?? {
        id,
        code: "STARTUP_CHECK_MISSING",
        detail: "启动检查缺失",
        action: "./sunabot.sh doctor"
      });
    }
  }
  for (const check of report?.checks ?? []) {
    if (["liveness", "readiness"].includes(check.kind) && check.status === "fail") add(check);
  }
  return failures;
}

export function assertStartupReportReady(report) {
  const failures = startupReportFailures(report);
  if (failures.length === 0) return;
  const detail = failures.map((item) => {
    const action = item.action ? `；修复：${item.action}` : "";
    return `[${item.code ?? "STARTUP_NOT_READY"}] ${item.detail ?? item.id}${action}`;
  }).join("；");
  throw runtimeError("STARTUP_NOT_READY", detail);
}

export function firstRunCompletionReadiness(report, stableForMs) {
  assertStartupReportReady(report);
  if (!Number.isFinite(stableForMs) || stableForMs < STARTUP_STABILITY_WINDOW_MS) {
    throw runtimeError(
      "FIRST_RUN_RUNTIME_NOT_STABLE",
      `首次运行的完整启动状态未连续稳定 ${STARTUP_STABILITY_WINDOW_MS}ms。`
    );
  }
  const checks = new Map((report?.checks ?? []).map((item) => [item.id, item]));
  const accounts = Array.isArray(report?.accounts) ? report.accounts : [];
  const primary = accounts.find((account) => account.id === "primary");
  const napcatReady = primary?.desiredState === "running"
    && primary.observedState === "running"
    && primary.reconcileRequired !== true
    && accounts.every((account) => (
      account.reconcileRequired !== true
      && (account.desiredState !== "running" || account.observedState === "running")
    ));
  if (!napcatReady) {
    throw runtimeError("FIRST_RUN_NAPCAT_NOT_READY", "首次运行的 NapCat 账号尚未通过运行状态检查。");
  }
  return {
    coreListening: checks.get("core-process")?.status === "pass"
      && checks.get("core-api")?.status === "pass",
    onebotListening: checks.get("onebot-listener")?.status === "pass",
    accountRuntimeReady: checks.get("account-reconciler")?.status === "pass",
    napcatReady: true,
    runtimeReady: true,
    stable: true
  };
}

async function waitForStableStartup(context) {
  const deadline = Date.now() + STARTUP_STABILITY_TIMEOUT_MS;
  let stableSince;
  while (Date.now() < deadline) {
    if (await startupComponentsReady(context)) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= STARTUP_STABILITY_WINDOW_MS) {
        const report = buildRuntimeProbe(await collectRuntimeProbeFacts(context));
        assertStartupReportReady(report);
        return { report, stableForMs: Date.now() - stableSince };
      }
    } else {
      stableSince = undefined;
    }
    await delay(STARTUP_STABILITY_POLL_MS);
  }
  const report = buildRuntimeProbe(await collectRuntimeProbeFacts(context));
  assertStartupReportReady(report);
  throw runtimeError("STARTUP_NOT_STABLE", `Core、OneBot 与账号调和未连续稳定 ${STARTUP_STABILITY_WINDOW_MS}ms。`);
}

async function startupComponentsReady(context) {
  const runtime = await inspectRuntime(context);
  if (!runtime.native.running || !runtime.reconciler.healthy) return false;
  const apiReady = await httpReady(
    `http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`
  );
  if (!apiReady) return false;
  const onebotHost = runtime.state?.onebotListenHost
    ?? defaultNativeOnebotHealthHost(context.contract.onebotHost);
  return httpReady(
    `http://${onebotHost}:${context.contract.onebotPort}${context.contract.onebotHealthPath}`
  );
}

async function doctor(context) {
  const report = buildRuntimeProbe(await collectRuntimeProbeFacts(context));
  console.log(JSON.stringify(report, null, 2));
  if (report.checks.some((item) => item.status === "fail")) process.exitCode = 1;
}

async function collectRuntimeProbeFacts(context) {
  const runtime = await inspectRuntime(context);
  const apiPath = `http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`;
  const onebotHealthHost = runtime.state?.onebotListenHost
    ?? defaultNativeOnebotHealthHost(context.contract.onebotHost);
  const onebotPath = `http://${onebotHealthHost}:${context.contract.onebotPort}${context.contract.onebotHealthPath}`;
  const apiReady = await httpReady(apiPath);
  const onebotReady = runtime.native.running && await httpReady(onebotPath);
  const rendererHealth = await readRendererHealth(
    `http://127.0.0.1:${context.contract.webfetchRendererPort}/healthz`
  );
  const webfetchRendererReady = runtime.nativeWebfetchRendererGroups.some((group) => group.members.some(
      (member) => member.pid === runtime.state?.webfetchRenderer?.pid
    ))
      && rendererHealth?.engine === "lightpanda"
      && rendererHealth?.runtimeIsolation === "linux-bubblewrap"
  ;
  const conflicts = accountRuntimeConflicts(runtime.reconciler, context);

  const docker = await dockerAvailable(context);
  const compose = docker && await commandSucceeds("docker", ["compose", "version"], {
    env: nativeProcessEnvironment(context)
  });
  const capabilities = {};
  capabilities.accountReconciler = {
    ok: runtime.reconciler.healthy,
    path: context.statePath,
    detail: runtime.reconciler.healthy
      ? `PID ${runtime.reconciler.owner.record.pid}`
      : runtime.reconciler.processes.length > 0
        ? `检测到 ${runtime.reconciler.processes.length} 个未完全登记的 host reconciler`
        : "host reconciler is not running"
  };
  const native = await inspectNativeCapabilities(context);
  Object.assign(capabilities, {
    codexCli: native.codexCli,
    codexAuth: native.codexAuth,
    workspaceBash: native.workspaceBash
  });

  const legacyRunning = runtime.legacyContainers.filter((item) => item.state === "running");
  if (legacyRunning.length > 0) {
    conflicts.push({
      id: "legacy-runtime",
      code: "LEGACY_RUNTIME_RUNNING",
      action: "按 docs/migrations/one-container-to-split-runtime.md 停止旧实例",
      detail: legacyRunning.map((item) => item.name).join(", ")
    });
  }
  if (runtime.foreignProjects.length > 0) {
    conflicts.push({
      id: "workspace-owner",
      code: "WORKSPACE_OWNER_CONFLICT",
      action: "停止使用同一 workspace 的其他 Compose project",
      detail: runtime.foreignProjects.join(", ")
    });
  }
  if (!runtime.native.running && apiReady) {
    conflicts.push({
      id: "admin-port-owner",
      code: "ADMIN_PORT_FOREIGN_OWNER",
      path: `127.0.0.1:${context.contract.adminPort}`,
      action: "停止占用管理端口的进程",
      detail: "管理端口由 launcher 外部进程占用"
    });
  }

  const accountObservations = Object.fromEntries(runtime.napcat.matches
    .filter((item) => item.accountId)
    .map((item) => [item.accountId, item.state === "running" ? "running" : "stopped"]));
  const workspaceFacts = await collectWorkspaceProbeFacts({
    workspace: context.workspace,
    environment: context.runtimeEnvironment,
    accountObservations,
    conflicts
  });

  return {
    ...workspaceFacts,
    core: {
      mode: runtime.native.running ? "native" : "stopped",
      running: runtime.native.running,
      apiReady,
      onebotReady,
      apiPath,
      onebotPath
    },
    dependencies: {
      node: {
        ok: !context.contract.nodeVersion || process.versions.node === context.contract.nodeVersion,
        detail: process.versions.node,
        action: `安装 Node ${context.contract.nodeVersion}`
      },
      docker: { ok: docker, detail: docker ? "available" : "unavailable" },
      compose: { ok: compose, detail: compose ? "available" : "unavailable" }
    },
    capabilities: {
      ...workspaceFacts.capabilities,
      ...capabilities,
      webfetchDynamicRenderer: {
        ok: webfetchRendererReady,
        detail: webfetchRendererReady
          ? `renderer healthy (${rendererHealth.runtimeIsolation}, lightpanda)`
          : "renderer unavailable or isolation unverified"
      }
    }
  };
}

async function loadRegisteredAccounts(context) {
  const databasePath = path.join(context.workspace, "business/data/sunabot.sqlite");
  if (!await exists(databasePath)) {
    throw runtimeError("ACCOUNT_REGISTRY_UNREADABLE", `账号注册库不存在：${databasePath}。`);
  }
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    return database.prepare(`
      SELECT aa.id, aa.agent_id, aa.qq_id, aa.enabled, aa.webui_port, a.enabled AS agent_enabled
      FROM agent_accounts aa
      JOIN agents a ON a.id = aa.agent_id
      ORDER BY aa.created_at, aa.id
    `).all().map((row) => ({
      id: String(row.id),
      agentId: String(row.agent_id),
      qqId: row.qq_id == null ? undefined : String(row.qq_id),
      enabled: Number(row.enabled) === 1,
      agentEnabled: Number(row.agent_enabled) === 1,
      webuiPort: Number(row.webui_port)
    }));
  } catch (error) {
    throw runtimeError("ACCOUNT_REGISTRY_UNREADABLE", `账号注册库无法读取：${message(error)}。`);
  } finally {
    database?.close();
  }
}

function printHelp() {
  console.log("用法：./sunabot.sh <up|start|down|restart|status|doctor|logs|bootstrap|help> [--dev]");
}

async function logs(context) {
  const runtime = await inspectRuntime(context);
  if (!runtime.native.running
    && !runtime.napcat.running
    && runtime.nativeWebfetchRendererGroups.length === 0) {
    throw new Error("Sunabot 尚未运行。");
  }
  const children = [];
  if (runtime.native.running && await exists(context.coreLog)) {
    children.push(spawn("tail", ["-n", "120", "-F", context.coreLog], { stdio: "inherit" }));
  }
  if (runtime.nativeWebfetchRendererGroups.length > 0
    && runtime.state?.webfetchRenderer?.logPath
    && await exists(runtime.state.webfetchRenderer.logPath)) {
    children.push(spawn("tail", ["-n", "120", "-F", runtime.state.webfetchRenderer.logPath], { stdio: "inherit" }));
  }
  for (const container of runtime.napcat.matches.filter((item) => item.state === "running")) {
    children.push(spawn("docker", ["logs", "-f", "--tail", "120", container.id], { stdio: "inherit" }));
  }
  await followChildren(children);
}

async function initializeWorkspace(context) {
  const { initializeWorkspace: initialize } = await import("../workspace/init-workspace.mjs");
  await initialize({ root: context.root, workspace: context.workspace });
}

async function prepareSecrets(context) {
  const source = await fs.readFile(context.runtimeEnv, "utf8");
  const result = ensureRuntimeSecrets(source, () => crypto.randomBytes(32).toString("base64url"));
  if (result.content !== source) {
    await atomicWrite(context.runtimeEnv, result.content, 0o600);
    console.log("运行密钥已准备（内容未输出）。");
  }
  context.runtimeEnvironment = dotenv.parse(result.content);
  return result;
}

async function ensureAdminCredentials(context) {
  const credentialsPath = path.join(context.workspace, "secrets/admin-credentials.json");
  if (await exists(credentialsPath)) return;
  if (!process.stdin.isTTY) {
    throw new Error("管理员凭据不存在；请在交互终端执行 ./sunabot.sh up 完成 Landing。");
  }
  console.log(`Sunabot ${context.contract.releaseVersion} 首次启动`);
  console.log(`数据目录：${context.workspace}`);
  await command(process.execPath, [
    path.join(context.root, "tooling/admin/admin-credentials.mjs"),
    "--landing"
  ], {
    cwd: context.root,
    env: { ...process.env, SUNABOT_WORKSPACE: context.workspace },
    timeoutMs: INTERACTIVE_COMMAND_TIMEOUT_MS
  });
}

async function startNapcatAccounts(context, accounts, reverseWebSocket, secrets) {
  for (const account of accounts) {
    await configureNapcat(context, reverseWebSocket, secrets, account);
    await clearNapcatLoginQr(context, account);
    await napcatCompose(context, account, napcatAccountUpArguments("start", context.contract.napcatService));
    await waitForNapcatAccountHealth(context, account.id, context.contract.napcatReadyTimeoutSeconds * 1_000);
    await writeAccountRuntimeState(
      path.join(context.workspace, "runtime/napcat/accounts", account.id),
      accountRuntimeState({
        accountId: account.id,
        desiredState: "running",
        observedState: "running",
        reconcileRequired: false
      })
    );
  }
}

async function reconcileAccount(context, accountId, forceRestart = false) {
  if (databasePathOverrideConfigured(context.environment, context.runtimeEnvironment)) {
    throw new Error("SUNABOT_DATABASE_PATH 已停止支持；账号调和只读取 canonical 主库。");
  }
  assertNonRootRuntimeUser();
  const runtime = await inspectRuntime(context);
  assertExpectedProject(context, runtime);
  const accounts = await loadRegisteredAccounts(context);
  const account = accounts.find((item) => item.id === accountId);
  const plan = planAccountReconciliation({
    accountId,
    account,
    containers: runtime.napcat.matches,
    forceRestart
  });
  const accountRoot = path.join(context.workspace, "runtime/napcat/accounts", accountId);

  try {
    await assertDockerAvailable(context);
    await assertNapcatImageAvailable(context);
    let observedState = plan.observedState;
    if (plan.desiredState === "running") {
      if (!account) throw new Error(`QQ 账号 ${accountId} 未注册。`);
      if (!runtime.native.running) {
        throw new Error("Sunabot Core 未运行；请执行 ./sunabot.sh up。");
      }
      const source = await fs.readFile(context.runtimeEnv, "utf8");
      const secrets = {
        ONEBOT_ACCESS_TOKEN: envValue(source, "ONEBOT_ACCESS_TOKEN"),
        WEBUI_TOKEN: envValue(source, "WEBUI_TOKEN")
      };
      if (!secrets.ONEBOT_ACCESS_TOKEN || !secrets.WEBUI_TOKEN) {
        throw new Error("运行密钥缺失；请执行 ./sunabot.sh up 完成初始化。");
      }
      const reverseWebSocket = runtime.state?.reverseWebSocket;
      if (!reverseWebSocket) throw new Error("Native OneBot 地址尚未写入 launcher 状态；请执行 ./sunabot.sh up。");

      const changed = await configureNapcat(context, reverseWebSocket, secrets, account);
      if (plan.action === "start" || plan.action === "restart") await clearNapcatLoginQr(context, account);
      if (plan.action === "start" || plan.action === "restart" || changed) {
        await napcatCompose(context, account, napcatAccountUpArguments(plan.action, context.contract.napcatService));
      }
      await waitForNapcatAccountHealth(
        context,
        account.id,
        context.contract.napcatReadyTimeoutSeconds * 1_000
      );
      observedState = "running";
    } else {
      for (const containerId of plan.targetContainerIds) {
        await dockerCommand(context, ["stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), containerId], {
          timeoutMs: (context.contract.shutdownTimeoutSeconds + 5) * 1_000
        });
        await dockerCommand(context, ["rm", containerId]);
      }
      observedState = "missing";
    }

    const state = accountRuntimeState({
      accountId,
      desiredState: plan.desiredState,
      observedState,
      reconcileRequired: false
    });
    if (account || await exists(accountRoot)) await writeAccountRuntimeState(accountRoot, state);
    if (!account && await exists(path.join(accountRoot, ".remove-on-stop"))) {
      await fs.rm(accountRoot, { recursive: true, force: true });
    }
    const launcherState = await readState(context.statePath);
    if (launcherState) {
      await writeState(context, {
        ...withoutUpdatedAt(launcherState),
        accounts: accounts
          .filter((item) => item.enabled && item.agentEnabled)
          .map(({ id, webuiPort }) => ({ id, webuiPort }))
      });
    }
    console.log(`SUNABOT_ACCOUNT_RECONCILE=${JSON.stringify(state)}`);
    return state;
  } catch (error) {
    const state = accountRuntimeState({
      accountId,
      desiredState: plan.desiredState,
      observedState: plan.observedState,
      reconcileRequired: true,
      lastError: message(error)
    });
    if (account || await exists(accountRoot)) await writeAccountRuntimeState(accountRoot, state).catch(() => {});
    console.log(`SUNABOT_ACCOUNT_RECONCILE=${JSON.stringify(state)}`);
    throw error;
  }
}

async function writeAccountRuntimeState(accountRoot, state) {
  await atomicJsonIfChanged(path.join(accountRoot, "runtime-state.json"), state);
}

async function configureNapcat(context, reverseWebSocket, secrets, account) {
  const accountRoot = path.join(context.workspace, "runtime/napcat/accounts", account.id);
  const configDir = path.join(accountRoot, "config-full");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  let names = (await fs.readdir(configDir)).filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
  if (names.length === 0) {
    names = /^\d{5,20}$/.test(account.qqId ?? "") ? [`onebot11_${account.qqId}.json`] : ["onebot11.json"];
  }
  const url = new URL(reverseWebSocket);
  url.searchParams.set("account_id", account.id);
  let changed = false;
  for (const name of names) {
    const filePath = path.join(configDir, name);
    const config = await readJsonOr(filePath, { network: { websocketClients: [] } });
    config.network ??= {};
    config.enableLocalFile2Url = true;
    config.network.websocketClients = [{
      name: "sunabot",
      enable: true,
      url: url.toString(),
      messagePostFormat: "array",
      reportSelfMessage: false,
      reconnectInterval: 5000,
      token: secrets.ONEBOT_ACCESS_TOKEN,
      debug: false,
      heartInterval: 30000
    }];
    changed = await atomicJsonIfChanged(filePath, config) || changed;
  }
  const webuiPath = path.join(configDir, "webui.json");
  const webui = await readJsonOr(webuiPath, {});
  Object.assign(webui, {
    host: "0.0.0.0",
    prefix: typeof webui.prefix === "string" ? webui.prefix : "",
    port: 6099,
    token: secrets.WEBUI_TOKEN,
    loginRate: Number.isInteger(webui.loginRate) ? webui.loginRate : 3
  });
  changed = await atomicJsonIfChanged(webuiPath, webui) || changed;
  const accountEnv = account.qqId ? `NAPCAT_ACCOUNT=${account.qqId}\n` : "";
  changed = await atomicTextIfChanged(path.join(accountRoot, "account.env"), accountEnv, 0o600) || changed;
  console.log(`NapCat ${account.id} 已配置：${names.join(", ")}（Token 已隐藏）。`);
  return changed;
}

async function loadNapcatAccounts(context) {
  const databasePath = path.join(context.workspace, "business/data/sunabot.sqlite");
  if (!await exists(databasePath)) return [{ id: "primary", qqId: undefined, webuiPort: context.contract.webuiPort }];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT id, qq_id, webui_port
      FROM agent_accounts
      WHERE enabled = 1
      ORDER BY created_at, id
    `).all();
    return rows.length > 0
      ? rows.map((row) => ({ id: String(row.id), qqId: row.qq_id == null ? undefined : String(row.qq_id), webuiPort: Number(row.webui_port) }))
      : [{ id: "primary", qqId: undefined, webuiPort: context.contract.webuiPort }];
  } finally {
    database.close();
  }
}

async function probeNativeOneBot(context) {
  const advertised = new URL(context.contract.nativeReverseWebSocket);
  const script = [
    "set -eu",
    "probe() { curl --noproxy '*' --fail --silent --show-error --max-time 3 \"http://$1:${SUNABOT_PROBE_PORT}${SUNABOT_PROBE_PATH}\" >/dev/null 2>&1; }",
    "selected=''",
    "if probe \"$SUNABOT_PROBE_HOST\"; then selected=$SUNABOT_PROBE_HOST; fi",
    "if [ -z \"$selected\" ]; then",
    "  route_hex=$(awk '$2 == \"00000000\" { print $3; exit }' /proc/net/route)",
    "  if [ -n \"$route_hex\" ]; then",
    "    gateway=$((16#${route_hex:6:2})).$((16#${route_hex:4:2})).$((16#${route_hex:2:2})).$((16#${route_hex:0:2}))",
    "    if probe \"$gateway\"; then selected=$gateway; fi",
    "  fi",
    "fi",
    "[ -n \"$selected\" ] || exit 2",
    "printf 'SUNABOT_PROBE_SELECTED=%s\\n' \"$selected\""
  ].join("\n");
  const output = await compose(context, [
    "run",
    "--rm",
    "--no-deps",
    "--pull", "never",
    "-e", `SUNABOT_PROBE_HOST=${advertised.hostname}`,
    "-e", `SUNABOT_PROBE_PORT=${context.contract.onebotPort}`,
    "-e", `SUNABOT_PROBE_PATH=${context.contract.onebotHealthPath}`,
    "--entrypoint", "/bin/bash",
    context.contract.napcatService,
    "-ec",
    script
  ], { capture: true, timeoutMs: 15_000 });
  const line = output.split(/\r?\n/).reverse()
    .find((value) => value.startsWith("SUNABOT_PROBE_SELECTED="));
  if (!line) {
    throw runtimeError(
      "ONEBOT_CONTAINER_PROBE_FAILED",
      "NapCat 容器无法通过 host.docker.internal 或运行网络 gateway 访问 Native OneBot /healthz。"
    );
  }
  const host = line.slice("SUNABOT_PROBE_SELECTED=".length).trim();
  return reverseWebSocketWithHost(context.contract.nativeReverseWebSocket, host);
}

async function resolveNativeOnebotListenHost(context) {
  if (!isDynamicNativeOnebotHost(context.contract.onebotHost)) return context.contract.onebotHost;
  const network = `${context.project}-runtime`;
  const gateway = (await dockerCommand(context, [
    "network",
    "inspect",
    network,
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}"
  ], { capture: true })).trim();
  return selectNativeOnebotListenHost({
    configuredHost: context.contract.onebotHost,
    dockerGateway: gateway,
    wsl: context.wsl,
    networkInterfaces: os.networkInterfaces(),
    network
  });
}

export function selectNativeOnebotListenHost({
  configuredHost,
  dockerGateway,
  wsl,
  networkInterfaces,
  network = "NapCat runtime network"
}) {
  if (!isDynamicNativeOnebotHost(configuredHost)) return configuredHost;
  if (net.isIP(dockerGateway) !== 4) {
    throw runtimeError(
      "ONEBOT_DOCKER_GATEWAY_INVALID",
      `无法解析 ${network} 的 IPv4 gateway；拒绝扩大 OneBot 监听范围。`
    );
  }
  const localAddresses = Object.values(networkInterfaces ?? {})
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" || entry.family === 4)
    .map((entry) => entry.address);
  if (localAddresses.includes(dockerGateway)) return dockerGateway;
  if (wsl && configuredHost === "docker-network-gateway-or-loopback") return "127.0.0.1";
  throw runtimeError(
    "ONEBOT_DOCKER_GATEWAY_NOT_LOCAL",
    `${network} gateway ${dockerGateway} 不属于 Native Core 网络命名空间；拒绝绑定不可用地址或公开 8788。`
  );
}

function isDynamicNativeOnebotHost(host) {
  return host === "docker-network-gateway"
    || host === "docker-network-gateway-or-loopback";
}

function defaultNativeOnebotHealthHost(host) {
  return isDynamicNativeOnebotHost(host) ? "127.0.0.1" : host;
}

async function ensureRuntimeNetwork(context) {
  const network = `${context.project}-runtime`;
  if (await commandSucceeds("docker", ["network", "inspect", network], {
    env: nativeProcessEnvironment(context)
  })) return;
  await dockerCommand(context, [
    "network", "create",
    "--label", `io.sunabot.runtime-id=${context.contract.runtimeId}`,
    "--label", `io.sunabot.workspace-id=${context.identity}`,
    "--label", "io.sunabot.component=runtime-network",
    network
  ]);
}

async function stopNapcatContainers(context) {
  const containers = (await labeledContainers(context)).filter((item) => item.component === "napcat");
  for (const container of containers) {
    await dockerCommand(context, ["stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), container.id], {
      timeoutMs: (context.contract.shutdownTimeoutSeconds + 5) * 1_000
    }).catch(() => {});
    await dockerCommand(context, ["rm", container.id]).catch(() => {});
  }
}

async function cleanupRemovedNapcatAccounts(context) {
  const accountsRoot = path.join(context.workspace, "runtime/napcat/accounts");
  if (!await exists(accountsRoot)) return;
  const registeredAccountIds = await loadRegisteredAccountIds(context);
  if (!registeredAccountIds) return;
  const entries = await fs.readdir(accountsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const accountRoot = path.join(accountsRoot, entry.name);
    const markedForRemoval = await exists(path.join(accountRoot, ".remove-on-stop"));
    if (!shouldCleanupRemovedNapcatAccount(entry.name, registeredAccountIds, markedForRemoval)) continue;
    await fs.rm(accountRoot, { recursive: true, force: true });
  }
}

export function shouldCleanupRemovedNapcatAccount(accountId, registeredAccountIds, markedForRemoval) {
  return markedForRemoval === true && !registeredAccountIds.has(accountId);
}

async function loadRegisteredAccountIds(context) {
  const databasePath = path.join(context.workspace, "business/data/sunabot.sqlite");
  if (!await exists(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return new Set(database.prepare("SELECT id FROM agent_accounts ORDER BY id")
      .all()
      .map((row) => String(row.id)));
  } finally {
    database.close();
  }
}

async function waitForNapcatAccountHealth(context, accountId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const match = (await labeledContainers(context))
      .find((item) => item.component === "napcat" && item.accountId === accountId);
    if (match) {
      lastStatus = await componentHealthStatus(context, match.id).catch(() => "inspect-error");
      if (lastStatus === "healthy") return;
      if (["unhealthy", "exited", "dead"].includes(lastStatus)) {
        throw new Error(`NapCat ${accountId} 容器健康检查失败：${lastStatus}`);
      }
    }
    await delay(250);
  }
  throw new Error(`NapCat ${accountId} 容器健康检查超时：${lastStatus}`);
}

async function componentHealthStatus(context, containerId) {
  const output = await dockerCommand(context, [
    "inspect",
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
    containerId
  ], { capture: true });
  return output.trim().toLowerCase();
}

export function bubblewrapProbeArguments(workspace, networkAccess = false) {
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
    "--bind", workspace, workspace,
    "--proc", "/proc",
    "--chdir", workspace,
    "--clearenv",
    "--", "/bin/bash", "--noprofile", "--norc", "-lc", ":"
  ];
  if (!networkAccess) args.splice(args.indexOf("--unshare-cgroup-try"), 0, "--unshare-net");
  return args;
}

export function bubblewrapExecutable(context) {
  const bundled = path.join(context.root, "runtime/bubblewrap/bwrap");
  return context.packaged ? bundled : "/usr/bin/bwrap";
}

async function startNativeCore(context, onebotListenHost, rendererToken) {
  await fs.mkdir(path.dirname(context.coreLog), { recursive: true, mode: 0o700 });
  const log = await fs.open(context.coreLog, "a", 0o600);
  const command = context.dev ? "npm" : process.execPath;
  const args = context.dev ? ["run", "dev"] : [context.apiEntry];
  const entry = context.dev ? "npm run dev" : context.apiEntry;
  const child = spawn(command, args, {
    cwd: context.root,
    detached: true,
    stdio: rendererToken
      ? ["ignore", log.fd, log.fd, "pipe"]
      : ["ignore", log.fd, log.fd],
    env: nativeCoreEnvironment(context, onebotListenHost, process.platform, Boolean(rendererToken))
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  if (rendererToken) child.stdio[3].end(rendererToken);
  child.unref();
  await log.close();
  let observed;
  try {
    observed = await waitForProcessObservation(child.pid, 3_000);
  } catch (error) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    throw error;
  }
  const record = {
    pid: child.pid,
    signature: observed.signature,
    entry,
    processGroup: child.pid,
    startedAt: new Date().toISOString()
  };
  const state = await readState(context.statePath);
  await writeState(context, {
    ...withoutUpdatedAt(state),
    mode: "native",
    dev: context.dev,
    core: record
  });
  return { running: true, alive: true, pid: child.pid, record };
}

async function startAccountRuntimeDaemon(context) {
  const previous = await readState(context.statePath);
  const current = await inspectAccountRuntime(context, previous?.reconciler);
  if (current.owner.status === "invalid") {
    throw new Error(`账号调和 owner 无效：${current.owner.detail ?? "拒绝覆盖。"}`);
  }
  if (current.processes.length > 1) {
    throw new Error(`workspace ${context.identity} 存在 ${current.processes.length} 个账号调和 daemon，检测到 split-brain。`);
  }
  if (current.stateAlive && !current.stateMatches) {
    throw new Error(`账号调和 PID ${previous.reconciler.pid} 已被其他进程复用；拒绝覆盖或终止该进程。`);
  }
  if (current.processes.length === 1) {
    if (current.owner.status !== "running" || current.owner.record.pid !== current.processes[0].pid) {
      throw new Error("检测到未登记或缺少可信 owner 的账号调和 daemon；请执行 ./sunabot.sh down 后重试。");
    }
    const state = await readState(context.statePath);
    await writeState(context, { ...withoutUpdatedAt(state), reconciler: current.owner.record });
    return current.owner.record;
  }
  if (current.owner.status === "running") {
    throw new Error("账号调和 owner 声明运行，但进程清单中没有匹配实例。");
  }
  if (current.owner.status === "stale") {
    await removeStaleAccountRuntimeOwner({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry: accountRuntimeDaemonEntry(context)
    });
  }
  await fs.mkdir(path.dirname(context.reconcilerLog), { recursive: true, mode: 0o700 });
  const log = await fs.open(context.reconcilerLog, "a", 0o600);
  const entry = accountRuntimeDaemonEntry(context);
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [
    entry,
    `--workspace-id=${context.identity}`,
    `--owner-token=${ownerToken}`
  ], {
    cwd: context.root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...nativeProcessEnvironment(context), SUNABOT_WORKSPACE: context.workspace }
  });
  let childExit;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
      resolve(childExit);
    });
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  await log.close();
  const deadline = Date.now() + 3_000;
  try {
    while (Date.now() < deadline) {
      const owner = await inspectAccountRuntimeOwner({
        workspace: context.workspace,
        workspaceId: context.identity,
        entry
      });
      if (owner.status === "invalid") {
        if (childExit) {
          await delay(50);
        } else {
          await Promise.race([delay(50), exited]);
        }
        continue;
      }
      if (owner.status === "running") {
        const processes = await listAccountRuntimeProcesses({
          workspace: context.workspace,
          workspaceId: context.identity,
          entry
        });
        if (processes.length > 1) {
          throw new Error(`workspace ${context.identity} 存在 ${processes.length} 个账号调和 daemon，检测到 split-brain。`);
        }
        if (processes.length === 1 && processes[0].pid === owner.record.pid) {
          const state = await readState(context.statePath);
          await writeState(context, { ...withoutUpdatedAt(state), reconciler: owner.record });
          return owner.record;
        }
      }
      if (childExit && owner.status === "missing") {
        throw new Error(`账号调和 daemon 启动失败（${childExit.signal ?? childExit.code ?? "unknown"}）。`);
      }
      await Promise.race([delay(50), exited]);
    }
    throw new Error("账号调和 daemon 未在时限内取得 workspace owner。 ");
  } catch (error) {
    const spawned = await listAccountRuntimeProcesses({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry
    }).catch(() => []);
    const owned = spawned.filter((item) => item.ownerToken === ownerToken);
    if (owned.length > 0) {
      await stopAccountRuntimeProcesses({
        workspace: context.workspace,
        workspaceId: context.identity,
        entry,
        processes: owned,
        timeoutMs: 1_000
      }).catch(() => {});
    }
    throw error;
  }
}

async function stopNativeCore(context, record, options = {}) {
  const observed = await observeProcess(record?.pid);
  if (!processSignatureMatches(record, observed)) {
    throw new Error(`PID ${record?.pid ?? "unknown"} 与 launcher 启动记录不匹配；未发送停止信号。`);
  }
  process.kill(-record.processGroup, "SIGTERM");
  const deadline = Date.now() + context.contract.shutdownTimeoutSeconds * 1_000;
  while (Date.now() < deadline && await processAlive(record.pid)) await delay(200);
  if (await processAlive(record.pid)) {
    const current = await observeProcess(record.pid);
    if (!processSignatureMatches(record, current)) {
      throw new Error(`PID ${record.pid} 在停止期间发生变化；未发送 SIGKILL。`);
    }
    process.kill(-record.processGroup, "SIGKILL");
  }
  if (options.removeState) await fs.rm(context.statePath, { force: true });
}

async function inspectRuntime(context, options = {}) {
  const state = await readState(context.statePath);
  let native = { running: false, alive: false, pid: state?.core?.pid, record: state?.core };
  if (state?.core?.pid) {
    const observed = await observeProcess(state.core.pid);
    native = {
      running: processSignatureMatches(state.core, observed),
      alive: Boolean(observed),
      pid: state.core.pid,
      record: state.core
    };
  }
  const [
    reconciler,
    containers,
    legacyContainers,
    nativeProcessGroups,
    nativeWebfetchRendererGroups
  ] = await Promise.all([
    inspectAccountRuntime(context, state?.reconciler),
    labeledContainers(context, { includeOneoffs: options.includeOneoffs === true }),
    findLegacyContainers(context),
    listNativeCoreProcessGroups({ root: context.root, workspace: context.workspace }),
    listNativeWebfetchRendererProcessGroups({ workspaceId: context.identity })
  ]);
  const napcat = componentStatus(containers, "napcat");
  const foreignProjects = [...new Set(containers
    .map((item) => item.project)
    .filter((project) => project && project !== context.project && !project.startsWith(`${context.project}-napcat-`)))];
  return {
    state,
    native,
    nativeProcessGroups,
    nativeWebfetchRendererGroups,
    reconciler,
    containers,
    legacyContainers,
    napcat,
    foreignProjects
  };
}

async function inspectAccountRuntime(context, stateRecord) {
  const entry = accountRuntimeDaemonEntry(context);
  const [owner, processes, stateObserved] = await Promise.all([
    inspectAccountRuntimeOwner({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry
    }),
    listAccountRuntimeProcesses({
      workspace: context.workspace,
      workspaceId: context.identity,
      entry
    }),
    stateRecord?.pid ? observeProcess(stateRecord.pid) : Promise.resolve(null)
  ]);
  const stateMatches = processSignatureMatches(stateRecord, stateObserved);
  const healthy = Boolean(
    owner.status === "running"
    && stateMatches
    && stateRecord.pid === owner.record.pid
    && processes.length === 1
    && processes[0].pid === owner.record.pid
    && processes[0].safeToSignal
  );
  return {
    healthy,
    running: healthy,
    alive: Boolean(stateObserved),
    pid: stateRecord?.pid,
    record: stateRecord,
    stateAlive: Boolean(stateObserved),
    stateMatches,
    stateObserved,
    owner,
    processes
  };
}

export function accountRuntimeConflicts(reconciler, context = {}) {
  const action = "./sunabot.sh down";
  const conflicts = [];
  if (reconciler.processes.length > 1) {
    conflicts.push({
      id: "account-reconciler-split-brain",
      code: "ACCOUNT_RECONCILER_SPLIT_BRAIN",
      action,
      detail: `同一 workspace 检测到 ${reconciler.processes.length} 个账号调和 daemon：${reconciler.processes.map((item) => item.pid).join(", ")}`
    });
  }
  if (reconciler.owner.status === "invalid") {
    conflicts.push({
      id: "account-reconciler-owner",
      code: "ACCOUNT_RECONCILER_OWNER_INVALID",
      path: reconciler.owner.ownerPath,
      action: "检查 owner 文件并确认对应进程身份",
      detail: reconciler.owner.detail ?? "owner 记录无效"
    });
  } else if (reconciler.owner.status === "stale") {
    conflicts.push({
      id: "account-reconciler-owner",
      code: "ACCOUNT_RECONCILER_OWNER_STALE",
      path: reconciler.owner.ownerPath,
      action,
      detail: `owner PID ${reconciler.owner.record.pid} 已停止`
    });
  }
  if (reconciler.stateAlive && !reconciler.stateMatches) {
    conflicts.push({
      id: "account-reconciler-state-pid",
      code: "ACCOUNT_RECONCILER_PID_REUSED",
      path: context.statePath,
      action,
      detail: `launcher-state PID ${reconciler.pid} 已被其他进程复用；不会向该 PID 发信号`
    });
  }
  if (reconciler.processes.some((item) => !item.safeToSignal)) {
    conflicts.push({
      id: "account-reconciler-process-identity",
      code: "ACCOUNT_RECONCILER_PROCESS_IDENTITY_INVALID",
      action: "检查同 workspace 的账号调和进程",
      detail: "至少一个账号调和进程缺少可验证的 workspace 或独立进程组身份"
    });
  }
  if (reconciler.processes.length === 1 && !reconciler.healthy) {
    const process = reconciler.processes[0];
    conflicts.push({
      id: "account-reconciler-unregistered",
      code: "ACCOUNT_RECONCILER_UNREGISTERED",
      path: context.statePath,
      action,
      detail: `PID ${process.pid} 未同时绑定有效 owner 与 launcher state`
    });
  }
  return conflicts;
}

function accountRuntimeDaemonEntry(context) {
  return path.join(context.root, "tooling/runtime/account-runtime-daemon.mjs");
}

function withoutUpdatedAt(state) {
  if (!state) return {};
  const { updatedAt: _updatedAt, ...rest } = state;
  return rest;
}

async function labeledContainers(context, options = {}) {
  if (!await dockerAvailable(context)) return [];
  const format = [
    '{{.ID}}',
    '{{.Label "io.sunabot.component"}}',
    '{{.State}}',
    '{{.Label "com.docker.compose.project"}}',
    '{{.Label "io.sunabot.account-id"}}',
    '{{.Label "com.docker.compose.oneoff"}}',
    '{{.Names}}',
    '{{.Label "io.sunabot.runtime-id"}}',
    '{{.Label "io.sunabot.workspace-id"}}'
  ].join("\t");
  const output = await dockerCommand(context, [
    "ps", "-a",
    "--filter", `label=io.sunabot.workspace-id=${context.identity}`,
    "--format", format
  ], { capture: true });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [
      id, component, state, project, accountId, oneoff,
      name, runtimeId, workspaceId
    ] = line.split("\t");
    const item = {
      id,
      component,
      state: state?.toLowerCase(),
      project,
      accountId,
      oneoff,
      name,
      runtimeId,
      workspaceId
    };
    return item;
  }).filter((item) => options.includeOneoffs === true || item.oneoff?.toLowerCase() !== "true");
}

async function runtimeNetworkWorkspaceId(context) {
  const network = `${context.project}-runtime`;
  const format = [
    "{{.Name}}",
    '{{.Label "io.sunabot.workspace-id"}}'
  ].join("\t");
  const output = await dockerCommand(context, ["network", "ls", "--format", format], { capture: true });
  const match = output.split(/\r?\n/u)
    .map((line) => line.split("\t"))
    .find(([name]) => name === network);
  return match ? String(match[1] ?? "") : null;
}

async function runtimeNetworkExists(context) {
  return await runtimeNetworkWorkspaceId(context) !== null;
}

async function removeRuntimeNetwork(context) {
  const workspaceId = await runtimeNetworkWorkspaceId(context);
  if (workspaceId == null) return;
  if (workspaceId !== context.identity) {
    throw runtimeError(
      "DOCKER_NETWORK_IDENTITY_INVALID",
      `Docker 网络 ${context.project}-runtime 缺少当前 workspace 身份；未删除。`
    );
  }
  await dockerCommand(context, ["network", "rm", `${context.project}-runtime`]);
}

async function findLegacyContainers(context) {
  if (!await dockerAvailable(context)) return [];
  const format = [
    '{{.ID}}',
    '{{.Names}}',
    '{{.State}}',
    '{{.Label "com.docker.compose.service"}}'
  ].join("\t");
  const output = await dockerCommand(context, ["ps", "-a", "--format", format], { capture: true });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, name, state, service] = line.split("\t");
    return { id, name, state: state?.toLowerCase(), service };
  }).filter((item) => item.name === "sunabot-qq-runtime" || item.service === "qq-runtime");
}

function componentStatus(containers, component) {
  const matches = containers.filter((item) => item.component === component);
  return { running: matches.some((item) => item.state === "running"), matches };
}

function assertExpectedProject(context, runtime) {
  const runningLegacy = runtime.legacyContainers.filter((item) => item.state === "running");
  if (runningLegacy.length > 0) {
    throw new Error(`检测到旧 one-container runtime：${runningLegacy.map((item) => item.name).join(", ")}；请按迁移备忘录停止旧容器。`);
  }
}

async function assertComposeServices(context) {
  if (!(await exists(context.contract.composeFile))) {
    throw new Error(`Compose 文件不存在：${context.contract.composeFile}`);
  }
  const output = await compose(context, ["config", "--services"], { capture: true });
  const services = new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  if (services.size !== 1 || !services.has(context.contract.napcatService)) {
    throw new Error("NapCat Compose 只能声明 napcat service。");
  }
}

async function compose(context, args, options = {}) {
  return command("docker", composeArgs(context, args), {
    capture: options.capture,
    timeoutMs: options.timeoutMs,
    cwd: context.root,
    env: composeEnvironment(context)
  });
}

async function napcatCompose(context, account, args, options = {}) {
  const project = `${context.project}-napcat-${account.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  return command("docker", composeArgs(context, args, project), {
    capture: options.capture,
    timeoutMs: options.timeoutMs,
    cwd: context.root,
    env: {
      ...composeEnvironment(context, project),
      NAPCAT_ACCOUNT_ID: account.id,
      NAPCAT_ACCOUNT: account.qqId ?? "",
      NAPCAT_WEBUI_PORT: String(account.webuiPort)
    }
  });
}

function composeArgs(context, args, project = context.project) {
  return [
    "compose",
    "--project-name", project,
    "--env-file", context.runtimeEnv,
    "--project-directory", context.root,
    "-f", context.contract.composeFile,
    ...args
  ];
}

function composeEnvironment(context, project = context.project) {
  return {
    ...context.environment,
    ...context.runtimeEnvironment,
    ...context.composeOverrides,
    COMPOSE_PROJECT_NAME: project,
    SUNABOT_COMPOSE_PROJECT: project,
    NAPCAT_IMAGE: context.contract.napcatImage,
    SUNABOT_NAPCAT_NETWORK: `${context.project}-runtime`,
    SUNABOT_RUNTIME_ID: context.contract.runtimeId,
    SUNABOT_RUNTIME_UID: String(process.getuid?.() ?? 1000),
    SUNABOT_RUNTIME_GID: String(process.getgid?.() ?? 1000),
    SUNABOT_PROJECT_ROOT: context.root,
    SUNABOT_WORKSPACE: context.workspace,
    SUNABOT_WORKSPACE_ID: context.identity,
    SUNABOT_RUNTIME_ENV: context.runtimeEnv
  };
}

function nativeProcessEnvironment(context) {
  return {
    ...context.environment,
    ...context.runtimeEnvironment
  };
}

export function nativeCoreEnvironment(
  context,
  onebotListenHost,
  platform = process.platform,
  rendererTokenFd = false
) {
  const environment = {
    ...nativeProcessEnvironment(context),
    NODE_ENV: context.dev ? "development" : "production",
    SUNABOT_RUNTIME_MODE: platform === "darwin" ? "macos" : "linux-native",
    SUNABOT_RUNTIME_ID: context.contract.runtimeId,
    SUNABOT_WORKSPACE: context.workspace,
    SUNABOT_WORKSPACE_ID: context.identity,
    SUNABOT_HOST: context.contract.adminHost,
    SUNABOT_PORT: String(context.contract.adminPort),
    SUNABOT_ONEBOT_HOST: onebotListenHost,
    SUNABOT_ONEBOT_PORT: String(context.contract.onebotPort),
    SUNABOT_BWRAP_EXECUTABLE: bubblewrapExecutable(context),
    SUNABOT_PACKAGED_RELEASE: context.packaged ? "1" : "0",
    SUNABOT_WEBFETCH_RENDERER_URL: `http://127.0.0.1:${context.contract.webfetchRendererPort}`
  };
  if (rendererTokenFd) environment.SUNABOT_WEBFETCH_RENDERER_TOKEN_FD = "3";
  else delete environment.SUNABOT_WEBFETCH_RENDERER_TOKEN_FD;
  delete environment.SUNABOT_DOCKER_SOCKET;
  return environment;
}

async function readRuntimeEnvironment(filePath) {
  try {
    return dotenv.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function ensureNativeDependencies(context) {
  const marker = path.join(context.root, "node_modules/.package-lock.json");
  const lock = path.join(context.root, "package-lock.json");
  if (context.packaged) {
    if (!await exists(marker)) throw new Error("RELEASE_DEPENDENCIES_MISSING");
  } else if (!(await exists(marker)) || await newerThan(lock, marker)) {
    await command("npm", ["ci"], { cwd: context.root, timeoutMs: BUILD_COMMAND_TIMEOUT_MS });
  }
  const capabilities = await inspectNativeCapabilities(context);
  if (!capabilities.codexCli.ok) throw new Error(`Native Codex CLI 不可用：${capabilities.codexCli.detail}`);
  if (process.platform === "linux" && !capabilities.workspaceBash.ok) {
    throw runtimeError(
      capabilities.workspaceBash.code ?? "BUBBLEWRAP_NAMESPACE_UNAVAILABLE",
      `Bubblewrap namespace 隔离不可用：${capabilities.workspaceBash.detail}`
    );
  }
}

async function inspectNativeCapabilities(context) {
  const codex = await inspectNativeCodex(context);
  let workspaceBash;
  try {
    if (process.platform === "linux") {
      await command(bubblewrapExecutable(context), bubblewrapProbeArguments(context.workspace, true), { capture: true });
      workspaceBash = { ok: true, detail: "bubblewrap namespace probe passed" };
    } else if (process.platform === "darwin") {
      await fs.access("/bin/bash", fs.constants.X_OK);
      workspaceBash = { ok: true, detail: "approved administrator host Bash available" };
    } else {
      throw new Error(`unsupported platform ${process.platform}`);
    }
  } catch (error) {
    workspaceBash = {
      ok: false,
      code: process.platform === "linux" ? "BUBBLEWRAP_NAMESPACE_UNAVAILABLE" : "HOST_BASH_UNAVAILABLE",
      action: process.platform === "linux"
        ? "确认包内 Bubblewrap 运行库完整且内核允许 user namespace"
        : "确认 /bin/bash 可执行",
      detail: message(error)
    };
  }
  return {
    workspaceBash,
    codexCli: codex.cli,
    codexAuth: codex.auth
  };
}

async function inspectNativeCodex(context) {
  const configured = context.runtimeEnvironment.SUNABOT_CODEX_EXECUTABLE?.trim();
  const executable = configured || path.resolve(context.root, context.contract.codexCli.executable);
  const codexHome = path.join(context.workspace, path.dirname(context.contract.codexCli.authFile));
  const environment = { ...nativeProcessEnvironment(context), CODEX_HOME: codexHome };
  let version;
  try {
    version = (await command(executable, ["--version"], { capture: true, env: environment })).trim();
  } catch (error) {
    const detail = message(error);
    return { cli: { ok: false, detail }, auth: { ok: false, detail: "Codex CLI 不可用。" } };
  }
  const cli = codexVersionCheck(context, version, executable);
  if (!cli.ok) return { cli, auth: { ok: false, detail: "Codex CLI 版本不匹配。" } };
  try {
    await command(executable, ["login", "status"], {
      capture: true,
      cwd: codexHome,
      env: environment
    });
    return { cli, auth: { ok: true, detail: codexHome } };
  } catch (error) {
    return { cli, auth: { ok: false, detail: message(error) } };
  }
}

function codexVersionCheck(context, version, executable) {
  const expected = `codex-cli ${context.contract.codexCli.version}`;
  return version === expected
    ? { ok: true, detail: `${executable} (${version})` }
    : { ok: false, detail: `需要 ${expected}，当前为 ${version || "unknown"}` };
}

function assertNonRootRuntimeUser() {
  if ((process.getuid?.() ?? 1) === 0) {
    throw new Error("拒绝以 root 启动 Sunabot；请使用拥有 workspace 的专用非 root 用户运行 ./sunabot.sh。");
  }
}

async function ensureNativeBuild(context) {
  const outputs = [context.apiEntry, context.webEntry];
  const present = await Promise.all(outputs.map(exists));
  if (context.packaged) {
    if (present.some((value) => !value)) throw new Error("RELEASE_BUILD_OUTPUT_MISSING");
    return;
  }
  if (present.some((value) => !value) || await sourcesNewerThan(context.root, outputs)) {
    await command("npm", ["run", "build"], { cwd: context.root, timeoutMs: BUILD_COMMAND_TIMEOUT_MS });
  }
}

async function sourcesNewerThan(projectRoot, outputs) {
  const outputTimes = await Promise.all(outputs.map((filePath) => fs.stat(filePath).then((stat) => stat.mtimeMs)));
  const cutoff = Math.min(...outputTimes);
  const sources = ["apps/api", "apps/admin-web/src", "adapters", "services", "src", "packages"];
  for (const relative of sources) {
    if (await treeNewerThan(path.join(projectRoot, relative), cutoff)) return true;
  }
  for (const relative of ["package.json", "package-lock.json", "tsconfig.json"]) {
    const stat = await fs.stat(path.join(projectRoot, relative)).catch(() => null);
    if (stat && stat.mtimeMs > cutoff) return true;
  }
  return false;
}

async function treeNewerThan(directory, cutoff) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await treeNewerThan(target, cutoff)) return true;
    } else if (entry.isFile() && (await fs.stat(target)).mtimeMs > cutoff) {
      return true;
    }
  }
  return false;
}

async function clearNapcatLoginQr(context, account) {
  const qrPath = path.join(context.workspace, "runtime/napcat/accounts", account.id, "qrcode.png");
  await fs.rm(qrPath, { force: true });
}

async function writeState(context, partial) {
  const state = {
    schemaVersion: 1,
    runtimeId: context.contract.runtimeId,
    workspace: context.workspace,
    workspaceId: context.identity,
    composeProject: context.project,
    updatedAt: new Date().toISOString(),
    ...partial
  };
  await atomicWrite(context.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

async function readState(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function observeProcess(pid) {
  if (!Number.isInteger(Number(pid)) || !await processAlive(Number(pid))) return null;
  try {
    const [signature, commandLine] = await Promise.all([
      command("ps", ["-p", String(pid), "-o", "lstart="], { capture: true }),
      command("ps", ["-p", String(pid), "-o", "command="], { capture: true })
    ]);
    return { signature: signature.trim(), command: commandLine.trim() };
  } catch {
    return { signature: "", command: "" };
  }
}

async function waitForProcessObservation(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await observeProcess(pid);
    if (observed?.signature) return observed;
    await delay(50);
  }
  throw new Error(`无法确认 Native Core PID ${pid} 的进程身份。`);
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    return false;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpReady(url)) return;
    await delay(250);
  }
  throw new Error(`健康检查超时：${url}`);
}

async function waitForRendererHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readRendererHealth(url);
    if (health?.ok === true) return health;
    await delay(250);
  }
  throw new Error(`WEBFETCH_RENDERER_HEALTH_TIMEOUT:${url}`);
}

function readRendererHealth(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1_500 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4_096) response.destroy();
        else chunks.push(chunk);
      });
      response.once("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(value && typeof value === "object" ? value : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.once("error", () => resolve(null));
  });
}

function httpReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1_500 }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300));
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForRuntimePortsClosed(context, state) {
  const onebotHost = state?.onebotListenHost
    ?? defaultNativeOnebotHealthHost(context.contract.onebotHost);
  const endpoints = [
    { name: "管理 API", host: "127.0.0.1", port: context.contract.adminPort },
    { name: "OneBot", host: onebotHost, port: context.contract.onebotPort }
  ];
  if (state?.dev) endpoints.push({ name: "Vite", host: "127.0.0.1", port: 5173 });
  const deadline = Date.now() + Math.min(context.contract.shutdownTimeoutSeconds * 1_000, 5_000);
  let occupied = [];
  while (Date.now() < deadline) {
    occupied = [];
    for (const endpoint of endpoints) {
      if (await tcpOpen(endpoint.host, endpoint.port)) occupied.push(endpoint);
    }
    if (occupied.length === 0) return;
    await delay(100);
  }
  const detail = occupied.map((item) => `${item.name} ${item.host}:${item.port}`).join("、");
  throw runtimeError(
    "RUNTIME_PORT_STILL_IN_USE",
    `${detail} 在当前 workspace 清理后仍被占用；拒绝启动新 Core。请检查占用进程后重试。`
  );
}

async function assertDockerAvailable(context) {
  if (await dockerAvailable(context)) return;
  throw new Error("NAPCAT_DOCKER_UNAVAILABLE：NapCat 需要本机 Docker Engine 与 Compose 插件。");
}

async function dockerAvailable(context) {
  try {
    await dockerCommand(context, ["info", "--format", "{{.ServerVersion}}"], {
      capture: true,
      timeoutMs: DOCKER_CONTROL_TIMEOUT_MS
    });
    return true;
  } catch {
    return false;
  }
}

function dockerCommand(context, args, options = {}) {
  return command("docker", args, {
    ...options,
    env: options.env ?? nativeProcessEnvironment(context)
  });
}

export function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const output = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let timeout;
    let forceKill;
    let terminalError;
    const timeoutMs = commandTimeoutMs(executable, args, options.timeoutMs);
    const terminateGraceMs = positiveTimeout(options.terminateGraceMs, COMMAND_TERMINATE_GRACE_MS);
    const maxOutputBytes = positiveTimeout(options.maxOutputBytes, DEFAULT_COMMAND_OUTPUT_BYTES);
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      callback();
    };
    const terminate = (error) => {
      if (terminating || settled) return;
      terminating = true;
      terminalError = error;
      try { child.kill("SIGTERM"); } catch {}
      forceKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        child.stdin?.destroy?.();
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
        finish(() => reject(terminalError));
      }, terminateGraceMs);
      forceKill.unref?.();
    };
    if (options.capture) {
      const collect = (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > maxOutputBytes) {
          terminate(runtimeError("COMMAND_OUTPUT_LIMIT", `${executable} 输出超过 ${maxOutputBytes} bytes。`));
          return;
        }
        output.push(buffer);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
    }
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        terminate(runtimeError(
          "COMMAND_TIMEOUT",
          `${executable} ${args.slice(0, 4).join(" ")} 超过 ${timeoutMs}ms 未结束。`
        ));
      }, timeoutMs);
      timeout.unref?.();
    }
    child.once("error", (error) => finish(() => reject(terminalError ?? error)));
    child.once("exit", (code, signal) => {
      const text = Buffer.concat(output).toString("utf8");
      finish(() => {
        if (terminalError) reject(terminalError);
        else if (code === 0) resolve(text);
        else reject(new Error(`${executable} ${args.slice(0, 4).join(" ")} 失败（${signal || code}）${text ? `：${text.trim()}` : ""}`));
      });
    });
  });
}

export function commandTimeoutMs(executable, args, explicitTimeoutMs) {
  if (Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) return Math.floor(explicitTimeoutMs);
  if (path.basename(executable) !== "docker") return DEFAULT_COMMAND_TIMEOUT_MS;
  if (args[0] === "compose") {
    if (args.includes("build") || args.includes("--build")) return BUILD_COMMAND_TIMEOUT_MS;
    return DOCKER_COMPOSE_TIMEOUT_MS;
  }
  if (args[0] === "run" || args[0] === "exec") return DOCKER_EXEC_TIMEOUT_MS;
  return DOCKER_CONTROL_TIMEOUT_MS;
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function commandSucceeds(executable, args, options = {}) {
  try {
    await command(executable, args, { ...options, capture: true });
    return true;
  } catch {
    return false;
  }
}

async function followChildren(children) {
  if (children.length === 0) return;
  const stop = () => children.forEach((child) => child.kill("SIGTERM"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  })));
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

async function atomicJsonIfChanged(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const current = await fs.readFile(filePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (current === content) return false;
  await atomicWrite(filePath, content, 0o600);
  return true;
}

async function atomicTextIfChanged(filePath, content, mode) {
  const current = await fs.readFile(filePath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (current === content && await exists(filePath)) return false;
  await atomicWrite(filePath, content, mode);
  return true;
}

async function atomicWrite(filePath, content, mode) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, content, { encoding: "utf8", mode });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, mode);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonOr(filePath, fallback) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function newerThan(left, right) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  return leftStat.mtimeMs > rightStat.mtimeMs;
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function runtimeError(code, detail) {
  const error = new Error(`${code}：${detail}`);
  error.code = code;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (direct) {
  await runLauncher().catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
