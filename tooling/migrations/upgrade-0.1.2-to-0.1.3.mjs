#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../shared/paths.mjs";
import { createRecoveryPoint } from "../workspace/sqlite-recovery.mjs";

export const FROM_VERSION = "0.1.2";
export const TARGET_VERSION = "0.1.3";
export const PROMPT_MIGRATION_ID = "conversation-chat-media-v2";

const root = resolveProjectRoot(import.meta.url);
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "RELEASE_UPGRADE_FAILED",
      message: error?.message ?? String(error),
      serviceMayBeStopped: error?.serviceMayBeStopped === true
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const { command, workspace } = parseArguments(argv);
  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = command === "plan"
    ? await planReleaseUpgrade({ workspace })
    : await applyReleaseUpgrade({ workspace });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function planReleaseUpgrade(options) {
  const projectRoot = options.projectRoot ?? root;
  const versions = await verifyTargetRelease(projectRoot);
  const workspace = path.resolve(options.workspace);
  const workspaceIdentity = await inspectWorkspace(workspace);
  return {
    ok: true,
    command: "plan",
    fromVersion: FROM_VERSION,
    targetVersion: TARGET_VERSION,
    workspace,
    versions,
    workspaceIdentity,
    changesRequired: true,
    promptMigration: {
      id: PROMPT_MIGRATION_ID,
      mode: "startup-preserving",
      backupPolicy: "once"
    },
    databaseMigration: false,
    resourceMigration: false
  };
}

export async function applyReleaseUpgrade(options) {
  (options.assertNonRoot ?? assertNonRoot)();
  const projectRoot = options.projectRoot ?? root;
  const plan = await planReleaseUpgrade({ ...options, projectRoot });
  const run = options.runCommand ?? runCommand;
  const environment = {
    ...process.env,
    SUNABOT_WORKSPACE: plan.workspace
  };
  const launcher = path.join(projectRoot, "sunabot.sh");
  let serviceMayBeStopped = false;
  try {
    await run(launcher, ["down"], { cwd: projectRoot, env: environment });
    serviceMayBeStopped = true;
    const recoveryPoint = await (options.createRecoveryPoint ?? createRecoveryPoint)({
      workspace: plan.workspace,
      quiesced: true
    });
    await run(launcher, ["up"], { cwd: projectRoot, env: environment });
    serviceMayBeStopped = false;
    await run(launcher, ["status"], { cwd: projectRoot, env: environment });
    await run(launcher, ["doctor"], { cwd: projectRoot, env: environment });
    return {
      ...plan,
      command: "apply",
      recoveryPoint,
      promptMigration: {
        ...plan.promptMigration,
        appliedBy: "runtime-startup"
      },
      runtime: {
        started: true,
        status: "passed",
        doctor: "passed"
      }
    };
  } catch (error) {
    const result = upgradeError(
      "RELEASE_UPGRADE_FAILED",
      serviceMayBeStopped
        ? `升级失败，服务保持停止：${error?.message ?? String(error)}`
        : `升级失败：${error?.message ?? String(error)}`
    );
    result.serviceMayBeStopped = serviceMayBeStopped;
    throw result;
  }
}

export async function verifyTargetRelease(projectRoot = root) {
  const [
    packageManifest,
    packageLock,
    runtimeContract,
    releaseCatalog,
    dockerfile,
    compose
  ] = await Promise.all([
    readJson(path.join(projectRoot, "package.json")),
    readJson(path.join(projectRoot, "package-lock.json")),
    readJson(path.join(projectRoot, "deploy", "runtime-contract.json")),
    fs.readFile(path.join(projectRoot, "packages", "platform", "releaseCatalog.ts"), "utf8"),
    fs.readFile(path.join(projectRoot, "deploy", "docker", "Dockerfile"), "utf8"),
    fs.readFile(path.join(projectRoot, "deploy", "docker", "compose.yml"), "utf8")
  ]);
  const versions = {
    package: packageManifest.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version,
    runtimeContract: runtimeContract.releaseVersion,
    releaseCatalog: releaseCatalog.match(/CURRENT_RELEASE_VERSION = "([^"]+)"/)?.[1],
    dockerfile: dockerfile.match(/ARG SUNABOT_RELEASE_VERSION=([^\s]+)/)?.[1],
    compose: compose.match(/SUNABOT_RELEASE_VERSION:-([^}]+)}/)?.[1]
  };
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== TARGET_VERSION)
    .map(([name, version]) => `${name}=${version ?? "missing"}`);
  if (mismatches.length) {
    throw upgradeError(
      "TARGET_RELEASE_MISMATCH",
      `升级脚本需要完整的 ${TARGET_VERSION} 代码，当前版本不一致：${mismatches.join(", ")}`
    );
  }
  return versions;
}

async function inspectWorkspace(workspace) {
  const stats = await fs.lstat(workspace, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw upgradeError("WORKSPACE_INVALID", "workspace 必须是普通目录。");
  }
  const realPath = await fs.realpath(workspace);
  if (realPath !== workspace) {
    throw upgradeError("WORKSPACE_INVALID", "workspace 路径必须是规范绝对路径。");
  }
  await fs.access(path.join(workspace, "business", "config", "sunabot.json"));
  return {
    realPath,
    device: String(stats.dev),
    inode: String(stats.ino)
  };
}

function parseArguments(argv) {
  const [command = "help", ...tokens] = argv;
  if (!["plan", "apply", "help"].includes(command)) {
    throw upgradeError("ARGUMENT_INVALID", `未知命令：${command}`);
  }
  let workspace = process.env.SUNABOT_WORKSPACE ?? path.join(root, "workspace");
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "--workspace" || !tokens[index + 1]) {
      throw upgradeError("ARGUMENT_INVALID", `无法识别参数：${tokens[index]}`);
    }
    workspace = tokens[index + 1];
    index += 1;
  }
  if (!path.isAbsolute(workspace)) {
    throw upgradeError("ARGUMENT_INVALID", "--workspace 必须是绝对路径。");
  }
  return { command, workspace: path.normalize(workspace) };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(upgradeError(
        "RELEASE_UPGRADE_COMMAND_FAILED",
        `${path.basename(command)} ${args.join(" ")} 失败（${signal ?? code}）。`
      ));
    });
  });
}

function assertNonRoot() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw upgradeError("ROOT_EXECUTION_FORBIDDEN", "升级必须由拥有仓库和 workspace 的非 root 用户执行。");
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function usage() {
  return `用法：
  npm run upgrade:0.1.3 -- plan [--workspace /absolute/path]
  npm run upgrade:0.1.3 -- apply [--workspace /absolute/path]

plan 只读检查 0.1.3 代码与 workspace；apply 停服创建全 Agent SQLite 恢复点，
启动时保留式迁移聊天媒体系统提示词，随后运行 status 与 doctor。`;
}

function upgradeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
