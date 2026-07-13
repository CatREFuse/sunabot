#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { evaluateRuntimeSnapshot } from "./doctor/core.mjs";
import { resolveProjectRoot, resolveWorkspace } from "../shared/paths.mjs";

const execFileAsync = promisify(execFile);
const root = resolveProjectRoot(import.meta.url);

try {
  const report = await runDoctor();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({
    ok: false,
    errors: [{ code: "DOCTOR_COLLECTION_FAILED", message: "runtime doctor 无法完成事实采集。" }]
  }, null, 2));
  process.exitCode = 1;
}

async function runDoctor() {
  const production = hasFlag("production");
  const expectation = hasFlag("expect-running") ? "running" : "free";
  const contract = await readJson(path.join(root, "deploy/runtime-contract.json"));
  const packageManifest = await readJson(path.join(root, "package.json"));
  const workspace = resolveWorkspace(root);
  const configuredWorkspace = process.env.SUNABOT_WORKSPACE?.trim();
  const host = option("host") ?? contract.network.admin?.host ?? contract.network.host ?? "127.0.0.1";
  const port = positivePort(
    option("port") ?? process.env.SUNABOT_PORT ?? contract.network.admin?.port ?? contract.network.apiPort ?? 8787
  );
  const domain = await localDomain();
  const workspaceIdentity = await pathIdentity(workspace);
  const expectedWorkspace = production
    ? await pathIdentity(contract.paths.workspace)
    : workspaceIdentity;
  const releaseIdentity = await pathIdentity(root);
  const databasePathOverride = Boolean(process.env.SUNABOT_DATABASE_PATH?.trim());
  const databasePath = path.join(workspace, contract.paths.database);

  const databases = await Promise.all([
    databaseFact("main", true, "runtime", databasePath),
    databaseFact("queue", true, "runtime", path.join(workspace, contract.paths.sessionQueue)),
    databaseFact("main", false, "legacy", path.join(workspace, "artifacts/sunabot.sqlite")),
    databaseFact("queue", false, "legacy", path.join(workspace, "artifacts/session-queue.sqlite")),
  ]);

  const network = await collectNetworkFacts({
    host,
    port,
    root,
    workspace,
    packageVersion: packageManifest.version,
    runtimeId: contract.runtimeId,
    domain,
    production
  });

  return evaluateRuntimeSnapshot({
    expectation,
    platform: process.platform,
    domain,
    release: {
      runtimeId: contract.runtimeId,
      root: releaseIdentity,
      contractVersion: contract.releaseVersion,
      packageVersion: packageManifest.version,
      expectedNodeVersion: contract.nodeVersion,
      actualNodeVersion: process.versions.node
    },
    workspace: {
      explicit: Boolean(configuredWorkspace),
      absoluteConfigured: configuredWorkspace ? path.isAbsolute(configuredWorkspace) : false,
      production,
      identity: workspaceIdentity,
      expected: expectedWorkspace
    },
    databases,
    listener: network.listener,
    onebot: network.onebot,
    configurationErrors: databasePathOverride ? [{
      code: "DATABASE_PATH_OVERRIDE_UNSUPPORTED",
      message: "SUNABOT_DATABASE_PATH 已停止支持；主库固定为 workspace/business/data/sunabot.sqlite。"
    }] : [],
    collectionWarnings: network.warnings
  });
}

async function databaseFact(role, canonical, source, targetPath) {
  return { role, canonical, source, ...await pathIdentity(targetPath) };
}

async function collectNetworkFacts(context) {
  const warnings = [];
  const collections = [];
  const occupied = await bindProbe(context.host, context.port);

  if (!occupied && !context.production) {
    return {
      listener: { host: context.host, port: context.port, listening: false, owners: [] },
      onebot: { candidates: [], connections: [] },
      warnings
    };
  }

  if (process.platform === "win32") {
    try {
      collections.push(await collectWindowsTcp(context, "windows", "powershell.exe"));
    } catch {
      warnings.push({ code: "WINDOWS_TCP_OWNER_UNAVAILABLE", message: "无法读取 Windows TCP owner；端口占用仍会作为失败处理。" });
    }
    if (context.production) {
      try {
        collections.push(await collectWslListeners(context));
      } catch {
        warnings.push({ code: "WSL_TCP_OWNER_UNAVAILABLE", message: "无法读取 WSL TCP owner。" });
      }
    }
  } else {
    try {
      collections.push(await collectProcTcp(context));
    } catch {
      warnings.push({ code: "PROC_TCP_OWNER_UNAVAILABLE", message: "无法读取 Linux TCP owner；端口占用仍会作为失败处理。" });
    }
    if (context.production && context.domain === "wsl") {
      try {
        collections.push(await collectWindowsTcp(context, "windows", "powershell.exe"));
      } catch {
        warnings.push({ code: "WINDOWS_HOST_TCP_OWNER_UNAVAILABLE", message: "无法读取 Windows host TCP owner。" });
      }
    }
  }

  const listenerOwners = uniqueProcesses(collections.flatMap((item) => item.listenerOwners));
  const listenerProxies = uniqueProcesses(collections.flatMap((item) => item.listenerProxies ?? []));
  const candidates = uniqueProcesses(collections.flatMap((item) => item.onebotCandidates));
  const connections = uniqueConnections(collections.flatMap((item) => item.onebotConnections));
  const discoveredListener = collections.some((item) => item.listening);

  return {
    listener: {
      host: context.host,
      port: context.port,
      listening: occupied || discoveredListener,
      owners: listenerOwners,
      proxies: listenerProxies
    },
    onebot: { candidates, connections },
    warnings
  };
}

async function collectProcTcp(context) {
  const tcpRows = [
    ...await readProcTcpFile("/proc/net/tcp", context.port),
    ...await readProcTcpFile("/proc/net/tcp6", context.port)
  ];
  const socketInodes = new Set(tcpRows.map((row) => row.inode).filter(Boolean));
  const processIds = (await fs.readdir("/proc", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name));
  const socketOwners = await findProcSocketOwners(processIds, socketInodes);
  const relevantPids = new Set([...socketOwners.values()].flat());
  const rawProcesses = new Map();

  await mapLimit(processIds, 24, async (pid) => {
    let basics;
    try {
      basics = await readProcBasics(pid);
    } catch {
      return;
    }
    if (!relevantPids.has(pid) && !isOneBotProcess(basics)) return;
    try {
      rawProcesses.set(pid, await readProcProcess(pid, basics));
    } catch {
      // The process may exit between /proc reads.
    }
  });

  const normalized = new Map();
  for (const [pid, raw] of rawProcesses) {
    normalized.set(pid, await normalizeProcess(raw, context, context.domain));
  }
  const onebotGroups = groupOneBotProcesses([...normalized.values()].filter((owner) => isOneBotProcess(owner)));

  const listenerOwners = [];
  const onebotConnections = [];
  for (const row of tcpRows) {
    const owners = (socketOwners.get(row.inode) ?? []).flatMap((pid) => normalized.get(pid) ?? []);
    if (row.state === "listen" && row.localPort === context.port) listenerOwners.push(...owners);
    if (row.state !== "established" || row.remotePort !== context.port || !row.loopback) continue;
    const onebotOwners = owners
      .filter((owner) => isOneBotProcess(owner))
      .map((owner) => onebotGroups.byPid.get(owner.pid) ?? owner);
    for (const owner of onebotOwners) {
      onebotConnections.push({
        id: `${context.domain}:${row.inode}:${owner.pid}`,
        state: row.state,
        localAddress: row.localAddress,
        localPort: row.localPort,
        remoteAddress: row.remoteAddress,
        remotePort: row.remotePort,
        owner
      });
    }
  }

  return {
    listening: tcpRows.some((row) => row.state === "listen" && row.localPort === context.port),
    listenerOwners,
    listenerProxies: [],
    onebotCandidates: onebotGroups.candidates,
    onebotConnections
  };
}

async function readProcTcpFile(filePath, port) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const line of content.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = parseProcEndpoint(fields[1]);
    const remote = parseProcEndpoint(fields[2]);
    if (!local || !remote || (local.port !== port && remote.port !== port)) continue;
    rows.push({
      inode: fields[9],
      state: fields[3] === "0A" ? "listen" : fields[3] === "01" ? "established" : "other",
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
      loopback: isProcLoopback(local.address) && isProcLoopback(remote.address)
    });
  }
  return rows;
}

function parseProcEndpoint(value) {
  if (typeof value !== "string") return undefined;
  const separator = value.lastIndexOf(":");
  if (separator < 0) return undefined;
  const address = value.slice(0, separator).toUpperCase();
  const port = Number.parseInt(value.slice(separator + 1), 16);
  if (!Number.isInteger(port)) return undefined;
  return { address, port };
}

function isProcLoopback(address) {
  return address === "0100007F" ||
    address === "00000000000000000000000001000000" ||
    address === "00000000000000000000000000000000";
}

async function findProcSocketOwners(processIds, socketInodes) {
  const owners = new Map();
  if (socketInodes.size === 0) return owners;
  await mapLimit(processIds, 24, async (pid) => {
    let descriptors;
    try {
      descriptors = await fs.readdir(`/proc/${pid}/fd`);
    } catch {
      return;
    }
    for (const descriptor of descriptors) {
      let target;
      try {
        target = await fs.readlink(`/proc/${pid}/fd/${descriptor}`);
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)]$/.exec(target);
      if (!match || !socketInodes.has(match[1])) continue;
      const values = owners.get(match[1]) ?? [];
      values.push(pid);
      owners.set(match[1], values);
    }
  });
  return owners;
}

async function readProcBasics(pid) {
  const [name, commandLine] = await Promise.all([
    fs.readFile(`/proc/${pid}/comm`, "utf8").then((value) => value.trim()),
    fs.readFile(`/proc/${pid}/cmdline`).then((value) => value.toString("utf8").replace(/\0/g, " ").trim())
  ]);
  return { pid, name, commandLine };
}

async function readProcProcess(pid, basics) {
  const [executable, cwd, environment, status] = await Promise.all([
    fs.readlink(`/proc/${pid}/exe`).catch(() => undefined),
    fs.readlink(`/proc/${pid}/cwd`).catch(() => undefined),
    fs.readFile(`/proc/${pid}/environ`).catch(() => Buffer.alloc(0)),
    fs.readFile(`/proc/${pid}/status`, "utf8").catch(() => "")
  ]);
  const selectedEnvironment = selectEnvironment(environment);
  return {
    ...basics,
    executable,
    cwd,
    user: /^Uid:\s+(\d+)/m.exec(status)?.[1],
    workspace: selectedEnvironment.SUNABOT_WORKSPACE,
    releaseVersion: selectedEnvironment.SUNABOT_RELEASE_VERSION,
    runtimeId: selectedEnvironment.SUNABOT_RUNTIME_ID,
    parentPid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0) || undefined,
    alive: true
  };
}

function selectEnvironment(buffer) {
  const selected = {};
  const allowed = new Set(["SUNABOT_WORKSPACE", "SUNABOT_RELEASE_VERSION", "SUNABOT_RUNTIME_ID"]);
  for (const entry of buffer.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    if (allowed.has(key)) selected[key] = entry.slice(separator + 1);
  }
  return selected;
}

async function collectWindowsTcp(context, domain, executable) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$connections = @(
  @(Get-NetTCPConnection -LocalPort ${context.port} -ErrorAction SilentlyContinue)
  @(Get-NetTCPConnection -RemotePort ${context.port} -ErrorAction SilentlyContinue)
) | Sort-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess -Unique | ForEach-Object {
  [pscustomobject]@{
    localAddress = [string]$_.LocalAddress
    localPort = [int]$_.LocalPort
    remoteAddress = [string]$_.RemoteAddress
    remotePort = [int]$_.RemotePort
    state = [string]$_.State
    owningProcess = [int]$_.OwningProcess
  }
}
$processIds = @($connections | ForEach-Object { $_.owningProcess } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
$processes = @($processIds | ForEach-Object {
  $processId = $_
  $item = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -ne $item) {
    [pscustomobject]@{
      pid = [int]$processId
      name = [string]$item.Name
      executable = [string]$item.ExecutablePath
      commandLine = [string]$item.CommandLine
    }
  }
})
[pscustomobject]@{ connections = $connections; processes = $processes } | ConvertTo-Json -Depth 5 -Compress
`;
  const { stdout } = await execFileAsync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 7_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8"
  });
  const payload = JSON.parse(String(stdout).trim() || "{}");
  const processMap = new Map();
  for (const raw of asArray(payload.processes)) {
    const normalized = await normalizeProcess({ ...raw, alive: true }, context, domain);
    processMap.set(Number(raw.pid), normalized);
  }
  const listenerOwners = [];
  const listenerProxies = [];
  const onebotConnections = [];
  for (const connection of asArray(payload.connections)) {
    const owner = processMap.get(Number(connection.owningProcess));
    const state = String(connection.state ?? "").toLowerCase();
    if (state === "listen" && Number(connection.localPort) === context.port && owner) {
      if (isTransportProxy(owner)) listenerProxies.push(owner);
      else listenerOwners.push(owner);
    }
    if (state !== "established" || Number(connection.remotePort) !== context.port || !owner || !isOneBotProcess(owner)) continue;
    onebotConnections.push({
      id: `${domain}:${connection.localAddress}:${connection.localPort}:${owner.pid}`,
      state,
      localAddress: connection.localAddress,
      localPort: connection.localPort,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      owner
    });
  }
  return {
    listening: asArray(payload.connections).some((item) => String(item.state).toLowerCase() === "listen" && Number(item.localPort) === context.port),
    listenerOwners,
    listenerProxies,
    onebotCandidates: [...processMap.values()].filter((owner) => isOneBotProcess(owner)),
    onebotConnections
  };
}

async function collectWslListeners(context) {
  const command = `ss -H -ltnp 'sport = :${context.port}' 2>/dev/null || true`;
  const { stdout } = await execFileAsync("wsl.exe", ["-e", "sh", "-lc", command], {
    timeout: 7_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  const owners = [];
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const pid = Number(/pid=(\d+)/.exec(line)?.[1]);
    const name = /\(\("([^"]+)"/.exec(line)?.[1] ?? "unknown";
    owners.push({
      pid: Number.isInteger(pid) ? pid : undefined,
      name,
      domain: "wsl",
      source: "foreign-domain",
      alive: true
    });
  }
  return {
    listening: lines.length > 0,
    listenerOwners: owners,
    listenerProxies: [],
    onebotCandidates: [],
    onebotConnections: []
  };
}

async function normalizeProcess(raw, context, domain) {
  const releaseRoot = raw.releaseRoot ?? deriveReleaseRoot(raw.commandLine) ??
    (isWithin(raw.cwd, context.root) ? context.root : undefined);
  let workspaceRealPath;
  if (raw.workspace && domain === context.domain) {
    try {
      workspaceRealPath = await fs.realpath(raw.workspace);
    } catch {
      workspaceRealPath = path.resolve(raw.workspace);
    }
  }
  const workspaceMatches = comparablePath(workspaceRealPath ?? raw.workspace) === comparablePath(context.workspace);
  let source = "unknown";
  if (domain !== context.domain) source = "foreign-domain";
  else if (releaseRoot && comparablePath(releaseRoot) === comparablePath(context.root)) source = "current-release";
  else if (releaseRoot) source = "foreign-release";
  else if (raw.runtimeId === context.runtimeId || workspaceMatches) source = isOneBotProcess(raw) ? "component" : "current-runtime";
  else if (/sunabot|dist[\\/]apps[\\/]api[\\/]main\.js/i.test(raw.commandLine ?? "")) source = "foreign-release";

  return {
    pid: Number(raw.pid),
    name: String(raw.name ?? "unknown"),
    user: raw.user == null ? undefined : String(raw.user),
    executable: raw.executable ? String(raw.executable) : undefined,
    domain,
    source,
    releaseRoot,
    releaseVersion: raw.releaseVersion ?? (source === "current-release" ? context.packageVersion : undefined),
    runtimeId: raw.runtimeId,
    parentPid: Number(raw.parentPid) || undefined,
    workspace: raw.workspace,
    workspaceRealPath,
    alive: raw.alive !== false,
    commandLine: raw.commandLine
  };
}

function deriveReleaseRoot(commandLine) {
  if (typeof commandLine !== "string") return undefined;
  const match = /(?:"([^"]+?[\\/]dist[\\/]apps[\\/]api[\\/]main\.js)"|([^\s]+?[\\/]dist[\\/]apps[\\/]api[\\/]main\.js))/i.exec(commandLine);
  const entry = match?.[1] ?? match?.[2];
  return entry ? path.dirname(path.dirname(path.dirname(path.dirname(entry)))) : undefined;
}

function isOneBotProcess(owner) {
  const name = String(owner?.name ?? "");
  const executable = String(owner?.executable ?? "");
  const commandLine = String(owner?.commandLine ?? "");
  return /^(?:qq|qq\.exe|linuxqq|napcat(?:\.exe)?)$/i.test(name) || /napcat/i.test(`${executable} ${commandLine}`);
}

function groupOneBotProcesses(processes) {
  const rawByPid = new Map(processes.map((owner) => [owner.pid, owner]));
  const byPid = new Map();
  const candidates = new Map();
  for (const owner of processes) {
    let rootOwner = owner;
    const visited = new Set([owner.pid]);
    while (rootOwner.parentPid && rawByPid.has(rootOwner.parentPid) && !visited.has(rootOwner.parentPid)) {
      visited.add(rootOwner.parentPid);
      rootOwner = rawByPid.get(rootOwner.parentPid);
    }
    const instanceId = `${owner.domain}:onebot:${rootOwner.pid}`;
    const enriched = { ...owner, instanceId };
    byPid.set(owner.pid, enriched);
    if (!candidates.has(instanceId)) candidates.set(instanceId, { ...rootOwner, instanceId });
  }
  return { byPid, candidates: [...candidates.values()] };
}

function isTransportProxy(owner) {
  return /^(?:wslrelay|wslhost|docker-proxy|com\.docker\.backend)(?:\.exe)?$/i.test(String(owner?.name ?? ""));
}

async function bindProbe(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") return resolve(true);
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(false));
    });
  });
}

async function pathIdentity(targetPath) {
  const absolutePath = path.resolve(targetPath);
  try {
    const [realPath, stats] = await Promise.all([fs.realpath(absolutePath), fs.stat(absolutePath, { bigint: true })]);
    return {
      path: absolutePath,
      realPath,
      exists: true,
      kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      device: stats.dev.toString(),
      inode: stats.ino.toString()
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { path: absolutePath, exists: false };
  }
}

async function localDomain() {
  if (process.platform === "win32") return "windows";
  try {
    await fs.access("/.dockerenv");
    return "docker";
  } catch {
    // Continue with WSL/native detection.
  }
  try {
    const release = await fs.readFile("/proc/sys/kernel/osrelease", "utf8");
    if (/microsoft/i.test(release)) return "wsl";
  } catch {
    // Non-proc Unix platforms use the linux domain label.
  }
  return "linux";
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function positivePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("invalid port");
  return parsed;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function uniqueProcesses(processes) {
  const values = new Map();
  for (const owner of processes) values.set(`${owner.domain}:${owner.pid}`, owner);
  return [...values.values()];
}

function uniqueConnections(connections) {
  const values = new Map();
  for (const connection of connections) values.set(connection.id, connection);
  return [...values.values()];
}

function comparablePath(value) {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate, rootPath) {
  if (!candidate || !rootPath) return false;
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function mapLimit(values, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await worker(values[index]);
    }
  });
  await Promise.all(runners);
}
