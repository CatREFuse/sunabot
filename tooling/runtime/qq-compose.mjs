#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);
const contract = JSON.parse(
  await fsPromises.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8")
);
const runtimeEnv = path.join(workspace, contract.paths.secrets);
const args = process.argv.slice(2);
if (args.length === 0) throw new Error("请提供 docker compose 子命令。");
if (!fs.existsSync(runtimeEnv)) {
  throw new Error(`运行环境文件不存在：${runtimeEnv}。请先执行 workspace 初始化或迁移。`);
}

const child = spawn("docker", [
  "compose",
  "--env-file",
  runtimeEnv,
  "--project-directory",
  root,
  "-f",
  path.join(root, "deploy/docker/compose.yml"),
  ...args
], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    SUNABOT_WORKSPACE: workspace,
    SUNABOT_RUNTIME_ENV: runtimeEnv
  }
});
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
