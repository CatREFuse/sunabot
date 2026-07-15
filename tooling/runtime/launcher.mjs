#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import { installGlobalProxyDispatcher, resolveProxyConfiguration } from "../../packages/platform/proxy.mjs";
import { validateMultiAgentWorkspacePath } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import { recoverStaleDockerOneoffs } from "./docker-recovery.mjs";
import { buildRuntimeProbe, collectWorkspaceProbeFacts } from "./probe.mjs";
import { accountRuntimeState, planAccountReconciliation } from "./account-reconciler.mjs";
import {
  beginFirstRunBootstrap,
  rollbackFirstRunBootstrap
} from "./first-run-state.mjs";
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

export async function runLauncher(argv = process.argv.slice(2), environment = process.env) {
  const parsed = parseLauncherArguments(argv, environment);
  const rawContract = await readJson(path.join(root, "deploy/runtime-contract.json"));
  const workspace = resolveWorkspace(root);
  if (!new Set(["help", "bootstrap"]).has(parsed.command)) {
    await validateMultiAgentWorkspacePath(workspace);
  }
  const wsl = isWslRuntime({ platform: process.platform, environment });
  const mode = resolveCoreMode(parsed.requestedMode, { platform: process.platform });
  if (parsed.dev && mode !== "native") {
    throw new Error("--dev 仅支持 Native Core；Docker Core 使用生产构建。");
  }
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
    webEntry: path.join(root, "apps/admin-web/dist/index.html")
  };
  context.runtimeEnvironment = await readRuntimeEnvironment(context.runtimeEnv);
  context.composeOverrides = {};
  await installGlobalProxyDispatcher({
    env: nativeProcessEnvironment(context),
    platform: process.platform
  });

  switch (parsed.command) {
    case "up":
      await up(context);
      break;
    case "down":
      await down(context);
      break;
    case "restart":
      await down(context);
      await up(context);
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
      console.log("运行依赖已准备。");
      break;
    case "reconcile-account":
      await reconcileAccount(context, parsed.accountId);
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

async function up(context) {
  if (databasePathOverrideConfigured(context.environment, context.runtimeEnvironment)) {
    throw new Error("SUNABOT_DATABASE_PATH 已停止支持；主库固定为 workspace/business/data/sunabot.sqlite。");
  }
  assertNonRootRuntimeUser();
  await assertDockerAvailable();
  await recoverStaleDockerOneoffs({
    identity: context.identity,
    runCommand: command
  });
  const initial = await inspectRuntime(context);
  assertExpectedProject(context, initial);
  await initializeWorkspace(context);
  await beginFirstRunBootstrap(context.workspace);
  const secrets = await prepareSecrets(context);
  await ensureAdminCredentials(context);
  await assertComposeServices(context);
  await ensureRuntimeNetwork(context);
  const before = await inspectRuntime(context);
  assertExpectedProject(context, before);

  if (context.mode === "native") {
    if (before.dockerCore.running) {
      throw new Error(`workspace ${context.identity} 已由 Docker Core 使用；请先执行 ./sunabot.sh down。`);
    }
  } else {
    if (before.native.running) {
      throw new Error(`workspace ${context.identity} 已由 Native Core 使用（PID ${before.native.pid}）；请先执行 ./sunabot.sh down。`);
    }
  }
  let baseline = before;
  if (before.state || before.native.running || before.containers.length > 0) {
    await down(context);
    baseline = await inspectRuntime(context);
  }
  if (context.mode === "native") await upNative(context, baseline, secrets.values);
  else await upDocker(context, baseline, secrets.values);
  try {
    await startAccountRuntimeDaemon(context);
  } catch (error) {
    await down(context).catch(() => {});
    throw error;
  }
  await printStatus(context);
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
  await compose(context, ["build", context.contract.napcatService]);
  const onebotListenHost = await resolveNativeOnebotListenHost(context);
  if (await tcpOpen(onebotListenHost, context.contract.onebotPort)) {
    throw new Error(`${onebotListenHost}:${context.contract.onebotPort} 已被非当前 launcher 管理的进程占用。`);
  }
  try {
    native = await startNativeCore(context, onebotListenHost);
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
    await compose(context, ["--profile", context.contract.coreProfile, "down", "--remove-orphans"]).catch(() => {});
    await stopNativeCore(context, native.record, { removeState: true }).catch(() => {});
    throw error;
  }
}

async function upDocker(context, before, secrets) {
  if (!before.dockerCore.running && await tcpOpen("127.0.0.1", context.contract.adminPort)) {
    throw new Error(`127.0.0.1:${context.contract.adminPort} 已被非当前 Docker Core 占用。`);
  }
  try {
    await prepareWslDockerProxy(context);
    await compose(context, [
      "--profile",
      context.contract.coreProfile,
      "up",
      "-d",
      "--build",
      context.contract.coreService
    ]);
    await waitForHttp(
      `http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`,
      context.contract.coreReadyTimeoutSeconds * 1_000
    );
    await waitForComponentHealth(context, "core", context.contract.coreReadyTimeoutSeconds * 1_000);
    await assertDockerCoreBwrap(context);
    await assertDockerCoreCodex(context);
    const accounts = await loadNapcatAccounts(context);
    await startNapcatAccounts(context, accounts, context.contract.dockerReverseWebSocket, secrets);
    await writeState(context, {
      mode: "docker",
      dev: false,
      reverseWebSocket: context.contract.dockerReverseWebSocket,
      accounts: accounts.map(({ id, webuiPort }) => ({ id, webuiPort }))
    });
  } catch (error) {
    await stopNapcatContainers(context).catch(() => {});
    await compose(context, ["--profile", context.contract.coreProfile, "down", "--remove-orphans"]).catch(() => {});
    await fs.rm(context.statePath, { force: true });
    throw error;
  }
}

async function down(context) {
  await assertDockerAvailable();
  await recoverStaleDockerOneoffs({
    identity: context.identity,
    runCommand: command
  });
  const runtime = await inspectRuntime(context);
  if (runtime.foreignProjects.length > 0) {
    throw new Error(`workspace ${context.identity} 已被其他 Compose project 使用：${runtime.foreignProjects.join(", ")}。`);
  }
  if (runtime.native.running && runtime.dockerCore.running) {
    throw new Error(`workspace ${context.identity} 同时存在 Native 与 Docker Core，检测到 split-brain。`);
  }
  if (runtime.native.alive && !runtime.native.running) {
    throw new Error(`Native PID ${runtime.native.pid} 与 launcher 记录不匹配；未发送停止信号。`);
  }
  if (runtime.reconciler.alive && !runtime.reconciler.running) {
    throw new Error(`账号调和 PID ${runtime.reconciler.pid} 与 launcher 记录不匹配；未发送停止信号。`);
  }
  if (runtime.reconciler.running) await stopAccountRuntimeDaemon(context, runtime.reconciler.record);
  if (runtime.napcat.matches.length > 0) {
    for (const container of runtime.napcat.matches) {
      await command("docker", ["stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), container.id]).catch(() => {});
      await command("docker", ["rm", container.id]).catch(() => {});
    }
  }
  if (runtime.native.running) {
    await stopNativeCore(context, runtime.state.core, { removeState: false });
  } else if (runtime.dockerCore.matches.length > 0) {
    await compose(context, ["--profile", context.contract.coreProfile, "stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), context.contract.coreService]);
  }
  if (runtime.containers.length > 0) {
    await compose(context, ["--profile", context.contract.coreProfile, "down", "--remove-orphans"]);
  }
  await cleanupRemovedNapcatAccounts(context);
  await fs.rm(context.statePath, { force: true });
  console.log("Sunabot Core 与 NapCat 已停止。");
}

async function printStatus(context) {
  const report = buildRuntimeProbe(await collectRuntimeProbeFacts(context));
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

async function doctor(context) {
  const report = buildRuntimeProbe(await collectRuntimeProbeFacts(context));
  console.log(JSON.stringify(report, null, 2));
  if (report.checks.some((item) => item.status === "fail")) process.exitCode = 1;
}

async function collectRuntimeProbeFacts(context) {
  const runtime = await inspectRuntime(context);
  const apiPath = `http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`;
  const onebotHealthHost = runtime.state?.onebotListenHost
    ?? (context.contract.onebotHost === "docker-network-gateway" ? "127.0.0.1" : context.contract.onebotHost);
  const onebotPath = `http://${onebotHealthHost}:${context.contract.onebotPort}${context.contract.onebotHealthPath}`;
  const apiReady = await httpReady(apiPath);
  let dockerCoreHealthy = false;
  if (runtime.dockerCore.matches.length > 0) {
    dockerCoreHealthy = await componentHealthStatus(runtime.dockerCore.matches[0].id)
      .then((status) => status === "healthy")
      .catch(() => false);
  }
  const onebotReady = runtime.native.running ? await httpReady(onebotPath) : dockerCoreHealthy;
  const conflicts = [];

  const docker = await dockerAvailable();
  const compose = docker && await commandSucceeds("docker", ["compose", "version"]);
  const capabilities = {};
  capabilities.accountReconciler = {
    ok: runtime.reconciler.running,
    path: context.statePath,
    detail: runtime.reconciler.running ? `PID ${runtime.reconciler.pid}` : "host reconciler is not running"
  };
  if (context.mode === "native") {
    const native = await inspectNativeCapabilities(context);
    Object.assign(capabilities, {
      codexCli: native.codexCli,
      codexAuth: native.codexAuth,
      libreOffice: native.libreOffice,
      workspaceBash: native.workspaceBash
    });
  } else if (runtime.dockerCore.running) {
    const codex = await inspectDockerCodex(context);
    let workspaceBash;
    try {
      await assertDockerCoreBwrap(context);
      workspaceBash = { ok: true, detail: "bubblewrap namespace probe passed" };
    } catch (error) {
      workspaceBash = { ok: false, detail: message(error) };
    }
    Object.assign(capabilities, {
      codexCli: codex.cli,
      codexAuth: codex.auth,
      libreOffice: { ok: true, detail: "Docker Core image" },
      workspaceBash
    });
  }

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
  if (runtime.native.running && runtime.dockerCore.running) {
    conflicts.push({
      id: "core-split-brain",
      code: "CORE_SPLIT_BRAIN",
      action: "./sunabot.sh down",
      detail: "Native Core 与 Docker Core 同时运行"
    });
  }
  if (!runtime.native.running && !runtime.dockerCore.running && apiReady) {
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
    accountObservations,
    conflicts
  });

  return {
    ...workspaceFacts,
    core: {
      mode: runtime.native.running ? "native" : runtime.dockerCore.running ? "docker" : "stopped",
      running: runtime.native.running || runtime.dockerCore.running,
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
    capabilities: { ...workspaceFacts.capabilities, ...capabilities }
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
  console.log("用法：./sunabot.sh <up|down|restart|status|doctor|logs|bootstrap|help> [--core=auto|native|docker] [--dev]");
}

async function logs(context) {
  const runtime = await inspectRuntime(context);
  if (!runtime.native.running && !runtime.dockerCore.running && !runtime.napcat.running) {
    throw new Error("Sunabot 尚未运行。");
  }
  const children = [];
  if (runtime.native.running && await exists(context.coreLog)) {
    children.push(spawn("tail", ["-n", "120", "-F", context.coreLog], { stdio: "inherit" }));
  }
  if (runtime.containers.length > 0) {
    const services = [
      ...(runtime.dockerCore.running ? [context.contract.coreService] : [])
    ];
    if (services.length) children.push(spawnCompose(context, ["--profile", context.contract.coreProfile, "logs", "-f", ...services]));
    for (const container of runtime.napcat.matches.filter((item) => item.state === "running")) {
      children.push(spawn("docker", ["logs", "-f", "--tail", "120", container.id], { stdio: "inherit" }));
    }
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
  const username = process.env.SUNABOT_ADMIN_USERNAME?.trim() || "admin";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(username)) {
    throw new Error("SUNABOT_ADMIN_USERNAME 只能包含字母、数字、点、下划线和短横线。");
  }
  if (!process.stdin.isTTY) {
    throw new Error(`管理员凭据不存在；请执行 npm run admin:set-password -- ${username}`);
  }
  console.log(`首次启动需要设置管理员账号 ${username}。`);
  await command(process.execPath, [
    path.join(context.root, "tooling/admin/admin-credentials.mjs"),
    username
  ], {
    cwd: context.root,
    env: { ...process.env, SUNABOT_WORKSPACE: context.workspace }
  });
}

async function startNapcatAccounts(context, accounts, reverseWebSocket, secrets) {
  for (const account of accounts) {
    await configureNapcat(context, reverseWebSocket, secrets, account);
    await clearNapcatLoginQr(context, account);
    await napcatCompose(context, account, ["up", "-d", "--build", context.contract.napcatService]);
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

async function reconcileAccount(context, accountId) {
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
    containers: runtime.napcat.matches
  });
  const accountRoot = path.join(context.workspace, "runtime/napcat/accounts", accountId);

  try {
    await assertDockerAvailable();
    let observedState = plan.observedState;
    if (plan.desiredState === "running") {
      if (!account) throw new Error(`QQ 账号 ${accountId} 未注册。`);
      if (!runtime.native.running && !runtime.dockerCore.running) {
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
      const reverseWebSocket = runtime.native.running
        ? runtime.state?.reverseWebSocket
        : context.contract.dockerReverseWebSocket;
      if (!reverseWebSocket) throw new Error("Native OneBot 地址尚未写入 launcher 状态；请执行 ./sunabot.sh up。");

      const changed = await configureNapcat(context, reverseWebSocket, secrets, account);
      if (plan.action === "start") await clearNapcatLoginQr(context, account);
      if (plan.action === "start" || changed) {
        await napcatCompose(context, account, ["up", "-d", "--build", context.contract.napcatService]);
      }
      await waitForNapcatAccountHealth(
        context,
        account.id,
        context.contract.napcatReadyTimeoutSeconds * 1_000
      );
      observedState = "running";
    } else {
      for (const containerId of plan.targetContainerIds) {
        await command("docker", ["stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), containerId]);
        await command("docker", ["rm", containerId]);
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
    "-e", `SUNABOT_PROBE_HOST=${advertised.hostname}`,
    "-e", `SUNABOT_PROBE_PORT=${context.contract.onebotPort}`,
    "-e", `SUNABOT_PROBE_PATH=${context.contract.onebotHealthPath}`,
    "--entrypoint", "/bin/bash",
    context.contract.napcatService,
    "-ec",
    script
  ], { capture: true });
  const line = output.split(/\r?\n/).reverse()
    .find((value) => value.startsWith("SUNABOT_PROBE_SELECTED="));
  if (!line) throw new Error("NapCat 容器无法访问 Native OneBot /healthz；请检查 Docker host-gateway。 ");
  const host = line.slice("SUNABOT_PROBE_SELECTED=".length).trim();
  return reverseWebSocketWithHost(context.contract.nativeReverseWebSocket, host);
}

async function resolveNativeOnebotListenHost(context) {
  if (context.contract.onebotHost !== "docker-network-gateway") return context.contract.onebotHost;
  const network = `${context.project}-runtime`;
  const gateway = (await command("docker", [
    "network",
    "inspect",
    network,
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}"
  ], { capture: true })).trim();
  if (net.isIP(gateway) !== 4) {
    throw new Error(`无法解析 ${network} 的 IPv4 gateway；拒绝把 OneBot 监听发布到所有宿主接口。`);
  }
  return gateway;
}

async function ensureRuntimeNetwork(context) {
  const network = `${context.project}-runtime`;
  if (await commandSucceeds("docker", ["network", "inspect", network])) return;
  await command("docker", [
    "network", "create",
    "--label", `io.sunabot.runtime-id=${context.contract.runtimeId}`,
    "--label", `io.sunabot.workspace-id=${context.identity}`,
    "--label", "io.sunabot.component=runtime-network",
    network
  ]);
}

async function stopNapcatContainers(context) {
  const containers = (await labeledContainers(context.identity)).filter((item) => item.component === "napcat");
  for (const container of containers) {
    await command("docker", ["stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), container.id]).catch(() => {});
    await command("docker", ["rm", container.id]).catch(() => {});
  }
}

async function cleanupRemovedNapcatAccounts(context) {
  const accountsRoot = path.join(context.workspace, "runtime/napcat/accounts");
  if (!await exists(accountsRoot)) return;
  const entries = await fs.readdir(accountsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const accountRoot = path.join(accountsRoot, entry.name);
    if (!await exists(path.join(accountRoot, ".remove-on-stop"))) continue;
    await fs.rm(accountRoot, { recursive: true, force: true });
  }
}

async function prepareWslDockerProxy(context) {
  if (!context.wsl || context.mode !== "docker") return;
  const proxy = await resolveProxyConfiguration({
    env: nativeProcessEnvironment(context),
    platform: "linux"
  });
  if (proxy.source !== "wsl-host" || !proxy.httpProxy) return;
  context.composeOverrides.SUNABOT_PROXY_MODE = "env";
  context.composeOverrides.SUNABOT_PROXY_DISCOVERED_URL = proxy.httpProxy;
}

async function waitForComponentHealth(context, component, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const containers = await labeledContainers(context.identity);
    const match = containers.find((item) => item.component === component);
    if (match) {
      lastStatus = await componentHealthStatus(match.id).catch(() => "inspect-error");
      if (lastStatus === "healthy") return;
      if (["unhealthy", "exited", "dead"].includes(lastStatus)) {
        throw new Error(`${component} 容器健康检查失败：${lastStatus}`);
      }
    }
    await delay(250);
  }
  throw new Error(`${component} 容器健康检查超时：${lastStatus}`);
}

async function waitForNapcatAccountHealth(context, accountId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const match = (await labeledContainers(context.identity))
      .find((item) => item.component === "napcat" && item.accountId === accountId);
    if (match) {
      lastStatus = await componentHealthStatus(match.id).catch(() => "inspect-error");
      if (lastStatus === "healthy") return;
      if (["unhealthy", "exited", "dead"].includes(lastStatus)) {
        throw new Error(`NapCat ${accountId} 容器健康检查失败：${lastStatus}`);
      }
    }
    await delay(250);
  }
  throw new Error(`NapCat ${accountId} 容器健康检查超时：${lastStatus}`);
}

async function componentHealthStatus(containerId) {
  const output = await command("docker", [
    "inspect",
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
    containerId
  ], { capture: true });
  return output.trim().toLowerCase();
}

async function assertDockerCoreBwrap(context) {
  const containers = await labeledContainers(context.identity);
  const core = containers.find((item) => item.component === "core" && item.state === "running");
  if (!core) throw new Error("Docker Core 未运行，无法执行 bubblewrap namespace probe。");
  try {
    await command("docker", [
      "exec",
      core.id,
      "/usr/bin/bwrap",
      ...bubblewrapProbeArguments("/srv/sunabot/workspace")
    ], { capture: true });
  } catch (error) {
    const detail = message(error);
    if (process.platform === "darwin" && process.arch === "arm64" && /invalid argument|EINVAL/i.test(detail)) {
      throw new Error("Apple Silicon Docker 的 linux/amd64 模拟内核拒绝 bubblewrap user namespace（EINVAL）；当前环境不能安全启用 workspace_bash。");
    }
    throw error;
  }
}

async function assertDockerCoreCodex(context) {
  const codex = await inspectDockerCodex(context);
  if (!codex.cli.ok) throw new Error(`Docker Codex CLI 不可用：${codex.cli.detail}`);
}

async function inspectDockerCodex(context) {
  const containers = await labeledContainers(context.identity);
  const core = containers.find((item) => item.component === "core" && item.state === "running");
  if (!core) {
    const detail = "Docker Core 未运行。";
    return { cli: { ok: false, detail }, auth: { ok: false, detail } };
  }
  const executable = context.contract.codexCli.executable;
  let version;
  try {
    version = (await command("docker", ["exec", core.id, executable, "--version"], { capture: true })).trim();
  } catch (error) {
    const detail = message(error);
    return { cli: { ok: false, detail }, auth: { ok: false, detail: "Codex CLI 不可用。" } };
  }
  const cli = codexVersionCheck(context, version, executable);
  if (!cli.ok) return { cli, auth: { ok: false, detail: "Codex CLI 版本不匹配。" } };

  const workspace = context.contract.paths.workspace ?? "/srv/sunabot/workspace";
  const codexHome = path.posix.join(workspace, path.posix.dirname(context.contract.codexCli.authFile));
  try {
    await command("docker", [
      "exec",
      "--env", `CODEX_HOME=${codexHome}`,
      core.id,
      executable,
      "login", "status"
    ], { capture: true });
    return { cli, auth: { ok: true, detail: codexHome } };
  } catch (error) {
    return { cli, auth: { ok: false, detail: message(error) } };
  }
}

function bubblewrapProbeArguments(workspace) {
  return [
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
}

async function startNativeCore(context, onebotListenHost) {
  await fs.mkdir(path.dirname(context.coreLog), { recursive: true, mode: 0o700 });
  const log = await fs.open(context.coreLog, "a", 0o600);
  const command = context.dev ? "npm" : process.execPath;
  const args = context.dev ? ["run", "dev"] : [context.apiEntry];
  const entry = context.dev ? "npm run dev" : context.apiEntry;
  const child = spawn(command, args, {
    cwd: context.root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...nativeProcessEnvironment(context),
      NODE_ENV: context.dev ? "development" : "production",
      SUNABOT_RUNTIME_MODE: process.platform === "darwin" ? "macos" : "linux-native",
      SUNABOT_RUNTIME_ID: context.contract.runtimeId,
      SUNABOT_WORKSPACE: context.workspace,
      SUNABOT_HOST: context.contract.adminHost,
      SUNABOT_PORT: String(context.contract.adminPort),
      SUNABOT_ONEBOT_HOST: onebotListenHost,
      SUNABOT_ONEBOT_PORT: String(context.contract.onebotPort)
    }
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
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
  await writeState(context, { mode: "native", dev: context.dev, core: record });
  return { running: true, alive: true, pid: child.pid, record };
}

async function startAccountRuntimeDaemon(context) {
  const previous = await readState(context.statePath);
  if (previous?.reconciler?.pid) {
    const observed = await observeProcess(previous.reconciler.pid);
    if (processSignatureMatches(previous.reconciler, observed)) return previous.reconciler;
    if (observed) throw new Error(`账号调和 PID ${previous.reconciler.pid} 已被其他进程复用。`);
  }
  await fs.mkdir(path.dirname(context.reconcilerLog), { recursive: true, mode: 0o700 });
  const log = await fs.open(context.reconcilerLog, "a", 0o600);
  const entry = path.join(context.root, "tooling/runtime/account-runtime-daemon.mjs");
  const child = spawn(process.execPath, [entry], {
    cwd: context.root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...nativeProcessEnvironment(context), SUNABOT_WORKSPACE: context.workspace }
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
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
  await writeState(context, { ...withoutUpdatedAt(state), reconciler: record });
  return record;
}

async function stopAccountRuntimeDaemon(context, record) {
  const observed = await observeProcess(record?.pid);
  if (!processSignatureMatches(record, observed)) {
    throw new Error(`账号调和 PID ${record?.pid ?? "unknown"} 与 launcher 启动记录不匹配。`);
  }
  process.kill(-record.processGroup, "SIGTERM");
  const deadline = Date.now() + Math.min(context.contract.shutdownTimeoutSeconds * 1_000, 5_000);
  while (Date.now() < deadline && await processAlive(record.pid)) await delay(100);
  if (await processAlive(record.pid)) {
    const current = await observeProcess(record.pid);
    if (!processSignatureMatches(record, current)) throw new Error(`账号调和 PID ${record.pid} 在停止期间发生变化。`);
    process.kill(-record.processGroup, "SIGKILL");
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

async function inspectRuntime(context) {
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
  let reconciler = { running: false, alive: false, pid: state?.reconciler?.pid, record: state?.reconciler };
  if (state?.reconciler?.pid) {
    const observed = await observeProcess(state.reconciler.pid);
    reconciler = {
      running: processSignatureMatches(state.reconciler, observed),
      alive: Boolean(observed),
      pid: state.reconciler.pid,
      record: state.reconciler
    };
  }
  const containers = await labeledContainers(context.identity);
  const legacyContainers = await findLegacyContainers();
  const dockerCore = componentStatus(containers, "core");
  const napcat = componentStatus(containers, "napcat");
  const foreignProjects = [...new Set(containers
    .map((item) => item.project)
    .filter((project) => project && project !== context.project && !project.startsWith(`${context.project}-napcat-`)))];
  return { state, native, reconciler, containers, legacyContainers, dockerCore, napcat, foreignProjects };
}

function withoutUpdatedAt(state) {
  if (!state) return {};
  const { updatedAt: _updatedAt, ...rest } = state;
  return rest;
}

async function labeledContainers(identity) {
  if (!await dockerAvailable()) return [];
  const format = [
    '{{.ID}}',
    '{{.Label "io.sunabot.component"}}',
    '{{.State}}',
    '{{.Label "com.docker.compose.project"}}',
    '{{.Label "io.sunabot.account-id"}}',
    '{{.Label "com.docker.compose.oneoff"}}'
  ].join("\t");
  const output = await command("docker", [
    "ps", "-a",
    "--filter", `label=io.sunabot.workspace-id=${identity}`,
    "--format", format
  ], { capture: true });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, component, state, project, accountId, oneoff] = line.split("\t");
    return { id, component, state: state?.toLowerCase(), project, accountId, oneoff };
  }).filter((item) => item.oneoff?.toLowerCase() !== "true");
}

async function findLegacyContainers() {
  if (!await dockerAvailable()) return [];
  const format = [
    '{{.ID}}',
    '{{.Names}}',
    '{{.State}}',
    '{{.Label "com.docker.compose.service"}}'
  ].join("\t");
  const output = await command("docker", ["ps", "-a", "--format", format], { capture: true });
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
  if (runtime.foreignProjects.length > 0) {
    throw new Error(`workspace ${context.identity} 已被其他 Compose project 使用：${runtime.foreignProjects.join(", ")}。`);
  }
  if (runtime.native.running && runtime.dockerCore.running) {
    throw new Error(`workspace ${context.identity} 同时存在 Native 与 Docker Core，检测到 split-brain。`);
  }
}

async function assertComposeServices(context) {
  if (!(await exists(context.contract.composeFile))) {
    throw new Error(`Compose 文件不存在：${context.contract.composeFile}`);
  }
  const output = await compose(context, ["--profile", context.contract.coreProfile, "config", "--services"], { capture: true });
  const services = new Set(output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  for (const expected of [context.contract.coreService, context.contract.napcatService]) {
    if (!services.has(expected)) throw new Error(`Compose 缺少 ${expected} service。`);
  }
}

async function compose(context, args, options = {}) {
  return command("docker", composeArgs(context, args), {
    capture: options.capture,
    cwd: context.root,
    env: composeEnvironment(context)
  });
}

async function napcatCompose(context, account, args, options = {}) {
  const project = `${context.project}-napcat-${account.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  return command("docker", composeArgs(context, args, project), {
    capture: options.capture,
    cwd: context.root,
    env: {
      ...composeEnvironment(context, project),
      NAPCAT_ACCOUNT_ID: account.id,
      NAPCAT_ACCOUNT: account.qqId ?? "",
      NAPCAT_WEBUI_PORT: String(account.webuiPort)
    }
  });
}

function spawnCompose(context, args) {
  return spawn("docker", composeArgs(context, args), {
    cwd: context.root,
    env: composeEnvironment(context),
    stdio: "inherit"
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
    ...process.env,
    ...context.runtimeEnvironment,
    ...context.composeOverrides,
    COMPOSE_PROJECT_NAME: project,
    SUNABOT_COMPOSE_PROJECT: project,
    SUNABOT_DOCKER_NETWORK: `${context.project}-runtime`,
    SUNABOT_RUNTIME_ID: context.contract.runtimeId,
    SUNABOT_RUNTIME_UID: String(process.getuid?.() ?? 1000),
    SUNABOT_RUNTIME_GID: String(process.getgid?.() ?? 1000),
    SUNABOT_WORKSPACE: context.workspace,
    SUNABOT_WORKSPACE_ID: context.identity,
    SUNABOT_RUNTIME_ENV: context.runtimeEnv
  };
}

function nativeProcessEnvironment(context) {
  return {
    ...process.env,
    ...context.runtimeEnvironment
  };
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
  if (!(await exists(marker)) || await newerThan(lock, marker)) {
    await command("npm", ["ci"], { cwd: context.root });
  }
  const capabilities = await inspectNativeCapabilities(context);
  if (!capabilities.libreOffice.ok) throw new Error(`Native 依赖缺失：${capabilities.libreOffice.detail}`);
  if (!capabilities.workspaceBash.ok) throw new Error(`Native Bash 隔离不可用：${capabilities.workspaceBash.detail}`);
  if (!capabilities.codexCli.ok) throw new Error(`Native Codex CLI 不可用：${capabilities.codexCli.detail}`);
}

async function inspectNativeCapabilities(context) {
  const libreOffice = await resolveLibreOfficeExecutable(context.runtimeEnvironment);
  const codex = await inspectNativeCodex(context);
  let workspaceBash = { ok: true, detail: "disabled on macOS Native Core" };
  if (process.platform === "linux") {
    try {
      await command("/usr/bin/bwrap", bubblewrapProbeArguments(context.workspace), { capture: true });
      workspaceBash = { ok: true, detail: "bubblewrap namespace probe passed" };
    } catch (error) {
      workspaceBash = { ok: false, detail: message(error) };
    }
  }
  return {
    libreOffice: libreOffice
      ? { ok: true, detail: libreOffice }
      : { ok: false, detail: "LibreOffice executable not found" },
    workspaceBash,
    codexCli: codex.cli,
    codexAuth: codex.auth
  };
}

async function inspectNativeCodex(context) {
  const executable = context.runtimeEnvironment.SUNABOT_CODEX_EXECUTABLE?.trim() || "codex";
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

async function resolveLibreOfficeExecutable(environment = {}) {
  const candidates = [
    environment.LIBREOFFICE_PATH,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/bin/soffice"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await commandSucceeds("test", ["-x", candidate])) return candidate;
  }
  return undefined;
}

function assertNonRootRuntimeUser() {
  if ((process.getuid?.() ?? 1) === 0) {
    throw new Error("拒绝以 root 启动 Sunabot；请使用拥有 workspace 的专用非 root 用户运行 ./sunabot.sh。");
  }
}

async function ensureNativeBuild(context) {
  const outputs = [context.apiEntry, context.webEntry];
  const present = await Promise.all(outputs.map(exists));
  if (present.some((value) => !value) || await sourcesNewerThan(context.root, outputs)) {
    await command("npm", ["run", "build"], { cwd: context.root });
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

async function assertDockerAvailable() {
  if (!await dockerAvailable()) throw new Error("Docker Engine 不可用；请启动 Docker Desktop 或 Docker Engine。 ");
}

async function dockerAvailable() {
  try {
    await command("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true });
    return true;
  } catch {
    return false;
  }
}

function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const output = [];
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    if (options.capture) {
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const text = Buffer.concat(output).toString("utf8");
      if (code === 0) resolve(text);
      else reject(new Error(`${executable} ${args.slice(0, 4).join(" ")} 失败（${signal || code}）${text ? `：${text.trim()}` : ""}`));
    });
  });
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
