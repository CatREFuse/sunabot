import { MCP_RUNTIME_DOWNLOADERS } from "./stdioLaunchPolicy.js";
import { MCP_RUNTIME_INTERPRETERS } from "../../packages/contracts/extensions/agentMcpDescriptorSecurity.js";

export const MCP_STDIO_ENTRYPOINT_VIRTUAL_PATH = "/run/sunabot/bin/mcp-stdio-entrypoint";
export const MCP_STDIO_LAUNCH_DIRECTORY_VIRTUAL_PATH = "/run/sunabot/secrets";

const ENTRYPOINT_BODY = String.raw`
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

const launchRoot = "/run/sunabot/secrets";
const configPath = "/run/sunabot/extensions/mcp.json";
const executableManifestPath = "/opt/sunabot/mcp/executables.json";
const maxLaunchBytes = 1024 * 1024;
const downloaders = new Set(${JSON.stringify([...MCP_RUNTIME_DOWNLOADERS])});
const interpreters = new Set(${JSON.stringify([...MCP_RUNTIME_INTERPRETERS])});
const forbiddenEnvironment = new Set([
  "HOME", "PATH", "PWD", "SHELL", "USER", "LOGNAME", "TERM", "NODE_OPTIONS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY"
]);

function fail() {
  throw new Error("MCP_STDIO_ENTRYPOINT_INVALID");
}

function exitInvalid() {
  try { process.stderr.write("MCP_STDIO_ENTRYPOINT_INVALID\n"); } catch {}
  process.exit(78);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function invalidText(value) {
  return typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16 * 1024;
}

async function readBoundFile(file, mode, maximumBytes = maxLaunchBytes, requireExecutable = false) {
  const before = await fs.lstat(file).catch(fail);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 ||
      before.size > maximumBytes || (mode != null && (before.mode & 0o777) !== mode) ||
      (requireExecutable && (before.mode & 0o111) === 0)) fail();
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(fail);
  let content;
  let completed = false;
  try {
    const opened = await handle.stat().catch(fail);
    if (!opened?.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) fail();
    content = await handle.readFile().catch(fail);
    const after = await handle.stat().catch(fail);
    if (!after || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail();
    completed = true;
    return content;
  } finally {
    let closeFailed = false;
    try { await handle.close(); } catch { closeFailed = true; }
    if (!completed || closeFailed) content?.fill(0);
    if (closeFailed) fail();
  }
}

function decodeUtf8(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.startsWith("\uFEFF")) fail();
  return text;
}

async function main() {
  const mode = process.argv.length === 2 ? "run" : process.argv.length === 3 && process.argv[2] === "--probe"
    ? "probe" : fail();
  const launchRootStat = await fs.lstat(launchRoot).catch(fail);
  if (!launchRootStat?.isDirectory() || launchRootStat.isSymbolicLink() ||
      (launchRootStat.mode & 0o777) !== 0o700) fail();
  const entries = await fs.readdir(launchRoot, { withFileTypes: true }).catch(fail);
  if (!entries || entries.length !== 1 || !entries[0]?.isFile() ||
      !/^[a-f0-9]{64}\.json$/u.test(entries[0].name)) fail();
  const launchFile = path.join(launchRoot, entries[0].name);
  const encoded = await readBoundFile(launchFile, 0o600);
  let config;
  let manifestEncoded;
  try {
    if (createHash("sha256").update(encoded).digest("hex") !== entries[0].name.slice(0, 64)) fail();
    config = await readBoundFile(configPath, 0o400);
    let envelope;
    let configured;
    try {
      envelope = JSON.parse(decodeUtf8(encoded));
      configured = JSON.parse(decodeUtf8(config));
    } catch {
      fail();
    }
  if (!exactKeys(envelope, ["agentId", "args", "command", "environment", "projectionDigestSha256", "schemaVersion", "serverId"]) ||
      envelope.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{1,31}$/u.test(envelope.agentId) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(envelope.serverId) ||
      !/^[a-f0-9]{64}$/u.test(envelope.projectionDigestSha256) ||
      createHash("sha256").update(config).digest("hex") !== envelope.projectionDigestSha256 ||
      configured?.agentId !== envelope.agentId || configured?.server?.id !== envelope.serverId ||
      !Array.isArray(envelope.args) || envelope.args.length > 128 ||
      !exactKeys(envelope.environment, Object.keys(envelope.environment ?? {}).sort())) fail();
  const command = path.posix.normalize(envelope.command);
  const base = path.posix.basename(command).toLowerCase();
  const interpreter = interpreters.has(base) || /^(?:node|nodejs|python|perl|ruby|php|java)\d+(?:\.\d+)*$/u.test(base);
  const allowed = /^\/(?:usr\/(?:local\/)?bin|bin)\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(command);
  const pythonDownloader = /^(?:python|python3)(?:\.\d+)?$/u.test(base) && envelope.args.some((value, index) =>
    String(value).toLowerCase() === "-m" && ["ensurepip", "pip", "pip3", "uv"].includes(String(envelope.args[index + 1] ?? "").toLowerCase()));
  if (!allowed || command !== envelope.command || downloaders.has(base) || interpreter || pythonDownloader || invalidText(command) ||
      envelope.args.some(invalidText) || Object.keys(envelope.environment).length > 64) fail();
  const environment = {
    HOME: "/workbench",
    PWD: "/workbench",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
    TMP: "/tmp",
    TEMP: "/tmp",
    USER: "sunabot"
  };
  for (const [key, value] of Object.entries(envelope.environment)) {
    const upper = key.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || forbiddenEnvironment.has(upper) || upper.endsWith("_PROXY") ||
        invalidText(value) || value.length === 0) fail();
    environment[key] = value;
  }
  await fs.access(command, fsConstants.X_OK).catch(fail);
  const canonicalCommand = await fs.realpath(command).catch(fail);
  const canonicalBase = path.posix.basename(canonicalCommand).toLowerCase();
  const canonicalInterpreter = interpreters.has(canonicalBase) || /^(?:node|nodejs|python|perl|ruby|php|java)\d+(?:\.\d+)*$/u.test(canonicalBase);
  const canonicalPythonDownloader = /^(?:python|python3)(?:\.\d+)?$/u.test(canonicalBase) && envelope.args.some((value, index) =>
    String(value).toLowerCase() === "-m" && ["ensurepip", "pip", "pip3", "uv"].includes(String(envelope.args[index + 1] ?? "").toLowerCase()));
  if (canonicalCommand !== command || downloaders.has(canonicalBase) || canonicalInterpreter || canonicalPythonDownloader) fail();
    manifestEncoded = await readBoundFile(executableManifestPath, 0o444);
    let manifest;
    try { manifest = JSON.parse(decodeUtf8(manifestEncoded)); } catch { fail(); }
    if (!exactKeys(manifest, ["executables", "schemaVersion"]) || manifest.schemaVersion !== 1 ||
        !Array.isArray(manifest.executables) || manifest.executables.length < 1 || manifest.executables.length > 128 ||
        manifest.executables.some((value) => !exactKeys(value, ["path", "sha256"]) || invalidText(value.path) ||
          !path.posix.isAbsolute(value.path) || !/^[a-f0-9]{64}$/u.test(value.sha256)) ||
        new Set(manifest.executables.map((value) => value.path)).size !== manifest.executables.length) fail();
    if (!/^[a-f0-9]{64}$/u.test(configured.executableManifestSha256) ||
        createHash("sha256").update(manifestEncoded).digest("hex") !== configured.executableManifestSha256) fail();
    const approved = manifest.executables.find((value) => value.path === command);
    if (!approved) fail();
    const executableEncoded = await readBoundFile(command, null, 32 * 1024 * 1024, true);
    try {
      if (createHash("sha256").update(executableEncoded).digest("hex") !== approved.sha256) fail();
    } finally {
      executableEncoded.fill(0);
    }
    if (mode === "probe") return;
    const child = spawn(command, envelope.args, {
    cwd: "/workbench",
    env: environment,
    stdio: "inherit",
    shell: false
  });
    let settled = false;
    const finish = (code) => {
    if (settled) return;
    settled = true;
    process.exit(typeof code === "number" && code >= 0 && code <= 255 ? code : 1);
    };
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code));
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => {
        try { child.kill(signal); } catch { finish(1); }
      });
    }
  } finally {
    encoded.fill(0);
    config?.fill(0);
    manifestEncoded?.fill(0);
  }
}

main().catch(exitInvalid);
`;

export function mcpStdioEntrypointSource(nodeExecutable: "/usr/bin/node" | "/usr/local/bin/node") {
  return `#!${nodeExecutable}${ENTRYPOINT_BODY}`;
}

export function mcpStdioEntrypointBody() {
  return ENTRYPOINT_BODY;
}
