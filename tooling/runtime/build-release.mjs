#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const outputOption = option("output");
if (!outputOption) {
  throw new Error("请使用 --output=<directory> 指定 release artifact 输出目录。");
}
if (process.platform !== "linux") {
  throw new Error("Native release artifact 必须在 Linux/WSL 中构建。");
}

const contract = JSON.parse(
  await fsPromises.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8")
);
if (process.versions.node !== contract.nodeVersion) {
  throw new Error(`需要 Node ${contract.nodeVersion}，当前为 ${process.versions.node}。`);
}

const outputDir = path.resolve(root, outputOption);
const archivePath = path.join(outputDir, `sunabot-${contract.releaseVersion}-linux-amd64.tar.gz`);
const checksumPath = `${archivePath}.sha256`;
const stage = path.join(outputDir, `.sunabot-release-${process.pid}`);
const requiredBuildFiles = [
  "dist/apps/api/main.js",
  "apps/admin-web/dist/index.html"
];
for (const relative of requiredBuildFiles) {
  await fsPromises.access(path.join(root, relative));
}

await fsPromises.mkdir(outputDir, { recursive: true });
if (!process.argv.includes("--force")) {
  for (const target of [archivePath, checksumPath]) {
    if (await exists(target)) throw new Error(`输出已存在：${target}。使用 --force 覆盖。`);
  }
}
await fsPromises.rm(stage, { recursive: true, force: true });
await fsPromises.mkdir(stage, { recursive: true, mode: 0o755 });

try {
  for (const relative of [
    "AGENTS.md",
    "package.json",
    "package-lock.json",
    "dist",
    "apps/admin-web/dist",
    "deploy/runtime-contract.json",
    "deploy/runtime-contract.schema.json",
    "deploy/native",
    "tooling/shared",
    "tooling/runtime",
    "components/component.lock.json",
    "components/component-lock.schema.json"
  ]) {
    await copy(relative);
  }

  await run(process.env.npm_execpath ? process.execPath : "npm", [
    ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
    "ci",
    "--omit=dev"
  ], stage);

  const commit = (await capture("git", ["rev-parse", "HEAD"], root)).trim();
  await fsPromises.writeFile(path.join(stage, "release-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    runtimeId: contract.runtimeId,
    releaseVersion: contract.releaseVersion,
    platform: "linux/amd64",
    nodeVersion: contract.nodeVersion,
    sourceCommit: commit,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });

  await fsPromises.rm(archivePath, { force: true });
  await fsPromises.rm(checksumPath, { force: true });
  await run("tar", ["-czf", archivePath, "-C", stage, "."], root);
  const checksum = await sha256(archivePath);
  await fsPromises.writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`, "utf8");
  process.stdout.write(`${archivePath}\n${checksumPath}\n`);
} finally {
  await fsPromises.rm(stage, { recursive: true, force: true });
}

async function copy(relative) {
  const source = path.join(root, relative);
  const destination = path.join(stage, relative);
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  await fsPromises.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败（${signal || code}）。`));
    });
  });
}

function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} 失败（${signal || code}）。`));
    });
  });
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function exists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
