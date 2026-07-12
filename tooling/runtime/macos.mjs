#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runLauncher } from "./launcher.mjs";

export function macosLauncherArguments(command = "start") {
  const mapped = {
    start: "up",
    stop: "down",
    restart: "restart",
    status: "status",
    logs: "logs",
    doctor: "doctor"
  }[command];
  if (!mapped) {
    throw new Error("旧 macOS NapCat Installer 入口已移除；请使用 ./sunabot.sh up --core=native。");
  }
  return [mapped, "--core=native"];
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error(`macOS 兼容入口不能用于 ${process.platform}/${process.arch}。`);
  }
  if (process.argv.length > 3) throw new Error("macos.mjs 只接受一个命令。");
  await runLauncher(macosLauncherArguments(process.argv[2] ?? "start"));
}

const direct = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (direct) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
