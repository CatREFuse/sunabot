#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";
import {
  applyRetention,
  createRecoveryPoint,
  drillRecoveryPoint,
  restoreRecoveryPoint,
  verifyRecoveryPoint
} from "./sqlite-recovery.mjs";

const root = resolveProjectRoot(import.meta.url);
const [command = "help", ...rawArguments] = process.argv.slice(2);
const argumentsMap = parseArguments(rawArguments);

try {
  let result;
  if (command === "create") {
    const workspace = requiredWorkspace();
    result = await createRecoveryPoint({
      workspace,
      backupsRoot: optionalPath("backup-root"),
      quiesced: hasFlag("quiesced"),
      busyTimeoutMs: optionalInteger("busy-timeout-ms")
    });
    result = { ok: true, backupDirectory: result.directory, manifest: result.manifest };
  } else if (command === "verify") {
    result = await verifyRecoveryPoint(requiredPath("backup"));
  } else if (command === "restore") {
    result = await restoreRecoveryPoint({
      backupDirectory: requiredPath("backup"),
      targetWorkspace: requiredPath("target-workspace")
    });
  } else if (command === "prune") {
    const workspace = requiredWorkspace();
    result = await applyRetention({
      backupsRoot: optionalPath("backup-root") ?? path.join(workspace, "backups", "sqlite-recovery"),
      apply: hasFlag("apply"),
      hotDays: optionalInteger("hot-days"),
      archiveDays: optionalInteger("archive-days")
    });
  } else if (command === "drill") {
    result = await drillRecoveryPoint({
      backupDirectory: requiredPath("backup"),
      targetWorkspace: optionalPath("target-workspace"),
      reportPath: optionalPath("report")
    });
  } else {
    printUsage();
    process.exitCode = command === "help" ? 0 : 2;
  }
  if (result) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code ?? "RECOVERY_GATE_FAILED",
    message: error.message,
    details: error.details
  }, null, 2));
  process.exitCode = 1;
}

function parseArguments(values) {
  const output = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`无法识别参数：${token}`);
    const name = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) output.set(name, true);
    else {
      output.set(name, next);
      index += 1;
    }
  }
  return output;
}

function requiredWorkspace() {
  const value = argumentsMap.get("workspace") ?? process.env.SUNABOT_WORKSPACE;
  if (!value || value === true) throw new Error("请通过 --workspace 或 SUNABOT_WORKSPACE 指定 workspace。");
  return resolvePath(value);
}

function requiredPath(name) {
  const value = argumentsMap.get(name);
  if (!value || value === true) throw new Error(`缺少 --${name} PATH。`);
  return resolvePath(value);
}

function optionalPath(name) {
  const value = argumentsMap.get(name);
  return typeof value === "string" ? resolvePath(value) : undefined;
}

function optionalInteger(name) {
  const value = argumentsMap.get(name);
  if (value === undefined) return undefined;
  if (value === true || !/^\d+$/.test(value)) throw new Error(`--${name} 必须为正整数。`);
  return Number(value);
}

function hasFlag(name) {
  return argumentsMap.get(name) === true;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

function printUsage() {
  console.log(`用法：
  sqlite-recovery-cli.mjs create --workspace PATH --quiesced [--backup-root PATH]
  sqlite-recovery-cli.mjs verify --backup PATH
  sqlite-recovery-cli.mjs restore --backup PATH --target-workspace EMPTY_PATH
  sqlite-recovery-cli.mjs prune --workspace PATH [--apply] [--hot-days 7] [--archive-days 30]
  sqlite-recovery-cli.mjs drill --backup PATH [--report PATH] [--target-workspace EMPTY_PATH]

create 只接受已停服并完成写入静默的 workspace；prune 默认为 dry-run。`);
}
