#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { resolveProxyConfiguration } from "../../packages/platform/proxy.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import {
  composeProjectName,
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
    runtimeEnv: path.join(workspace, contract.paths.secrets ?? "secrets/runtime.env"),
    statePath: path.join(workspace, "runtime/launcher-state.json"),
    coreLog: path.join(workspace, contract.paths.logs ?? "runtime/logs", parsed.dev ? "core-dev.log" : "core.log"),
    apiEntry: path.join(root, "dist/apps/api/main.js"),
    webEntry: path.join(root, "apps/admin-web/dist/index.html")
  };
  context.runtimeEnvironment = await readRuntimeEnvironment(context.runtimeEnv);
  context.composeOverrides = {};

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
  }
}

async function up(context) {
  assertNonRootRuntimeUser();
  await assertDockerAvailable();
  const initial = await inspectRuntime(context);
  assertExpectedProject(context, initial);
  await initializeWorkspace(context);
  const secrets = await prepareSecrets(context);
  await ensureAdminCredentials(context);
  await assertComposeServices(context);
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
  await compose(context, ["create", context.contract.napcatService]);
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
    await configureNapcat(context, reverseWebSocket, secrets);
    await clearNapcatLoginQr(context);
    await compose(context, ["up", "-d", context.contract.napcatService]);
    await waitForComponentHealth(
      context,
      "napcat",
      context.contract.napcatReadyTimeoutSeconds * 1_000
    );
    await writeState(context, {
      ...(await readState(context.statePath)),
      mode: "native",
      dev: context.dev,
      reverseWebSocket,
      onebotListenHost,
      core: native.record
    });
  } catch (error) {
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
    await configureNapcat(context, context.contract.dockerReverseWebSocket, secrets);
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
    await clearNapcatLoginQr(context);
    await compose(context, [
      "--profile",
      context.contract.coreProfile,
      "up",
      "-d",
      "--build",
      context.contract.napcatService
    ]);
    await waitForComponentHealth(
      context,
      "napcat",
      context.contract.napcatReadyTimeoutSeconds * 1_000
    );
    await writeState(context, {
      mode: "docker",
      dev: false,
      reverseWebSocket: context.contract.dockerReverseWebSocket
    });
  } catch (error) {
    await compose(context, ["--profile", context.contract.coreProfile, "down", "--remove-orphans"]).catch(() => {});
    await fs.rm(context.statePath, { force: true });
    throw error;
  }
}

async function down(context) {
  await assertDockerAvailable();
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
  if (runtime.napcat.matches.length > 0) {
    await compose(context, ["--profile", context.contract.coreProfile, "stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), context.contract.napcatService]);
  }
  if (runtime.native.running) {
    await stopNativeCore(context, runtime.state.core, { removeState: false });
  } else if (runtime.dockerCore.matches.length > 0) {
    await compose(context, ["--profile", context.contract.coreProfile, "stop", "--timeout", String(context.contract.shutdownTimeoutSeconds), context.contract.coreService]);
  }
  if (runtime.containers.length > 0) {
    await compose(context, ["--profile", context.contract.coreProfile, "down", "--remove-orphans"]);
  }
  await fs.rm(context.statePath, { force: true });
  console.log("Sunabot Core 与 NapCat 已停止。");
}

async function printStatus(context) {
  const runtime = await inspectRuntime(context);
  const api = await httpReady(`http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`);
  const onebotHealthHost = runtime.state?.onebotListenHost
    ?? (context.contract.onebotHost === "docker-network-gateway" ? "127.0.0.1" : context.contract.onebotHost);
  const nativeOnebot = runtime.native.running
    ? await httpReady(`http://${onebotHealthHost}:${context.contract.onebotPort}${context.contract.onebotHealthPath}`)
    : false;
  const coreMode = runtime.native.running ? "native" : runtime.dockerCore.running ? "docker" : "stopped";
  console.log(`Workspace: ${context.workspace}`);
  console.log(`Workspace ID: ${context.identity}`);
  console.log(`Core: ${coreMode}${runtime.native.running ? ` (PID ${runtime.native.pid})` : ""}`);
  console.log(`API: ${api ? "ready" : "unavailable"} http://127.0.0.1:${context.contract.adminPort}`);
  console.log(`OneBot ingress: ${runtime.dockerCore.running ? "internal" : nativeOnebot ? "ready" : "unavailable"}`);
  console.log(`NapCat: ${runtime.napcat.running ? "running" : "stopped"}`);
  if (runtime.state?.dev && runtime.native.running) console.log("Frontend: http://127.0.0.1:5173");
  console.log(`NapCat WebUI: http://127.0.0.1:${context.contract.webuiPort}/webui`);
  if (runtime.napcat.running && await awaitingLogin(context)) console.log("QQ: awaiting-login");
  if (runtime.foreignProjects.length > 0) {
    console.log(`Conflict: workspace labels also appear in ${runtime.foreignProjects.join(", ")}`);
    process.exitCode = 1;
  }
  const legacyRunning = runtime.legacyContainers.filter((item) => item.state === "running");
  const legacyStopped = runtime.legacyContainers.filter((item) => item.state !== "running");
  if (legacyRunning.length > 0) {
    console.log("Conflict: legacy one-container runtime is running; follow docs/migrations/one-container-to-split-runtime.md");
    process.exitCode = 1;
  }
  if (legacyStopped.length > 0) console.log("Legacy rollback container: retained (stopped)");
  if (coreMode === "stopped" && api) {
    console.log(`Conflict: ${context.contract.adminPort} is owned outside this launcher`);
    process.exitCode = 1;
  }
}

async function doctor(context) {
  const checks = [];
  checks.push(check("Platform", process.platform === "darwin" || process.platform === "linux", `${process.platform}/${process.arch}`));
  checks.push(check("WSL", process.platform !== "win32", context.wsl ? "WSL2" : "not required"));
  checks.push(check("Runtime user", (process.getuid?.() ?? 1) !== 0, `uid=${process.getuid?.() ?? "n/a"}`));
  checks.push(check("Node", !context.contract.nodeVersion || process.versions.node === context.contract.nodeVersion, process.versions.node));
  checks.push(check("Workspace", await exists(context.workspace), context.workspace));
  checks.push(check("runtime.env", await exists(context.runtimeEnv), context.runtimeEnv));
  let source = "";
  if (await exists(context.runtimeEnv)) source = await fs.readFile(context.runtimeEnv, "utf8");
  try {
    ensureRuntimeSecrets(source, () => "doctor-placeholder");
    checks.push(check("runtime.env uniqueness", true, "launcher-owned keys are unique"));
  } catch (error) {
    checks.push(check("runtime.env uniqueness", false, message(error)));
  }
  checks.push(check("OneBot Token", Boolean(envValue(source, "ONEBOT_ACCESS_TOKEN")), "value hidden"));
  checks.push(check("NapCat WebUI Token", Boolean(envValue(source, "WEBUI_TOKEN")), "value hidden"));
  if (context.mode === "native") {
    const nativeCapabilities = await inspectNativeCapabilities(context);
    checks.push(check("LibreOffice", nativeCapabilities.libreOffice.ok, nativeCapabilities.libreOffice.detail));
    checks.push(check("workspace_bash", nativeCapabilities.workspaceBash.ok, nativeCapabilities.workspaceBash.detail));
    checks.push(check("Codex CLI", nativeCapabilities.codexCli.ok, nativeCapabilities.codexCli.detail));
    checks.push(check("Codex auth", nativeCapabilities.codexAuth.ok, nativeCapabilities.codexAuth.detail));
  } else if (process.platform === "linux") {
    checks.push(check("Docker Core architecture", process.arch === "x64", `${process.arch}; required linux/amd64`));
  }
  checks.push(check("Docker", await dockerAvailable(), "Docker Engine + Compose"));
  if (checks.at(-1).ok && await exists(context.runtimeEnv)) {
    try {
      await assertComposeServices(context);
      checks.push(check("Compose", true, `${context.contract.coreService}, ${context.contract.napcatService}`));
    } catch (error) {
      checks.push(check("Compose", false, message(error)));
    }
  }
  const runtime = await inspectRuntime(context);
  const legacyRunning = runtime.legacyContainers.filter((item) => item.state === "running");
  const legacyStopped = runtime.legacyContainers.filter((item) => item.state !== "running");
  checks.push(check("Runtime ownership", runtime.foreignProjects.length === 0
    && !(runtime.native.running && runtime.dockerCore.running)
    && legacyRunning.length === 0,
  legacyRunning.length
    ? `legacy one-container: ${legacyRunning.map((item) => item.name).join(", ")}; see docs/migrations/one-container-to-split-runtime.md`
    : runtime.foreignProjects.length ? runtime.foreignProjects.join(", ") : "single workspace owner"));
  if (runtime.native.running || runtime.dockerCore.running) {
    checks.push(check("Core API", await httpReady(
      `http://127.0.0.1:${context.contract.adminPort}${context.contract.healthPath}`
    ), `127.0.0.1:${context.contract.adminPort}`));
  }
  if (runtime.native.running) {
    const host = runtime.state?.onebotListenHost
      ?? (context.contract.onebotHost === "docker-network-gateway" ? "127.0.0.1" : context.contract.onebotHost);
    checks.push(check("OneBot ingress", await httpReady(
      `http://${host}:${context.contract.onebotPort}${context.contract.onebotHealthPath}`
    ), `${host}:${context.contract.onebotPort}`));
  }
  if (runtime.dockerCore.matches.length > 0) {
    const status = await componentHealthStatus(runtime.dockerCore.matches[0].id);
    checks.push(check("Docker Core health", status === "healthy", status));
    if (runtime.dockerCore.running) {
      try {
        await assertDockerCoreBwrap(context);
        checks.push(check("Docker workspace_bash", true, "bubblewrap namespace probe passed"));
      } catch (error) {
        checks.push(check("Docker workspace_bash", false, message(error)));
      }
      const codex = await inspectDockerCodex(context);
      checks.push(check("Docker Codex CLI", codex.cli.ok, codex.cli.detail));
      checks.push(check("Docker Codex auth", codex.auth.ok, codex.auth.detail));
    }
  }
  if (runtime.napcat.matches.length > 0) {
    const status = await componentHealthStatus(runtime.napcat.matches[0].id);
    checks.push(check("NapCat health", status === "healthy", status));
  }
  for (const item of checks) console.log(`${item.ok ? "[OK]" : "[FAIL]"} ${item.name}: ${item.detail}`);
  if (legacyStopped.length > 0) console.log("[OK] Legacy rollback container: retained (stopped)");
  if (checks.some((item) => !item.ok)) process.exitCode = 1;
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
      ...(runtime.dockerCore.running ? [context.contract.coreService] : []),
      ...(runtime.napcat.running ? [context.contract.napcatService] : [])
    ];
    children.push(spawnCompose(context, ["--profile", context.contract.coreProfile, "logs", "-f", ...services]));
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

async function configureNapcat(context, reverseWebSocket, secrets) {
  const configDir = path.join(context.workspace, context.contract.paths.napcatConfig ?? "runtime/napcat/config-full");
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  let names = (await fs.readdir(configDir)).filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
  if (names.length === 0) {
    const source = await fs.readFile(context.runtimeEnv, "utf8");
    const account = envValue(source, "NAPCAT_ACCOUNT");
    names = /^\d{5,12}$/.test(account) ? [`onebot11_${account}.json`] : ["onebot11.json"];
  }
  let changed = false;
  for (const name of names) {
    const filePath = path.join(configDir, name);
    const config = await readJsonOr(filePath, { network: { websocketClients: [] } });
    config.network ??= {};
    config.enableLocalFile2Url = true;
    config.network.websocketClients = [{
      name: "sunabot",
      enable: true,
      url: reverseWebSocket,
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
    port: context.contract.webuiPort,
    token: secrets.WEBUI_TOKEN,
    loginRate: Number.isInteger(webui.loginRate) ? webui.loginRate : 3
  });
  changed = await atomicJsonIfChanged(webuiPath, webui) || changed;
  console.log(`NapCat 已配置：${names.join(", ")}（Token 已隐藏）。`);
  return changed;
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
  const containers = await labeledContainers(context.identity);
  const legacyContainers = await findLegacyContainers();
  const dockerCore = componentStatus(containers, "core");
  const napcat = componentStatus(containers, "napcat");
  const foreignProjects = [...new Set(containers
    .map((item) => item.project)
    .filter((project) => project && project !== context.project))];
  return { state, native, containers, legacyContainers, dockerCore, napcat, foreignProjects };
}

async function labeledContainers(identity) {
  if (!await dockerAvailable()) return [];
  const format = [
    '{{.ID}}',
    '{{.Label "io.sunabot.component"}}',
    '{{.State}}',
    '{{.Label "com.docker.compose.project"}}'
  ].join("\t");
  const output = await command("docker", [
    "ps", "-a",
    "--filter", `label=io.sunabot.workspace-id=${identity}`,
    "--format", format
  ], { capture: true });
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, component, state, project] = line.split("\t");
    return { id, component, state: state?.toLowerCase(), project };
  });
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

function spawnCompose(context, args) {
  return spawn("docker", composeArgs(context, args), {
    cwd: context.root,
    env: composeEnvironment(context),
    stdio: "inherit"
  });
}

function composeArgs(context, args) {
  return [
    "compose",
    "--project-name", context.project,
    "--env-file", context.runtimeEnv,
    "--project-directory", context.root,
    "-f", context.contract.composeFile,
    ...args
  ];
}

function composeEnvironment(context) {
  return {
    ...process.env,
    ...context.runtimeEnvironment,
    ...context.composeOverrides,
    COMPOSE_PROJECT_NAME: context.project,
    SUNABOT_COMPOSE_PROJECT: context.project,
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

async function awaitingLogin(context) {
  const qrPath = path.join(context.workspace, context.contract.paths.napcatQrCode ?? "runtime/napcat/qrcode.png");
  const manualLoginPath = path.join(context.workspace, context.contract.paths.napcatManualLogin ?? "runtime/napcat/manual-login-required");
  if (await exists(manualLoginPath)) return true;
  if (await exists(qrPath)) return true;
  const source = await fs.readFile(context.runtimeEnv, "utf8").catch(() => "");
  return !envValue(source, "NAPCAT_ACCOUNT");
}

async function clearNapcatLoginQr(context) {
  const qrPath = path.join(context.workspace, context.contract.paths.napcatQrCode ?? "runtime/napcat/qrcode.png");
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
