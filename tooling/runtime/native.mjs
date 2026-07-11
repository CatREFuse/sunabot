#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { resolveProjectRoot } from "../shared/paths.mjs";
import { ensureNapcatCacheLink } from "../../packages/platform/napcatRuntimeLayout.mjs";

const root = resolveProjectRoot(import.meta.url);
const contract = JSON.parse(
  await fsPromises.readFile(path.join(root, "deploy/runtime-contract.json"), "utf8")
);
const lock = JSON.parse(
  await fsPromises.readFile(path.join(root, contract.componentsLock), "utf8")
);
const command = process.argv[2];
const target = contract.native.targetUnit;
const releaseBase = path.dirname(contract.paths.installPrefix);
const componentBase = "/opt/sunabot/components/napcat";
const workspace = contract.paths.workspace;
const nativeUser = contract.runtimeUsers.native.name;

switch (command) {
  case "install":
  case "upgrade":
    await install();
    break;
  case "rollback":
    await rollback();
    break;
  case "start":
  case "stop":
  case "restart":
    requireRoot();
    await run("systemctl", [command, target]);
    break;
  case "status":
    await run("systemctl", ["status", "--no-pager", target]);
    break;
  case "doctor":
    await run(process.execPath, [
      path.join(contract.paths.installPrefix, "tooling/runtime/doctor.mjs"),
      "--production",
      "--expect-running"
    ], { env: { ...process.env, SUNABOT_WORKSPACE: workspace } });
    break;
  case "uninstall":
    await uninstall();
    break;
  default:
    process.stderr.write(
      "用法：native.mjs <install|upgrade|rollback|start|stop|restart|status|doctor|uninstall> [options]\n"
    );
    process.exitCode = 2;
}

async function install() {
  requireRoot();
  assertLinuxRuntime();
  const releaseArchive = requiredOption("release-archive");
  const componentArchive = requiredOption("napcat-archive");
  await Promise.all([verifyArchive(releaseArchive), verifyArchive(componentArchive)]);
  await ensureNativeDependencies();
  await ensureRuntimeUser();
  await prepareWorkspace();

  const releaseVersion = contract.releaseVersion;
  const componentVersion = lock.components.napcat.version;
  const releaseFinal = path.join(releaseBase, releaseVersion);
  const componentFinal = path.join(componentBase, componentVersion);
  const releaseStage = `${releaseFinal}.install-${process.pid}`;
  const componentStage = `${componentFinal}.install-${process.pid}`;
  await fsPromises.mkdir(releaseBase, { recursive: true });
  await fsPromises.mkdir(componentBase, { recursive: true });
  await fsPromises.rm(releaseStage, { recursive: true, force: true });
  await fsPromises.rm(componentStage, { recursive: true, force: true });
  await fsPromises.mkdir(releaseStage, { recursive: true });
  await fsPromises.mkdir(componentStage, { recursive: true });

  try {
    await run("tar", ["-xzf", path.resolve(releaseArchive), "-C", releaseStage]);
    await run("tar", ["-xzf", path.resolve(componentArchive), "-C", componentStage]);
    const releaseManifest = await readJson(path.join(releaseStage, "release-manifest.json"));
    const componentManifest = await readJson(path.join(componentStage, "component-manifest.json"));
    validateReleaseManifest(releaseManifest, releaseVersion);
    if (componentManifest.version !== componentVersion || componentManifest.platform !== "linux/amd64") {
      throw new Error("NapCat component artifact 与 component lock 不匹配。");
    }
    await Promise.all([
      fsPromises.access(path.join(releaseStage, "dist/apps/api/main.js")),
      fsPromises.access(path.join(releaseStage, "apps/admin-web/dist/index.html")),
      fsPromises.access(path.join(componentStage, "opt/QQ/qq"), fs.constants.X_OK),
      fsPromises.access(path.join(componentStage, "app/napcat/napcat.mjs"))
    ]);
    await prepareNativeComponent(componentStage, componentFinal);
    await installImmutable(releaseStage, releaseFinal);
    await installImmutable(componentStage, componentFinal);
    await ensureNativeNapcatCacheLink(componentFinal);
    await switchSymlink(path.join(componentBase, "current"), componentFinal);
    await switchSymlink(contract.paths.installPrefix, releaseFinal);
    await installSystemdUnits(releaseFinal);
    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["enable", target]);
    process.stdout.write(
      `Native runtime 已安装：release=${releaseVersion} napcat=${componentVersion}；尚未自动启动。\n`
    );
  } finally {
    await fsPromises.rm(releaseStage, { recursive: true, force: true });
    await fsPromises.rm(componentStage, { recursive: true, force: true });
  }
}

async function rollback() {
  requireRoot();
  const releaseVersion = requiredOption("release-version");
  const componentVersion = requiredOption("napcat-version");
  const releaseTarget = path.join(releaseBase, safeVersion(releaseVersion));
  const componentTarget = path.join(componentBase, safeVersion(componentVersion));
  const [releaseManifest] = await Promise.all([
    readJson(path.join(releaseTarget, "release-manifest.json")),
    fsPromises.access(path.join(componentTarget, "component-manifest.json"))
  ]);
  validateReleaseManifest(releaseManifest, releaseVersion);
  await ensureNativeNapcatCacheLink(componentTarget);
  await switchSymlink(path.join(componentBase, "current"), componentTarget);
  await switchSymlink(contract.paths.installPrefix, releaseTarget);
  await installSystemdUnits(releaseTarget);
  await run("systemctl", ["daemon-reload"]);
  process.stdout.write(`Native runtime 已回滚到 release=${releaseVersion} napcat=${componentVersion}。\n`);
}

async function uninstall() {
  requireRoot();
  await runAllowFailure("systemctl", ["disable", "--now", target]);
  for (const unit of [
    contract.native.apiUnit,
    contract.native.napcatUnit,
    contract.native.targetUnit
  ]) {
    await fsPromises.rm(path.join("/etc/systemd/system", unit), { force: true });
  }
  await fsPromises.rm(contract.paths.installPrefix, { force: true });
  await fsPromises.rm(path.join(componentBase, "current"), { force: true });
  await run("systemctl", ["daemon-reload"]);
  process.stdout.write("Native units 与 current 链接已移除；workspace、release 和组件版本目录已保留。\n");
}

async function prepareNativeComponent(stage, finalPath) {
  const shellRoot = path.join(stage, "app/napcat");
  const configPath = path.join(shellRoot, "config");
  const defaultsPath = path.join(stage, "app/napcat-default-config");
  if (!(await exists(defaultsPath))) {
    if (await exists(configPath)) {
      await fsPromises.cp(configPath, defaultsPath, { recursive: true });
    } else {
      throw new Error("NapCat component 缺少默认配置。");
    }
  }
  await fsPromises.rm(configPath, { recursive: true, force: true });
  await fsPromises.symlink(
    path.join(workspace, contract.paths.napcatConfig),
    configPath,
    "dir"
  );
  await ensureNapcatCacheLink({ workspace, paths: contract.paths, shellRoot });
  const finalShellUrl = pathToFileURL(path.join(finalPath, "app/napcat/napcat.mjs")).href;
  await fsPromises.writeFile(
    path.join(stage, "opt/QQ/resources/app/loadNapCat.js"),
    `(async () => { await import(${JSON.stringify(finalShellUrl)}); })();\n`,
    { encoding: "utf8", mode: 0o644 }
  );
}

async function ensureNativeNapcatCacheLink(componentRoot) {
  await ensureNapcatCacheLink({
    workspace,
    paths: contract.paths,
    shellRoot: path.join(componentRoot, "app/napcat")
  });
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
  ].map((relative) => path.join(workspace, relative));
  await fsPromises.mkdir(workspace, { recursive: true, mode: 0o700 });
  await Promise.all(directories.map((directory) => fsPromises.mkdir(directory, {
    recursive: true,
    mode: 0o700
  })));
  await run("chown", ["-R", `${nativeUser}:${nativeUser}`, workspace]);
  await fsPromises.access(path.join(workspace, contract.paths.secrets));
}

async function ensureRuntimeUser() {
  if (!(await succeeds("getent", ["group", nativeUser]))) {
    await run("groupadd", ["--system", nativeUser]);
  }
  if (!(await succeeds("id", ["-u", nativeUser]))) {
    await run("useradd", [
      "--system",
      "--gid", nativeUser,
      "--home-dir", workspace,
      "--no-create-home",
      "--shell", "/usr/sbin/nologin",
      nativeUser
    ]);
  }
}

async function ensureNativeDependencies() {
  if (process.versions.node !== contract.nodeVersion) {
    throw new Error(`需要 Node ${contract.nodeVersion}，当前为 ${process.versions.node}。`);
  }
  for (const executable of ["xvfb-run", "ffmpeg", "libreoffice", "systemctl", "tar"]) {
    if (!(await succeeds("sh", ["-c", `command -v ${executable} >/dev/null 2>&1`]))) {
      throw new Error(`Native 依赖缺失：${executable}`);
    }
  }
}

async function installSystemdUnits(releaseRoot) {
  const source = path.join(releaseRoot, "deploy/native/systemd");
  for (const unit of [
    contract.native.apiUnit,
    contract.native.napcatUnit,
    contract.native.targetUnit
  ]) {
    await fsPromises.copyFile(path.join(source, unit), path.join("/etc/systemd/system", unit));
    await fsPromises.chmod(path.join("/etc/systemd/system", unit), 0o644);
  }
}

async function installImmutable(stage, destination) {
  if (await exists(destination)) return;
  await fsPromises.rename(stage, destination);
  await run("chown", ["-R", "root:root", destination]);
  await run("chmod", ["-R", "a-w", destination]);
}

async function switchSymlink(linkPath, targetPath) {
  const temporary = `${linkPath}.next-${process.pid}`;
  await fsPromises.rm(temporary, { force: true });
  await fsPromises.symlink(targetPath, temporary, "dir");
  await fsPromises.rename(temporary, linkPath);
}

async function verifyArchive(inputPath) {
  const archivePath = path.resolve(inputPath);
  await fsPromises.access(archivePath);
  const checksumFile = `${archivePath}.sha256`;
  const expected = (await fsPromises.readFile(checksumFile, "utf8")).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`无效校验文件：${checksumFile}`);
  const actual = await sha256(archivePath);
  if (actual !== expected) throw new Error(`SHA-256 不匹配：${archivePath}`);
}

function run(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      stdio: "inherit",
      env: options.env ?? process.env,
      cwd: options.cwd
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${commandName} 失败（${signal || code}）。`));
    });
  });
}

async function runAllowFailure(commandName, args) {
  try {
    await run(commandName, args);
  } catch {
    // Uninstall remains idempotent when a unit was never installed.
  }
}

function succeeds(commandName, args) {
  return new Promise((resolve) => {
    const child = spawn(commandName, args, { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`缺少 --${name}=...`);
  return value;
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function safeVersion(value) {
  if (!/^[A-Za-z0-9._+-]+$/.test(value)) throw new Error(`无效版本：${value}`);
  return value;
}

function validateReleaseManifest(releaseManifest, releaseVersion) {
  if (
    releaseManifest.releaseVersion !== releaseVersion
    || releaseManifest.platform !== "linux/amd64"
    || releaseManifest.nodeVersion !== contract.nodeVersion
  ) {
    throw new Error("release artifact 与 runtime contract 不匹配。");
  }
}

function requireRoot() {
  if (process.platform !== "linux" || process.getuid?.() !== 0) {
    throw new Error("该操作必须在 Linux 上以 root 运行。");
  }
}

function assertLinuxRuntime() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`不支持的平台：${process.platform}/${process.arch}`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fsPromises.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await fsPromises.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
