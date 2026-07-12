#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import { configureNapcatClient } from "./napcat-client-config.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);
const contract = JSON.parse(
  await fs.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8")
);
if (process.argv.length > 2) {
  throw new Error("NapCat 配置目录由 runtime contract 固定，不接受目录参数。");
}
const configDir = path.join(workspace, contract.paths.napcatConfig);
const requestedMode = process.env.SUNABOT_CORE_MODE?.trim() || "auto";
if (!["auto", "native", "docker"].includes(requestedMode)) {
  throw new Error("SUNABOT_CORE_MODE 必须是 auto、native 或 docker。");
}
const coreMode = requestedMode === "auto"
  ? process.platform === "darwin" ? "native" : "docker"
  : requestedMode;
const nativePlatform = process.platform === "darwin"
  ? "macos"
  : process.env.WSL_DISTRO_NAME?.trim()
    ? "wsl"
    : "linux";
const onebotReverseWebSocket = process.env.SUNABOT_ONEBOT_ADVERTISED_URL?.trim()
  || (coreMode === "docker"
    ? contract.network.onebot.dockerAdvertisedUrl
    : contract.network.onebot.nativeAdvertisedUrls[nativePlatform]);
if (!onebotReverseWebSocket) {
  throw new Error(`runtime contract 缺少 ${coreMode} Core 的 OneBot 地址。`);
}
const result = await configureNapcatClient({
  configDir,
  secretsPath: path.join(workspace, contract.paths.secrets),
  secretsLabel: contract.paths.secrets,
  onebotReverseWebSocket
});
for (const name of result.names) {
  console.log(`${name} 已配置 Sunabot 反向 WebSocket（Token 已隐藏）。`);
}
