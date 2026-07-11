#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const root = process.cwd();
const configured = process.env.SUNABOT_WORKSPACE?.trim();
const workspace = configured
  ? (path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(root, configured))
  : path.join(root, "workspace");
const args = process.argv.slice(2);
if (args.length === 0) throw new Error("请提供 docker compose 子命令。");

const child = spawn("docker", [
  "compose",
  "--env-file",
  path.join(workspace, ".env"),
  "-f",
  path.join(root, "components/qq-runtime/compose.yml"),
  ...args
], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, SUNABOT_WORKSPACE: workspace }
});
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
