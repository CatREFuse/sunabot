import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const MAX_STDOUT_BUFFER_BYTES = 64 * 1024;
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
      stdio: ["pipe", "pipe", "ignore"]
    });
    let settled = false;
    let initialized = false;
    let refreshCompleted = false;
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("CODEX_AUTH_REFRESH_TIMEOUT"));
    }, timeoutMs);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const write = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.once("error", () => finish(new Error("CODEX_AUTH_REFRESH_UNAVAILABLE")));
    child.once("exit", () => {
      if (refreshCompleted) finish();
      else finish(new Error("CODEX_AUTH_REFRESH_FAILED"));
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
          child.stdin.end();
          finish(new Error("CODEX_AUTH_REFRESH_FAILED"));
          return;
        }
        refreshCompleted = true;
        child.stdin.end();
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
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && payload.exp * 1_000 <= Date.now() + Math.max(0, windowMs);
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
