import path from "node:path";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export interface HardenedStdioLaunchSpec {
  command: string;
  args: string[];
  cwd: "/workbench";
  env: Readonly<Record<string, string>>;
  inheritEnv: false;
  stderr: "pipe";
  killScope: "process_group";
}

export interface HardenedStdioLaunchHandlers {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  exit(): void;
  error(error: unknown): void;
}

export interface HardenedStdioProcess {
  writeStdin(value: string): Promise<void>;
  closeStdin(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
  terminateGroup(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

/**
 * The launcher is deliberately injected. Its implementation must create a
 * process-group or container boundary, map the virtual cwd to /workbench, and
 * honour inheritEnv=false. The adapter has no raw-host fallback.
 */
export interface HardenedStdioProcessLauncher {
  launch(spec: HardenedStdioLaunchSpec, handlers: HardenedStdioLaunchHandlers): Promise<HardenedStdioProcess>;
}

export interface HardenedStdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  launcher: HardenedStdioProcessLauncher;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  closeGraceMs?: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const FORBIDDEN_ENV = new Set([
  "HOME",
  "PATH",
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
  "NO_PROXY"
]);

export class HardenedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly maxMessageBytes: number;
  private readonly maxStderrBytes: number;
  private readonly closeGraceMs: number;
  private process?: HardenedStdioProcess;
  private readBuffer = Buffer.alloc(0);
  private totalStderrBytes = 0;
  private closed = false;
  private closeNotified = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private readonly command: string;
  private readonly args: string[];
  private readonly environment: Record<string, string>;
  private readonly launcher: HardenedStdioProcessLauncher;

  constructor(options: HardenedStdioTransportOptions) {
    this.command = options.command;
    this.args = [...(options.args ?? [])];
    this.environment = { ...(options.env ?? {}) };
    this.launcher = options.launcher;
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);
    this.maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);
    this.closeGraceMs = closeGrace(options.closeGraceMs);
  }

  async start() {
    if (this.closed) throw stableError("MCP_STDIO_NOT_RUNNING");
    if (this.process) return;
    if (this.starting) return this.starting;
    try {
      this.validateConfiguration();
    } catch (error) {
      this.clearLaunchInputs();
      throw error;
    }
    const launchSpec: HardenedStdioLaunchSpec = {
      command: this.command,
      args: [...this.args],
      cwd: "/workbench",
      env: { ...this.environment },
      inheritEnv: false,
      stderr: "pipe",
      killScope: "process_group"
    };
    this.starting = this.launcher.launch(launchSpec, {
      stdout: (chunk) => this.handleStdout(chunk),
      stderr: (chunk) => this.handleStderr(chunk),
      exit: () => {
        this.clearLaunchInputs();
        clearTransientLaunchSpec(launchSpec);
        this.process = undefined;
        this.closed = true;
        this.notifyClosed();
      },
      error: () => {
        this.report("MCP_STDIO_PROCESS_ERROR");
        void this.close().catch(() => this.report("MCP_STDIO_CLEANUP_FAILED"));
      }
    }).then(async (process) => {
      if (this.closed) {
        await this.stopProcess(process);
        return;
      }
      this.process = process;
    }).catch((error) => {
      if (error instanceof Error && error.message === "MCP_STDIO_CLEANUP_FAILED") throw error;
      throw stableError("MCP_STDIO_LAUNCH_FAILED");
    }).finally(() => {
      this.clearLaunchInputs();
      clearTransientLaunchSpec(launchSpec);
      this.starting = undefined;
    });
    return this.starting;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions) {
    const process = this.process;
    if (!process || this.closed) throw stableError("MCP_STDIO_NOT_RUNNING");
    let serialized: string;
    try {
      serialized = serializeMessage(message);
    } catch {
      throw stableError("MCP_STDIO_MESSAGE_INVALID");
    }
    if (Buffer.byteLength(serialized) > this.maxMessageBytes) {
      throw stableError("MCP_STDIO_MESSAGE_TOO_LARGE");
    }
    try {
      await process.writeStdin(serialized);
    } catch {
      throw stableError("MCP_STDIO_WRITE_FAILED");
    }
  }

  async close() {
    if (this.closed && !this.process && !this.starting) {
      this.clearLaunchInputs();
      return;
    }
    if (this.closing) return this.closing;
    this.closed = true;
    const operation = (async () => {
      try {
        await waitForStartOnClose(this.starting, this.closeGraceMs);
        const process = this.process;
        if (process) {
          await this.stopProcess(process);
          if (this.process === process) this.process = undefined;
        }
        this.readBuffer = Buffer.alloc(0);
        this.notifyClosed();
      } finally {
        this.clearLaunchInputs();
      }
    })().finally(() => {
      if (this.closing === operation) this.closing = undefined;
    });
    this.closing = operation;
    return operation;
  }

  stderrSummary() {
    return {
      byteLength: this.totalStderrBytes,
      truncated: this.totalStderrBytes > this.maxStderrBytes
    };
  }

  private async stopProcess(process: HardenedStdioProcess) {
    await boundedCleanup(() => process.closeStdin(), this.closeGraceMs);
    if (await waitSafely(process, this.closeGraceMs)) return;
    await boundedCleanup(() => process.terminateGroup("SIGTERM"), this.closeGraceMs);
    if (await waitSafely(process, this.closeGraceMs)) return;
    await strictCleanup(() => process.terminateGroup("SIGKILL"), this.closeGraceMs);
    if (!await waitSafely(process, this.closeGraceMs)) throw stableError("MCP_STDIO_CLEANUP_FAILED");
  }

  private handleStdout(chunk: Buffer) {
    if (this.closed || chunk.length === 0) return;
    let offset = 0;
    while (true) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        const tail = chunk.subarray(offset);
        if (this.readBuffer.length + tail.length > this.maxMessageBytes) {
          this.failMessageLimit();
          return;
        }
        this.readBuffer = Buffer.concat([this.readBuffer, tail]);
        return;
      }
      const segment = chunk.subarray(offset, newline);
      if (this.readBuffer.length + segment.length > this.maxMessageBytes) {
        this.failMessageLimit();
        return;
      }
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([this.readBuffer, segment]));
      } catch {
        this.readBuffer = Buffer.alloc(0);
        this.failProtocol("MCP_STDIO_MESSAGE_INVALID");
        return;
      }
      this.readBuffer = Buffer.alloc(0);
      offset = newline + 1;
      if (!line.trim()) continue;
      try {
        this.onmessage?.(deserializeMessage(line));
      } catch {
        this.failProtocol("MCP_STDIO_MESSAGE_INVALID");
        return;
      }
    }
  }

  private handleStderr(chunk: Buffer) {
    if (chunk.length === 0) return;
    this.totalStderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.totalStderrBytes + chunk.length);
  }

  private failMessageLimit() {
    this.readBuffer = Buffer.alloc(0);
    this.failProtocol("MCP_STDIO_MESSAGE_TOO_LARGE");
  }

  private failProtocol(code: string) {
    this.readBuffer = Buffer.alloc(0);
    this.report(code);
    void this.close().catch(() => this.report("MCP_STDIO_CLEANUP_FAILED"));
  }

  private report(code: string) {
    this.onerror?.(stableError(code));
  }

  private notifyClosed() {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }

  private validateConfiguration() {
    if (!path.isAbsolute(this.command) || invalidText(this.command)) {
      throw stableError("MCP_STDIO_CONFIG_INVALID");
    }
    if (this.args.length > 128 || Object.keys(this.environment).length > 64) {
      throw stableError("MCP_STDIO_CONFIG_INVALID");
    }
    for (const arg of this.args) {
      if (invalidText(arg)) throw stableError("MCP_STDIO_CONFIG_INVALID");
    }
    for (const [rawKey, value] of Object.entries(this.environment)) {
      const key = rawKey.toUpperCase();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)
        || FORBIDDEN_ENV.has(key)
        || key.endsWith("_PROXY")
        || invalidText(value)) {
        throw stableError("MCP_STDIO_CONFIG_INVALID");
      }
    }
  }

  private clearLaunchInputs() {
    clearResolvedEnvironment(this.environment);
    this.args.fill("");
    this.args.splice(0, this.args.length);
  }
}

function clearTransientLaunchSpec(spec: HardenedStdioLaunchSpec) {
  clearResolvedEnvironment(spec.env as Record<string, string>);
  spec.args.fill("");
  spec.args.splice(0, spec.args.length);
}

function clearResolvedEnvironment(environment: Record<string, string>) {
  for (const key of Object.keys(environment)) {
    const value = environment[key] ?? "";
    environment[key] = "\0".repeat(Math.min(value.length, 16 * 1024));
    environment[key] = "";
    delete environment[key];
  }
}

function invalidText(value: unknown): value is string {
  return typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 16 * 1024;
}

function positiveInteger(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 32 * 1024 * 1024) {
    throw stableError("MCP_STDIO_CONFIG_INVALID");
  }
  return value;
}

function closeGrace(value: number | undefined) {
  const resolved = value ?? DEFAULT_CLOSE_GRACE_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 10_000) {
    throw stableError("MCP_STDIO_CONFIG_INVALID");
  }
  return resolved;
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}

async function waitSafely(process: HardenedStdioProcess, timeoutMs: number) {
  try {
    return await withDeadline(process.waitForExit(timeoutMs), timeoutMs, false);
  } catch {
    return false;
  }
}

async function boundedCleanup(operation: () => Promise<void>, timeoutMs: number) {
  try {
    await withDeadline(operation(), timeoutMs, undefined);
  } catch {
    // Cleanup remains best-effort and bounded by the injected launcher.
  }
}

async function strictCleanup(operation: () => Promise<void>, timeoutMs: number) {
  try {
    await withDeadlineReject(operation(), timeoutMs);
  } catch {
    throw stableError("MCP_STDIO_CLEANUP_FAILED");
  }
}

async function waitForStartOnClose(promise: Promise<void> | undefined, timeoutMs: number) {
  if (!promise) return;
  try {
    await withDeadlineReject(promise, timeoutMs);
  } catch (error) {
    if (error instanceof Error && (error.message === "MCP_STDIO_CLEANUP_FAILED" ||
        error.message === "MCP_STDIO_CLEANUP_TIMEOUT")) throw stableError("MCP_STDIO_CLEANUP_FAILED");
    // A launch failure has no process to clean up.
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, fallback: T) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function withDeadlineReject<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(stableError("MCP_STDIO_CLEANUP_TIMEOUT")), timeoutMs);
    timer.unref?.();
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
