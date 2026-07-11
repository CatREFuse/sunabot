import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TOOL_CALL_TIMEOUT_MS } from "./toolConstants.js";
import {
  WORKSPACE_BASH_ISOLATION_ERROR,
  buildBubblewrapInvocation,
  ensureWorkspaceBashIsolation,
  type WorkspaceBashSandboxOptions
} from "./bashSandbox.js";

export const WORKSPACE_BASH_TOOL_NAME = "workspace_bash";

const MAX_COMMAND_LENGTH = 4_000;
const MAX_OUTPUT_CHARS = 24_000;

export interface WorkspaceBashInput {
  command?: unknown;
  timeoutMs?: unknown;
}

export interface WorkspaceBashResult {
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface WorkspaceBashOptions {
  workspaceOnly?: boolean;
  blockedKeywords?: string[];
  sandbox?: WorkspaceBashSandboxOptions;
}

export const workspaceBashTool = {
  type: "function",
  name: WORKSPACE_BASH_TOOL_NAME,
  description: "Run a bash command in a filesystem sandbox where the host filesystem is read-only outside the agent workspace.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        description: "Bash command to run from the workspace root."
      },
      timeoutMs: {
        type: ["integer", "null"],
        enum: [TOOL_CALL_TIMEOUT_MS, null],
        description: "Tool timeout is fixed at 300000 milliseconds. Use null to apply it."
      }
    },
    required: ["command", "timeoutMs"]
  },
  strict: true
};

export function createWorkspaceBashTool(options: WorkspaceBashOptions = {}) {
  const blockedKeywords = uniqueBlockedKeywords(options.blockedKeywords ?? []);
  const description = "Run a bash command in a filesystem sandbox where the host filesystem is read-only outside the agent workspace.";
  return {
    ...workspaceBashTool,
    description: blockedKeywords.length
      ? `${description} Commands containing these blocked keywords are rejected: ${blockedKeywords.join(", ")}.`
      : description
  };
}

export async function runWorkspaceBash(
  input: WorkspaceBashInput,
  workspacePath: string,
  options: WorkspaceBashOptions = {}
): Promise<WorkspaceBashResult> {
  const command = normalizeCommand(input.command);
  const workspaceRoot = await resolveWorkspaceRoot(workspacePath);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const workspaceOnly = options.workspaceOnly !== false;
  const blockedReason =
    validateBasicCommand(command) ||
    validateBlockedKeywords(command, options.blockedKeywords ?? []) ||
    (workspaceOnly ? validateWorkspaceCommand(command, workspaceRoot) : "");

  if (blockedReason) {
    return blockedResult(command, workspaceRoot, blockedReason);
  }

  await fs.mkdir(path.join(workspaceRoot, ".tmp"), { recursive: true });
  const environment = buildWorkspaceEnv(workspaceRoot);
  let sandboxExecutable: string;
  try {
    sandboxExecutable = await ensureWorkspaceBashIsolation(workspaceRoot, environment, options.sandbox);
  } catch (error) {
    return blockedResult(
      command,
      workspaceRoot,
      `${WORKSPACE_BASH_ISOLATION_ERROR}: ${errorMessage(error)}`
    );
  }
  const { file, args } = buildBubblewrapInvocation(command, workspaceRoot, environment, sandboxExecutable);

  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: workspaceRoot,
      env: environment,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      killSignal: "SIGTERM"
    }, (error, stdout, stderr) => {
      const nodeError = error as ExecFileError | null;
      resolve({
        ok: !error,
        command,
        cwd: workspaceRoot,
        exitCode: typeof nodeError?.code === "number" ? nodeError.code : error ? 1 : 0,
        signal: typeof nodeError?.signal === "string" ? nodeError.signal : null,
        timedOut: Boolean(nodeError?.killed && nodeError?.signal === "SIGTERM"),
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr || (error && typeof nodeError?.code !== "number" ? error.message : ""))
      });
    });
  });
}

interface ExecFileError extends Error {
  code?: number | string;
  signal?: string;
  killed?: boolean;
}

async function resolveWorkspaceRoot(workspacePath: string) {
  const resolved = path.resolve(workspacePath);
  await fs.mkdir(resolved, { recursive: true });
  return fs.realpath(resolved);
}

function normalizeCommand(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeTimeout(_value: unknown) {
  return TOOL_CALL_TIMEOUT_MS;
}

function validateBasicCommand(command: string) {
  if (!command) return "Empty bash command.";
  if (command.length > MAX_COMMAND_LENGTH) return `Command is too long. Maximum length is ${MAX_COMMAND_LENGTH} characters.`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(command)) return "Control characters are not allowed.";
  return "";
}

function validateBlockedKeywords(command: string, blockedKeywords: string[]) {
  const lowerCommand = command.toLowerCase();
  const blockedKeyword = uniqueBlockedKeywords(blockedKeywords).find((keyword) => lowerCommand.includes(keyword.toLowerCase()));
  return blockedKeyword ? `Command contains blocked keyword: ${blockedKeyword}` : "";
}

function validateWorkspaceCommand(command: string, workspaceRoot: string) {
  if (/(^|[;&|()\s])cd(?:\s|$)/.test(command)) return "Changing directories is not allowed. Run commands from the workspace root.";
  if (/(^|[\s:=])~(?:[/\s]|$)/.test(command)) return "Home-directory paths are not allowed.";
  if (/(^|[\s/\\])\.\.([\s/\\]|$)/.test(command)) return "Parent-directory paths are not allowed.";

  for (const absolutePath of extractAbsolutePaths(command)) {
    const resolvedPath = path.resolve(absolutePath);
    if (!isWithinPath(workspaceRoot, resolvedPath)) {
      return `Path is outside the workspace: ${absolutePath}`;
    }
  }

  return "";
}

function uniqueBlockedKeywords(blockedKeywords: string[]) {
  return [...new Set(blockedKeywords.map((keyword) => keyword.trim()).filter(Boolean))];
}

function extractAbsolutePaths(command: string) {
  const paths: string[] = [];
  const pattern = /(^|[\s"'`=([{;|&<>])\/(?!\/)([^\s"'`;|&<>)]*)/g;
  for (const match of command.matchAll(pattern)) {
    const value = `/${match[2] ?? ""}`.replace(/[),.]+$/, "");
    if (value !== "/") paths.push(value);
  }
  return paths;
}

function isWithinPath(rootPath: string, candidatePath: string) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function buildWorkspaceEnv(workspaceRoot: string) {
  const tmpDir = path.join(workspaceRoot, ".tmp");
  return {
    PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: workspaceRoot,
    PWD: workspaceRoot,
    TMPDIR: `${tmpDir}${path.sep}`,
    TMP: tmpDir,
    TEMP: tmpDir,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "",
    SHELL: "/bin/bash",
    USER: process.env.USER || os.userInfo().username
  };
}

function blockedResult(command: string, workspaceRoot: string, reason: string): WorkspaceBashResult {
  return {
    ok: false,
    command,
    cwd: workspaceRoot,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: reason
  };
}

function truncateOutput(value: string) {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}
