#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);
const args = process.argv.slice(2);
if (args.length === 0) throw new Error("请提供 docker compose 子命令。");

const child = spawn("docker", [
  "compose",
  "--env-file",
  path.join(workspace, ".env"),
  "-f",
  path.join(root, "deploy/docker/compose.yml"),
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
