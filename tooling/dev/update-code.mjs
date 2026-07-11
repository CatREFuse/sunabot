#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const beforeLock = await digest("package-lock.json");
await run("git", ["diff", "--quiet"]);
await run("git", ["diff", "--cached", "--quiet"]);
await run("git", ["pull", "--ff-only"]);
const afterLock = await digest("package-lock.json");
if (beforeLock !== afterLock) await run(npmCommand(), ["ci"]);
await run(npmCommand(), ["run", "build"]);
console.log("业务代码已快进更新并构建；workspace 未被 Git 修改。请按部署方式重启 sunabot。");

async function digest(filePath) {
  const bytes = await fs.readFile(path.join(root, filePath));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 失败（${code}）`)));
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
