import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const RENDERER_DEPENDENCIES = ["fastify", "ipaddr.js", "playwright"];
const INSTALL_MARKER = "sunabot-native-webfetch-installation-v1";
const BROWSER_MARKER = "sunabot-native-webfetch-browser-v1";

export async function prepareNativeWebfetchRendererInstallation(context, options = {}) {
  const command = options.command;
  if (typeof command !== "function") throw new Error("WEBFETCH_INSTALL_COMMAND_REQUIRED");
  const cacheRoot = nativeRendererCacheRoot({
    environment: context.environment,
    platform: process.platform
  });
  assertRendererCacheBoundary(cacheRoot, context);
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(cacheRoot, 0o700);

  const packageLockPath = path.join(context.root, "package-lock.json");
  const packageLockContent = await fs.readFile(packageLockPath);
  const packageLock = JSON.parse(packageLockContent.toString("utf8"));
  const dependencyDigest = sha256(Buffer.concat([
    packageLockContent,
    Buffer.from(`\nnode=${process.versions.node}\n`, "utf8")
  ]));
  packageLockContent.fill(0);
  const dependenciesRoot = path.join(cacheRoot, "dependencies", dependencyDigest);
  await ensureRendererDependencies({
    dependenciesRoot,
    packageLock,
    projectRoot: context.root
  });

  const applicationInputs = [
    path.join(context.root, "dist/apps/webfetch-renderer"),
    path.join(context.root, "dist/adapters/webfetch"),
    path.join(context.root, "dist/services/webfetch"),
    path.join(context.root, "tooling/runtime/native-webfetch-renderer-supervisor.mjs")
  ];
  const applicationDigest = await hashPaths(applicationInputs);
  const applicationRoot = path.join(cacheRoot, "applications", applicationDigest);
  await ensureRendererApplication({
    applicationRoot,
    dependenciesRoot,
    projectRoot: context.root
  });

  const playwrightVersion = packageLock.packages?.["node_modules/playwright"]?.version;
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(playwrightVersion ?? "")) {
    throw new Error("WEBFETCH_PLAYWRIGHT_VERSION_INVALID");
  }
  const browserRoot = path.join(
    cacheRoot,
    "browsers",
    `playwright-${playwrightVersion}-${process.platform}-${process.arch}`
  );
  const browserExecutable = await ensureNativeChromium({
    browserRoot,
    markerPath: path.join(browserRoot, "installation.json"),
    playwrightCli: path.join(context.root, "node_modules/playwright/cli.js"),
    command,
    repair: options.repairBrowser === true
  });

  return {
    applicationRoot,
    browserExecutable,
    browserRoot,
    cacheRoot,
    entry: path.join(applicationRoot, "dist/apps/webfetch-renderer/main.js"),
    supervisorEntry: path.join(
      applicationRoot,
      "tooling/runtime/native-webfetch-renderer-supervisor.mjs"
    )
  };
}

export async function createNativeWebfetchRendererLaunch(context, installation) {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), `sunabot-webfetch-${context.identity}-`));
  const home = path.join(runRoot, "home");
  const cache = path.join(runRoot, "cache");
  const runtime = path.join(runRoot, "run");
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(cache, { recursive: true, mode: 0o700 }),
    fs.mkdir(runtime, { recursive: true, mode: 0o700 })
  ]);
  const logPath = path.join(installation.cacheRoot, "logs", `${context.identity}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const environment = rendererProcessEnvironment({
    browserExecutable: installation.browserExecutable,
    browserRoot: installation.browserRoot,
    cache,
    entry: installation.entry,
    home,
    port: context.contract.webfetchRendererPort,
    runtime,
    workspaceId: context.identity
  });

  if (process.platform === "darwin") {
    await fs.rm(runRoot, { recursive: true, force: true });
    throw new Error("WEBFETCH_MACOS_NATIVE_RENDERER_UNSUPPORTED");
  }

  if (process.platform === "linux") {
    await fs.access("/usr/bin/bwrap", fs.constants.X_OK).catch(() => {
      throw new Error("WEBFETCH_LINUX_BUBBLEWRAP_UNAVAILABLE");
    });
    const bubblewrapOptions = {
      cache,
      home,
      projectRoot: context.root,
      runtime,
      sensitivePaths: await existingDirectories(linuxCredentialPaths()),
      workspace: context.workspace
    };
    Object.assign(environment, {
      SUNABOT_WEBFETCH_RUNTIME_ISOLATION: "linux-bubblewrap"
    });
    return {
      args: [
        ...linuxRendererBubblewrapPrefix(bubblewrapOptions),
        process.execPath,
        installation.supervisorEntry
      ],
      environment,
      executable: "/usr/bin/bwrap",
      isolationProbe: {
        args: linuxRendererBubblewrapPrefix(bubblewrapOptions),
        executable: "/usr/bin/bwrap"
      },
      logPath,
      runRoot,
      runtimeIsolation: "linux-bubblewrap"
    };
  }

  throw new Error(`WEBFETCH_NATIVE_PLATFORM_UNSUPPORTED:${process.platform}`);
}

export async function verifyNativeWebfetchRendererIsolation(context, launch, command) {
  const probe = [
    "const fs=require('node:fs');",
    "for (const target of process.argv.slice(1)) {",
    "  try { fs.readFileSync(target); process.exit(21); }",
    "  catch (error) { if (!['EACCES','EPERM','ENOENT'].includes(error?.code)) throw error; }",
    "}",
    "fs.writeFileSync(process.env.HOME + '/isolation-probe', 'ok', { mode: 0o600 });",
    "for (const key of Object.keys(process.env)) {",
    "  if (/PROVIDER|ONEBOT|CODEX|NAPCAT|API_KEY|ACCESS_TOKEN/u.test(key)) process.exit(22);",
    "}"
  ].join("");
  if (!launch.isolationProbe?.executable || !Array.isArray(launch.isolationProbe.args)) {
    throw new Error("WEBFETCH_ISOLATION_LAUNCH_INVALID");
  }
  await command(launch.isolationProbe.executable, [
    ...launch.isolationProbe.args,
    process.execPath,
    "-e",
    probe,
    path.join(context.root, "package.json"),
    path.join(context.workspace, "business/data/sunabot.sqlite")
  ], {
    capture: true,
    env: launch.environment,
    timeoutMs: 10_000
  });
}

export function rendererProcessEnvironment(options) {
  return {
    HOME: options.home,
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PLAYWRIGHT_BROWSERS_PATH: options.browserRoot,
    SUNABOT_WEBFETCH_CHROMIUM_EXECUTABLE: options.browserExecutable,
    SUNABOT_WEBFETCH_CHROMIUM_SANDBOX: "1",
    SUNABOT_WEBFETCH_RENDERER_ENTRY: options.entry,
    SUNABOT_WEBFETCH_RENDERER_HOST: "127.0.0.1",
    SUNABOT_WEBFETCH_RENDERER_PORT: String(options.port),
    SUNABOT_WEBFETCH_RENDERER_TOKEN_FD: "3",
    SUNABOT_WEBFETCH_RENDERER_WORKSPACE_ID: options.workspaceId,
    TMPDIR: options.runtime,
    XDG_CACHE_HOME: options.cache,
    XDG_RUNTIME_DIR: options.runtime
  };
}

export function nativeRendererCacheRoot(options = {}) {
  const configured = options.environment?.SUNABOT_WEBFETCH_NATIVE_CACHE?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("WEBFETCH_NATIVE_CACHE_NOT_ABSOLUTE");
    return path.resolve(configured);
  }
  const home = options.homedir ?? os.homedir();
  return options.platform === "darwin"
    ? path.join(home, "Library/Caches/Sunabot/webfetch-renderer")
    : path.join(options.environment?.XDG_CACHE_HOME?.trim() || path.join(home, ".cache"), "sunabot/webfetch-renderer");
}

export function linuxRendererBubblewrapPrefix(options) {
  const masks = [options.projectRoot, options.workspace, ...(options.sensitivePaths ?? [])]
    .map((value) => path.resolve(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left.length - right.length)
    .filter((value, index, values) => !values.slice(0, index).some((parent) => isWithin(value, parent)));
  return [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-cgroup-try",
    "--uid", "65534",
    "--gid", "65534",
    "--cap-drop", "ALL",
    "--ro-bind", "/", "/",
    ...masks.flatMap((value) => ["--tmpfs", value]),
    "--bind", options.home, options.home,
    "--bind", options.cache, options.cache,
    "--bind", options.runtime, options.runtime,
    "--dev", "/dev",
    "--proc", "/proc",
    "--chdir", options.runtime,
    "--"
  ];
}

export function linuxCredentialPaths(home = os.homedir(), uid = process.getuid?.()) {
  return [
    path.join(home, ".aws"),
    path.join(home, ".codex"),
    path.join(home, ".config"),
    path.join(home, ".gnupg"),
    path.join(home, ".local/share/keyrings"),
    path.join(home, ".mozilla"),
    path.join(home, ".password-store"),
    path.join(home, ".ssh"),
    ...(Number.isSafeInteger(uid) ? [`/run/user/${uid}`] : [])
  ];
}

async function ensureRendererDependencies(options) {
  const markerPath = path.join(options.dependenciesRoot, "installation.json");
  if (await markerMatches(markerPath, INSTALL_MARKER)) return;
  const stage = `${options.dependenciesRoot}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(path.join(stage, "node_modules"), { recursive: true, mode: 0o700 });
  const packages = dependencyClosure(options.packageLock, RENDERER_DEPENDENCIES);
  for (const name of packages) {
    const source = path.join(options.projectRoot, "node_modules", ...name.split("/"));
    const destination = path.join(stage, "node_modules", ...name.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.cp(source, destination, { recursive: true, dereference: true });
  }
  await fs.writeFile(path.join(stage, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  await fs.writeFile(path.join(stage, "installation.json"), JSON.stringify({
    schema: INSTALL_MARKER,
    packages: [...packages].sort()
  }, null, 2) + "\n", { mode: 0o600 });
  await fs.mkdir(path.dirname(options.dependenciesRoot), { recursive: true, mode: 0o700 });
  await fs.rename(stage, options.dependenciesRoot).catch(async (error) => {
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    await fs.rm(stage, { recursive: true, force: true });
  });
}

async function ensureRendererApplication(options) {
  const markerPath = path.join(options.applicationRoot, "installation.json");
  if (await markerMatches(markerPath, INSTALL_MARKER)) return;
  const stage = `${options.applicationRoot}.${process.pid}.${Date.now()}.tmp`;
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true, mode: 0o700 });
  for (const relative of [
    "dist/apps/webfetch-renderer",
    "dist/adapters/webfetch",
    "dist/services/webfetch"
  ]) {
    await fs.cp(path.join(options.projectRoot, relative), path.join(stage, relative), {
      recursive: true,
      dereference: true
    });
  }
  const supervisorRelative = "tooling/runtime/native-webfetch-renderer-supervisor.mjs";
  await fs.mkdir(path.join(stage, "tooling/runtime"), { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(options.projectRoot, supervisorRelative), path.join(stage, supervisorRelative));
  await fs.writeFile(path.join(stage, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
  await fs.symlink(path.join(options.dependenciesRoot, "node_modules"), path.join(stage, "node_modules"), "dir");
  await fs.writeFile(path.join(stage, "installation.json"), JSON.stringify({
    schema: INSTALL_MARKER
  }, null, 2) + "\n", { mode: 0o600 });
  await fs.mkdir(path.dirname(options.applicationRoot), { recursive: true, mode: 0o700 });
  await fs.rename(stage, options.applicationRoot).catch(async (error) => {
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    await fs.rm(stage, { recursive: true, force: true });
  });
}

async function ensureNativeChromium(options) {
  const marker = await readJson(options.markerPath);
  if (marker?.schema === BROWSER_MARKER) {
    if (typeof marker.executable !== "string" || !await regularExecutable(marker.executable)) {
      if (!options.repair) throw new Error("WEBFETCH_BROWSER_MISSING");
    } else {
      return marker.executable;
    }
  }
  await fs.mkdir(options.browserRoot, { recursive: true, mode: 0o700 });
  const projectRoot = path.resolve(path.dirname(options.playwrightCli), "../..");
  await options.command(process.execPath, [options.playwrightCli, "install", "chromium"], {
    cwd: projectRoot,
    env: {
      HOME: os.homedir(),
      PATH: process.env.PATH,
      PLAYWRIGHT_BROWSERS_PATH: options.browserRoot
    },
    timeoutMs: 15 * 60_000
  });
  const executable = (await options.command(process.execPath, [
    "--input-type=module",
    "-e",
    "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath());"
  ], {
    capture: true,
    cwd: projectRoot,
    env: {
      HOME: os.homedir(),
      PATH: process.env.PATH,
      PLAYWRIGHT_BROWSERS_PATH: options.browserRoot
    }
  })).trim();
  if (!await regularExecutable(executable)) throw new Error("WEBFETCH_BROWSER_INSTALL_INVALID");
  await fs.writeFile(options.markerPath, JSON.stringify({
    schema: BROWSER_MARKER,
    executable
  }, null, 2) + "\n", { mode: 0o600 });
  return executable;
}

function dependencyClosure(packageLock, roots) {
  const packages = packageLock.packages ?? {};
  const selected = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (selected.has(name)) continue;
    const entry = packages[`node_modules/${name}`];
    if (!entry) throw new Error(`WEBFETCH_DEPENDENCY_MISSING:${name}`);
    selected.add(name);
    for (const dependency of Object.keys(entry.dependencies ?? {})) {
      if (packages[`node_modules/${dependency}`]) queue.push(dependency);
    }
  }
  return selected;
}

async function hashPaths(inputs) {
  const hash = crypto.createHash("sha256");
  for (const input of [...inputs].sort()) await hashPath(hash, input, path.dirname(input));
  return hash.digest("hex");
}

async function existingDirectories(inputs) {
  const directories = [];
  for (const input of inputs) {
    try {
      if ((await fs.stat(input)).isDirectory()) directories.push(input);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return directories;
}

async function hashPath(hash, target, base) {
  const stat = await fs.lstat(target);
  const relative = path.relative(base, target);
  hash.update(relative);
  if (stat.isDirectory()) {
    for (const entry of (await fs.readdir(target)).sort()) {
      await hashPath(hash, path.join(target, entry), base);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`WEBFETCH_INSTALL_INPUT_INVALID:${target}`);
  hash.update(await fs.readFile(target));
}

function assertRendererCacheBoundary(cacheRoot, context) {
  const resolved = path.resolve(cacheRoot);
  for (const forbidden of [context.root, context.workspace]) {
    if (isWithin(resolved, path.resolve(forbidden))) {
      throw new Error("WEBFETCH_NATIVE_CACHE_BOUNDARY_INVALID");
    }
  }
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function markerMatches(markerPath, schema) {
  return (await readJson(markerPath))?.schema === schema;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function regularExecutable(filePath) {
  if (!path.isAbsolute(filePath)) return false;
  try {
    const stat = await fs.stat(filePath);
    await fs.access(filePath, fs.constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
