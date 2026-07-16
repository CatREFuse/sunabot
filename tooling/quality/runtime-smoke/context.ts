import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import {
  asOptionalRecord,
  asRecord,
  assertNotProductionWorkspace,
  assertPathWithin,
  assertRealDirectoryWithin,
  assertRealFileWithin,
  explicitWorkspace,
  loadRuntimeLayout,
  readEnvTextWithin,
  readJson,
  rememberSecret
} from "./shared.js";
import type { LoadContextOptions, RawProviderConfig, RawSmokeConfig, SmokeContext } from "./types.js";

const MARKER_FILE = ".sunabot-smoke-workspace.json";
const MARKER_PURPOSE = "sunabot-runtime-smoke";
const DEFAULT_ONEBOT_PORT = 18_878;
const DEFAULT_ONEBOT_ADVERTISED_HOST = "127.0.0.1";
const RESERVED_PORTS = new Set([6_099, 8_787, 8_788]);

export async function initializeSmokeWorkspace() {
  const { root, configuredWorkspace } = explicitWorkspace(import.meta.url);
  await fs.mkdir(configuredWorkspace, { recursive: true });
  const workspace = await fs.realpath(configuredWorkspace);
  assertNotProductionWorkspace(root, workspace);
  const markerPath = path.join(workspace, MARKER_FILE);
  const marker = { schemaVersion: 1, purpose: MARKER_PURPOSE };
  try {
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await validateMarker(markerPath, workspace);
  }
  return workspace;
}

export async function loadSmokeContext(options: LoadContextOptions = {}): Promise<SmokeContext> {
  const { root, configuredWorkspace } = explicitWorkspace(import.meta.url);
  const workspace = await fs.realpath(configuredWorkspace);
  assertNotProductionWorkspace(root, workspace);
  await validateMarker(path.join(workspace, MARKER_FILE), workspace);

  const layout = await loadRuntimeLayout(root);
  const configPath = path.join(workspace, layout.config);
  await assertRealFileWithin(configPath, workspace, "测试配置");
  const config = validateRawConfig(await readJson(configPath));
  const provider = config.providers.items.find((item) => item.id === config.providers.defaultProviderId);
  if (!provider) throw new Error("测试配置中的默认 Provider 不存在。");
  if (!provider.enabled) throw new Error("测试配置中的默认 Provider 未启用。");

  const providerEnvPath = resolveProviderEnvPath(root, workspace, provider.envFile, layout.secrets);
  const providerEnv = await readOptionalEnvWithin(
    providerEnvPath,
    workspace,
    "Provider 凭据文件",
    Boolean(options.requireProviderCredential)
  );
  const workspaceEnvPath = path.join(workspace, layout.secrets);
  const workspaceEnv = providerEnvPath === workspaceEnvPath
    ? providerEnv
    : await readOptionalEnvWithin(
      workspaceEnvPath,
      workspace,
      "测试环境文件",
      Boolean(options.requireOneBotCredential)
    );
  const providerToken = String(providerEnv[provider.apiKeyEnv] ?? "").trim();
  const onebotToken = String(workspaceEnv[config.onebot.accessTokenEnv] ?? "").trim();
  const napcatAccount = String(
    process.env.SUNABOT_SMOKE_NAPCAT_ACCOUNT ?? workspaceEnv.NAPCAT_ACCOUNT ?? ""
  ).trim();
  rememberSecret(providerToken);
  rememberSecret(onebotToken);

  if (options.requireProviderCredential && !providerToken) {
    throw new Error(`隔离 Provider 凭据文件未设置 ${provider.apiKeyEnv}。`);
  }
  if (options.requireOneBotCredential && !onebotToken) {
    throw new Error(`隔离测试环境未设置 ${config.onebot.accessTokenEnv}。`);
  }
  if (options.requireOneBotCredential && !/^\d{5,12}$/.test(napcatAccount)) {
    throw new Error("隔离测试环境未设置有效的 NAPCAT_ACCOUNT。");
  }

  const adminQq = String(config.bot.adminQq ?? "").trim();
  if (!/^\d{5,12}$/.test(adminQq)) throw new Error("测试配置中的 bot.adminQq 无效。");
  const onebotPath = normalizeOneBotPath(config.onebot.reverseWsPath);
  const onebotPort = smokeOneBotPort();
  const onebotAdvertisedHost = smokeOneBotAdvertisedHost();
  const onebotUrl = `ws://${onebotAdvertisedHost}:${onebotPort}${onebotPath}`;
  const context: SmokeContext = {
    root,
    workspace,
    configPath,
    config,
    provider,
    providerEnvPath,
    providerToken,
    onebotToken,
    adminQq,
    napcatAccount,
    onebotPort,
    onebotPath,
    onebotUrl,
    layout
  };
  if (options.requireNapCatConfig) await inspectNapCatSmokeConfig(context);
  return context;
}

export async function configureNapCatForSmoke(context: SmokeContext) {
  const configDirectory = path.join(context.workspace, context.layout.napcatConfig);
  await fs.mkdir(configDirectory, { recursive: true });
  await assertRealDirectoryWithin(configDirectory, context.workspace, "NapCat 测试配置目录");
  const currentNames = (await fs.readdir(configDirectory)).filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
  const names = currentNames.length > 0 ? currentNames : [`onebot11_${context.napcatAccount}.json`];
  const written: string[] = [];

  for (const name of names) {
    const filePath = path.join(configDirectory, name);
    let current: Record<string, unknown> = {};
    try {
      current = asRecord(await readJson(filePath), `NapCat 配置 ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = buildNapCatSmokeConfig(current, context.onebotUrl, context.onebotToken);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    written.push(filePath);
  }
  return written;
}

export function buildNapCatSmokeConfig(current: Record<string, unknown>, onebotUrl: string, token: string) {
  const network = asOptionalRecord(current.network);
  return {
    ...current,
    network: {
      ...network,
      websocketClients: [{
        name: "sunabot-smoke",
        enable: true,
        url: onebotUrl,
        messagePostFormat: "array",
        reportSelfMessage: false,
        reconnectInterval: 1_000,
        token,
        debug: false,
        heartInterval: 30_000
      }]
    }
  };
}

export async function inspectNapCatSmokeConfig(context: SmokeContext) {
  const directory = path.join(context.workspace, context.layout.napcatConfig);
  await assertRealDirectoryWithin(directory, context.workspace, "NapCat 测试配置目录");
  const names = (await fs.readdir(directory)).filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
  if (names.length === 0) throw new Error("未找到隔离 NapCat OneBot 配置；先运行 configure-onebot。");

  for (const name of names) {
    const filePath = path.join(directory, name);
    await assertRealFileWithin(filePath, context.workspace, `NapCat 配置 ${name}`);
    const config = asRecord(await readJson(filePath), `NapCat 配置 ${name}`);
    const network = asOptionalRecord(config.network);
    const clients = Array.isArray(network.websocketClients) ? network.websocketClients : [];
    if (clients.length !== 1) throw new Error(`NapCat 配置 ${name} 必须只保留一个测试 WebSocket client。`);
    const client = asRecord(clients[0], `NapCat 配置 ${name} WebSocket client`);
    if (client.name !== "sunabot-smoke" || client.enable !== true || client.url !== context.onebotUrl) {
      throw new Error(`NapCat 配置 ${name} 未指向隔离 OneBot 冒烟入口。`);
    }
    if (String(client.token ?? "") !== context.onebotToken) {
      throw new Error(`NapCat 配置 ${name} 的测试 Token 与隔离 workspace 不一致。`);
    }
  }
  return names;
}

async function validateMarker(markerPath: string, workspace: string) {
  await assertRealFileWithin(markerPath, workspace, "隔离冒烟标记");
  const marker = asRecord(await readJson(markerPath), "隔离冒烟标记");
  if (marker.schemaVersion !== 1 || marker.purpose !== MARKER_PURPOSE) {
    throw new Error("SUNABOT_WORKSPACE 没有有效的隔离冒烟标记。");
  }
}

function validateRawConfig(value: unknown): RawSmokeConfig {
  const config = asRecord(value, "测试配置");
  const providers = asRecord(config.providers, "测试配置 providers");
  if (!Array.isArray(providers.items) || providers.items.length === 0) throw new Error("测试配置至少需要一个 Provider。");
  const items = providers.items.map((item, index) => {
    const provider = asRecord(item, `Provider ${index}`);
    for (const field of ["id", "kind", "model", "apiKeyEnv"] as const) {
      if (typeof provider[field] !== "string" || !String(provider[field]).trim()) {
        throw new Error(`Provider ${index} 缺少 ${field}。`);
      }
    }
    return provider as unknown as RawProviderConfig;
  });
  const bot = asRecord(config.bot, "测试配置 bot");
  const onebot = asRecord(config.onebot, "测试配置 onebot");
  return {
    providers: { defaultProviderId: String(providers.defaultProviderId ?? ""), items },
    bot: { adminQq: String(bot.adminQq ?? "") },
    onebot: {
      reverseWsPath: String(onebot.reverseWsPath ?? ""),
      accessTokenEnv: String(onebot.accessTokenEnv ?? "")
    }
  };
}

function resolveProviderEnvPath(root: string, workspace: string, configured: string | undefined, secretsPath: string) {
  const value = configured?.trim() || `workspace/${secretsPath.replaceAll("\\", "/")}`;
  let resolved: string;
  if (path.isAbsolute(value)) resolved = path.normalize(value);
  else {
    const normalized = value.replaceAll("\\", "/");
    if (normalized === ".env" || normalized === "workspace/.env") resolved = path.join(workspace, secretsPath);
    else if (normalized.startsWith("workspace/")) resolved = path.join(workspace, normalized.slice("workspace/".length));
    else resolved = path.resolve(root, value);
  }
  assertPathWithin(resolved, workspace, "Provider 凭据文件");
  return resolved;
}

async function readOptionalEnvWithin(filePath: string, workspace: string, label: string, required: boolean) {
  try {
    return dotenv.parse(await readEnvTextWithin(filePath, workspace, label));
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function normalizeOneBotPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("测试配置中的 OneBot reverseWsPath 无效。");
  }
  return trimmed;
}

function smokeOneBotPort() {
  const raw = process.env.SUNABOT_SMOKE_ONEBOT_PORT ?? String(DEFAULT_ONEBOT_PORT);
  if (!isCanonicalUnsignedDecimal(raw, 5, false)) {
    throw new Error("SUNABOT_SMOKE_ONEBOT_PORT 必须是 1024-65535 的 canonical 十进制端口，且不能使用 6099、8787 或 8788。");
  }
  const value = Number(raw);
  if (value < 1_024 || value > 65_535 || RESERVED_PORTS.has(value)) {
    throw new Error("SUNABOT_SMOKE_ONEBOT_PORT 必须是 1024-65535 的 canonical 十进制端口，且不能使用 6099、8787 或 8788。");
  }
  return value;
}

function smokeOneBotAdvertisedHost() {
  const value = process.env.SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST ?? DEFAULT_ONEBOT_ADVERTISED_HOST;
  if (value === DEFAULT_ONEBOT_ADVERTISED_HOST || value === "host.docker.internal") return value;
  if (isPrivateIpv4(value)) return value;
  throw new Error(
    "SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST 必须是 127.0.0.1、host.docker.internal 或 canonical RFC1918 IPv4。"
  );
}

function isPrivateIpv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !isCanonicalUnsignedDecimal(part, 3, true))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isCanonicalUnsignedDecimal(value: string, maximumDigits: number, allowZero: boolean) {
  if (value === "0") return allowZero;
  if (value.length < 1 || value.length > maximumDigits) return false;
  const first = value.charCodeAt(0);
  if (first < 49 || first > 57) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}
