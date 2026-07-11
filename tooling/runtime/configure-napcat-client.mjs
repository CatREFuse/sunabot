#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);
const contract = JSON.parse(
  await fs.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8")
);
if (process.argv.length > 2) {
  throw new Error("NapCat 配置目录由 runtime contract 固定，不接受目录参数。");
}
const configDir = path.join(workspace, contract.paths.napcatConfig);
const env = dotenv.parse(
  await fs.readFile(path.join(workspace, contract.paths.secrets), "utf8")
);
const token = env.ONEBOT_ACCESS_TOKEN?.trim();
if (!token) throw new Error(`${contract.paths.secrets} 缺少 ONEBOT_ACCESS_TOKEN。`);
const account = env.NAPCAT_ACCOUNT?.trim();

await fs.mkdir(configDir, { recursive: true });
let names = (await fs.readdir(configDir))
  .filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
if (names.length === 0) {
  names = account && /^\d{5,12}$/.test(account)
    ? [`onebot11_${account}.json`]
    : ["onebot11.json"];
}

for (const name of names) {
  const filePath = path.join(configDir, name);
  const config = await readJsonOrDefault(filePath, { network: { websocketClients: [] } });
  const clients = Array.isArray(config.network?.websocketClients)
    ? config.network.websocketClients
    : [];
  const template = clients.find((item) => item?.name === "sunabot")
    ?? clients[0]
    ?? {};
  const client = {
    ...template,
    name: "sunabot",
    enable: true,
    url: contract.network.onebotReverseWebSocket,
    messagePostFormat: "array",
    reportSelfMessage: false,
    reconnectInterval: 5000,
    token,
    debug: false,
    heartInterval: 30000
  };
  config.network ??= {};
  config.network.websocketClients = [client];
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  console.log(`${name} 已配置 Sunabot 反向 WebSocket（Token 已隐藏）。`);
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return structuredClone(fallback);
  }
}
