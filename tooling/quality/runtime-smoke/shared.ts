import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { RuntimeLayout, SmokeContext } from "./types.js";

const redactionValues = new Set<string>();

export function explicitWorkspace(metaUrl: string) {
  const root = discoverProjectRoot(path.dirname(fileURLToPath(metaUrl)));
  const configured = process.env.SUNABOT_WORKSPACE?.trim();
  if (!configured) throw new Error("必须显式设置隔离测试的 SUNABOT_WORKSPACE。");
  if (!path.isAbsolute(configured)) throw new Error("SUNABOT_WORKSPACE 必须是绝对路径。");
  return { root, configuredWorkspace: path.normalize(configured) };
}

export function assertNotProductionWorkspace(root: string, workspace: string) {
  const normalized = normalizeComparisonPath(workspace);
  const explicitProduction = process.env.SUNABOT_PRODUCTION_WORKSPACE?.trim();
  const forbidden = [
    explicitProduction ? normalizeComparisonPath(path.resolve(explicitProduction)) : "",
    normalizeComparisonPath("/srv/sunabot/workspace"),
    normalizeComparisonPath(path.resolve(root, "..", "sunabot", "workspace"))
  ].filter(Boolean);
  if (forbidden.includes(normalized)) throw new Error("拒绝把已知生产 workspace 用作冒烟环境。");
  if (/[\\/]sunabot[\\/]workspace$/i.test(workspace) && !/[\\/]sunabot-dev[\\/]/i.test(workspace)) {
    throw new Error("拒绝把疑似生产 workspace 用作冒烟环境。");
  }
}

export async function loadRuntimeLayout(root: string): Promise<RuntimeLayout> {
  const contractPath = path.join(root, "deploy", "runtime-contract.json");
  const contract = asRecord(await readJson(contractPath), "运行时契约");
  if (contract.schemaVersion !== 1) throw new Error("运行时契约版本不受支持。");
  const paths = asRecord(contract.paths, "运行时契约 paths");
  const config = relativeContractPath(paths.config, "paths.config");
  const secrets = relativeContractPath(paths.secrets, "paths.secrets");
  const napcatConfig = relativeContractPath(paths.napcatConfig, "paths.napcatConfig");
  return { config, secrets, napcatConfig };
}

export async function readEnvTextWithin(filePath: string, workspace: string, label: string) {
  await assertRealFileWithin(filePath, workspace, label);
  return fs.readFile(filePath, "utf8");
}

export async function assertRealFileWithin(filePath: string, workspace: string, label: string) {
  const real = await fs.realpath(filePath);
  assertPathWithin(real, workspace, label);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`${label} 不是文件。`);
}

export async function assertRealDirectoryWithin(directory: string, workspace: string, label: string) {
  const real = await fs.realpath(directory);
  assertPathWithin(real, workspace, label);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error(`${label} 不是目录。`);
}

export function assertPathWithin(candidate: string, workspace: string, label: string) {
  const relative = path.relative(workspace, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} 必须位于隔离 workspace 内。`);
}

export async function readJson(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效。`);
  return value as Record<string, unknown>;
}

export function asOptionalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function boundedTimeout(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须在 ${minimum}-${maximum} 毫秒之间。`);
  }
  return value;
}

export function isolateRuntimeEnvironment(context: SmokeContext) {
  for (const key of context.config.providers.items.map((provider) => provider.apiKeyEnv).filter(Boolean)) {
    delete process.env[key];
  }
  delete process.env[context.config.onebot.accessTokenEnv];
  delete process.env.SUNABOT_DATABASE_PATH;
  process.env.SUNABOT_WORKSPACE = context.workspace;
  process.env.SUNABOT_CONFIG = context.configPath;
  process.env[context.provider.apiKeyEnv] = context.providerToken;
  process.env[context.config.onebot.accessTokenEnv] = context.onebotToken;
}

export function rememberSecret(secret: string) {
  if (secret.length >= 4) redactionValues.add(secret);
}

export function scrubSecrets(value: unknown, secrets: Iterable<string> = redactionValues) {
  let text = value instanceof Error ? value.message : String(value ?? "未知错误");
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 1_500);
}

export function maskQq(value: string) {
  const text = String(value);
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-2)}`;
}

export function normalizeComparisonPath(value: string) {
  return path.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
}

function relativeContractPath(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`运行时契约 ${label} 必须是 workspace 相对路径。`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`运行时契约 ${label} 不能越过 workspace。`);
  }
  return normalized;
}

function discoverProjectRoot(startDirectory: string) {
  let current = path.resolve(startDirectory);
  for (;;) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "AGENTS.md"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("无法解析 sunabot 项目根目录。");
    current = parent;
  }
}
