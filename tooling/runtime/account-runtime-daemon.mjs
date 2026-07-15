#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { validateMultiAgentWorkspacePath } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const execFileAsync = promisify(execFile);
const root = resolveProjectRoot(import.meta.url);
const workspace = resolveWorkspace(root);
const requestsDirectory = path.join(workspace, "runtime/account-reconciler/requests");
const resultsDirectory = path.join(workspace, "runtime/account-reconciler/results");
let stopping = false;

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });
await validateMultiAgentWorkspacePath(workspace);
await fs.mkdir(requestsDirectory, { recursive: true, mode: 0o700 });
await fs.mkdir(resultsDirectory, { recursive: true, mode: 0o700 });

while (!stopping) {
  const entries = await fs.readdir(requestsDirectory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of entries.filter((entry) => /^[a-f0-9-]{36}\.json$/.test(entry)).sort()) {
    if (stopping) break;
    await processRequest(name).catch((error) => console.error("[account-reconciler] request failed", safeMessage(error)));
  }
  if (!stopping) await delay(200);
}

async function processRequest(name) {
  const requestPath = path.join(requestsDirectory, name);
  let request;
  try {
    request = JSON.parse(await fs.readFile(requestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const kind = request?.kind ?? "account-reconcile";
  const baseValid = request?.schemaVersion === 1
    && /^[a-f0-9-]{36}$/.test(request.requestId ?? "")
    && `${request.requestId}.json` === name;
  const accountValid = kind === "account-reconcile"
    && /^[A-Za-z0-9_-]{1,64}$/.test(request.accountId ?? "")
    && ["running", "stopped"].includes(request.desiredState);
  const connectedAccountIds = request.connectedAccountIds ?? [];
  const probeValid = kind === "runtime-probe"
    && Array.isArray(connectedAccountIds)
    && connectedAccountIds.every((accountId) => /^[A-Za-z0-9_-]{1,64}$/.test(accountId));
  if (!baseValid || (!accountValid && !probeValid)) {
    await fs.rm(requestPath, { force: true });
    return;
  }

  if (kind === "runtime-probe") {
    await processRuntimeProbe({ ...request, connectedAccountIds }, name, requestPath);
    return;
  }

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(process.execPath, [
      path.join(root, "tooling/runtime/launcher.mjs"),
      "reconcile-account",
      `--account=${request.accountId}`
    ], {
      cwd: root,
      env: { ...process.env, SUNABOT_WORKSPACE: workspace },
      maxBuffer: 2 * 1024 * 1024
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = stringField(error, "stdout");
    stderr = stringField(error, "stderr");
  }
  const state = parseState(`${stdout}\n${stderr}`, request.accountId) ?? {
    schemaVersion: 1,
    accountId: request.accountId,
    desiredState: request.desiredState,
    observedState: "unknown",
    reconcileRequired: true,
    lastError: safeMessage(stderr || "账号运行时调和失败。"),
    updatedAt: new Date().toISOString()
  };
  await atomicJson(path.join(resultsDirectory, name), {
    schemaVersion: 1,
    requestId: request.requestId,
    accountId: request.accountId,
    state
  });
  await fs.rm(requestPath, { force: true });
}

async function processRuntimeProbe(request, name, requestPath) {
  let facts;
  let error;
  try {
    const result = await execFileAsync(process.execPath, [
      path.join(root, "tooling/runtime/launcher.mjs"),
      "probe-runtime"
    ], {
      cwd: root,
      env: { ...process.env, SUNABOT_WORKSPACE: workspace },
      maxBuffer: 2 * 1024 * 1024
    });
    facts = withConnectedAccounts(
      parseFacts(`${result.stdout}\n${result.stderr}`),
      request.connectedAccountIds
    );
    if (!facts) error = "Host runtime probe 未返回有效结果。";
  } catch (cause) {
    error = safeMessage(stringField(cause, "stderr") || cause);
  }
  await atomicJson(path.join(resultsDirectory, name), {
    schemaVersion: 1,
    kind: "runtime-probe",
    requestId: request.requestId,
    ...(facts ? { facts } : { error: error ?? "Host runtime probe 失败。" })
  });
  await fs.rm(requestPath, { force: true });
}

function withConnectedAccounts(facts, connectedAccountIds) {
  if (!facts) return undefined;
  const connected = new Set(connectedAccountIds);
  return {
    ...facts,
    accounts: Array.isArray(facts.accounts)
      ? facts.accounts.map((account) => ({ ...account, connected: connected.has(String(account.id)) }))
      : []
  };
}

function parseState(output, accountId) {
  const prefix = "SUNABOT_ACCOUNT_RECONCILE=";
  const line = output.split(/\r?\n/).reverse().find((item) => item.startsWith(prefix));
  if (!line) return undefined;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    return value?.schemaVersion === 1 && value.accountId === accountId ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseFacts(output) {
  const prefix = "SUNABOT_RUNTIME_PROBE_FACTS=";
  const line = output.split(/\r?\n/).reverse().find((item) => item.startsWith(prefix));
  if (!line) return undefined;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

function stringField(error, key) {
  if (!error || typeof error !== "object") return "";
  const value = error[key];
  return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function safeMessage(value) {
  return (value instanceof Error ? value.message : String(value ?? "账号运行时调和失败。"))
    .replaceAll(/[\r\n]+/g, " ")
    .slice(0, 1_000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
