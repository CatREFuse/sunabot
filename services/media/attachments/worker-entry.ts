import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INLINE_RESULT_LIMIT_BYTES = 256 * 1024;

interface WorkerTask {
  taskId: string;
  workDir: string;
  command:
    | { kind: "echo"; value?: unknown }
    | { kind: "module"; modulePath: string; exportName?: string; payload?: unknown };
}

interface WorkerContext {
  taskId: string;
  workDir: string;
}

type WorkerHandler = (payload: unknown, context: WorkerContext) => unknown | Promise<unknown>;

if (typeof process.send === "function") {
  process.once("message", (message) => {
    const taskId = taskIdFrom(message);
    void runTask(message).then(sendIpcResponse, (error) => sendIpcFailure(error, taskId));
  });
} else {
  void runStdinTask();
}

async function runTask(value: unknown) {
  const task = parseTask(value);
  await fs.mkdir(task.workDir, { recursive: true });
  const result = await executeCommand(task);
  const serialized = serializeResult(result);
  if (Buffer.byteLength(serialized) <= INLINE_RESULT_LIMIT_BYTES) {
    return {
      taskId: task.taskId,
      ok: true as const,
      result,
      resultBytes: Buffer.byteLength(serialized),
      workerPeakRssBytes: peakRssBytes()
    };
  }

  const resultId = createHash("sha256").update(task.taskId).digest("hex").slice(0, 20);
  const resultFile = path.join(task.workDir, `result-${resultId}.json`);
  const temporaryFile = path.join(task.workDir, `.result-${resultId}.${process.pid}.part`);
  await fs.writeFile(temporaryFile, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporaryFile, resultFile);
  return {
    taskId: task.taskId,
    ok: true as const,
    resultFile,
    resultBytes: Buffer.byteLength(serialized),
    workerPeakRssBytes: peakRssBytes()
  };
}

async function executeCommand(task: WorkerTask) {
  if (task.command.kind === "echo") return task.command.value;
  const moduleUrl = pathToFileURL(task.command.modulePath).href;
  const imported = await import(moduleUrl) as Record<string, unknown>;
  const exportName = task.command.exportName?.trim() || "default";
  const handler = imported[exportName];
  if (typeof handler !== "function") throw new Error(`Worker module export ${exportName} is not a function`);
  return (handler as WorkerHandler)(task.command.payload, {
    taskId: task.taskId,
    workDir: task.workDir
  });
}

function parseTask(value: unknown): WorkerTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Worker task must be an object");
  const task = value as Partial<WorkerTask>;
  if (!String(task.taskId ?? "").trim()) throw new TypeError("Worker taskId is required");
  if (!task.workDir || !path.isAbsolute(task.workDir)) throw new TypeError("Worker workDir must be absolute");
  if (!task.command || (task.command.kind !== "echo" && task.command.kind !== "module")) {
    throw new TypeError("Worker command must be echo or module");
  }
  if (task.command.kind === "module" && !path.isAbsolute(task.command.modulePath)) {
    throw new TypeError("Worker modulePath must be absolute");
  }
  return task as WorkerTask;
}

function serializeResult(result: unknown) {
  const serialized = JSON.stringify(result ?? null);
  if (serialized === undefined) throw new TypeError("Worker result is not JSON serializable");
  return serialized;
}

function sendIpcResponse(response: Awaited<ReturnType<typeof runTask>>) {
  process.send?.(response, (error) => {
    if (error) process.exitCode = 1;
    process.disconnect();
  });
}

function sendIpcFailure(error: unknown, taskId: string) {
  const response = failureResponse(error, taskId);
  process.send?.(response, () => {
    process.exitCode = 1;
    process.disconnect();
  });
}

function sendStdoutResponse(response: Awaited<ReturnType<typeof runTask>>) {
  process.stdout.write(`${JSON.stringify(response)}\n`, () => {
    process.exitCode = 0;
  });
}

function sendStdoutFailure(error: unknown, taskId: string) {
  process.stdout.write(`${JSON.stringify(failureResponse(error, taskId))}\n`, () => {
    process.exitCode = 1;
  });
}

function failureResponse(error: unknown, taskId: string) {
  return {
    taskId,
    ok: false as const,
    error: {
      code: "worker_command_failed",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
    }
  };
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function runStdinTask() {
  let taskId = "";
  try {
    const message = JSON.parse(await readStdin()) as unknown;
    taskId = taskIdFrom(message);
    sendStdoutResponse(await runTask(message));
  } catch (error) {
    sendStdoutFailure(error, taskId);
  }
}

function taskIdFrom(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String((value as { taskId?: unknown }).taskId ?? "").trim();
}

function peakRssBytes() {
  return Math.max(0, Math.floor(process.resourceUsage().maxRSS * 1024));
}
