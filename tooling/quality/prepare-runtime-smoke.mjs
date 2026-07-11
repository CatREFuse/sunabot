#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export async function prepareProviderSmokeWorkspace(options) {
  const source = requireAbsolute(options.source, "source");
  const destination = requireAbsolute(options.destination, "destination");
  if (samePath(source, destination)) throw new Error("源 workspace 与隔离测试 workspace 不能相同。");
  if (!options.confirmCredentialCopy) throw new Error("复制 Provider 凭据需要显式确认。");
  await assertDirectory(source, "源 workspace");
  await assertEmptyOrMissing(destination);

  const sourceConfigPath = await firstExisting([
    path.join(source, "business/config/sunabot.json"),
    path.join(source, "config/sunabot.json")
  ]);
  if (!sourceConfigPath) throw new Error("源 workspace 没有 Sunabot 配置。");
  const config = JSON.parse(await fs.readFile(sourceConfigPath, "utf8"));
  const provider = config.providers?.items?.find((item) => item?.id === config.providers?.defaultProviderId);
  if (!provider?.id || !provider.apiKeyEnv) throw new Error("源 workspace 的默认 Provider 配置无效。");
  const sourceEnvPath = resolveSourcePath(source, provider.envFile || "workspace/secrets/runtime.env");
  await assertFileInside(sourceEnvPath, source, "Provider 凭据文件");
  const sourceEnvironment = dotenv.parse(await fs.readFile(sourceEnvPath, "utf8"));
  const providerToken = String(sourceEnvironment[provider.apiKeyEnv] ?? "").trim();
  if (!providerToken) throw new Error(`源 Provider 凭据未设置 ${provider.apiKeyEnv}。`);

  const destinationConfigPath = path.join(destination, "business/config/sunabot.json");
  const destinationEnvPath = path.join(destination, "secrets/runtime.env");
  const agentSource = resolveSourcePath(source, config.persona?.agentWorkspace || "workspace/agents/plana");
  const agentDestination = path.join(destination, "business/agents/plana");
  const preparedConfig = {
    ...config,
    server: { ...config.server, host: "127.0.0.1", port: options.apiPort ?? 18_876 },
    persona: {
      ...config.persona,
      defaultAgentId: "plana",
      agentWorkspace: "workspace/business/agents/plana"
    },
    providers: {
      defaultProviderId: provider.id,
      items: [{ ...provider, envFile: "workspace/secrets/runtime.env" }]
    }
  };

  await fs.mkdir(path.dirname(destinationConfigPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(destinationEnvPath), { recursive: true, mode: 0o700 });
  if (await directoryExists(agentSource)) {
    await assertPathInside(agentSource, source, "Agent workspace");
    await fs.cp(agentSource, agentDestination, { recursive: true, errorOnExist: true, force: false });
  } else {
    await fs.mkdir(agentDestination, { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(destinationConfigPath, `${JSON.stringify(preparedConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  const onebotEnvironment = String(config.onebot?.accessTokenEnv || "ONEBOT_ACCESS_TOKEN");
  const values = new Map([[provider.apiKeyEnv, providerToken]]);
  if (!values.has(onebotEnvironment)) values.set(onebotEnvironment, crypto.randomBytes(32).toString("base64url"));
  const environmentText = [...values].map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
  await fs.writeFile(destinationEnvPath, `${environmentText}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return {
    source,
    destination,
    configPath: destinationConfigPath,
    envPath: destinationEnvPath,
    provider: { id: provider.id, kind: provider.kind, model: provider.model, apiKeyEnv: provider.apiKeyEnv }
  };
}

function resolveSourcePath(workspace, configured) {
  if (path.isAbsolute(configured)) return path.normalize(configured);
  const normalized = String(configured).replace(/\\/g, "/");
  if (normalized === ".env" || normalized === "workspace/.env") return path.join(workspace, ".env");
  if (normalized.startsWith("workspace/")) return path.join(workspace, normalized.slice("workspace/".length));
  return path.resolve(workspace, normalized);
}

async function assertEmptyOrMissing(directory) {
  try {
    const entries = await fs.readdir(directory);
    if (entries.length) throw new Error("隔离测试 workspace 必须不存在或为空。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function assertDirectory(directory, label) {
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) throw new Error(`${label} 不是目录。`);
}

async function assertFileInside(filePath, root, label) {
  await assertPathInside(filePath, root, label);
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error(`${label} 不是文件。`);
}

async function assertPathInside(candidate, root, label) {
  const [realCandidate, realRoot] = await Promise.all([fs.realpath(candidate), fs.realpath(root)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 不在源 workspace 内。`);
}

async function directoryExists(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireAbsolute(value, name) {
  const text = String(value ?? "").trim();
  if (!path.isAbsolute(text)) throw new Error(`${name} 必须是绝对路径。`);
  return path.resolve(text);
}

function samePath(left, right) {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await prepareProviderSmokeWorkspace({
    source: option("source"),
    destination: option("destination"),
    confirmCredentialCopy: process.argv.includes("--confirm-copy-provider-credential"),
    apiPort: Number(option("api-port") || 18_876)
  });
  console.log(`隔离 Provider workspace 已准备：${result.destination}`);
  console.log(`provider: ${result.provider.id} / ${result.provider.kind} / ${result.provider.model}`);
  console.log(`credential: configured (${result.provider.apiKeyEnv}); value hidden`);
}
