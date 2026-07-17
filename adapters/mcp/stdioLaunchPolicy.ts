import path from "node:path";
import {
  isSafeMcpCommandPath,
  isUnsafeMcpCommand
} from "../../packages/contracts/extensions/agentMcpDescriptorSecurity.js";
import type { HardenedStdioLaunchSpec } from "./hardenedStdioTransport.js";

export const MCP_RUNTIME_DOWNLOADERS = [
  "bunx",
  "corepack",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "uv",
  "uvx",
  "yarn"
] as const;

const runtimeDownloaders = new Set<string>(MCP_RUNTIME_DOWNLOADERS);
const forbiddenServerEnvironment = new Set([
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "NO_PROXY"
]);

export function validateMcpStdioLaunchSpec(spec: HardenedStdioLaunchSpec) {
  const normalized = path.posix.normalize(spec.command);
  const environmentPrototype = Object.getPrototypeOf(spec.env);
  if (!isSafeMcpCommandPath(normalized) || isUnsafeMcpCommand(normalized) || normalized !== spec.command ||
      isMcpRuntimeDownloaderCommand(normalized, spec.args) ||
      spec.cwd !== "/workbench" || spec.inheritEnv !== false || spec.stderr !== "pipe" ||
      spec.killScope !== "process_group" || spec.args.length > 128 || Object.keys(spec.env).length > 64 ||
      (environmentPrototype !== Object.prototype && environmentPrototype !== null) ||
      !Object.isExtensible(spec.env) || Object.keys(spec.env).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(spec.env, key);
        return !descriptor || descriptor.get !== undefined || descriptor.set !== undefined ||
          descriptor.writable !== true || descriptor.configurable !== true;
      }) ||
      spec.args.some(invalidMcpStdioText) || Object.entries(spec.env).some(([key, value]) => {
        const upper = key.toUpperCase();
        return !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || forbiddenServerEnvironment.has(upper) ||
          upper.endsWith("_PROXY") || invalidMcpStdioText(value) || value.length === 0;
      })) {
    throw stableError("MCP_STDIO_CONFIG_INVALID");
  }
}

export function clearMcpStdioResolvedEnvironment(environment: Readonly<Record<string, string>>) {
  const target = environment as Record<string, string>;
  try {
    for (const key of Object.keys(target)) {
      const value = target[key] ?? "";
      target[key] = "\0".repeat(Math.min(value.length, 16 * 1024));
      target[key] = "";
      delete target[key];
    }
  } catch {
    throw stableError("MCP_STDIO_SECRET_CLEAR_FAILED");
  }
  if (Object.keys(target).length !== 0) throw stableError("MCP_STDIO_SECRET_CLEAR_FAILED");
}

export function isMcpRuntimeDownloaderCommand(command: string, args: readonly string[]) {
  const base = path.posix.basename(command).toLowerCase();
  if (runtimeDownloaders.has(base)) return true;
  return /^(?:python|python3)(?:\.\d+)?$/u.test(base) && args.some((value, index) =>
    value.toLowerCase() === "-m" && ["ensurepip", "pip", "pip3", "uv"].includes(
      (args[index + 1] ?? "").toLowerCase()
    ));
}

export function invalidMcpStdioText(value: unknown) {
  return typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16 * 1024;
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
