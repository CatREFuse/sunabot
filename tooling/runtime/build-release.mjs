#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { resolveProjectRoot } from "../shared/paths.mjs";
import {
  assertCleanSourceStatus,
  assertReleaseBuildPlatform,
  assertSourceCommit,
  createReleaseManifest,
  releasePlatformId,
  sha256File,
  validateReleaseManifest
} from "./release-integrity.mjs";

const root = resolveProjectRoot(import.meta.url);
const outputOption = option("output");
if (!outputOption) throw new Error("请使用 --output=<directory> 指定 release artifact 输出目录。");

const platform = releasePlatformId();
assertReleaseBuildPlatform();
const [contract, componentLock] = await Promise.all([
  readJson(path.join(root, "deploy/runtime-contract.json")),
  readJson(path.join(root, "components/component.lock.json"))
]);
if (process.versions.node !== contract.nodeVersion) {
  throw new Error(`需要 Node ${contract.nodeVersion}，当前为 ${process.versions.node}。`);
}
if (!componentLock.supportedPlatforms?.includes(platform)) {
  throw new Error(`component lock 不支持 ${platform}。`);
}

assertCleanSourceStatus(await capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], root));
const commit = (await capture("git", ["rev-parse", "HEAD"], root)).trim();
assertSourceCommit(commit);
await runNpm(["run", "build"], root, { ...process.env, NODE_ENV: "production" });
assertCleanSourceStatus(await capture("git", ["status", "--porcelain=v1", "--untracked-files=all"], root));
if ((await capture("git", ["rev-parse", "HEAD"], root)).trim() !== commit) {
  throw new Error("发行构建期间 Git HEAD 已变化。");
}

const platformSlug = platform.replace("/", "-");
const outputDir = path.resolve(root, outputOption);
const archivePath = path.join(outputDir, `sunabot-${contract.releaseVersion}-${platformSlug}.tar.gz`);
const checksumPath = `${archivePath}.sha256`;
const stage = path.join(outputDir, `.sunabot-release-${process.pid}`);
const componentCache = path.resolve(
  option("component-cache")
    ?? process.env.SUNABOT_RELEASE_COMPONENT_CACHE
    ?? path.join(outputDir, ".component-cache")
);
const requiredBuildFiles = ["dist/apps/api/main.js", "apps/admin-web/dist/index.html"];
for (const relative of requiredBuildFiles) await fs.access(path.join(root, relative));

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(componentCache, { recursive: true, mode: 0o755 });
if (!process.argv.includes("--force")) {
  for (const target of [archivePath, checksumPath]) {
    if (await exists(target)) throw new Error(`输出已存在：${target}。使用 --force 覆盖。`);
  }
}
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true, mode: 0o755 });

try {
  for (const relative of releaseSourcePaths()) await copy(relative);
  await runNpm(["ci", "--omit=dev"], stage, { ...process.env, NODE_ENV: "production" });
  await installBundledNode(componentLock.components.node);
  await installBubblewrap(componentLock.components.bubblewrap);
  await installLightpanda(componentLock.components.lightpanda);
  await assertBundledRuntime(componentLock.components.bubblewrap);

  const releaseManifest = await createReleaseManifest({
    root: stage,
    runtimeId: contract.runtimeId,
    releaseVersion: contract.releaseVersion,
    platform,
    nodeVersion: contract.nodeVersion,
    sourceCommit: commit,
    createdAt: new Date().toISOString(),
    components: {
      node: componentLock.components.node.version,
      lightpanda: componentLock.components.lightpanda.version,
      bubblewrap: componentLock.components.bubblewrap.version,
      napcat: componentLock.components.napcat.version,
      codexCli: componentLock.components["codex-cli"].version
    }
  });
  await fs.writeFile(
    path.join(stage, "release-manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 }
  );
  await validateReleaseManifest({ root: stage, manifest: releaseManifest });

  await fs.rm(archivePath, { force: true });
  await fs.rm(checksumPath, { force: true });
  await run("tar", ["-czf", archivePath, "-C", stage, "."], root);
  const checksum = await sha256File(archivePath);
  await fs.writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`, "utf8");
  process.stdout.write(`${archivePath}\n${checksumPath}\n`);
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}

function releaseSourcePaths() {
  return [
    ".node-version",
    ".nvmrc",
    "AGENTS.md",
    "CHANGELOG.md",
    "README.md",
    "install.sh",
    "sunabot.sh",
    "package.json",
    "package-lock.json",
    "config",
    "dist",
    "src",
    "services",
    "adapters",
    "packages",
    "apps/api",
    "apps/webfetch-renderer",
    "apps/admin-web/dist",
    "codex-skills/workbench-config",
    "docs",
    "deploy/napcat",
    "deploy/runtime-contract.json",
    "deploy/runtime-contract.schema.json",
    "deploy/native",
    "tooling/shared",
    "tooling/runtime",
    "tooling/workspace",
    "tooling/admin",
    "tooling/agents",
    "tooling/migrations",
    "components/component.lock.json",
    "components/component-lock.schema.json"
  ];
}

async function installBundledNode(component) {
  const asset = component?.archives?.[platform];
  if (!asset?.file || !asset?.sha256) throw new Error(`Node ${platform} 归档未锁定。`);
  const url = new URL(asset.file, component.source).href;
  const archive = await cachedDownload(url, asset.file, asset.sha256);
  const destination = path.join(stage, "runtime/node");
  await fs.mkdir(destination, { recursive: true, mode: 0o755 });
  const archiveRoot = asset.file.replace(/\.tar\.xz$/u, "");
  await run("tar", [
    "-xJf", archive,
    "-C", destination,
    "--strip-components=1",
    `${archiveRoot}/bin/node`,
    `${archiveRoot}/LICENSE`
  ], root);
  await fs.chmod(path.join(destination, "bin/node"), 0o755);
}

async function installLightpanda(component) {
  const asset = component?.assets?.[platform];
  const source = component?.correspondingSource;
  if (!asset?.file || !asset?.url || !asset?.sha256 || !source?.file || !source?.url || !source?.sha256) {
    throw new Error(`Lightpanda ${platform} 发行输入未锁定。`);
  }
  const [binary, sourceArchive] = await Promise.all([
    cachedDownload(asset.url, asset.file, asset.sha256),
    cachedDownload(source.url, source.file, source.sha256)
  ]);
  const runtimeDirectory = path.join(stage, "runtime/lightpanda");
  const sourceDirectory = path.join(stage, "sources");
  const licenseDirectory = path.join(stage, "licenses/lightpanda");
  await Promise.all([
    fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o755 }),
    fs.mkdir(sourceDirectory, { recursive: true, mode: 0o755 }),
    fs.mkdir(licenseDirectory, { recursive: true, mode: 0o755 })
  ]);
  await fs.copyFile(binary, path.join(runtimeDirectory, "lightpanda"));
  await fs.chmod(path.join(runtimeDirectory, "lightpanda"), 0o755);
  await fs.copyFile(sourceArchive, path.join(sourceDirectory, source.file));
  await run("tar", [
    "-xzf", sourceArchive,
    "-C", licenseDirectory,
    "--strip-components=1",
    `browser-${component.version}/LICENSE`
  ], root);
  await fs.writeFile(path.join(licenseDirectory, "SOURCE.txt"), [
    `Lightpanda ${component.version}`,
    `Upstream: ${component.source}`,
    `Corresponding source: ../../sources/${source.file}`,
    `Source SHA-256: ${source.sha256}`,
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o644 });
}

async function installBubblewrap(component) {
  const asset = component?.archives?.[platform];
  const runtime = component?.runtimeDependencies?.[platform];
  const sourceArchives = component?.sourceArchives;
  const runtimeSourceArchives = component?.runtimeSourceArchives;
  if (!asset?.file || !asset?.url || !asset?.sha256
    || !runtime?.loader || !Array.isArray(runtime.needed) || runtime.needed.length < 1
    || !Array.isArray(runtime.libraryPaths) || runtime.libraryPaths.length < 1
    || !Array.isArray(runtime.archives) || runtime.archives.length < 1
    || runtime.archives.some((dependency) => !dependency?.package || !dependency?.file
      || !dependency?.url || !dependency?.sha256)
    || !Array.isArray(sourceArchives) || sourceArchives.length < 1
    || sourceArchives.some((source) => !source?.file || !source?.url || !source?.sha256)
    || !Array.isArray(runtimeSourceArchives) || runtimeSourceArchives.length < 1
    || runtimeSourceArchives.some((source) => !source?.package || !source?.file
      || !source?.url || !source?.sha256)) {
    throw new Error(`Bubblewrap ${platform} 发行输入未锁定。`);
  }
  const [archive, dependencies, sources, runtimeSources] = await Promise.all([
    cachedDownload(asset.url, asset.file, asset.sha256),
    Promise.all(runtime.archives.map(async (dependency) => ({
      ...dependency,
      archive: await cachedDownload(dependency.url, dependency.file, dependency.sha256)
    }))),
    Promise.all(sourceArchives.map(async (source) => ({
      ...source,
      archive: await cachedDownload(source.url, source.file, source.sha256)
    }))),
    Promise.all(runtimeSourceArchives.map(async (source) => ({
      ...source,
      archive: await cachedDownload(source.url, source.file, source.sha256)
    })))
  ]);
  const unpackDigest = createHash("sha256")
    .update([asset.sha256, ...runtime.archives.map((dependency) => dependency.sha256)].join("\n"))
    .digest("hex");
  const unpacked = path.join(componentCache, `${unpackDigest}-unpacked`);
  const unpackedInputs = [
    "usr/bin/bwrap",
    ...runtime.libraryPaths,
    ...runtime.archives.map((dependency) => `usr/share/doc/${dependency.package}/copyright`)
  ];
  if (!(await Promise.all(unpackedInputs.map((relative) => exists(path.join(unpacked, relative)))))
    .every(Boolean)) {
    await fs.rm(unpacked, { recursive: true, force: true });
    await fs.mkdir(unpacked, { recursive: true, mode: 0o755 });
    await run("dpkg-deb", ["-x", archive, unpacked], root);
    for (const dependency of dependencies) {
      await run("dpkg-deb", ["-x", dependency.archive, unpacked], root);
    }
  }
  const destination = path.join(stage, "runtime/bubblewrap");
  const libraryDirectory = path.join(destination, "lib");
  const licenseDirectory = path.join(destination, "licenses");
  const sourceDirectory = path.join(stage, "sources/bubblewrap");
  await Promise.all([
    fs.mkdir(destination, { recursive: true, mode: 0o755 }),
    fs.mkdir(libraryDirectory, { recursive: true, mode: 0o755 }),
    fs.mkdir(licenseDirectory, { recursive: true, mode: 0o755 }),
    fs.mkdir(sourceDirectory, { recursive: true, mode: 0o755 })
  ]);
  await fs.copyFile(path.join(unpacked, "usr/bin/bwrap"), path.join(destination, "bwrap.bin"));
  const libraryNames = runtime.libraryPaths.map((relative) => path.basename(relative));
  if (new Set(libraryNames).size !== libraryNames.length || !libraryNames.includes(runtime.loader)) {
    throw new Error(`Bubblewrap ${platform} 运行库清单无效。`);
  }
  for (const relative of runtime.libraryPaths) {
    await fs.copyFile(path.join(unpacked, relative), path.join(libraryDirectory, path.basename(relative)));
  }
  await fs.writeFile(path.join(destination, "bwrap"), [
    "#!/bin/sh",
    "set -eu",
    "case \"$0\" in",
    "  */*) bwrap_root=${0%/*} ;;",
    "  *) echo 'BUBBLEWRAP_BUNDLED_RUNTIME_PATH_INVALID' >&2; exit 126 ;;",
    "esac",
    `exec "$bwrap_root/lib/${runtime.loader}" --inhibit-cache --library-path "$bwrap_root/lib" "$bwrap_root/bwrap.bin" "$@"`,
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  await fs.copyFile(path.join(unpacked, "usr/share/doc/bubblewrap/copyright"), path.join(destination, "LICENSE"));
  for (const dependency of runtime.archives) {
    await fs.copyFile(
      path.join(unpacked, `usr/share/doc/${dependency.package}/copyright`),
      path.join(licenseDirectory, `${dependency.package}.txt`)
    );
  }
  for (const source of sources) {
    await fs.copyFile(source.archive, path.join(sourceDirectory, source.file));
  }
  for (const source of runtimeSources) {
    await fs.copyFile(source.archive, path.join(sourceDirectory, source.file));
  }
  await fs.writeFile(path.join(destination, "SOURCE.txt"), [
    `Bubblewrap ${component.version}`,
    `Upstream: ${component.source}`,
    `Runtime loader: lib/${runtime.loader}`,
    ...runtime.archives.map((dependency) => (
      `Runtime package: ${dependency.package} ${dependency.version} (${dependency.sha256})`
    )),
    ...sources.map((source) => `Source: ../../sources/bubblewrap/${source.file} (${source.sha256})`),
    ...runtimeSources.map((source) => (
      `Runtime source: ../../sources/bubblewrap/${source.file} (${source.sha256})`
    )),
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o644 });
  await fs.chmod(path.join(destination, "bwrap.bin"), 0o755);
  await fs.chmod(path.join(libraryDirectory, runtime.loader), 0o755);
  await fs.chmod(path.join(destination, "bwrap"), 0o755);
}

async function assertBundledRuntime(bubblewrapComponent) {
  const bundledNode = path.join(stage, "runtime/node/bin/node");
  const bundledBubblewrap = path.join(stage, "runtime/bubblewrap/bwrap");
  const bundledLightpanda = path.join(stage, "runtime/lightpanda/lightpanda");
  const bundledCodex = path.join(stage, contract.capabilities.codexCli.executable);
  await fs.chmod(bundledCodex, 0o755);
  const nodeVersion = (await capture(bundledNode, ["-p", "process.versions.node"], stage)).trim();
  if (nodeVersion !== contract.nodeVersion) throw new Error(`包内 Node 版本错误：${nodeVersion}。`);
  await capture(bundledNode, [
    "--input-type=module",
    "-e",
    "await Promise.all([import('sharp'),import('@napi-rs/canvas'),import('officeparser')])"
  ], stage);
  const codexVersion = (await capture(bundledNode, [
    bundledCodex,
    "--version"
  ], stage)).trim();
  if (codexVersion !== `codex-cli ${contract.capabilities.codexCli.version}`) {
    throw new Error(`包内 Codex CLI 版本错误：${codexVersion}。`);
  }
  await assertBundledBubblewrap(bundledBubblewrap, bubblewrapComponent);
  await capture(bundledLightpanda, ["version"], stage, {
    ...process.env,
    LIGHTPANDA_DISABLE_TELEMETRY: "true"
  });
  await fs.access(path.join(stage, "node_modules/.package-lock.json"));
}

async function assertBundledBubblewrap(executable, component) {
  const runtime = component?.runtimeDependencies?.[platform];
  if (!runtime?.loader || !Array.isArray(runtime.needed)) {
    throw new Error(`Bubblewrap ${platform} 运行库清单缺失。`);
  }
  const directory = path.dirname(executable);
  const libraryDirectory = path.join(directory, "lib");
  const loader = path.join(libraryDirectory, runtime.loader);
  const binary = path.join(directory, "bwrap.bin");
  await capture(executable, ["--version"], stage);
  const linked = await capture(loader, [
    "--inhibit-cache",
    "--library-path", libraryDirectory,
    "--list", binary
  ], stage);
  for (const needed of runtime.needed) {
    if (!linked.includes(`${needed} => ${path.join(libraryDirectory, needed)}`)) {
      throw new Error(`Bubblewrap 运行库未从发行包解析：${needed}。`);
    }
  }
  await capture(executable, bubblewrapNamespaceProbeArguments(), stage);
}

function bubblewrapNamespaceProbeArguments() {
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-cgroup-try",
    "--uid", "0",
    "--gid", "0",
    "--cap-drop", "ALL",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--chdir", "/",
    "--", "/bin/true"
  ];
}

async function cachedDownload(url, fileName, expectedSha256) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error(`组件 SHA-256 无效：${fileName}。`);
  const target = path.join(componentCache, `${expectedSha256}-${path.basename(fileName)}`);
  if (await exists(target) && await sha256File(target) === expectedSha256) return target;
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(temporary, { force: true });
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`组件下载失败：${url}（HTTP ${response.status}）。`);
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(temporary, { mode: 0o600 })));
  const actual = await sha256File(temporary);
  if (actual !== expectedSha256) {
    await fs.rm(temporary, { force: true });
    throw new Error(`组件校验失败：${fileName}。`);
  }
  await fs.rename(temporary, target);
  return target;
}

async function copy(relative) {
  const source = path.join(root, relative);
  const destination = path.join(stage, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

function runNpm(args, cwd, env = process.env) {
  return run(
    process.env.npm_execpath ? process.execPath : "npm",
    process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args,
    cwd,
    env
  );
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 失败（${signal || code}）。`));
    });
  });
}

function capture(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} 失败（${signal || code}）。`));
    });
  });
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
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
