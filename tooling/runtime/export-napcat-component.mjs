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
if (!outputOption) throw new Error("请使用 --output=<directory> 指定组件输出目录。");
if (process.platform !== "linux") throw new Error("NapCat Native 组件必须在 Linux/WSL 中导出。");

const lock = JSON.parse(
  await fsPromises.readFile(path.join(root, "components/component.lock.json"), "utf8")
);
const version = lock.components.napcat.version;
const image = option("image") || "sunabot-qq-runtime:local";
const outputDir = path.resolve(root, outputOption);
const archivePath = path.join(outputDir, `sunabot-napcat-${version}-linux-amd64.tar.gz`);
const checksumPath = `${archivePath}.sha256`;
const stage = path.join(outputDir, `.sunabot-napcat-${process.pid}`);
const container = `sunabot-component-export-${process.pid}`;

await fsPromises.mkdir(outputDir, { recursive: true });
if (!process.argv.includes("--force")) {
  for (const target of [archivePath, checksumPath]) {
    if (await exists(target)) throw new Error(`输出已存在：${target}。使用 --force 覆盖。`);
  }
}
await fsPromises.rm(stage, { recursive: true, force: true });
await fsPromises.mkdir(path.join(stage, "app"), { recursive: true });
await fsPromises.mkdir(path.join(stage, "opt"), { recursive: true });

let created = false;
try {
  const imageInfo = JSON.parse(await capture("docker", ["image", "inspect", image], root));
  const config = imageInfo[0]?.Config;
  if (config?.User !== "1000:1000") throw new Error("目标镜像不是锁定的非 root runtime user。");
  if (config?.Volumes && Object.keys(config.Volumes).length > 0) {
    throw new Error("目标镜像含有隐藏 volume，拒绝导出 Native 组件。");
  }

  await run("docker", ["create", "--name", container, "--entrypoint", "/bin/true", image], root);
  created = true;
  await run("docker", ["cp", `${container}:/opt/QQ`, path.join(stage, "opt/QQ")], root);
  await run("docker", ["cp", `${container}:/app/napcat`, path.join(stage, "app/napcat")], root);
  await run("docker", [
    "cp",
    `${container}:/app/napcat-default-config`,
    path.join(stage, "app/napcat-default-config")
  ], root);
  await fsPromises.rm(path.join(stage, "app/napcat/config"), { recursive: true, force: true });
  await fsPromises.writeFile(path.join(stage, "component-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    component: "napcat",
    version,
    platform: "linux/amd64",
    sourceImage: image,
    sourceDigest: lock.components.napcat.digest,
    qqVersion: lock.components.qq.version,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");

  await fsPromises.rm(archivePath, { force: true });
  await fsPromises.rm(checksumPath, { force: true });
  await run("tar", ["-czf", archivePath, "-C", stage, "."], root);
  const checksum = await sha256(archivePath);
  await fsPromises.writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`, "utf8");
  process.stdout.write(`${archivePath}\n${checksumPath}\n`);
} finally {
  if (created) await runAllowFailure("docker", ["rm", "-f", container], root);
  await fsPromises.rm(stage, { recursive: true, force: true });
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

async function runAllowFailure(command, args, cwd) {
  try {
    await run(command, args, cwd);
  } catch {
    // Cleanup is best effort; the original failure remains authoritative.
  }
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
