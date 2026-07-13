import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const LAUNCHER_COMMANDS = new Set(["up", "down", "restart", "status", "logs", "doctor"]);
export const CORE_MODES = new Set(["auto", "native", "docker"]);

export function parseLauncherArguments(argv, environment = {}) {
  const values = [...argv];
  let command = "up";
  if (values[0] && !values[0].startsWith("-")) command = values.shift();
  if (!LAUNCHER_COMMANDS.has(command)) {
    throw new Error(`未知命令 ${command}。可用命令：${[...LAUNCHER_COMMANDS].join(", ")}。`);
  }

  let requestedMode = environment.SUNABOT_CORE_MODE?.trim() || "auto";
  let dev = /^(?:1|true|yes)$/i.test(environment.SUNABOT_DEV?.trim() || "");
  while (values.length > 0) {
    const value = values.shift();
    if (value === "--dev") {
      dev = true;
      continue;
    }
    if (value === "--core") {
      requestedMode = values.shift() ?? "";
      continue;
    }
    if (value?.startsWith("--core=")) {
      requestedMode = value.slice("--core=".length);
      continue;
    }
    throw new Error(`不支持的参数 ${value}。仅支持 --core=auto|native|docker 和 --dev。`);
  }
  if (!CORE_MODES.has(requestedMode)) {
    throw new Error(`SUNABOT_CORE_MODE 必须是 auto、native 或 docker，当前为 ${requestedMode || "空值"}。`);
  }
  return { command, requestedMode, dev };
}

export function isWslRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return false;
  const environment = options.environment ?? process.env;
  const release = options.release ?? os.release();
  return Boolean(environment.WSL_DISTRO_NAME?.trim()) || /microsoft|wsl/i.test(release);
}

export function resolveCoreMode(requestedMode, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    throw new Error("Windows 主机请在 WSL2 终端中运行 sunabot.sh。");
  }
  if (requestedMode !== "auto") return requestedMode;
  if (platform === "darwin") return "native";
  if (platform === "linux") return "docker";
  throw new Error(`暂不支持 ${platform}；支持 macOS、Linux 和 Windows WSL2。`);
}

export function workspaceIdentity(workspace) {
  const normalized = path.resolve(workspace).normalize("NFC");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function databasePathOverrideConfigured(...environments) {
  return environments.some((environment) => Boolean(environment?.SUNABOT_DATABASE_PATH?.trim()));
}

export function composeProjectName(baseName, identity) {
  const base = String(baseName || "sunabot")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") || "sunabot";
  return `${base}-${identity.slice(0, 12)}`;
}

export function resolveLauncherContract(contract, options) {
  const network = contract.network ?? {};
  const admin = network.admin ?? {};
  const onebot = network.onebot ?? {};
  const napcatWebui = network.napcatWebui ?? {};
  const docker = contract.docker ?? {};
  const dockerServices = docker.services ?? {};
  const coreService = dockerServices.core ?? {};
  const napcatService = dockerServices.napcat ?? {};
  const codexCli = contract.capabilities?.codexCli ?? {};
  const nativeUrls = onebot.nativeAdvertisedUrls ?? {};
  const nativeKey = options.platform === "darwin"
    ? "macos"
    : options.wsl
      ? "wsl"
      : "linux";

  const adminHost = admin.host ?? network.host ?? "127.0.0.1";
  const adminPort = positivePort(admin.port ?? network.apiPort ?? 8787, "管理端口");
  const onebotPath = onebot.path ?? "/onebot/v11/ws";
  const onebotPort = positivePort(onebot.internalPort ?? network.onebotPort ?? 8788, "OneBot 端口");
  const nativeReverseWebSocket = network.onebotNativeReverseWebSocket
    ?? nativeUrls[nativeKey]
    ?? network.onebotReverseWebSocket
    ?? `ws://host.docker.internal:${onebotPort}${onebotPath}`;
  const dockerReverseWebSocket = network.onebotDockerReverseWebSocket
    ?? onebot.dockerAdvertisedUrl
    ?? `ws://core:${onebotPort}${onebotPath}`;
  const webuiPort = positivePort(napcatWebui.port ?? network.napcatWebuiPort ?? 6099, "NapCat WebUI 端口");
  const composeBase = docker.composeProject ?? docker.project ?? contract.runtimeId ?? "sunabot";

  return {
    runtimeId: contract.runtimeId ?? "sunabot-runtime",
    nodeVersion: contract.nodeVersion,
    adminHost,
    adminPort,
    onebotHost: onebot.nativeListenerHosts?.[nativeKey]
      ?? onebot.nativeListenHost
      ?? network.onebotHost
      ?? "0.0.0.0",
    onebotPort,
    onebotPath,
    nativeReverseWebSocket,
    dockerReverseWebSocket,
    webuiPort,
    healthPath: contract.health?.services?.admin?.path
      ?? contract.health?.services?.core?.path
      ?? contract.health?.livenessPath
      ?? "/api/auth/session",
    onebotHealthPath: contract.health?.services?.onebot?.path
      ?? onebot.healthPath
      ?? "/healthz",
    composeFile: path.resolve(options.root, docker.composeFile ?? "deploy/docker/compose.yml"),
    composeBase,
    coreService: coreService.name ?? docker.coreService ?? "core",
    coreProfile: coreService.profile ?? docker.coreProfile ?? "core-docker",
    napcatService: napcatService.name ?? docker.napcatService ?? "napcat",
    coreReadyTimeoutSeconds: positiveInteger(
      contract.startup?.coreReadyTimeoutSeconds ?? 60
    ),
    napcatReadyTimeoutSeconds: positiveInteger(
      contract.startup?.napcatReadyTimeoutSeconds ?? 120
    ),
    shutdownTimeoutSeconds: positiveInteger(
      contract.startup?.shutdownTimeoutSeconds ?? contract.shutdownTimeoutSeconds ?? 30
    ),
    paths: contract.paths ?? {},
    codexCli: {
      version: String(codexCli.version ?? "").trim(),
      executable: codexCli.executable ?? "/usr/local/bin/codex",
      authFile: codexCli.authFile ?? "secrets/codex/auth.json"
    }
  };
}

export function ensureRuntimeSecrets(source, generateToken) {
  let content = String(source ?? "");
  const result = {};
  for (const key of ["ONEBOT_ACCESS_TOKEN", "WEBUI_TOKEN", "NAPCAT_ACCOUNT"]) {
    if (envAssignmentCount(content, key) > 1) {
      throw new Error(`runtime.env contains duplicate ${key} assignments.`);
    }
  }
  for (const key of ["ONEBOT_ACCESS_TOKEN", "WEBUI_TOKEN"]) {
    const existing = envValue(content, key);
    const value = existing || generateToken(key);
    if (!existing) content = setEnvValue(content, key, value);
    result[key] = value;
  }
  return { content, values: result };
}

function envAssignmentCount(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=`, "m");
  return String(source).split(/\r?\n/).filter((line) => expression.test(line)).length;
}

export function envValue(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(source).match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=[ \\t]*(.*)$`, "m"));
  if (!match) return "";
  const raw = match[1].trim();
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return "";
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw.replace(/\s+#.*$/, "").trim();
}

export function setEnvValue(source, key, value) {
  const encoded = /^[A-Za-z0-9._~:/+-]+$/.test(value) ? value : JSON.stringify(value);
  const assignment = `${key}=${encoded}`;
  const lines = String(source ?? "").split(/\r?\n/);
  const expression = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*=`);
  let replaced = false;
  const updated = lines.map((line) => {
    if (!expression.test(line)) return line;
    if (replaced) return line;
    replaced = true;
    return assignment;
  });
  if (!replaced) {
    while (updated.at(-1) === "") updated.pop();
    updated.push(assignment);
  }
  return `${updated.join("\n")}\n`;
}

export function reverseWebSocketWithHost(value, host) {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`OneBot 反向 WebSocket 必须使用 ws:// 或 wss://：${value}`);
  }
  url.hostname = host;
  return url.toString();
}

export function parseComposePs(output) {
  const text = String(output ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
}

export function composeServiceRunning(items, service) {
  return items.some((item) => {
    const name = item.Service ?? item.service;
    const state = String(item.State ?? item.state ?? "").toLowerCase();
    return name === service && (state === "running" || state === "healthy");
  });
}

export function processSignatureMatches(record, observed) {
  if (!record?.pid || !record?.signature || !record?.entry) return false;
  if (!observed?.signature || observed.signature !== record.signature) return false;
  return String(observed.command ?? "").includes(record.entry);
}

function positivePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}必须是 1-65535 的整数。`);
  }
  return port;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 30;
}
