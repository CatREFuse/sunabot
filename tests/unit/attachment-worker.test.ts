// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentWorkerError,
  AttachmentWorkerSupervisor,
  type AttachmentWorkerTask
} from "../../services/media/attachments/worker.js";

let temporaryDirectory = "";
let fixtureWorkerPath = "";

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-worker-test-"));
  fixtureWorkerPath = path.join(temporaryDirectory, "fixture-worker.mjs");
  await fs.writeFile(fixtureWorkerPath, fixtureWorkerSource(), "utf8");
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("AttachmentWorkerSupervisor", () => {
  it("accepts one JSON task on worker-entry stdin", async () => {
    const entryPath = fileURLToPath(new URL("../../services/media/attachments/worker-entry.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", entryPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify({
      taskId: "stdin",
      workDir: workDir("stdin"),
      command: { kind: "echo", value: { received: true } }
    }));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      taskId: "stdin",
      ok: true,
      result: { received: true }
    });
  });

  it("runs worker-entry modules and spills large results to the work directory", async () => {
    const modulePath = path.join(temporaryDirectory, "handler.mjs");
    await fs.writeFile(
      modulePath,
      "export default ({ size, fail }) => { if (fail) throw new Error('fixture failed'); return { text: 'x'.repeat(size) }; };\n",
      "utf8"
    );
    const supervisor = new AttachmentWorkerSupervisor({
      workerEntryPath: fileURLToPath(new URL("../../services/media/attachments/worker-entry.ts", import.meta.url)),
      workerExecArgv: ["--import", "tsx"]
    });

    const small = await supervisor.run({
      taskId: "small",
      workDir: workDir("small"),
      command: { kind: "module", modulePath, payload: { size: 20 } }
    });
    const large = await supervisor.run({
      taskId: "large",
      workDir: workDir("large"),
      command: { kind: "module", modulePath, payload: { size: 300_000 } }
    });

    expect(small.result).toEqual({ text: "x".repeat(20) });
    expect(small.workerPeakRssBytes).toBeGreaterThan(0);
    expect(large.result).toBeUndefined();
    expect(large.resultFile).toMatch(new RegExp(`^${escapeRegExp(workDir("large"))}/result-[a-f0-9]{20}\\.json$`));
    expect(JSON.parse(await fs.readFile(large.resultFile!, "utf8")).text).toHaveLength(300_000);

    await expect(supervisor.run({
      taskId: "failed",
      workDir: workDir("failed"),
      command: { kind: "module", modulePath, payload: { size: 0, fail: true } }
    })).rejects.toMatchObject({ code: "worker_task_failed", message: "fixture failed" });
  });

  it("terminates a worker process group after timeout", async () => {
    const supervisor = fixtureSupervisor({ timeoutMs: 50, terminationGraceMs: 20 });

    await expect(supervisor.run(task("timeout", { mode: "hang" }))).rejects.toMatchObject({
      code: "worker_timeout"
    });
  });

  it("rejects IPC responses over one MiB without retaining them", async () => {
    const supervisor = fixtureSupervisor();

    await expect(supervisor.run(task("oversize", { mode: "oversize" }))).rejects.toMatchObject({
      code: "worker_ipc_limit"
    });
  });

  it("reports a worker crash with exit metadata", async () => {
    const supervisor = fixtureSupervisor();

    await expect(supervisor.run(task("crash", { mode: "crash" }))).rejects.toMatchObject({
      code: "worker_crashed",
      details: { exitCode: 23 }
    });
  });

  it("never runs more than two workers concurrently", async () => {
    const logPath = path.join(temporaryDirectory, "concurrency.log");
    const supervisor = fixtureSupervisor({ maxConcurrency: 2 });
    await Promise.all([1, 2, 3, 4].map((number) => supervisor.run(task(`job-${number}`, {
      mode: "delay",
      delayMs: 80,
      logPath
    }))));

    const events = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    let active = 0;
    let maximum = 0;
    for (const event of events) {
      active += event.type === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("enforces work-directory and RSS limits with small controlled fixtures", async () => {
    const workDirSupervisor = fixtureSupervisor({
      monitorIntervalMs: 10,
      maxWorkDirBytes: 32,
      measureProcessGroupRssBytes: async () => 0
    });
    await expect(workDirSupervisor.run(task("workdir", { mode: "write-and-hang", bytes: 64 })))
      .rejects.toMatchObject({ code: "worker_workdir_limit" });

    const rssSupervisor = fixtureSupervisor({
      monitorIntervalMs: 10,
      maxRssBytes: 100,
      measureProcessGroupRssBytes: async () => 101
    });
    await expect(rssSupervisor.run(task("rss", { mode: "hang" })))
      .rejects.toMatchObject({ code: "worker_rss_limit" });
  });

  it("keeps the work-directory limit active when the RSS probe fails", async () => {
    const supervisor = fixtureSupervisor({
      monitorIntervalMs: 10,
      maxWorkDirBytes: 32,
      measureWorkDirBytes: async () => 64,
      measureProcessGroupRssBytes: async () => {
        throw new Error("RSS probe unavailable");
      }
    });

    await expect(supervisor.run(task("rss-probe-failed", { mode: "hang" }))).rejects.toMatchObject({
      code: "worker_workdir_limit",
      details: { workDirBytes: 64 }
    });
  });

  it("keeps the RSS limit active when the work-directory probe fails", async () => {
    const supervisor = fixtureSupervisor({
      monitorIntervalMs: 10,
      maxRssBytes: 100,
      measureWorkDirBytes: async () => {
        throw new Error("work-directory probe unavailable");
      },
      measureProcessGroupRssBytes: async () => 101
    });

    await expect(supervisor.run(task("workdir-probe-failed", { mode: "hang" }))).rejects.toMatchObject({
      code: "worker_rss_limit",
      details: { rssBytes: 101 }
    });
  });

  it("keeps monitoring until timeout when both resource probes fail", async () => {
    const measureWorkDirBytes = vi.fn(async () => {
      throw new Error("work-directory probe unavailable");
    });
    const measureProcessGroupRssBytes = vi.fn(async () => {
      throw new Error("RSS probe unavailable");
    });
    const supervisor = fixtureSupervisor({
      timeoutMs: 80,
      monitorIntervalMs: 10,
      measureWorkDirBytes,
      measureProcessGroupRssBytes
    });

    await expect(supervisor.run(task("both-probes-failed", { mode: "hang" }))).rejects.toMatchObject({
      code: "worker_timeout"
    });
    expect(measureWorkDirBytes.mock.calls.length).toBeGreaterThan(0);
    expect(measureProcessGroupRssBytes.mock.calls.length).toBeGreaterThan(0);
  });

  it("waits for a delayed work-directory limit after the RSS probe rejects first", async () => {
    const workDirProbe = deferred<number>();
    const rssProbe = deferred<number>();
    const measureWorkDirBytes = vi.fn(() => workDirProbe.promise);
    const measureProcessGroupRssBytes = vi.fn(() => rssProbe.promise);
    const supervisor = fixtureSupervisor({
      monitorIntervalMs: 10,
      maxWorkDirBytes: 32,
      measureWorkDirBytes,
      measureProcessGroupRssBytes
    });
    let settled = false;
    const result = supervisor.run(task("delayed-probe-order", { mode: "hang" }));
    void result.then(
      () => { settled = true; },
      () => { settled = true; }
    );
    await vi.waitFor(() => {
      expect(measureWorkDirBytes).toHaveBeenCalledTimes(1);
      expect(measureProcessGroupRssBytes).toHaveBeenCalledTimes(1);
    });

    rssProbe.reject(new Error("RSS probe unavailable"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    workDirProbe.resolve(64);

    await expect(result).rejects.toMatchObject({
      code: "worker_workdir_limit",
      details: { workDirBytes: 64 }
    });
  });

  it("preserves the resource limit without an unhandled rejection when group termination throws", async () => {
    const signalError = Object.assign(new Error("process-group signal failed"), { code: "EIO" });
    const processKill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw signalError;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const supervisor = fixtureSupervisor({
      monitorIntervalMs: 10,
      maxWorkDirBytes: 32,
      measureWorkDirBytes: async () => 64,
      measureProcessGroupRssBytes: async () => 0
    });

    try {
      await expect(supervisor.run(task("termination-signal-failed", { mode: "hang" }))).rejects.toMatchObject({
        code: "worker_workdir_limit",
        details: { workDirBytes: 64 }
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(processKill).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      processKill.mockRestore();
    }
  });

  it("checks final work-directory bytes before accepting a fast result", async () => {
    const supervisor = fixtureSupervisor({
      monitorIntervalMs: 1_000,
      maxWorkDirBytes: 32,
      measureProcessGroupRssBytes: async () => 0
    });

    await expect(supervisor.run(task("fast-workdir", {
      mode: "write-and-exit",
      bytes: 64
    }))).rejects.toMatchObject({
      code: "worker_workdir_limit",
      details: { workDirBytes: 64 }
    });
  });

  it("rejects a fast worker whose self-reported peak RSS exceeded the limit", async () => {
    const supervisor = fixtureSupervisor({
      monitorIntervalMs: 1_000,
      maxRssBytes: 100,
      measureProcessGroupRssBytes: async () => 0
    });

    await expect(supervisor.run(task("fast-rss", {
      mode: "reported-peak",
      peakRssBytes: 101
    }))).rejects.toMatchObject({
      code: "worker_rss_limit",
      details: { workerPeakRssBytes: 101 }
    });
  });

  it("caps concurrency configuration at two", () => {
    expect(() => new AttachmentWorkerSupervisor({ maxConcurrency: 3 })).toThrow(RangeError);
    expect(new AttachmentWorkerError("worker_timeout", "timeout").code).toBe("worker_timeout");
  });
});

function fixtureSupervisor(overrides: ConstructorParameters<typeof AttachmentWorkerSupervisor>[0] = {}) {
  return new AttachmentWorkerSupervisor({
    workerEntryPath: fixtureWorkerPath,
    timeoutMs: 2_000,
    monitorIntervalMs: 1_000,
    terminationGraceMs: 20,
    ...overrides
  });
}

function task(taskId: string, value: Record<string, unknown>): AttachmentWorkerTask {
  return {
    taskId,
    workDir: workDir(taskId),
    command: { kind: "echo", value }
  };
}

function workDir(taskId: string) {
  return path.join(temporaryDirectory, `work-${taskId}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixtureWorkerSource() {
  return `
import fs from "node:fs";
import path from "node:path";

process.once("message", (task) => {
  const value = task.command.value ?? {};
  const peakRssBytes = () => Math.max(0, Math.floor(process.resourceUsage().maxRSS * 1024));
  if (value.mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (value.mode === "crash") process.exit(23);
  if (value.mode === "oversize") {
    process.send({ taskId: task.taskId, ok: true, result: "x".repeat(1024 * 1024 + 100), resultBytes: 1024 * 1024 + 100, workerPeakRssBytes: peakRssBytes() });
    return;
  }
  if (value.mode === "write-and-hang") {
    fs.mkdirSync(task.workDir, { recursive: true });
    fs.writeFileSync(path.join(task.workDir, "output.bin"), Buffer.alloc(value.bytes));
    setInterval(() => {}, 1000);
    return;
  }
  if (value.mode === "write-and-exit") {
    fs.mkdirSync(task.workDir, { recursive: true });
    fs.writeFileSync(path.join(task.workDir, "output.bin"), Buffer.alloc(value.bytes));
    process.send({ taskId: task.taskId, ok: true, result: "done", resultBytes: 6, workerPeakRssBytes: peakRssBytes() }, () => process.exit(0));
    return;
  }
  if (value.mode === "reported-peak") {
    process.send({ taskId: task.taskId, ok: true, result: "done", resultBytes: 6, workerPeakRssBytes: value.peakRssBytes }, () => process.exit(0));
    return;
  }
  if (value.mode === "delay") {
    fs.appendFileSync(value.logPath, JSON.stringify({ type: "start", taskId: task.taskId }) + "\\n");
    setTimeout(() => {
      fs.appendFileSync(value.logPath, JSON.stringify({ type: "end", taskId: task.taskId }) + "\\n");
      process.send({ taskId: task.taskId, ok: true, result: task.taskId, resultBytes: task.taskId.length, workerPeakRssBytes: peakRssBytes() }, () => process.exit(0));
    }, value.delayMs);
    return;
  }
  process.send({ taskId: task.taskId, ok: true, result: value, resultBytes: Buffer.byteLength(JSON.stringify(value)), workerPeakRssBytes: peakRssBytes() }, () => process.exit(0));
});
`;
}
