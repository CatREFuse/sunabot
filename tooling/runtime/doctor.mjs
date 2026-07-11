#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root, { requireExplicit: process.argv.includes("--production") });
const contract = JSON.parse(await fs.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8"));
const host = option("host") ?? contract.network.host;
const port = positivePort(option("port") ?? process.env.SUNABOT_PORT ?? contract.network.apiPort);
const expectation = process.argv.includes("--expect-running") ? "running" : "free";
const report = {
  ok: true,
  expectation,
  releaseRoot: root,
  workspace: await pathIdentity(workspace),
  databases: [],
  listener: await listenerState(host, port)
};

for (const relativePath of [
  contract.paths.database,
  contract.paths.sessionQueue,
  "artifacts/sunabot.sqlite",
  "artifacts/session-queue.sqlite"
]) {
  const identity = await pathIdentity(path.join(workspace, relativePath));
  if (identity.exists) report.databases.push(identity);
}

const databaseRealPaths = new Set(report.databases.map((item) => item.realPath));
if (databaseRealPaths.size !== report.databases.length) {
  report.ok = false;
  report.error = "多个数据库路径指向同一文件，workspace 布局存在别名。";
}
if (expectation === "free" && report.listener.listening) {
  report.ok = false;
  report.error = `${host}:${port} 已被占用，拒绝启动第二个 Sunabot 实例。`;
}
if (expectation === "running" && !report.listener.listening) {
  report.ok = false;
  report.error = `${host}:${port} 没有监听中的 Sunabot。`;
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function positivePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`无效端口：${value}`);
  return parsed;
}

async function listenerState(hostName, portNumber) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve({ host: hostName, port: portNumber, listening: true, code: error.code });
        return;
      }
      reject(error);
    });
    server.listen({ host: hostName, port: portNumber, exclusive: true }, () => {
      server.close(() => resolve({ host: hostName, port: portNumber, listening: false }));
    });
  });
}

async function pathIdentity(targetPath) {
  try {
    const [realPath, stats] = await Promise.all([fs.realpath(targetPath), fs.stat(targetPath)]);
    return {
      path: path.resolve(targetPath),
      realPath,
      exists: true,
      kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      device: stats.dev,
      inode: stats.ino
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { path: path.resolve(targetPath), exists: false };
  }
}

