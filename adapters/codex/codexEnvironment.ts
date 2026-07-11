import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexAuthStrategy } from "../../packages/contracts/tools/codex.js";

export class CodexPreparationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexPreparationError";
  }
}

export async function resolveCodexExecutable(
  configured: string | undefined,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
) {
  const requested = configured?.trim() || "auto";
  const auto = requested === "auto";
  const value = auto
    ? String(environment.SUNABOT_CODEX_BIN ?? "").trim() || "codex"
    : requested;
  if (path.isAbsolute(value) || value.includes(path.sep)) return value;
  if (auto && platform === "darwin") {
    for (const candidate of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex"
    ]) {
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return await fs.realpath(candidate);
      } catch {
        // Fall through to PATH discovery.
      }
    }
  }
  const candidates = executableNames(value, platform);
  for (const directory of String(environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of candidates) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return await fs.realpath(candidate);
      } catch {
        // Continue through the inherited PATH without exposing it to the worker prompt.
      }
    }
  }
  throw new CodexPreparationError("executable_not_found", `Codex executable was not found: ${value}`);
}

export function buildIsolatedEnvironment(
  source: NodeJS.ProcessEnv,
  paths: {
    homeDir: string;
    codexHomeDir: string;
    xdgConfigDir: string;
    xdgDataDir: string;
    xdgCacheDir: string;
    tempDir: string;
    shimDir: string;
  }
) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY"
  ]) {
    if (source[key]) env[key] = source[key];
  }
  env.PATH = `${paths.shimDir}${path.delimiter}${env.PATH ?? ""}`;
  env.HOME = paths.homeDir;
  env.CODEX_HOME = paths.codexHomeDir;
  env.XDG_CONFIG_HOME = paths.xdgConfigDir;
  env.XDG_DATA_HOME = paths.xdgDataDir;
  env.XDG_CACHE_HOME = paths.xdgCacheDir;
  env.TMPDIR = paths.tempDir;
  env.NO_COLOR = "1";
  env.SUNABOT_ASYNC_CODEX = "1";
  env.SUNABOT_NESTED_CODEX_DISABLED = "1";
  return env;
}

export function resolveAuthSource(explicit: string | undefined, environment: NodeJS.ProcessEnv) {
  if (explicit?.trim()) return path.resolve(explicit.trim());
  const sourceHome = String(environment.CODEX_HOME ?? "").trim()
    || path.join(String(environment.HOME ?? "").trim() || os.homedir(), ".codex");
  return path.join(sourceHome, "auth.json");
}

export async function installIsolatedAuth(
  sourcePath: string,
  destinationPath: string,
  strategy: CodexAuthStrategy,
  explicit: boolean
) {
  let realSource: string;
  let sourceStats;
  try {
    realSource = await fs.realpath(sourcePath);
    sourceStats = await fs.stat(realSource);
  } catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CodexPreparationError("auth_unavailable", `Codex auth file is unavailable: ${errorMessage(error)}`);
  }
  if (!sourceStats.isFile()) throw new CodexPreparationError("auth_invalid", "Codex auth source must be a regular file.");
  if ((sourceStats.mode & 0o022) !== 0) {
    throw new CodexPreparationError("auth_insecure", "Codex auth source must not be group- or world-writable.");
  }
  if (typeof process.getuid === "function" && sourceStats.uid !== process.getuid()) {
    throw new CodexPreparationError("auth_owner_mismatch", "Codex auth source is owned by another user.");
  }

  try {
    const destinationStats = await fs.lstat(destinationPath);
    if (strategy === "copy" && destinationStats.isFile() && !destinationStats.isSymbolicLink()) {
      if ((destinationStats.mode & 0o077) !== 0) await fs.chmod(destinationPath, 0o600);
      return;
    }
    if (strategy === "symlink" && destinationStats.isSymbolicLink()) {
      const destinationRealPath = await fs.realpath(destinationPath);
      if (destinationRealPath === realSource) return;
    }
    throw new CodexPreparationError("auth_destination_invalid", "Existing isolated Codex auth does not match the requested strategy.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (strategy === "symlink") {
    await fs.symlink(realSource, destinationPath, "file");
    return;
  }
  const temporaryPath = `${destinationPath}.tmp-${process.pid}`;
  try {
    await fs.copyFile(realSource, temporaryPath, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, destinationPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function installNestedCodexShim(directory: string, platform: NodeJS.Platform) {
  if (platform === "win32") {
    await fs.writeFile(
      path.join(directory, "codex.cmd"),
      "@echo off\r\necho Nested Codex invocation is disabled. 1>&2\r\nexit /b 126\r\n",
      { mode: 0o700 }
    );
    return;
  }
  const shimPath = path.join(directory, "codex");
  await fs.writeFile(shimPath, "#!/bin/sh\necho 'Nested Codex invocation is disabled.' >&2\nexit 126\n", { mode: 0o700 });
  await fs.chmod(shimPath, 0o700);
}

function executableNames(value: string, platform: NodeJS.Platform) {
  return platform === "win32" && !path.extname(value)
    ? [value, `${value}.exe`, `${value}.cmd`, `${value}.bat`]
    : [value];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
