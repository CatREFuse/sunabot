import fs from "node:fs/promises";
import path from "node:path";

export const MCP_OAUTH_VAULT_KEY_ENV = "SUNABOT_MCP_CREDENTIAL_VAULT_KEY";
export const MCP_STDIO_BACKEND_ENV = "SUNABOT_MCP_STDIO_BACKEND";
export const MCP_STDIO_EXECUTABLE_MANIFEST_ENV = "SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST";

/**
 * @returns {false | { backend: "bubblewrap"; executableManifestPath: string }}
 */
export function resolveMcpStdioRuntimeOptions(environment = process.env, platform = process.platform) {
  const backend = String(environment[MCP_STDIO_BACKEND_ENV] ?? "").trim();
  if (!backend || backend === "disabled") return false;
  if (backend === "bubblewrap") {
    if (platform === "darwin" || platform === "win32") invalid("MCP_STDIO_BACKEND_UNAVAILABLE");
    const executableManifestPath = String(environment[MCP_STDIO_EXECUTABLE_MANIFEST_ENV] ?? "").trim();
    if (!path.isAbsolute(executableManifestPath) || /[\u0000\r\n]/u.test(executableManifestPath)) {
      invalid("MCP_STDIO_EXECUTABLE_MANIFEST_INVALID");
    }
    return { backend, executableManifestPath: path.resolve(executableManifestPath) };
  }
  invalid("MCP_STDIO_BACKEND_INVALID");
}

export async function inspectMcpRuntimeConfiguration(input = {}) {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const oauth = inspectOAuthVaultKey(environment);
  let stdio;
  try {
    const options = resolveMcpStdioRuntimeOptions(environment, platform);
    if (options === false) {
      stdio = { ok: false, configured: false, backend: "disabled", detail: "stdio MCP is disabled" };
    } else {
      const manifest = await inspectNativeManifest(
        options.executableManifestPath,
        input.expectedManifestUid ?? 0
      );
      stdio = {
        ok: manifest.ok,
        configured: true,
        backend: "bubblewrap",
        path: options.executableManifestPath,
        detail: manifest.detail
      };
    }
  } catch (error) {
    stdio = {
      ok: false,
      configured: true,
      backend: String(environment[MCP_STDIO_BACKEND_ENV] ?? "").trim() || "invalid",
      detail: stableCode(error, "MCP_STDIO_RUNTIME_CONFIG_INVALID")
    };
  }
  return { oauth, stdio };
}

function inspectOAuthVaultKey(environment) {
  const raw = String(environment[MCP_OAUTH_VAULT_KEY_ENV] ?? "").trim();
  if (!raw) return { ok: false, configured: false, detail: "OAuth credential vault key is missing" };
  if (!/^[A-Za-z0-9_-]{43}$/u.test(raw)) {
    return { ok: false, configured: true, detail: "MCP_OAUTH_VAULT_KEY_INVALID" };
  }
  const key = Buffer.from(raw, "base64url");
  const valid = key.byteLength === 32 && key.toString("base64url") === raw;
  key.fill(0);
  return valid
    ? { ok: true, configured: true, detail: "OAuth credential vault key configured" }
    : { ok: false, configured: true, detail: "MCP_OAUTH_VAULT_KEY_INVALID" };
}

async function inspectNativeManifest(file, expectedUid) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== expectedUid ||
        (stat.mode & 0o777) !== 0o444 || await fs.realpath(file) !== file) {
      return { ok: false, detail: "MCP_STDIO_EXECUTABLE_MANIFEST_INVALID" };
    }
    return { ok: true, detail: "root-owned read-only executable manifest configured" };
  } catch {
    return { ok: false, detail: "MCP_STDIO_EXECUTABLE_MANIFEST_INVALID" };
  }
}

function stableCode(error, fallback) {
  const code = error instanceof Error ? error.message : "";
  return /^MCP_[A-Z0-9_]+$/u.test(code) ? code : fallback;
}

function invalid(code) {
  const error = new Error(code);
  error.name = "McpRuntimeConfigurationError";
  throw error;
}
