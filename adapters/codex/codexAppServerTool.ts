import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CodexControlRunner,
  CodexProcessIdentity,
  CodexTaskKind,
  CodexToolExecutionContext,
  CodexToolInput,
  CodexToolResult
} from "../../packages/contracts/tools/codex.js";
import {
  buildAppServerTask,
  parseControlInput,
  type CodexControlAction,
  type ParsedControlInput
} from "./codexAppServerContract.js";
import { CodexPreparationError, resolveCodexExecutable } from "./codexEnvironment.js";
import {
  CODEX_DEFAULT_TERMINATION_GRACE_MS,
  signalCodexProcessGroup
} from "./codexProcess.js";
import { CODEX_MAX_JSONL_LINE_BYTES, CODEX_MAX_STDOUT_BYTES } from "./codexProtocol.js";
import {
  CODEX_RESULT_SCHEMA,
  failureResult,
  normalizeModelResult,
  parseCodexResultText,
  validateCodexResultArtifacts,
  withTruncatedOutputNotice
} from "./codexResult.js";

const APP_SERVER_TIMEOUT_MS = 15 * 60 * 1000;
const APP_SERVER_STDERR_CHARS = 64 * 1024;
export { parseControlInput } from "./codexAppServerContract.js";

interface AppServerRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface AppServerMessage extends Record<string, unknown> {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface CodexAppServerRunnerOptions {
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  signalProcessGroup?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  now?: () => number;
  experimentalApi?: boolean;
}

export class CodexAppServerRunner implements CodexControlRunner {
  private readonly spawnProcess;
  private readonly signalProcess;
  private readonly environment;
  private readonly platform;
  private readonly homeDir;
  private readonly now;
  private readonly experimentalApi;

  constructor(options: CodexAppServerRunnerOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.signalProcess = options.signalProcessGroup ?? signalCodexProcessGroup;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? os.homedir();
    this.now = options.now ?? Date.now;
    this.experimentalApi = options.experimentalApi === true;
  }

  async run(input: CodexToolInput, context: CodexToolExecutionContext): Promise<CodexToolResult> {
    const startedAt = this.now();
    const parsed = parseControlInput(input);
    if (!parsed.ok) {
      return failureResult(context.jobId, "analysis", "failed", parsed.code, parsed.error, false);
    }
    if (this.platform !== "darwin" || this.environment.SUNABOT_RUNTIME_MODE === "docker") {
      return failureResult(
        context.jobId,
        controlKind(parsed.value.action),
        "failed",
        "native_control_unavailable",
        "Codex session control is available only from macOS Native Core.",
        false
      );
    }
    if (context.signal?.aborted) {
      return failureResult(context.jobId, controlKind(parsed.value.action), "cancelled", "cancelled", abortMessage(context.signal), false);
    }

    let prepared: PreparedAppServer;
    try {
      prepared = await this.prepare(parsed.value, context);
    } catch (error) {
      return failureResult(
        context.jobId,
        controlKind(parsed.value.action),
        "failed",
        error instanceof CodexPreparationError ? error.code : "prepare_failed",
        errorMessage(error),
        false,
        { durationMs: this.now() - startedAt }
      );
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      return failureResult(
        context.jobId,
        controlKind(parsed.value.action),
        "failed",
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "executable_not_found" : "spawn_failed",
        errorMessage(error),
        true,
        { durationMs: this.now() - startedAt }
      );
    }

    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
      signalSafely(this.signalProcess, child, "SIGKILL");
      return failureResult(
        context.jobId,
        controlKind(parsed.value.action),
        "unknown",
        "process_identity_missing",
        "Codex app-server started without a usable process id.",
        true,
        { durationMs: this.now() - startedAt }
      );
    }
    const identity: CodexProcessIdentity = {
      pid: Number(pid),
      processGroupId: Number(pid),
      attempt: prepared.attempt,
      runToken: prepared.runToken,
      commandMarker: prepared.commandMarker,
      startedAt
    };
    try {
      context.onProcessStarted?.(identity);
    } catch (error) {
      signalSafely(this.signalProcess, child, "SIGKILL");
      return failureResult(
        context.jobId,
        controlKind(parsed.value.action),
        "unknown",
        "process_identity_persist_failed",
        errorMessage(error),
        true,
        { durationMs: this.now() - startedAt }
      );
    }

    return this.monitor(child, parsed.value, context, prepared, startedAt);
  }

  private async prepare(
    input: ParsedControlInput,
    context: CodexToolExecutionContext
  ): Promise<PreparedAppServer> {
    if (!String(context.jobId ?? "").trim()) throw new CodexPreparationError("invalid_job", "jobId is required.");
    if (!path.isAbsolute(context.jobDir)) throw new CodexPreparationError("invalid_path", "jobDir must be absolute.");
    const attempt = positiveInteger(context.attempt, 1);
    const runToken = normalizeRunToken(context.runToken ?? randomUUID());
    const runDir = path.join(context.jobDir, ".codex-app-server", `attempt-${attempt}-${runToken}`);
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const outputDir = !input.sshHost && input.action !== "list_sessions"
      ? path.join(
          context.jobDir,
          ".codex-worker",
          `attempt-${attempt}-${runToken}`,
          "outputs"
        )
      : undefined;
    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
      await validateCodexResultArtifacts({
        declarations: [],
        outputDir,
        jobDir: context.jobDir
      });
    }
    const env = appServerEnvironment(this.environment);
    env.HOME = this.homeDir;

    if (input.sshHost) {
      const sshExecutable = String(this.environment.SUNABOT_CODEX_SSH_BIN ?? "").trim() || "/usr/bin/ssh";
      if (!path.isAbsolute(sshExecutable)) {
        throw new CodexPreparationError("invalid_ssh_executable", "SUNABOT_CODEX_SSH_BIN must be an absolute path.");
      }
      const marker = `SUNABOT_CODEX_RUN_MARKER=${runToken}`;
      return {
        command: sshExecutable,
        args: [
          "-T",
          "-o", "BatchMode=yes",
          input.sshHost,
          "env", marker,
          "codex", "app-server", "--stdio"
        ],
        cwd: runDir,
        env,
        commandMarker: marker,
        reportFile: path.join(runDir, "result.json"),
        attempt,
        runToken
      };
    }

    const executable = await resolveCodexExecutable(context.executable, this.environment, this.platform);
    const launcher = path.join(runDir, `codex-${runToken}`);
    await fs.symlink(executable, launcher);
    env.CODEX_HOME = String(this.environment.SUNABOT_CODEX_GUI_HOME ?? "").trim()
      || path.join(this.homeDir, ".codex");
    return {
      command: launcher,
      args: ["app-server", "--stdio"],
      cwd: runDir,
      env,
      commandMarker: runDir,
      reportFile: path.join(runDir, "result.json"),
      outputDir,
      attempt,
      runToken
    };
  }

  private monitor(
    child: ChildProcess,
    input: ParsedControlInput,
    context: CodexToolExecutionContext,
    prepared: PreparedAppServer,
    startedAt: number
  ): Promise<CodexToolResult> {
    const timeoutMs = positiveInteger(context.timeoutMs, APP_SERVER_TIMEOUT_MS);
    const graceMs = positiveInteger(context.terminationGraceMs, CODEX_DEFAULT_TERMINATION_GRACE_MS);
    const client = new AppServerClient(child);
    let stderr = "";
    let forced: { status: "timed_out" | "cancelled" | "unknown"; code: string; message: string } | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    return new Promise<CodexToolResult>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => terminate("timed_out", "timed_out", `Codex app-server exceeded ${timeoutMs} ms.`), timeoutMs);
      timeout.unref();
      const onAbort = () => terminate("cancelled", "cancelled", abortMessage(context.signal));
      context.signal?.addEventListener("abort", onAbort, { once: true });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, String(chunk), APP_SERVER_STDERR_CHARS);
      });

      const finish = (result: CodexToolResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        context.signal?.removeEventListener("abort", onAbort);
        client.close();
        signalSafely(this.signalProcess, child, "SIGTERM");
        resolve({
          ...result,
          durationMs: this.now() - startedAt,
          stderr: stderr.trim() || undefined
        });
      };

      const fail = (error: unknown) => {
        const state = forced ?? {
          status: "failed" as const,
          code: error instanceof AppServerProtocolError ? error.code : "app_server_failed",
          message: errorMessage(error)
        };
        finish(failureResult(
          context.jobId,
          controlKind(input.action),
          state.status,
          state.code,
          state.message,
          state.status === "timed_out",
          { stderr: stderr.trim() || undefined }
        ));
      };
      client.onError = fail;

      const terminate = (
        status: "timed_out" | "cancelled" | "unknown",
        code: string,
        message: string
      ) => {
        if (settled || forced) return;
        forced = { status, code, message };
        client.rejectAll(new AppServerProtocolError(code, message));
        signalSafely(this.signalProcess, child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) signalSafely(this.signalProcess, child, "SIGKILL");
        }, graceMs);
        killTimer.unref();
        fail(forced);
      };

      child.once("error", fail);
      child.once("close", (exitCode, signal) => {
        if (!settled) {
          fail(new AppServerProtocolError(
            "app_server_exited",
            stderr.trim() || `Codex app-server exited before completion (${exitCode ?? signal ?? "unknown"}).`
          ));
        }
      });

      void this.execute(client, input, context, prepared).then(finish, fail);
    });
  }

  private async execute(
    client: AppServerClient,
    input: ParsedControlInput,
    context: CodexToolExecutionContext,
    prepared: PreparedAppServer
  ): Promise<CodexToolResult> {
    await client.request("initialize", {
      clientInfo: {
        name: "sunabot",
        title: "Sunabot Codex Tool",
        version: "1"
      },
      ...(this.experimentalApi ? { capabilities: { experimentalApi: true } } : {})
    });
    client.notify("initialized");

    if (input.action === "list_sessions") {
      const response = readRecord(await client.request("thread/list", {
        archived: false,
        limit: input.limit,
        sortKey: "updated_at",
        sortDirection: "desc",
        ...(input.workspacePath ? { cwd: input.workspacePath } : {}),
        ...(input.query ? { searchTerm: input.query } : {})
      }));
      const sessions = Array.isArray(response.data)
        ? response.data.slice(0, input.limit).map(sessionSummary)
        : [];
      return {
        ok: true,
        status: "succeeded",
        jobId: context.jobId,
        kind: "analysis",
        content: JSON.stringify({
          sessions,
          nextCursor: nullableText(response.nextCursor),
          host: input.sshHost ?? "local"
        }, null, 2)
      };
    }

    const threadResponse = input.action === "start"
      ? readRecord(await client.request("thread/start", {
          cwd: input.workspacePath,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          ephemeral: false,
          ...(this.experimentalApi ? { runtimeWorkspaceRoots: [input.workspacePath] } : {}),
          ...(context.model?.trim() ? { model: context.model.trim() } : {})
        }))
      : readRecord(await client.request("thread/resume", {
          threadId: input.threadId,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          cwd: input.workspacePath,
          ...(this.experimentalApi ? { runtimeWorkspaceRoots: [input.workspacePath] } : {}),
          ...(context.model?.trim() ? { model: context.model.trim() } : {})
        }));
    const thread = readRecord(threadResponse.thread);
    const threadId = requiredText(thread.id, "Codex thread response omitted thread.id.");
    let finalText = "";
    let usage: Record<string, number> | undefined;
    const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
      client.onNotification = (message) => {
        const method = String(message.method ?? "");
        const params = readRecord(message.params);
        if (method === "item/completed") {
          if (params.threadId !== threadId) return;
          const item = readRecord(params.item);
          if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
            finalText = item.text;
          }
        } else if (method === "thread/tokenUsage/updated") {
          if (params.threadId !== threadId) return;
          const tokenUsage = readRecord(params.tokenUsage);
          usage = numericRecord(tokenUsage.last) ?? numericRecord(tokenUsage.total);
        } else if (method === "turn/completed" && params.threadId === threadId) {
          const turn = readRecord(params.turn);
          const status = String(turn.status ?? "");
          if (status === "failed") {
            reject(new AppServerProtocolError("codex_turn_failed", nestedError(turn.error)));
          } else {
            resolve(turn);
          }
        }
      };
    });
    await client.request("turn/start", {
      threadId,
      input: [{
        type: "text",
        text: buildAppServerTask(
          input.task!,
          input.workspacePath!,
          prepared.outputDir
        )
      }],
      approvalPolicy: "never",
      cwd: prepared.outputDir ?? input.workspacePath,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: prepared.outputDir
          ? [prepared.outputDir, input.workspacePath]
          : [input.workspacePath],
        networkAccess: true
      },
      ...(this.experimentalApi ? {
        runtimeWorkspaceRoots: prepared.outputDir
          ? [prepared.outputDir, input.workspacePath]
          : [input.workspacePath]
      } : {}),
      outputSchema: CODEX_RESULT_SCHEMA
    });
    await completed;
    const modelResult = parseCodexResultText(finalText);
    let artifacts: CodexToolResult["artifacts"] = undefined;
    if (modelResult.status === "succeeded" && modelResult.artifacts?.length) {
      if (!prepared.outputDir) {
        return failureResult(
          context.jobId,
          "local",
          "failed",
          "codex_remote_artifact_unsupported",
          "Remote Codex sessions cannot return file artifacts to this conversation.",
          false,
          { threadId, usage }
        );
      }
      try {
        artifacts = await validateCodexResultArtifacts({
          declarations: modelResult.artifacts,
          outputDir: prepared.outputDir,
          jobDir: context.jobDir
        });
      } catch (error) {
        return failureResult(
          context.jobId,
          "local",
          "failed",
          "codex_artifact_invalid",
          errorMessage(error),
          false,
          { threadId, usage }
        );
      }
    }
    const normalized = normalizeModelResult({
      ...context,
      task: input.task!,
      kind: "local"
    }, modelResult, {
      threadId,
      usage,
      ...(artifacts?.length ? { artifacts } : {})
    });
    if (!client.outputTruncated) return normalized;
    await fs.writeFile(prepared.reportFile, finalText, { encoding: "utf8", mode: 0o600 });
    return withTruncatedOutputNotice(normalized, {
      outputBytes: client.outputBytes,
      reportFile: prepared.reportFile
    });
  }
}

interface PreparedAppServer {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  commandMarker: string;
  reportFile: string;
  outputDir?: string;
  attempt: number;
  runToken: string;
}

class AppServerClient {
  private nextId = 1;
  private buffer = "";
  private totalBytes = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  onNotification?: (message: AppServerMessage) => void;
  onError?: (error: unknown) => void;

  get outputBytes() {
    return this.totalBytes;
  }

  get outputTruncated() {
    return this.totalBytes > CODEX_MAX_STDOUT_BYTES;
  }

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on("data", (chunk: Buffer | string) => this.push(chunk));
  }

  request(method: string, params?: unknown) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  rejectAll(error: unknown) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    this.rejectAll(new AppServerProtocolError("app_server_closed", "Codex app-server connection closed."));
    this.child.stdin?.end();
  }

  private write(message: Omit<AppServerRequest, "id"> & { id?: number }) {
    if (!this.child.stdin?.writable) {
      throw new AppServerProtocolError("stdin_unavailable", "Codex app-server stdin is unavailable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private push(chunk: Buffer | string) {
    const text = String(chunk);
    this.totalBytes += Buffer.byteLength(text);
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.parseLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > CODEX_MAX_JSONL_LINE_BYTES) {
      this.fail(new AppServerProtocolError("jsonl_line_limit", "Codex app-server emitted an oversized JSON line."));
    }
  }

  private parseLine(line: string) {
    if (!line.trim()) return;
    let message: AppServerMessage;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("message must be an object");
      message = parsed as AppServerMessage;
    } catch (error) {
      this.fail(new AppServerProtocolError("invalid_jsonl", `Invalid Codex app-server JSONL: ${errorMessage(error)}`));
      return;
    }
    const id = Number(message.id);
    if (Number.isSafeInteger(id) && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      if (message.error != null) {
        pending.reject(new AppServerProtocolError("request_failed", nestedError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Number.isSafeInteger(id) && typeof message.method === "string") {
      this.fail(new AppServerProtocolError(
        "unexpected_server_request",
        `Codex app-server requested unsupported interaction: ${message.method}`
      ));
      return;
    }
    if (typeof message.method === "string") this.onNotification?.(message);
  }

  private fail(error: unknown) {
    this.rejectAll(error);
    this.onError?.(error);
  }
}

class AppServerProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AppServerProtocolError";
  }
}

function appServerEnvironment(source: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"
  ]) {
    if (source[key]) env[key] = source[key];
  }
  env.NO_COLOR = "1";
  env.SUNABOT_ASYNC_CODEX = "1";
  return env;
}

function sessionSummary(value: unknown) {
  const thread = readRecord(value);
  return {
    id: nullableText(thread.id),
    title: nullableText(thread.title) ?? nullableText(thread.preview),
    cwd: nullableText(thread.cwd),
    updatedAt: thread.updatedAt ?? null,
    status: normalizedSessionStatus(thread),
    protocolStatus: thread.status ?? null
  };
}

function normalizedSessionStatus(
  thread: Record<string, unknown>
): "created" | "running" | "completed" | "failed" | "notLoaded" {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = readRecord(turns.at(-1));
  const turnStatus = String(lastTurn.status ?? "");
  if (turnStatus === "inProgress") return "running";
  if (turnStatus === "completed") return "completed";
  if (turnStatus === "failed" || turnStatus === "interrupted") return "failed";

  const protocol = readRecord(thread.status);
  const protocolType = String(protocol.type ?? thread.status ?? "");
  if (protocolType === "notLoaded") return "notLoaded";
  if (protocolType === "active") return "running";
  if (protocolType === "systemError") return "failed";
  if (protocolType === "idle") {
    return optionalText(thread.preview) || optionalText(thread.name) || optionalText(thread.title)
      ? "completed"
      : "created";
  }
  return "created";
}

function controlKind(action: CodexControlAction): CodexTaskKind {
  return action === "list_sessions" ? "analysis" : "local";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numericRecord(value: unknown) {
  const record = readRecord(value);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

function nestedError(value: unknown) {
  const record = readRecord(value);
  return String(record.message ?? record.code ?? "Codex app-server request failed.").slice(0, 4_000);
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, message: string) {
  const text = optionalText(value);
  if (!text) throw new AppServerProtocolError("invalid_response", message);
  return text;
}

function normalizeRunToken(value: string) {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
    throw new CodexPreparationError("invalid_run_token", "Codex run token is invalid.");
  }
  return token;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function signalSafely(
  signalProcess: (child: ChildProcess, signal: NodeJS.Signals) => void,
  child: ChildProcess,
  signal: NodeJS.Signals
) {
  try {
    signalProcess(child, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function abortMessage(signal?: AbortSignal) {
  if (!signal) return "Codex task was cancelled.";
  return signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason ?? "Codex task was cancelled.");
}

function appendBounded(current: string, incoming: string, maximum: number) {
  if (current.length >= maximum) return current;
  return `${current}${incoming}`.slice(0, maximum);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
