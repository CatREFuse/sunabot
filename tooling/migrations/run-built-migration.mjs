#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";
import { validateReleaseManifest } from "../runtime/release-integrity.mjs";

const MIGRATIONS = new Set([
  "migrate-to-sqlite.mjs",
  "migrate-single-agent-to-multi-agent.mjs"
]);

const root = resolveProjectRoot(import.meta.url);
const [migration, ...migrationArgs] = process.argv.slice(2);
if (!MIGRATIONS.has(migration)) {
  throw new Error(`不支持的迁移入口：${migration || "空值"}。`);
}

const sourceCheckout = await exists(path.join(root, ".git"));
const releaseManifestPath = path.join(root, "release-manifest.json");
const releaseManifestExists = await exists(releaseManifestPath);
if (sourceCheckout) {
  await runNpm(["run", "build:api"]);
} else {
  if (!releaseManifestExists) throw new Error("发行包缺少 release-manifest.json。");
  await validateReleaseManifest({
    root,
    manifest: await readReleaseManifest(releaseManifestPath)
  });
}

for (const relative of ["dist/src/config.js", "dist/adapters/sqlite/applicationDataStore.js"]) {
  if (!await exists(path.join(root, relative))) {
    throw new Error(`缺少预构建迁移依赖：${relative}。`);
  }
}

const exit = await run(process.execPath, [path.join(root, "tooling/migrations", migration), ...migrationArgs], root);
if (exit.signal) process.kill(process.pid, exit.signal);
process.exitCode = exit.code ?? 1;

async function runNpm(args) {
  const command = process.env.npm_execpath ? process.execPath : "npm";
  const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
  const exit = await run(command, commandArgs, root);
  if (exit.code !== 0) throw new Error(`npm ${args.join(" ")} 失败（${exit.signal || exit.code}）。`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readReleaseManifest(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`发行清单无法读取：${error.message}`);
  }
}
