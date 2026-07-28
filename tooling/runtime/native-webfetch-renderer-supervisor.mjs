#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const entry = process.env.SUNABOT_WEBFETCH_RENDERER_ENTRY?.trim();
if (!entry) throw new Error("WEBFETCH_RENDERER_ENTRY_REQUIRED");
const token = readToken();
let stopping = false;
let child;
let restartCount = 0;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    stopping = true;
    stopChild(child, signal);
  });
}

while (!stopping) {
  const startedAt = Date.now();
  child = spawnWorker();
  child.stdio[3].end(token);
  const result = await waitForExit(child);
  child = undefined;
  if (stopping) break;
  restartCount = Date.now() - startedAt >= 30_000 ? 0 : restartCount + 1;
  const delayMs = Math.min(10_000, 250 * (2 ** Math.min(restartCount, 5)));
  console.error(`WebFetch Renderer 异常退出（${safeExit(result)}），${delayMs}ms 后重启。`);
  await delay(delayMs);
}

token.fill(0);

function spawnWorker() {
  return spawn(process.execPath, [entry], {
    detached: false,
    env: workerEnvironment(),
    stdio: ["ignore", "inherit", "inherit", "pipe"]
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function readToken() {
  const raw = process.env.SUNABOT_WEBFETCH_RENDERER_TOKEN_FD?.trim();
  delete process.env.SUNABOT_WEBFETCH_RENDERER_TOKEN_FD;
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 64) {
    throw new Error("WEBFETCH_RENDERER_AUTH_INVALID");
  }
  const buffer = Buffer.alloc(128);
  try {
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
    const value = buffer.subarray(0, bytes).toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("WEBFETCH_RENDERER_AUTH_INVALID");
    return Buffer.from(value, "utf8");
  } finally {
    buffer.fill(0);
    fs.closeSync(fd);
  }
}

function workerEnvironment() {
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG || "C.UTF-8",
    NODE_ENV: "production",
    PATH: process.env.PATH,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    SUNABOT_WEBFETCH_CHROMIUM_EXECUTABLE: process.env.SUNABOT_WEBFETCH_CHROMIUM_EXECUTABLE,
    SUNABOT_WEBFETCH_CHROMIUM_SANDBOX: "1",
    SUNABOT_WEBFETCH_RENDERER_HOST: "127.0.0.1",
    SUNABOT_WEBFETCH_RENDERER_PORT: process.env.SUNABOT_WEBFETCH_RENDERER_PORT,
    SUNABOT_WEBFETCH_RENDERER_TOKEN_FD: "3",
    SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID: process.env.SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID,
    SUNABOT_WEBFETCH_RUNTIME_ISOLATION: process.env.SUNABOT_WEBFETCH_RUNTIME_ISOLATION,
    TMPDIR: process.env.TMPDIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR
  };
}

function stopChild(child, signal) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  try {
    child.kill(signal);
    if (signal !== "SIGKILL") {
      setTimeout(() => stopChild(child, "SIGKILL"), 2_000).unref();
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function safeExit(result) {
  if (result?.error) return "spawn_error";
  if (result?.signal) return String(result.signal);
  return `code_${Number.isInteger(result?.code) ? result.code : "unknown"}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
