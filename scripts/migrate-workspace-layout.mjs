#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const workspace = resolveWorkspace();
await fs.mkdir(workspace, { recursive: true });

const legacyEnv = path.join(root, ".env");
const workspaceEnv = path.join(workspace, ".env");
if (await exists(legacyEnv)) {
  if (await exists(workspaceEnv)) throw new Error("根目录 .env 与 workspace/.env 同时存在，请先人工合并。");
  await fs.rename(legacyEnv, workspaceEnv);
  console.log("已将 .env 移入 workspace/.env。");
}

const configPath = process.env.SUNABOT_CONFIG?.trim() || path.join(workspace, "config/sunabot.json");
if (await exists(configPath)) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  let changed = false;
  for (const provider of config.providers?.items ?? []) {
    if (provider?.envFile === ".env") {
      provider.envFile = "workspace/.env";
      changed = true;
    }
  }
  if (changed) {
    const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, configPath);
    console.log("已更新 provider envFile 路径。");
  }
}

function resolveWorkspace() {
  const configured = process.env.SUNABOT_WORKSPACE?.trim();
  if (!configured) return path.join(root, "workspace");
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(root, configured);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
