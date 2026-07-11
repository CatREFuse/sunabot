#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const releaseRoot = "/srv/sunabot";
const contract = JSON.parse(
  await fs.readFile(path.join(releaseRoot, "deploy/runtime-contract.json"), "utf8")
);
const workspace = path.resolve(process.env.SUNABOT_WORKSPACE ?? "");
const expectedWorkspace = path.resolve(contract.paths.workspace);
const shutdownTimeoutMs = contract.shutdownTimeoutSeconds * 1_000;
const statePath = path.join(workspace, contract.paths.temporary, "supervisor-state.json");
const startedAt = new Date().toISOString();
const managed = new Map();
let shuttingDown = false;
let stateWrite = Promise.resolve();

await preflight();
await prepareWorkspace();

const state = {
  schemaVersion: 1,
  runtimeId: contract.runtimeId,
  supervisorPid: process.pid,
  startedAt,
  status: "running",
  processes: {
    sunabot: processState("starting"),
    napcat: processState("waiting-for-api")
  }
};

await persistState();
startManaged("sunabot", {
  command: process.execPath,
  args: [path.join(releaseRoot, "dist/apps/api/main.js")],
  cwd: releaseRoot,
  restartDelayMs: 2_000,
  env: {
    NODE_ENV: "production",
    SUNABOT_WORKSPACE: workspace,
    SUNABOT_HOST: process.env.SUNABOT_HOST || "0.0.0.0",
    SUNABOT_PORT: String(process.env.SUNABOT_PORT || contract.network.apiPort)
  }
});
void startNapcatAfterApi();

process.once("SIGTERM", () => void shutdown(0, "SIGTERM"));
process.once("SIGINT", () => void shutdown(0, "SIGINT"));
process.once("uncaughtException", (error) => {
  log("supervisor", `uncaught exception: ${formatError(error)}`);
  void shutdown(1, "uncaughtException");
});
process.once("unhandledRejection", (error) => {
  log("supervisor", `unhandled rejection: ${formatError(error)}`);
  void shutdown(1, "unhandledRejection");
});

async function preflight() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`unsupported runtime platform: ${process.platform}/${process.arch}`);
  }
  if (!workspace || workspace !== expectedWorkspace) {
    throw new Error(`SUNABOT_WORKSPACE must be ${expectedWorkspace}`);
  }
  if (process.versions.node !== contract.nodeVersion) {
    throw new Error(
      `runtime contract requires Node ${contract.nodeVersion}; found ${process.versions.node}`
    );
  }
  await Promise.all([
    fs.access(path.join(releaseRoot, "dist/apps/api/main.js")),
    fs.access("/app/napcat/napcat.mjs"),
    fs.access("/opt/QQ/qq", 1)
  ]);
}

async function prepareWorkspace() {
  const directories = [
    path.dirname(contract.paths.config),
    path.dirname(contract.paths.database),
    path.dirname(contract.paths.sessionQueue),
    contract.paths.media,
    contract.paths.napcatState,
    contract.paths.napcatConfig,
    path.join(contract.paths.napcatState, "qq"),
    path.dirname(contract.paths.secrets),
    contract.paths.logs,
    contract.paths.temporary,
    contract.paths.cache,
    contract.paths.backups
  ];
  await Promise.all(
    directories.map((relative) => fs.mkdir(path.join(workspace, relative), {
      recursive: true,
      mode: 0o700
    }))
  );

  const napcatConfig = path.join(workspace, contract.paths.napcatConfig);
  if (!(await exists(path.join(napcatConfig, "napcat.json")))) {
    await fs.cp("/app/napcat-default-config", napcatConfig, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }

  const webuiToken = process.env.WEBUI_TOKEN?.trim();
  const webuiConfig = path.join(napcatConfig, "webui.json");
  if (webuiToken && !(await exists(webuiConfig))) {
    await atomicJson(webuiConfig, {
      host: "0.0.0.0",
      prefix: process.env.WEBUI_PREFIX?.trim() || "",
      port: contract.network.napcatWebuiPort,
      token: webuiToken,
      loginRate: 3
    });
  }
}

async function startNapcatAfterApi() {
  const ready = await waitForApi(60_000);
  if (shuttingDown) return;
  if (!ready) {
    log("supervisor", "Sunabot readiness timeout; starting NapCat so it can reconnect later");
  }
  const args = [
    "-a",
    "-s",
    "-screen 0 1080x760x16 +extension GLX +render",
    "/opt/QQ/qq",
    "--no-sandbox"
  ];
  const account = process.env.NAPCAT_ACCOUNT?.trim();
  if (account) args.push("-q", account);
  startManaged("napcat", {
    command: "/usr/bin/xvfb-run",
    args,
    cwd: "/app/napcat",
    restartDelayMs: 10_000,
    env: {
      HOME: "/app",
      XDG_CONFIG_HOME: "/app/.config",
      FFMPEG_PATH: "/usr/bin/ffmpeg"
    }
  });
}

function startManaged(name, spec) {
  if (shuttingDown) return;
  const previous = managed.get(name) ?? { restarts: 0 };
  if (previous.timer) clearTimeout(previous.timer);
  state.processes[name] = {
    ...state.processes[name],
    status: "starting",
    pid: null,
    startedAt: new Date().toISOString(),
    restartCount: previous.restarts
  };
  void persistState();

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...spec.env }
  });
  const record = { ...previous, child, spec, settled: false };
  managed.set(name, record);
  prefixStream(name, child.stdout, process.stdout);
  prefixStream(name, child.stderr, process.stderr);

  child.once("spawn", () => {
    state.processes[name] = {
      ...state.processes[name],
      status: "running",
      pid: child.pid
    };
    void persistState();
  });
  child.once("error", (error) => {
    log(name, `spawn failed: ${formatError(error)}`);
    settleManaged(name, null, null, error);
  });
  child.once("exit", (code, signal) => {
    settleManaged(name, code, signal);
  });
}

function settleManaged(name, code, signal, error) {
  const record = managed.get(name);
  if (!record || record.settled) return;
  record.settled = true;
  record.child = null;
  state.processes[name] = {
    ...state.processes[name],
    status: shuttingDown ? "stopped" : "restarting",
    pid: null,
    lastExitAt: new Date().toISOString(),
    lastExitCode: code,
    lastSignal: signal,
    lastError: error ? formatError(error) : null
  };
  void persistState();
  if (shuttingDown) return;

  record.restarts += 1;
  log(name, `exited (${signal || (code ?? "unknown")}); restart in ${record.spec.restartDelayMs}ms`);
  record.timer = setTimeout(() => startManaged(name, record.spec), record.spec.restartDelayMs);
  managed.set(name, record);
}

async function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  state.status = "stopping";
  state.stopReason = reason;
  state.stoppingAt = new Date().toISOString();
  for (const record of managed.values()) {
    if (record.timer) clearTimeout(record.timer);
  }
  await persistState();

  const running = [...managed.values()]
    .map((record) => record.child)
    .filter(Boolean);
  for (const child of running) signalGroup(child.pid, "SIGTERM");
  await Promise.race([
    Promise.all(running.map(waitForExit)),
    delay(shutdownTimeoutMs)
  ]);
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) signalGroup(child.pid, "SIGKILL");
  }
  state.status = "stopped";
  state.stoppedAt = new Date().toISOString();
  await persistState();
  process.exit(exitCode);
}

async function waitForApi(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const port = process.env.SUNABOT_PORT || contract.network.apiPort;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${contract.health.livenessPath}`, {
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return true;
    } catch {
      // The API is still starting. The supervisor retries with a fixed bound.
    }
    await delay(1_000);
  }
  return false;
}

function processState(status) {
  return {
    status,
    pid: null,
    startedAt: null,
    restartCount: 0,
    lastExitAt: null,
    lastExitCode: null,
    lastSignal: null,
    lastError: null
  };
}

function prefixStream(name, readable, writable) {
  if (!readable) return;
  let buffered = "";
  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) writable.write(`[${name}] ${line}\n`);
  });
  readable.on("end", () => {
    if (buffered) writable.write(`[${name}] ${buffered}\n`);
  });
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") log("supervisor", `failed to signal pid ${pid}: ${formatError(error)}`);
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function persistState() {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  stateWrite = stateWrite
    .catch(() => {})
    .then(async () => {
      const temporary = `${statePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, statePath);
    });
  return stateWrite;
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.rename(temporary, filePath);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function log(name, message) {
  process.stderr.write(`[${name}] ${message}\n`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
