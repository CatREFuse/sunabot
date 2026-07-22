// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerBashSupervisor } from "../../adapters/docker/dockerBashSupervisor.js";
import {
  DockerEngineClientError,
  type DockerEngineClientPort,
  type DockerEngineRequest,
  type DockerEngineResponse
} from "../../adapters/docker/dockerEngineClient.js";

const baseInput = {
  workbenchRoot: "/srv/sunabot/agents/plana/docker-workbench",
  image: "sunabot-bash:test",
  readOnlyMounts: {
    skills: "/srv/sunabot/agents/plana/extensions/skills",
    mcp: "/srv/sunabot/agents/plana/extensions/mcp"
  },
  effectiveUid: 1_000,
  effectiveGid: 1_000
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Docker Bash reliability contracts", () => {
  it("limits execution concurrency to two and returns busy after the third waits one second", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const engine = new ControllableDockerEngine({ holdWaits: true });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "1".repeat(32)
    });

    const first = runtime.execute(executionInput("printf first"));
    const second = runtime.execute(executionInput("printf second"));
    await flushUntil(() => engine.waitCallCount === 2);

    expect(engine.maxRunningCount).toBe(2);
    expect(engine.commandCreateNames()).toHaveLength(2);

    let thirdSettled = false;
    const third = runtime.execute(executionInput("printf third")).then((result) => {
      thirdSettled = true;
      return result;
    });
    await flushMicrotasks();

    expect(thirdSettled).toBe(false);
    expect(engine.commandCreateNames()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(thirdSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(third).resolves.toMatchObject({
      ok: false,
      errorCode: "BASH_BUSY"
    });
    expect(engine.commandCreateNames()).toHaveLength(2);

    engine.releaseHeldWaits();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, cleanupSucceeded: true }),
      expect.objectContaining({ ok: true, cleanupSucceeded: true })
    ]);
    expect(engine.maxRunningCount).toBe(2);
  });

  it("does not replay start after Docker starts the container and loses the response", async () => {
    const engine = new ControllableDockerEngine({ loseStartedResponseOnce: true });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "2".repeat(32)
    });

    const result = await runtime.execute(executionInput("printf recovered"));

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      cleanupAttempted: true,
      cleanupSucceeded: true
    });
    expect(engine.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
    expect(engine.calls.filter((call) => call.path.includes("/wait?"))).toHaveLength(1);
    expect(engine.deleteCallCount).toBe(1);
    expect(engine.containerCount).toBe(0);
  });

  it("maps exit 124 to execution timeout and cleans up the container", async () => {
    const engine = new ControllableDockerEngine({ executionExitCode: 124 });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "3".repeat(32)
    });

    const result = await runtime.execute(executionInput("sleep 60"));

    expect(result).toMatchObject({
      ok: false,
      exitCode: 124,
      timedOut: true,
      errorCode: "BASH_EXECUTION_TIMEOUT",
      cleanupAttempted: true,
      cleanupSucceeded: true
    });
    expect(result.stderr).toContain("BASH_EXECUTION_TIMEOUT");
    expect(engine.deleteCallCount).toBe(1);
    expect(engine.containerCount).toBe(0);
  });

  it("uses one capability probe and two command containers on the same runtime", async () => {
    const engine = new ControllableDockerEngine();
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "4".repeat(32)
    });

    await expect(runtime.capability(baseInput)).resolves.toEqual({ available: true });
    await expect(runtime.execute(executionInput("printf one"))).resolves.toMatchObject({ ok: true });
    await expect(runtime.execute(executionInput("printf two"))).resolves.toMatchObject({ ok: true });

    const createdNames = engine.createNames();
    expect(createdNames.filter((name) => name.startsWith("sunabot-bash-probe-"))).toHaveLength(1);
    expect(createdNames.filter((name) => (
      name.startsWith("sunabot-bash-") && !name.startsWith("sunabot-bash-probe-")
    ))).toHaveLength(2);
    expect(createdNames).toHaveLength(3);
  });

  it("keeps a hung Docker wait inside the total execution budget", async () => {
    vi.useFakeTimers();
    const engine = new ControllableDockerEngine({ waitTimesOut: true });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      totalExecutionBudgetMs: 45_000,
      delay: async () => undefined,
      runtimeId: "5".repeat(32)
    });
    const startedAt = Date.now();
    const result = runtime.execute({
      ...executionInput("sleep 60"),
      timeoutMs: 30_000
    });
    await flushUntil(() => engine.waitCallCount === 1);

    await vi.advanceTimersToNextTimerAsync();
    await expect(result).resolves.toMatchObject({
      ok: false,
      timedOut: true,
      errorCode: "BASH_EXECUTION_TIMEOUT",
      cleanupSucceeded: true
    });
    expect(Date.now() - startedAt).toBeLessThanOrEqual(45_000);
  });
});

interface ControllableDockerEngineOptions {
  holdWaits?: boolean;
  loseStartedResponseOnce?: boolean;
  executionExitCode?: number;
  waitTimesOut?: boolean;
}

interface FixtureContainer {
  labels: Record<string, string>;
  status: "created" | "exited" | "running";
  exitCode: number;
}

class ControllableDockerEngine implements DockerEngineClientPort {
  readonly endpointId = "docker-bash-reliability-fixture";
  readonly calls: DockerEngineRequest[] = [];
  maxRunningCount = 0;
  private readonly containers = new Map<string, FixtureContainer>();
  private readonly heldWaits: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  private runningCount = 0;
  private lostStartedResponse = false;

  constructor(private readonly options: ControllableDockerEngineOptions = {}) {}

  get waitCallCount() {
    return this.calls.filter((call) => call.path.includes("/wait?")).length;
  }

  get deleteCallCount() {
    return this.calls.filter((call) => call.method === "DELETE").length;
  }

  get containerCount() {
    return this.containers.size;
  }

  async request(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    this.calls.push(input);
    if (input.path === "/_ping") return response(200, "OK");
    if (input.path.startsWith("/images/")) return response(200, { Id: "sha256:image" });
    if (input.path.startsWith("/containers/json")) return response(200, []);

    if (input.path.startsWith("/containers/create")) {
      const name = new URL(`http://fixture${input.path}`).searchParams.get("name") ?? "";
      if (this.containers.has(name)) return response(409, { message: "conflict" });
      const body = input.body as Record<string, unknown>;
      this.containers.set(name, {
        labels: body.Labels as Record<string, string>,
        status: "created",
        exitCode: this.options.executionExitCode ?? 0
      });
      return response(201, { Id: `id-${name}` });
    }

    const name = containerName(input.path);
    const container = this.containers.get(name);
    if (input.path.endsWith("/json")) {
      return container
        ? response(200, {
            Config: { Labels: container.labels },
            State: { Status: container.status, ExitCode: container.exitCode }
          })
        : response(404, { message: "absent" });
    }
    if (input.path.endsWith("/start")) {
      if (!container) return response(404, { message: "absent" });
      this.markRunning(container);
      if (this.options.loseStartedResponseOnce && !this.lostStartedResponse) {
        this.lostStartedResponse = true;
        throw new DockerEngineClientError("timeout");
      }
      return response(204);
    }
    if (input.path.includes("/wait?")) {
      if (!container) return response(404, { message: "absent" });
      if (this.options.waitTimesOut) {
        await new Promise((_, reject) => {
          setTimeout(() => reject(new DockerEngineClientError("timeout")), input.timeoutMs);
        });
      }
      if (this.options.holdWaits) {
        const held = deferred();
        this.heldWaits.push(held);
        await held.promise;
      }
      this.markExited(container);
      return response(200, { StatusCode: container.exitCode });
    }
    if (input.path.includes("/logs?")) return response(200, dockerFrame(1, "ok"));
    if (input.path.includes("/kill?")) {
      if (container) {
        container.exitCode = 137;
        this.markExited(container);
      }
      return response(container ? 204 : 404);
    }
    if (input.method === "DELETE") {
      if (container?.status === "running") this.runningCount = Math.max(0, this.runningCount - 1);
      const removed = this.containers.delete(name);
      return response(removed ? 204 : 404);
    }
    return response(500, { message: "unexpected request" });
  }

  releaseHeldWaits() {
    for (const held of this.heldWaits.splice(0)) held.resolve();
  }

  createNames() {
    return this.calls
      .filter((call) => call.path.startsWith("/containers/create"))
      .map((call) => new URL(`http://fixture${call.path}`).searchParams.get("name") ?? "");
  }

  commandCreateNames() {
    return this.createNames().filter((name) => !name.startsWith("sunabot-bash-probe-"));
  }

  private markRunning(container: FixtureContainer) {
    if (container.status !== "running") {
      this.runningCount += 1;
      this.maxRunningCount = Math.max(this.maxRunningCount, this.runningCount);
    }
    container.status = "running";
  }

  private markExited(container: FixtureContainer) {
    if (container.status === "running") this.runningCount = Math.max(0, this.runningCount - 1);
    container.status = "exited";
  }
}

function executionInput(command: string) {
  return {
    ...baseInput,
    execution: { kind: "shell" as const, command },
    timeoutMs: 30_000,
    isCurrent: () => true
  };
}

function response(statusCode: number, value?: unknown): DockerEngineResponse {
  const body = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value)
      : value === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(value));
  return { statusCode, headers: {}, body };
}

function dockerFrame(stream: 1 | 2, value: string) {
  const payload = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

function containerName(requestPath: string) {
  const match = requestPath.match(/^\/containers\/([^/?]+)/);
  return match ? decodeURIComponent(match[1] ?? "") : "";
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(iterations = 12) {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

async function flushUntil(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for the controlled Docker Engine state.");
}
