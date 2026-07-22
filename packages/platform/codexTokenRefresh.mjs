import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const MAX_STDOUT_BUFFER_BYTES = 64 * 1024;
const MAX_STDERR_BUFFER_BYTES = 16 * 1024;
const CHILD_SHUTDOWN_GRACE_MS = 1_000;
const refreshes = new Map();

export async function ensureCodexAccessToken(options) {
  const authFile = path.resolve(options.authFile);
  const current = await readAccessToken(authFile);
  if (current && !jwtExpiresWithin(current, options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS)) {
    return current;
  }

  const active = refreshes.get(authFile);
  if (active) return active;

  const refresh = refreshAccessToken({
    ...options,
    authFile,
    codexHome: path.resolve(options.codexHome ?? path.dirname(authFile))
  }).finally(() => refreshes.delete(authFile));
  refreshes.set(authFile, refresh);
  return refresh;
}

async function refreshAccessToken(options) {
  await requestManagedRefresh(options);
  const token = await readAccessToken(options.authFile);
  if (!token || jwtExpiresWithin(token, 0)) {
    throw new Error("CODEX_AUTH_REFRESH_FAILED");
  }
  return token;
}

async function requestManagedRefresh(options) {
  const command = options.command?.trim() || "codex";
  const args = options.args ?? ["app-server"];
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.codexHome,
      env: {
        ...process.env,
        CODEX_HOME: options.codexHome,
        RUST_LOG: "error"
      },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    let initialized = false;
    let refreshCompleted = false;
    let desiredError;
    let stdout = "";
    let stderrBytes = 0;
    let shutdownTimer;
    let killTimer;
    const timer = setTimeout(() => {
      desiredError = new Error("CODEX_AUTH_REFRESH_TIMEOUT");
      terminateChild(child, "SIGTERM");
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), CHILD_SHUTDOWN_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (killTimer) clearTimeout(killTimer);
      if (desiredError) reject(desiredError);
      else if (!refreshCompleted) reject(new Error("CODEX_AUTH_REFRESH_FAILED"));
      else resolve();
    };

    const write = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.stdin.on("error", () => {
      if (!refreshCompleted && !desiredError) desiredError = new Error("CODEX_AUTH_REFRESH_FAILED");
    });
    child.once("error", () => {
      desiredError = new Error("CODEX_AUTH_REFRESH_UNAVAILABLE");
    });
    child.once("close", finish);
    child.stderr.on("data", (chunk) => {
      stderrBytes = Math.min(MAX_STDERR_BUFFER_BYTES, stderrBytes + Buffer.byteLength(chunk));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-MAX_STDOUT_BUFFER_BYTES);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id === 1 && !initialized) {
          initialized = true;
          write({ method: "initialized" });
          write({ method: "account/read", id: 2, params: { refreshToken: true } });
          continue;
        }
        if (message?.id !== 2) continue;
        if (message.error) {
          desiredError = new Error("CODEX_AUTH_REFRESH_FAILED");
          child.stdin.end();
          return;
        }
        refreshCompleted = true;
        child.stdin.end();
        shutdownTimer = setTimeout(() => {
          terminateChild(child, "SIGTERM");
          killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), CHILD_SHUTDOWN_GRACE_MS);
          killTimer.unref?.();
        }, CHILD_SHUTDOWN_GRACE_MS);
        shutdownTimer.unref?.();
      }
    });

    write({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "sunabot",
          title: "Sunabot",
          version: "0.1.0"
        },
        capabilities: {}
      }
    });
  });
}

async function readAccessToken(authFile) {
  try {
    const payload = JSON.parse(await fs.readFile(authFile, "utf8"));
    return String(payload?.tokens?.access_token ?? "").trim();
  } catch {
    return "";
  }
}

function jwtExpiresWithin(token, windowMs) {
  try {
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) return true;
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= 0 || payload.exp > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
      return true;
    }
    return payload.exp * 1_000 <= Date.now() + Math.max(0, windowMs);
  } catch {
    return true;
  }
}

function terminateChild(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* child already exited */ }
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
