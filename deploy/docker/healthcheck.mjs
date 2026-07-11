#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const releaseRoot = "/srv/sunabot";
const contract = JSON.parse(
  await fs.readFile(path.join(releaseRoot, "deploy/runtime-contract.json"), "utf8")
);
const workspace = path.resolve(process.env.SUNABOT_WORKSPACE ?? "");
const statePath = path.join(workspace, contract.paths.temporary, "supervisor-state.json");
const result = {
  ok: false,
  runtimeId: contract.runtimeId,
  layers: {
    supervisor: false,
    apiProcess: false,
    apiHttp: false
  }
};

try {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  result.layers.supervisor = state.status === "running" && processExists(state.supervisorPid);
  result.layers.apiProcess = state.processes?.sunabot?.status === "running"
    && processExists(state.processes.sunabot.pid);
  if (result.layers.apiProcess) {
    const port = process.env.SUNABOT_PORT || contract.network.apiPort;
    const response = await fetch(
      `http://127.0.0.1:${port}${contract.health.livenessPath}`,
      { signal: AbortSignal.timeout(3_000) }
    );
    result.layers.apiHttp = response.ok;
  }
  result.ok = Object.values(result.layers).every(Boolean);
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}

if (!result.ok || process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (!result.ok) process.exitCode = 1;

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
