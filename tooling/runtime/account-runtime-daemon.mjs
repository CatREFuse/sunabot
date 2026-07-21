#!/usr/bin/env node
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateMultiAgentWorkspacePath } from "../../packages/platform/multiAgentMigrationGate.mjs";
import { ensureSafeAbsoluteDirectory } from "../shared/safe-absolute-path.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";
import { processSignatureMatches, workspaceIdentity } from "./launcher-core.mjs";

const execFileAsync = promisify(execFile);
const root = resolveProjectRoot(import.meta.url);
const daemonEntry = fileURLToPath(import.meta.url);
const OWNER_SCHEMA_VERSION = 1;
const OWNER_KIND = "account-runtime-daemon-owner";
const MAX_OWNER_BYTES = 8 * 1024;
const PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;

export const ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH = "runtime/account-reconciler/owner.json";

export async function runAccountRuntimeDaemon(options = {}) {
  const environment = options.environment ?? process.env;
  const workspace = resolveWorkspace(root);
  const parsed = parseDaemonArguments(options.argv ?? process.argv.slice(2));
  await validateMultiAgentWorkspacePath(workspace);
  const expectedWorkspaceId = workspaceIdentity(workspace);
  if (parsed.workspaceId !== expectedWorkspaceId) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "account runtime daemon 的 workspace identity 与实际 workspace 不匹配。");
  }
  if (environment.SUNABOT_WORKSPACE?.trim() && path.resolve(environment.SUNABOT_WORKSPACE) !== workspace) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "account runtime daemon 的 workspace 环境与解析结果不匹配。");
  }

  const reconcilerDirectory = path.join(workspace, "runtime/account-reconciler");
  const requestsDirectory = path.join(reconcilerDirectory, "requests");
  const processingDirectory = path.join(reconcilerDirectory, "processing");
  const resultsDirectory = path.join(reconcilerDirectory, "results");
  await ensureSafeAbsoluteDirectory(reconcilerDirectory, { create: true, mode: 0o700 });
  const owner = await acquireAccountRuntimeOwner({
    workspace,
    workspaceId: expectedWorkspaceId,
    entry: daemonEntry,
    ownerToken: parsed.ownerToken
  });

  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await ensureSafeAbsoluteDirectory(requestsDirectory, { create: true, mode: 0o700 });
    await ensureSafeAbsoluteDirectory(processingDirectory, { create: true, mode: 0o700 });
    await ensureSafeAbsoluteDirectory(resultsDirectory, { create: true, mode: 0o700 });
    await recoverAbandonedClaims(processingDirectory, resultsDirectory);

    while (!stopping) {
      await assertAccountRuntimeOwnership(owner);
      const entries = await fs.readdir(requestsDirectory)
        .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
      for (const name of entries.filter((entry) => /^[a-f0-9-]{36}\.json$/.test(entry)).sort()) {
        if (stopping) break;
        await assertAccountRuntimeOwnership(owner);
        const claimed = await claimRequest(requestsDirectory, processingDirectory, name);
        if (!claimed) continue;
        await processRequest({
          name,
          requestPath: claimed,
          resultsDirectory,
          workspace
        }).catch((error) => console.error("[account-reconciler] request failed", safeMessage(error)));
      }
      if (!stopping) await delay(200);
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await releaseAccountRuntimeOwner(owner);
  }
}

export async function inspectAccountRuntimeOwner(options) {
  const workspace = path.resolve(options.workspace);
  const ownerPath = path.join(workspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
  const ownerDirectory = path.dirname(ownerPath);
  try {
    await ensureSafeAbsoluteDirectory(ownerDirectory);
  } catch (error) {
    if (await pathMissing(ownerDirectory)) return { status: "missing", ownerPath };
    return { status: "invalid", ownerPath, detail: safeMessage(error) };
  }

  let snapshot;
  try {
    snapshot = await readOwnerSnapshot(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", ownerPath };
    return { status: "invalid", ownerPath, detail: safeMessage(error) };
  }

  let record;
  try {
    record = validateOwnerRecord(JSON.parse(snapshot.content), {
      workspace,
      workspaceId: options.workspaceId,
      entry: options.entry
    });
    await assertOwnerEvidence(ownerPath, snapshot.identity, record);
  } catch (error) {
    return {
      status: "invalid",
      ownerPath,
      identity: snapshot.identity,
      detail: safeMessage(error)
    };
  }

  const observed = await observeAccountRuntimeProcess(record.pid, { workspace });
  if (!observed) {
    return { status: "stale", ownerPath, identity: snapshot.identity, record };
  }
  if (!accountRuntimeOwnerMatchesObservation(record, observed)) {
    return {
      status: "invalid",
      ownerPath,
      identity: snapshot.identity,
      record,
      observed,
      detail: `owner PID ${record.pid} 的进程身份与 owner 记录不匹配。`
    };
  }
  return { status: "running", ownerPath, identity: snapshot.identity, record, observed };
}

export async function listAccountRuntimeProcesses(options) {
  const workspace = path.resolve(options.workspace);
  const workspaceIdValue = options.workspaceId;
  const entry = path.resolve(options.entry);
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="], {
    maxBuffer: PROCESS_OUTPUT_BYTES
  });
  const pids = String(stdout)
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match && commandContainsEntry(match[2], entry))
    .map((match) => Number(match[1]));
  const observed = await Promise.all(pids.map((pid) => observeAccountRuntimeProcess(pid, { workspace })));
  return observed
    .filter(Boolean)
    .map((item) => classifyObservedDaemon(item, { workspaceId: workspaceIdValue, entry }))
    .filter((item) => item.belongsToWorkspace)
    .sort((left, right) => left.pid - right.pid);
}

export async function stopAccountRuntimeProcesses(options) {
  const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs) || 5_000, 30_000));
  const processes = [...options.processes];
  const verified = [];
  let identityError;
  for (const candidate of processes) {
    if (!candidate.safeToSignal) {
      identityError ??= daemonError(
        "ACCOUNT_RUNTIME_PROCESS_IDENTITY_INVALID",
        `账号调和 PID ${candidate.pid} 缺少可验证的 workspace、进程组或 owner 身份；未发送停止信号。`
      );
      continue;
    }
    const current = await observeAccountRuntimeProcess(candidate.pid, { workspace: options.workspace });
    if (!current) continue;
    const classified = classifyObservedDaemon(current, {
      workspaceId: options.workspaceId,
      entry: options.entry
    });
    if (!sameProcessSnapshot(candidate, classified) || !classified.safeToSignal) {
      identityError ??= daemonError(
        "ACCOUNT_RUNTIME_PROCESS_IDENTITY_CHANGED",
        `账号调和 PID ${candidate.pid} 在停止前发生变化；未发送停止信号。`
      );
      continue;
    }
    verified.push(classified);
  }

  for (const candidate of verified) signalProcessGroup(candidate, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(verified.map((item) => processAlive(item.pid)))).every((alive) => !alive)) break;
    await delay(50);
  }

  for (const candidate of verified) {
    if (!await processAlive(candidate.pid)) continue;
    const current = await observeAccountRuntimeProcess(candidate.pid, { workspace: options.workspace });
    const classified = current && classifyObservedDaemon(current, {
      workspaceId: options.workspaceId,
      entry: options.entry
    });
    if (!classified || !sameProcessSnapshot(candidate, classified) || !classified.safeToSignal) {
      identityError ??= daemonError(
        "ACCOUNT_RUNTIME_PROCESS_IDENTITY_CHANGED",
        `账号调和 PID ${candidate.pid} 在停止期间发生变化；未发送 SIGKILL。`
      );
      continue;
    }
    signalProcessGroup(classified, "SIGKILL");
  }

  const finalDeadline = Date.now() + 2_000;
  while (Date.now() < finalDeadline) {
    if ((await Promise.all(verified.map((item) => processAlive(item.pid)))).every((alive) => !alive)) {
      break;
    }
    await delay(25);
  }
  const alive = [];
  for (const candidate of verified) if (await processAlive(candidate.pid)) alive.push(candidate.pid);
  if (alive.length > 0) {
    throw daemonError("ACCOUNT_RUNTIME_PROCESS_STOP_TIMEOUT", `账号调和进程停止超时：${alive.join(", ")}。`);
  }
  if (identityError) throw identityError;
  return verified.map((item) => item.pid);
}

export async function removeStaleAccountRuntimeOwner(options) {
  const inspected = await inspectAccountRuntimeOwner(options);
  if (inspected.status === "missing") return false;
  if (inspected.status === "invalid") {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", inspected.detail ?? "账号调和 owner 记录无效。");
  }
  if (inspected.status === "running") {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_ACTIVE", `账号调和 owner PID ${inspected.record.pid} 仍在运行。`);
  }
  await removeOwnerSnapshot(inspected.ownerPath, inspected.identity, inspected.record);
  return true;
}

export async function quarantineInvalidAccountRuntimeOwner(options) {
  const inspected = await inspectAccountRuntimeOwner(options);
  if (inspected.status === "missing") return undefined;
  if (inspected.status !== "invalid") {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_NOT_INVALID", "仅允许隔离已确认无效的账号调和 owner。");
  }
  const processes = await listAccountRuntimeProcesses(options);
  if (processes.length > 0) {
    throw daemonError(
      "ACCOUNT_RUNTIME_OWNER_PROCESS_ACTIVE",
      `仍有 ${processes.length} 个同 workspace 账号调和进程；拒绝隔离 owner。`
    );
  }
  if (!inspected.identity) {
    throw daemonError(
      "ACCOUNT_RUNTIME_OWNER_INVALID",
      "无效 owner 缺少安全读取时绑定的 inode 身份；拒绝隔离。"
    );
  }
  const ownerDirectory = path.dirname(inspected.ownerPath);
  await ensureSafeAbsoluteDirectory(ownerDirectory);
  const quarantinePath = path.join(
    ownerDirectory,
    `.owner.invalid.${Date.now()}.${crypto.randomBytes(16).toString("hex")}.quarantine`
  );
  await claimOwnerPath({
    ownerPath: inspected.ownerPath,
    claimPath: quarantinePath,
    expectedIdentity: inspected.identity,
    ownerExpectation: {
      workspace: path.resolve(options.workspace),
      workspaceId: options.workspaceId,
      entry: path.resolve(options.entry)
    },
    changedDetail: "无效 owner 在隔离期间发生变化"
  });
  await syncDirectory(ownerDirectory);
  return quarantinePath;
}

export function accountRuntimeOwnerMatchesObservation(record, observed) {
  return Boolean(
    processSignatureMatches(record, observed)
    && Number(observed.pid) === record.pid
    && Number(observed.processGroup) === record.processGroup
    && record.processGroup === record.pid
    && commandHasArgument(observed.command, `--workspace-id=${record.workspaceId}`)
    && commandHasArgument(observed.command, `--owner-token=${record.ownerToken}`)
  );
}

async function acquireAccountRuntimeOwner(options) {
  const ownerPath = path.join(options.workspace, ACCOUNT_RUNTIME_OWNER_RELATIVE_PATH);
  const ownerDirectory = path.dirname(ownerPath);
  await ensureSafeAbsoluteDirectory(ownerDirectory, { create: true, mode: 0o700 });
  const observed = await observeAccountRuntimeProcess(process.pid, { workspace: options.workspace });
  if (!observed || observed.processGroup !== process.pid) {
    throw daemonError("ACCOUNT_RUNTIME_PROCESS_IDENTITY_INVALID", "无法确认 account runtime daemon 的独立进程组身份。");
  }
  const record = validateOwnerRecord({
    schemaVersion: OWNER_SCHEMA_VERSION,
    kind: OWNER_KIND,
    workspace: options.workspace,
    workspaceId: options.workspaceId,
    pid: process.pid,
    processGroup: process.pid,
    signature: observed.signature,
    entry: options.entry,
    ownerToken: options.ownerToken,
    startedAt: new Date().toISOString()
  }, options);
  if (!accountRuntimeOwnerMatchesObservation(record, observed)) {
    throw daemonError("ACCOUNT_RUNTIME_PROCESS_IDENTITY_INVALID", "account runtime daemon 的命令行身份与 owner token 不匹配。");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const evidencePath = ownerEvidencePath(ownerPath, record);
    let handle;
    let published = false;
    try {
      handle = await fs.open(evidencePath, ownerCreateFlags(), 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.link(evidencePath, ownerPath);
      published = true;
      await syncDirectory(ownerDirectory);
      const snapshot = await readOwnerSnapshot(ownerPath);
      const publishedRecord = validateOwnerRecord(JSON.parse(snapshot.content), options);
      if (publishedRecord.ownerToken !== record.ownerToken) {
        throw daemonError("ACCOUNT_RUNTIME_OWNER_CHANGED", "owner 原子发布后内容发生变化。 ");
      }
      await assertOwnerEvidence(ownerPath, snapshot.identity, publishedRecord);
      return { ...record, ownerPath, identity: snapshot.identity };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (published) throw error;
      const ownerMissing = await pathMissing(ownerPath);
      if (error?.code !== "EEXIST" || ownerMissing) {
        await fs.rm(evidencePath, { force: true }).catch(() => {});
      }
      if (error?.code !== "EEXIST") throw error;
      if (ownerMissing) continue;
      await fs.rm(evidencePath, { force: true }).catch(() => {});
      const existing = await inspectAccountRuntimeOwner(options);
      if (existing.status === "stale") {
        await removeOwnerSnapshot(existing.ownerPath, existing.identity, existing.record);
        continue;
      }
      if (existing.status === "running") {
        throw daemonError(
          "ACCOUNT_RUNTIME_OWNER_ACTIVE",
          `workspace 已有 account runtime daemon（PID ${existing.record.pid}）。`
        );
      }
      throw daemonError(
        "ACCOUNT_RUNTIME_OWNER_INVALID",
        existing.detail ?? "account runtime daemon owner 记录损坏；拒绝覆盖。"
      );
    }
  }
  throw daemonError("ACCOUNT_RUNTIME_OWNER_BUSY", "account runtime daemon owner 竞争未收敛。");
}

async function assertAccountRuntimeOwnership(owner) {
  const deadline = Date.now() + 2_000;
  do {
    const inspected = await inspectAccountRuntimeOwner({
      workspace: owner.workspace,
      workspaceId: owner.workspaceId,
      entry: owner.entry
    });
    if (inspected.status === "running") {
      if (sameOwnerLease(inspected.record, owner)) return;
      break;
    }
    if (Date.now() >= deadline) break;
    await delay(25);
  } while (true);
  throw daemonError("ACCOUNT_RUNTIME_OWNER_LOST", "account runtime daemon 已失去当前 workspace 的 owner 身份。");
}

async function releaseAccountRuntimeOwner(owner) {
  const inspected = await inspectAccountRuntimeOwner({
    workspace: owner.workspace,
    workspaceId: owner.workspaceId,
    entry: owner.entry
  });
  if (inspected.status === "missing") return;
  if (inspected.status !== "running" || !sameOwnerLease(inspected.record, owner)) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_LOST", "account runtime daemon owner 已变化；拒绝清理其他 owner。 ");
  }
  await removeOwnerSnapshot(inspected.ownerPath, inspected.identity, inspected.record);
}

async function claimRequest(requestsDirectory, processingDirectory, name) {
  const source = path.join(requestsDirectory, name);
  const target = path.join(processingDirectory, name);
  try {
    await fs.rename(source, target);
    return target;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function recoverAbandonedClaims(processingDirectory, resultsDirectory) {
  const names = (await fs.readdir(processingDirectory))
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .sort();
  for (const name of names) {
    const requestPath = path.join(processingDirectory, name);
    const resultPath = path.join(resultsDirectory, name);
    if (!await pathMissing(resultPath)) {
      await fs.rm(requestPath, { force: true });
      continue;
    }
    let request;
    try {
      request = JSON.parse(await fs.readFile(requestPath, "utf8"));
    } catch {
      await fs.rm(requestPath, { force: true });
      continue;
    }
    if (request?.schemaVersion !== 1 || `${request.requestId}.json` !== name) {
      await fs.rm(requestPath, { force: true });
      continue;
    }
    if (request.kind === "runtime-probe") {
      await atomicJson(resultPath, {
        schemaVersion: 1,
        kind: "runtime-probe",
        requestId: request.requestId,
        error: "Host runtime probe 的原 owner 在 claim 后退出；为避免重复执行，本请求已失败关闭。"
      });
    } else if (/^[A-Za-z0-9_-]{1,64}$/.test(request.accountId ?? "")
      && ["running", "stopped"].includes(request.desiredState)) {
      await atomicJson(resultPath, {
        schemaVersion: 1,
        requestId: request.requestId,
        accountId: request.accountId,
        state: {
          schemaVersion: 1,
          accountId: request.accountId,
          desiredState: request.desiredState,
          observedState: "unknown",
          reconcileRequired: true,
          lastError: "账号调和原 owner 在 claim 后退出；为避免重复执行，本请求已失败关闭。",
          updatedAt: new Date().toISOString()
        }
      });
    }
    await fs.rm(requestPath, { force: true });
  }
}

async function processRequest(options) {
  const { name, requestPath, resultsDirectory, workspace } = options;
  let request;
  try {
    request = JSON.parse(await fs.readFile(requestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    await fs.rm(requestPath, { force: true });
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
    await processRuntimeProbe({ ...request, connectedAccountIds }, name, requestPath, resultsDirectory, workspace);
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
      maxBuffer: PROCESS_OUTPUT_BYTES
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

async function processRuntimeProbe(request, name, requestPath, resultsDirectory, workspace) {
  let facts;
  let error;
  try {
    const result = await execFileAsync(process.execPath, [
      path.join(root, "tooling/runtime/launcher.mjs"),
      "probe-runtime"
    ], {
      cwd: root,
      env: { ...process.env, SUNABOT_WORKSPACE: workspace },
      maxBuffer: PROCESS_OUTPUT_BYTES
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

function parseDaemonArguments(argv) {
  let workspaceIdValue;
  let ownerToken;
  for (const value of argv) {
    if (value.startsWith("--workspace-id=")) {
      if (workspaceIdValue != null) throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "workspace-id 重复。");
      workspaceIdValue = value.slice("--workspace-id=".length);
      continue;
    }
    if (value.startsWith("--owner-token=")) {
      if (ownerToken != null) throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner-token 重复。");
      ownerToken = value.slice("--owner-token=".length);
      continue;
    }
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", `不支持的 account runtime daemon 参数：${value}。`);
  }
  if (!/^[a-f0-9]{16}$/.test(workspaceIdValue ?? "")) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "account runtime daemon 缺少合法 workspace-id。");
  }
  if (!/^[a-f0-9]{64}$/.test(ownerToken ?? "")) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "account runtime daemon 缺少合法 owner-token。");
  }
  return { workspaceId: workspaceIdValue, ownerToken };
}

function validateOwnerRecord(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 必须是 JSON 对象。");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "entry",
    "kind",
    "ownerToken",
    "pid",
    "processGroup",
    "schemaVersion",
    "signature",
    "startedAt",
    "workspace",
    "workspaceId"
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 字段集合无效。");
  }
  if (value.schemaVersion !== OWNER_SCHEMA_VERSION || value.kind !== OWNER_KIND) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 版本或类型无效。");
  }
  if (value.workspace !== path.resolve(expected.workspace) || value.workspaceId !== expected.workspaceId) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner workspace 绑定无效。");
  }
  if (value.entry !== path.resolve(expected.entry)) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 入口绑定无效。");
  }
  if (!Number.isInteger(value.pid) || value.pid <= 1 || value.processGroup !== value.pid) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner PID 或进程组无效。");
  }
  if (typeof value.signature !== "string" || value.signature.length < 1 || value.signature.length > 256) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 进程签名无效。");
  }
  if (!/^[a-f0-9]{64}$/.test(value.ownerToken)) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner token 无效。");
  }
  if (!Number.isFinite(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 启动时间无效。");
  }
  return value;
}

function classifyObservedDaemon(observed, options) {
  const declaredWorkspaceId = argumentValue(observed.command, "--workspace-id=");
  const ownerToken = argumentValue(observed.command, "--owner-token=");
  const currentFormat = declaredWorkspaceId != null || ownerToken != null;
  const identityMatches = declaredWorkspaceId === options.workspaceId && /^[a-f0-9]{64}$/.test(ownerToken ?? "");
  const legacyMatches = !currentFormat && observed.environmentMatchesWorkspace;
  const belongsToWorkspace = identityMatches || observed.environmentMatchesWorkspace;
  return {
    ...observed,
    entry: options.entry,
    workspaceId: options.workspaceId,
    ownerToken: /^[a-f0-9]{64}$/.test(ownerToken ?? "") ? ownerToken : undefined,
    legacy: legacyMatches,
    belongsToWorkspace,
    safeToSignal: Boolean(
      belongsToWorkspace
      && observed.signature
      && observed.processGroup === observed.pid
      && commandContainsEntry(observed.command, options.entry)
      && (identityMatches || legacyMatches)
    )
  };
}

export async function observeAccountRuntimeProcess(pid, options = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 1 || !await processAlive(numericPid)) return null;
  try {
    const [{ stdout: signature }, { stdout: command }, { stdout: processGroup }, environmentMatchesWorkspace] = await Promise.all([
      execFileAsync("ps", ["-p", String(numericPid), "-o", "lstart="], { maxBuffer: PROCESS_OUTPUT_BYTES }),
      execFileAsync("ps", ["-p", String(numericPid), "-o", "command="], { maxBuffer: PROCESS_OUTPUT_BYTES }),
      execFileAsync("ps", ["-p", String(numericPid), "-o", "pgid="], { maxBuffer: PROCESS_OUTPUT_BYTES }),
      options.workspace
        ? processEnvironmentMatchesWorkspace(numericPid, path.resolve(options.workspace))
        : Promise.resolve(false)
    ]);
    return {
      pid: numericPid,
      signature: String(signature).trim(),
      command: String(command).trim(),
      processGroup: Number(String(processGroup).trim()),
      environmentMatchesWorkspace
    };
  } catch {
    return await processAlive(numericPid)
      ? { pid: numericPid, signature: "", command: "", processGroup: 0, environmentMatchesWorkspace: false }
      : null;
  }
}

async function readOwnerSnapshot(ownerPath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(ownerPath, flags);
  try {
    const before = await handle.stat();
    assertOwnerFileStat(before);
    if (before.size > MAX_OWNER_BYTES) {
      throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 文件超过大小上限。");
    }
    const raw = await handle.readFile();
    const after = await handle.stat();
    assertOwnerFileStat(after);
    if (!sameOwnerFileSnapshot(before, after)) {
      throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 文件在读取期间发生变化。");
    }
    return { content: raw.toString("utf8"), raw, identity: fileIdentity(before) };
  } finally {
    await handle.close();
  }
}

function assertOwnerFileStat(stat) {
  if (!stat.isFile() || stat.isSymbolicLink?.() || stat.nlink < 1 || stat.nlink > 2) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 必须是至多双链接的普通文件。");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 权限必须拒绝 group/other 访问。");
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 不属于当前运行用户。");
  }
}

async function assertOwnerEvidence(ownerPath, expectedIdentity, record) {
  const matches = await matchingOwnerEvidencePaths(ownerPath, record, expectedIdentity);
  if (matches.length !== 1) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 原子发布 evidence 无效。");
  }
  const evidencePath = matches[0];
  const evidence = await fs.lstat(evidencePath);
  if (!evidence.isFile()
    || evidence.isSymbolicLink()
    || evidence.nlink !== 2
    || !sameFileIdentity(evidence, expectedIdentity)
    || (evidence.mode & 0o077) !== 0
    || (process.getuid && evidence.uid !== process.getuid())) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner 原子发布 evidence 无效。");
  }
  return evidencePath;
}

async function matchingOwnerEvidencePaths(ownerPath, record, expectedIdentity) {
  const ownerDirectory = path.dirname(ownerPath);
  const canonicalName = path.basename(ownerEvidencePath(ownerPath, record));
  const recoveryPattern = new RegExp(
    `^${escapeRegExp(`.owner.${record.pid}.${record.ownerToken}`)}\\.recovery\\.[a-f0-9]{64}\\.evidence$`,
    "u"
  );
  const names = await fs.readdir(ownerDirectory);
  const matches = [];
  for (const name of names) {
    if (name !== canonicalName && !recoveryPattern.test(name)) continue;
    const candidate = path.join(ownerDirectory, name);
    try {
      const stat = await fs.lstat(candidate);
      if (sameFileIdentity(stat, expectedIdentity)) matches.push(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return matches;
}

async function removeOwnerSnapshot(ownerPath, expectedIdentity, record) {
  const ownerDirectory = path.dirname(ownerPath);
  await ensureSafeAbsoluteDirectory(ownerDirectory);
  const tombstone = path.join(ownerDirectory, `.owner.${process.pid}.${crypto.randomBytes(16).toString("hex")}.stale`);
  await claimOwnerPath({
    ownerPath,
    claimPath: tombstone,
    expectedIdentity,
    ownerExpectation: {
      workspace: record.workspace,
      workspaceId: record.workspaceId,
      entry: record.entry
    },
    changedDetail: "owner 在清理前发生变化"
  });
  let evidencePath;
  try {
    evidencePath = await assertOwnerEvidence(ownerPath, expectedIdentity, record);
  } catch (error) {
    const restored = await republishClaimedOwnerWithoutOverwrite({
      claimPath: tombstone,
      ownerPath,
      ownerExpectation: {
        workspace: record.workspace,
        workspaceId: record.workspaceId,
        entry: record.entry
      }
    });
    if (!restored) {
      throw daemonError(
        "ACCOUNT_RUNTIME_OWNER_CHANGED",
        `${safeMessage(error)} ownerPath 已被占用；原 owner 保留在 ${tombstone}。`
      );
    }
    throw error;
  }
  await fs.unlink(tombstone);
  await fs.unlink(evidencePath);
  await syncDirectory(ownerDirectory);
}

async function claimOwnerPath(options) {
  if (!options.expectedIdentity) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_INVALID", "owner claim 缺少预期 inode 身份。");
  }
  try {
    await fs.rename(options.ownerPath, options.claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw daemonError("ACCOUNT_RUNTIME_OWNER_CHANGED", `${options.changedDetail}；ownerPath 已不存在。`);
    }
    throw error;
  }

  let claimed;
  try {
    claimed = await fs.lstat(options.claimPath);
  } catch (error) {
    const restored = await republishClaimedOwnerWithoutOverwrite({
      claimPath: options.claimPath,
      ownerPath: options.ownerPath,
      ownerExpectation: options.ownerExpectation
    })
      .catch(() => false);
    throw daemonError(
      "ACCOUNT_RUNTIME_OWNER_CHANGED",
      `${options.changedDetail}；无法复验 claim inode${restored ? "，已恢复 ownerPath" : "，claim 已保留"}。${safeMessage(error)}`
    );
  }
  if (sameFileIdentity(claimed, options.expectedIdentity)) return claimed;

  const restored = await republishClaimedOwnerWithoutOverwrite({
    claimPath: options.claimPath,
    ownerPath: options.ownerPath,
    ownerExpectation: options.ownerExpectation
  });
  throw daemonError(
    "ACCOUNT_RUNTIME_OWNER_CHANGED",
    `${options.changedDetail}；移动到 claim 的 inode 不匹配${restored ? "，已原子恢复 ownerPath" : `，ownerPath 已被占用且 claim 保留在 ${options.claimPath}`}。`
  );
}

async function republishClaimedOwnerWithoutOverwrite(options) {
  const snapshot = await readOwnerSnapshot(options.claimPath);
  const record = validateOwnerRecord(JSON.parse(snapshot.content), options.ownerExpectation);
  const ownerDirectory = path.dirname(options.ownerPath);
  const evidencePath = recoveryOwnerEvidencePath(options.ownerPath, record);
  let handle;
  let evidenceCreated = false;
  try {
    handle = await fs.open(evidencePath, ownerCreateFlags(), 0o600);
    evidenceCreated = true;
    await handle.writeFile(snapshot.raw);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (evidenceCreated) await fs.rm(evidencePath, { force: true }).catch(() => {});
    throw error;
  }

  try {
    await fs.link(evidencePath, options.ownerPath);
  } catch (error) {
    await fs.rm(evidencePath, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  await syncDirectory(ownerDirectory);
  const published = await readOwnerSnapshot(options.ownerPath);
  const publishedRecord = validateOwnerRecord(JSON.parse(published.content), options.ownerExpectation);
  if (publishedRecord.ownerToken !== record.ownerToken || !published.raw.equals(snapshot.raw)) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_CHANGED", "恢复发布后的 owner 内容发生变化；已保留新 owner 与 evidence。");
  }
  const publishedEvidence = await assertOwnerEvidence(options.ownerPath, published.identity, publishedRecord);
  if (publishedEvidence !== evidencePath) {
    throw daemonError("ACCOUNT_RUNTIME_OWNER_CHANGED", "恢复发布后的 owner evidence 身份不一致；已保留全部路径。");
  }
  await cleanupClaimedOwnerArtifacts({
    claimPath: options.claimPath,
    claimIdentity: snapshot.identity,
    ownerPath: options.ownerPath,
    record,
    publishedEvidence: evidencePath
  });
  return true;
}

async function cleanupClaimedOwnerArtifacts(options) {
  const candidates = [
    options.claimPath,
    ...await matchingOwnerEvidencePaths(options.ownerPath, options.record, options.claimIdentity)
  ];
  for (const candidate of new Set(candidates)) {
    if (candidate === options.publishedEvidence) continue;
    try {
      const stat = await fs.lstat(candidate);
      if (!sameFileIdentity(stat, options.claimIdentity)) continue;
      await fs.unlink(candidate);
    } catch {}
  }
  await syncDirectory(path.dirname(options.ownerPath)).catch(() => {});
}

function ownerEvidencePath(ownerPath, record) {
  return path.join(path.dirname(ownerPath), `.owner.${record.pid}.${record.ownerToken}.evidence`);
}

function recoveryOwnerEvidencePath(ownerPath, record) {
  return path.join(
    path.dirname(ownerPath),
    `.owner.${record.pid}.${record.ownerToken}.recovery.${crypto.randomBytes(32).toString("hex")}.evidence`
  );
}

function ownerCreateFlags() {
  return fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
}

function fileIdentity(stat) {
  return { dev: Number(stat.dev), ino: Number(stat.ino), size: Number(stat.size) };
}

function sameFileIdentity(left, right) {
  return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino);
}

function sameOwnerLease(left, right) {
  return Boolean(
    left?.ownerToken === right?.ownerToken
    && left?.pid === right?.pid
    && left?.processGroup === right?.processGroup
    && left?.signature === right?.signature
    && left?.workspace === right?.workspace
    && left?.workspaceId === right?.workspaceId
    && left?.entry === right?.entry
    && left?.startedAt === right?.startedAt
  );
}

function sameOwnerFileSnapshot(left, right) {
  return Boolean(
    sameFileIdentity(left, right)
    && Number(left.size) === Number(right.size)
    && Number(left.mode) === Number(right.mode)
    && Number(left.nlink) === Number(right.nlink)
    && Number(left.uid) === Number(right.uid)
    && Number(left.gid) === Number(right.gid)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs)
  );
}

function sameProcessSnapshot(left, right) {
  return Boolean(
    right
    && left.pid === right.pid
    && left.signature === right.signature
    && left.command === right.command
    && left.processGroup === right.processGroup
    && left.belongsToWorkspace === right.belongsToWorkspace
  );
}

function signalProcessGroup(candidate, signal) {
  if (!candidate.safeToSignal || candidate.processGroup !== candidate.pid) {
    throw daemonError("ACCOUNT_RUNTIME_PROCESS_IDENTITY_INVALID", `账号调和 PID ${candidate.pid} 的进程组身份无效。`);
  }
  try {
    process.kill(-candidate.processGroup, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function commandContainsEntry(command, entry) {
  const escaped = escapeRegExp(path.resolve(entry));
  return new RegExp(`^\\S*(?:node|nodejs)(?:\\.exe)?\\s+${escaped}(?=$|\\s)`, "u")
    .test(String(command ?? ""));
}

function commandHasArgument(command, argument) {
  const escaped = escapeRegExp(argument);
  return new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`, "u").test(String(command ?? ""));
}

function argumentValue(command, prefix) {
  const escaped = escapeRegExp(prefix);
  const match = new RegExp(`(?:^|\\s)${escaped}([^\\s]+)(?=$|\\s)`, "u").exec(String(command ?? ""));
  return match?.[1];
}

async function processEnvironmentMatchesWorkspace(pid, workspace) {
  let output;
  try {
    const result = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], {
      encoding: "buffer",
      maxBuffer: PROCESS_OUTPUT_BYTES
    });
    output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const needle = Buffer.from(`SUNABOT_WORKSPACE=${workspace}`, "utf8");
    for (let offset = output.indexOf(needle); offset !== -1; offset = output.indexOf(needle, offset + 1)) {
      const before = offset === 0 ? 0x20 : output[offset - 1];
      const afterIndex = offset + needle.length;
      const after = afterIndex >= output.length ? 0x20 : output[afterIndex];
      if (isAsciiWhitespace(before) && isAsciiWhitespace(after)) return true;
    }
    return false;
  } catch (error) {
    if (Buffer.isBuffer(error?.stdout)) error.stdout.fill(0);
    if (Buffer.isBuffer(error?.stderr)) error.stderr.fill(0);
    return false;
  } finally {
    output?.fill(0);
  }
}

function isAsciiWhitespace(value) {
  return value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await fs.rename(temporary, filePath);
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

async function pathMissing(candidate) {
  try {
    await fs.lstat(candidate);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

async function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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

function daemonError(code, detail) {
  const error = new Error(`${code}：${detail}`);
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const direct = process.argv[1] ? await isDirectEntrypoint(process.argv[1]) : false;
if (direct) {
  await runAccountRuntimeDaemon().catch((error) => {
    console.error(safeMessage(error));
    process.exitCode = 1;
  });
}

async function isDirectEntrypoint(candidate) {
  const invoked = await fs.realpath(path.resolve(candidate)).catch(() => path.resolve(candidate));
  const current = await fs.realpath(daemonEntry).catch(() => daemonEntry);
  return pathToFileURL(invoked).href === pathToFileURL(current).href;
}
