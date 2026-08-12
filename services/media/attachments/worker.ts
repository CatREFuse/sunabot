import { fork, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ATTACHMENT_WORKER_MAX_CONCURRENCY = 2;
export const ATTACHMENT_WORKER_TIMEOUT_MS = 90_000;
export const ATTACHMENT_WORKER_MAX_OLD_SPACE_MB = 768;
export const ATTACHMENT_WORKER_MAX_IPC_BYTES = 1024 * 1024;
export const ATTACHMENT_WORKER_MAX_WORK_DIR_BYTES = 1024 * 1024 * 1024;
export const ATTACHMENT_WORKER_MAX_RSS_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

export type AttachmentWorkerCommand =
  | { kind: "echo"; value?: unknown }
  | { kind: "module"; modulePath: string; exportName?: string; payload?: unknown };

export interface AttachmentWorkerTask {
  taskId: string;
  workDir: string;
  command: AttachmentWorkerCommand;
}

export interface AttachmentWorkerSuccess<T = unknown> {
  taskId: string;
  ok: true;
  result?: T;
  resultFile?: string;
  resultBytes: number;
  workerPeakRssBytes: number;
}

interface AttachmentWorkerFailure {
  taskId?: string;
  ok: false;
  error?: { code?: string; message?: string };
}

export type AttachmentWorkerErrorCode =
  | "worker_timeout"
  | "worker_ipc_limit"
  | "worker_workdir_limit"
  | "worker_rss_limit"
  | "worker_crashed"
  | "worker_protocol_error"
  | "worker_task_failed"
  | "worker_spawn_failed";

export class AttachmentWorkerError extends Error {
  constructor(
    readonly code: AttachmentWorkerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AttachmentWorkerError";
  }
}

export interface AttachmentWorkerSupervisorOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
  maxIpcBytes?: number;
  maxWorkDirBytes?: number;
  maxRssBytes?: number;
  monitorIntervalMs?: number;
  terminationGraceMs?: number;
  workerEntryPath?: string;
  workerExecArgv?: string[];
  measureWorkDirBytes?: (workDir: string) => Promise<number>;
  measureProcessGroupRssBytes?: (processGroupId: number) => Promise<number>;
}

interface QueueItem<T> {
  task: AttachmentWorkerTask;
  signal?: AbortSignal;
  onQueuedAbort?: () => void;
  resolve: (result: AttachmentWorkerSuccess<T>) => void;
  reject: (error: unknown) => void;
}

export class AttachmentWorkerSupervisor {
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private readonly maxIpcBytes: number;
  private readonly maxWorkDirBytes: number;
  private readonly maxRssBytes: number;
  private readonly monitorIntervalMs: number;
  private readonly terminationGraceMs: number;
  private readonly workerEntryPath: string;
  private readonly workerExecArgv: string[];
  private readonly measureWorkDirBytes: (workDir: string) => Promise<number>;
  private readonly measureProcessGroupRssBytes: (processGroupId: number) => Promise<number>;
  private readonly queue: QueueItem<unknown>[] = [];
  private active = 0;

  constructor(options: AttachmentWorkerSupervisorOptions = {}) {
    this.maxConcurrency = boundedInteger(
      options.maxConcurrency,
      ATTACHMENT_WORKER_MAX_CONCURRENCY,
      1,
      ATTACHMENT_WORKER_MAX_CONCURRENCY,
      "maxConcurrency"
    );
    this.timeoutMs = positiveInteger(options.timeoutMs, ATTACHMENT_WORKER_TIMEOUT_MS, "timeoutMs");
    this.maxIpcBytes = positiveInteger(options.maxIpcBytes, ATTACHMENT_WORKER_MAX_IPC_BYTES, "maxIpcBytes");
    this.maxWorkDirBytes = positiveInteger(
      options.maxWorkDirBytes,
      ATTACHMENT_WORKER_MAX_WORK_DIR_BYTES,
      "maxWorkDirBytes"
    );
    this.maxRssBytes = positiveInteger(options.maxRssBytes, ATTACHMENT_WORKER_MAX_RSS_BYTES, "maxRssBytes");
    this.monitorIntervalMs = positiveInteger(options.monitorIntervalMs, 1_000, "monitorIntervalMs");
    this.terminationGraceMs = positiveInteger(options.terminationGraceMs, 2_000, "terminationGraceMs");
    this.workerEntryPath = options.workerEntryPath ?? fileURLToPath(new URL("./worker-entry.js", import.meta.url));
    this.workerExecArgv = options.workerExecArgv?.slice() ?? [];
    this.measureWorkDirBytes = options.measureWorkDirBytes ?? directorySizeBytes;
    this.measureProcessGroupRssBytes = options.measureProcessGroupRssBytes ?? processGroupRssBytes;
  }

  get activeCount() {
    return this.active;
  }

  get pendingCount() {
    return this.queue.length;
  }

  run<T = unknown>(
    task: AttachmentWorkerTask,
    signal?: AbortSignal
  ): Promise<AttachmentWorkerSuccess<T>> {
    validateTask(task);
    signal?.throwIfAborted();
    return new Promise<AttachmentWorkerSuccess<T>>((resolve, reject) => {
      const item: QueueItem<unknown> = {
        task,
        signal,
        resolve: resolve as QueueItem<unknown>["resolve"],
        reject
      };
      const onQueuedAbort = () => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(signal?.reason ?? new Error("Attachment worker cancelled."));
      };
      item.onQueuedAbort = onQueuedAbort;
      signal?.addEventListener("abort", onQueuedAbort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.signal?.removeEventListener("abort", item.onQueuedAbort!);
      if (item.signal?.aborted) {
        item.reject(item.signal.reason ?? new Error("Attachment worker cancelled."));
        continue;
      }
      this.active += 1;
      void this.execute(item.task, item.signal)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private async execute(
    task: AttachmentWorkerTask,
    signal?: AbortSignal
  ): Promise<AttachmentWorkerSuccess> {
    signal?.throwIfAborted();
    await fs.mkdir(task.workDir, { recursive: true });
    signal?.throwIfAborted();
    const child = this.spawnWorker();
    const processGroupId = child.pid;
    if (!processGroupId) {
      child.kill("SIGKILL");
      throw new AttachmentWorkerError("worker_spawn_failed", "Attachment worker did not receive a process ID");
    }

    return new Promise<AttachmentWorkerSuccess>((resolve, reject) => {
      let completed = false;
      let monitoring = false;
      let forcedError: AttachmentWorkerError | undefined;
      let response: AttachmentWorkerSuccess | undefined;
      let stderr = "";
      let killTimer: NodeJS.Timeout | undefined;
      const terminationGraceMs = this.terminationGraceMs;
      const onAbort = () => {
        terminate(new AttachmentWorkerError(
          "worker_task_failed",
          "Attachment worker was cancelled.",
          { taskId: task.taskId }
        ));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      const timeout = setTimeout(() => {
        terminate(new AttachmentWorkerError("worker_timeout", `Attachment worker exceeded ${this.timeoutMs} ms`, {
          taskId: task.taskId
        }));
      }, this.timeoutMs);

      const monitor = setInterval(() => {
        if (monitoring || completed || forcedError) return;
        monitoring = true;
        let pendingProbes = 2;
        const finishProbe = () => {
          pendingProbes -= 1;
          if (pendingProbes === 0) monitoring = false;
        };
        void Promise.resolve()
          .then(() => this.measureWorkDirBytes(task.workDir))
          .then((workDirBytes) => {
            if (completed || forcedError || workDirBytes <= this.maxWorkDirBytes) return;
            terminate(new AttachmentWorkerError(
              "worker_workdir_limit",
              `Attachment worker directory exceeded ${this.maxWorkDirBytes} bytes`,
              { taskId: task.taskId, workDirBytes }
            ));
          }, (error) => {
            if (!completed && !forcedError) {
              stderr = appendBounded(stderr, `monitor(workdir): ${errorMessage(error)}\n`);
            }
          })
          .catch((error) => {
            if (!completed) stderr = appendBounded(stderr, `monitor(workdir handler): ${errorMessage(error)}\n`);
          })
          .finally(finishProbe);
        void Promise.resolve()
          .then(() => this.measureProcessGroupRssBytes(processGroupId))
          .then((rssBytes) => {
            if (completed || forcedError || rssBytes <= this.maxRssBytes) return;
            terminate(new AttachmentWorkerError(
              "worker_rss_limit",
              `Attachment worker process group exceeded ${this.maxRssBytes} bytes RSS`,
              { taskId: task.taskId, rssBytes }
            ));
          }, (error) => {
            if (!completed && !forcedError) {
              stderr = appendBounded(stderr, `monitor(rss): ${errorMessage(error)}\n`);
            }
          })
          .catch((error) => {
            if (!completed) stderr = appendBounded(stderr, `monitor(rss handler): ${errorMessage(error)}\n`);
          })
          .finally(finishProbe);
      }, this.monitorIntervalMs);

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendBounded(stderr, String(chunk));
      });

      child.on("message", (message: unknown) => {
        if (completed || forcedError || response) return;
        let serialized: string;
        try {
          serialized = JSON.stringify(message);
        } catch {
          terminate(new AttachmentWorkerError("worker_protocol_error", "Attachment worker returned non-JSON IPC"));
          return;
        }
        const ipcBytes = Buffer.byteLength(serialized);
        if (ipcBytes > this.maxIpcBytes) {
          terminate(new AttachmentWorkerError(
            "worker_ipc_limit",
            `Attachment worker IPC exceeded ${this.maxIpcBytes} bytes`,
            { taskId: task.taskId, ipcBytes }
          ));
          return;
        }

        const parsed = normalizeWorkerResponse(message, task);
        if (parsed instanceof AttachmentWorkerError) {
          terminate(parsed);
          return;
        }
        response = parsed;
      });

      child.once("error", (error) => {
        terminate(new AttachmentWorkerError("worker_spawn_failed", `Attachment worker failed: ${error.message}`, {
          taskId: task.taskId
        }));
      });

      child.once("exit", (code, exitSignal) => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener?.("abort", onAbort);
        clearTimeout(timeout);
        clearInterval(monitor);
        if (killTimer) clearTimeout(killTimer);
        if (forcedError) {
          reject(forcedError);
          return;
        }
        if (response) {
          const successfulResponse = response;
          void this.validateFinalResources(task, successfulResponse).then(
            () => resolve(successfulResponse),
            reject
          );
          return;
        }
        reject(new AttachmentWorkerError("worker_crashed", "Attachment worker exited without a result", {
          taskId: task.taskId,
          exitCode: code,
          signal: exitSignal,
          stderr: stderr.trim()
        }));
      });

      child.send(task, (error) => {
        if (!error) return;
        terminate(new AttachmentWorkerError("worker_spawn_failed", `Unable to send attachment task: ${error.message}`, {
          taskId: task.taskId
        }));
      });

      function terminate(error: AttachmentWorkerError) {
        if (completed || forcedError) return;
        forcedError = error;
        signalWorker("SIGTERM", false);
        killTimer = setTimeout(() => {
          if (!completed) signalWorker("SIGKILL", true);
        }, terminationGraceMs);
      }

      function signalWorker(signal: NodeJS.Signals, fallbackToChild: boolean) {
        try {
          signalProcessGroup(child, signal);
        } catch (error) {
          stderr = appendBounded(stderr, `terminate(${signal}): ${errorMessage(error)}\n`);
          if (!fallbackToChild) return;
          try {
            child.kill(signal);
          } catch (fallbackError) {
            stderr = appendBounded(stderr, `terminate(${signal}, child): ${errorMessage(fallbackError)}\n`);
          }
        }
      }
    });
  }

  private async validateFinalResources(
    task: AttachmentWorkerTask,
    response: AttachmentWorkerSuccess
  ) {
    let workDirBytes: number;
    try {
      workDirBytes = await this.measureWorkDirBytes(task.workDir);
    } catch (error) {
      throw new AttachmentWorkerError(
        "worker_protocol_error",
        "Attachment worker directory could not be inspected after completion",
        { taskId: task.taskId, error: errorMessage(error) }
      );
    }
    if (workDirBytes > this.maxWorkDirBytes) {
      throw new AttachmentWorkerError(
        "worker_workdir_limit",
        `Attachment worker directory exceeded ${this.maxWorkDirBytes} bytes`,
        { taskId: task.taskId, workDirBytes }
      );
    }
    if (response.workerPeakRssBytes > this.maxRssBytes) {
      throw new AttachmentWorkerError(
        "worker_rss_limit",
        `Attachment worker process exceeded ${this.maxRssBytes} bytes peak RSS`,
        { taskId: task.taskId, workerPeakRssBytes: response.workerPeakRssBytes }
      );
    }
  }

  private spawnWorker() {
    return fork(this.workerEntryPath, [], {
      detached: process.platform === "darwin" || process.platform === "linux",
      execArgv: [`--max-old-space-size=${ATTACHMENT_WORKER_MAX_OLD_SPACE_MB}`, ...this.workerExecArgv],
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
  }
}

function normalizeWorkerResponse(message: unknown, task: AttachmentWorkerTask) {
  const record = readRecord(message);
  if (record.taskId !== task.taskId || typeof record.ok !== "boolean") {
    return new AttachmentWorkerError("worker_protocol_error", "Attachment worker returned an invalid response", {
      taskId: task.taskId
    });
  }
  if (record.ok === false) {
    const failure = record as unknown as AttachmentWorkerFailure;
    return new AttachmentWorkerError(
      "worker_task_failed",
      String(failure.error?.message ?? "Attachment worker task failed").slice(0, 2_000),
      { taskId: task.taskId, workerCode: failure.error?.code }
    );
  }

  const resultBytes = Number(record.resultBytes);
  if (!Number.isSafeInteger(resultBytes) || resultBytes < 0) {
    return new AttachmentWorkerError("worker_protocol_error", "Attachment worker returned an invalid result size", {
      taskId: task.taskId
    });
  }
  const workerPeakRssBytes = Number(record.workerPeakRssBytes);
  if (!Number.isSafeInteger(workerPeakRssBytes) || workerPeakRssBytes < 0) {
    return new AttachmentWorkerError("worker_protocol_error", "Attachment worker returned invalid peak RSS", {
      taskId: task.taskId
    });
  }
  const success: AttachmentWorkerSuccess = {
    taskId: task.taskId,
    ok: true,
    resultBytes,
    workerPeakRssBytes
  };
  if ("result" in record) success.result = record.result;
  if (typeof record.resultFile === "string") {
    const resultFile = path.resolve(record.resultFile);
    const workDir = path.resolve(task.workDir);
    if (resultFile !== workDir && !resultFile.startsWith(`${workDir}${path.sep}`)) {
      return new AttachmentWorkerError("worker_protocol_error", "Attachment worker result escaped its work directory", {
        taskId: task.taskId
      });
    }
    success.resultFile = resultFile;
  }
  return success;
}

export async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(entryPath)).size;
    }
  }
  return total;
}

export function processGroupRssBytes(processGroupId: number): Promise<number> {
  const args = process.platform === "darwin"
    ? ["-o", "rss=", "-g", String(processGroupId)]
    : process.platform === "linux"
      ? ["-o", "rss=", "--pgid", String(processGroupId)]
      : [];
  if (!args.length) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    execFile("ps", args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as { code?: number }).code === 1) {
          resolve(0);
          return;
        }
        reject(error);
        return;
      }
      const kibibytes = stdout
        .split(/\s+/)
        .map(Number)
        .filter(Number.isFinite)
        .reduce((sum, value) => sum + value, 0);
      resolve(kibibytes * 1024);
    });
  });
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code !== "EPERM") throw error;
    try {
      child.kill(signal);
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") throw fallbackError;
    }
  }
}

function validateTask(task: AttachmentWorkerTask) {
  if (!task || typeof task !== "object") throw new TypeError("task is required");
  if (!String(task.taskId ?? "").trim()) throw new TypeError("taskId is required");
  if (!path.isAbsolute(task.workDir)) throw new TypeError("workDir must be an absolute path");
  if (!task.command || (task.command.kind !== "echo" && task.command.kind !== "module")) {
    throw new TypeError("command must be echo or module");
  }
  if (task.command.kind === "module" && !path.isAbsolute(task.command.modulePath)) {
    throw new TypeError("modulePath must be an absolute path");
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive integer`);
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function appendBounded(current: string, addition: string) {
  return `${current}${addition}`.slice(-32_768);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
