#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

const configDir = process.argv[2];
if (!configDir) {
  throw new Error("用法：configure-napcat-client.mjs NAPCAT_CONFIG_DIR");
}

const workspace = process.env.SUNABOT_WORKSPACE?.trim()
  ? path.resolve(process.env.SUNABOT_WORKSPACE)
  : path.join(process.cwd(), "workspace");
const env = dotenv.parse(await fs.readFile(path.join(workspace, ".env"), "utf8"));
const token = env.ONEBOT_ACCESS_TOKEN?.trim();
if (!token) throw new Error("workspace/.env 缺少 ONEBOT_ACCESS_TOKEN。");

const names = (await fs.readdir(configDir))
  .filter((name) => /^onebot11(?:_\d+)?\.json$/.test(name));
if (names.length === 0) throw new Error("未找到 NapCat OneBot 11 配置。");

for (const name of names) {
  const filePath = path.join(configDir, name);
  const config = JSON.parse(await fs.readFile(filePath, "utf8"));
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
    url: "ws://127.0.0.1:8787/onebot/v11/ws",
    messagePostFormat: "array",
    reportSelfMessage: false,
    reconnectInterval: 5000,
    token,
    debug: false,
    heartInterval: 30000
  };
  config.network ??= {};
  config.network.websocketClients = [
    ...clients.filter((item) => item?.name !== "sunabot" && !isLegacyAstrBotClient(item)),
    client
  ];
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  console.log(`${name} 已配置 Sunabot 反向 WebSocket（Token 已隐藏）。`);
}

function isLegacyAstrBotClient(item) {
  const name = String(item?.name ?? "").toLowerCase();
  const url = String(item?.url ?? "").toLowerCase();
  return name.includes("astrbot") || /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):6199(?:\/|$)/.test(url);
}
