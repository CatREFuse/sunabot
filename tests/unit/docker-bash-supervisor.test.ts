// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createDockerBashSupervisor
} from "../../adapters/docker/dockerBashSupervisor.js";
import {
  BASH_OUTPUT_LIMIT_EXIT_CODE,
  BASH_OUTPUT_LIMIT_MARKER,
  DockerCircuit,
  DockerWorkspaceReaper,
  LABEL_COMPONENT,
  LABEL_EXPIRES,
  LABEL_INVOCATION,
  LABEL_OWNER,
  LABEL_RUNTIME,
  LABEL_WORKSPACE
} from "../../adapters/docker/dockerBashSupport.js";
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
  effectiveGid: 1_000,
  dockerEnvironment: {
    SUNABOT_RUNTIME_ID: "sunabot-qq-runtime",
    SUNABOT_WORKSPACE_ID: "a".repeat(16)
  }
};

describe("Docker Bash supervisor", () => {
  it("shares one startup capability probe and keeps the successful lease", async () => {
    let currentTime = 1_000;
    const ping = deferred<void>();
    const engine = new StatefulDockerEngine(async (input) => {
      if (input.path === "/_ping") {
        await ping.promise;
        return response(200, "OK");
      }
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      now: () => currentTime,
      delay: async () => undefined,
      runtimeId: "a".repeat(32)
    });

    const probes = Array.from({ length: 20 }, () => runtime.capability(baseInput));
    await vi.waitFor(() => expect(engine.calls.filter((call) => call.path === "/_ping")).toHaveLength(1));
    ping.resolve();
    await expect(Promise.all(probes)).resolves.toEqual(
      Array.from({ length: 20 }, () => ({ available: true }))
    );
    expect(engine.createNames().filter((name) => name.startsWith("sunabot-bash-probe-"))).toHaveLength(1);

    const callCount = engine.calls.length;
    currentTime += 60 * 60_000;
    await expect(runtime.capability(baseInput)).resolves.toEqual({ available: true });
    expect(engine.calls).toHaveLength(callCount);
  });

  it("runs one labeled container with the in-container watchdog and no command probe", async () => {
    const engine = new StatefulDockerEngine();
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "b".repeat(32)
    });

    const result = await runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "printf ok" },
      timeoutMs: 30_000,
      isCurrent: () => true
    });

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "ok",
      cleanupAttempted: true,
      cleanupSucceeded: true
    });
    const create = engine.calls.find((call) => call.path.startsWith("/containers/create"));
    const body = create?.body as Record<string, unknown>;
    const command = body.Cmd as string[];
    const hostConfig = body.HostConfig as Record<string, unknown>;
    expect(command).toEqual(expect.arrayContaining([
      "/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "30s",
      "/bin/bash", "--noprofile", "--norc", "-lc", "printf ok"
    ]));
    expect(command.join("\n")).toContain("SUNABOT_BASH_OUTPUT_LIMIT");
    expect(command.join("\n")).toContain("/usr/bin/head -c");
    expect(hostConfig).toMatchObject({
      AutoRemove: false,
      LogConfig: {
        Type: "local",
        Config: { "max-size": "512k", "max-file": "1", compress: "false" }
      },
      NetworkMode: "bridge",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      PidsLimit: 64,
      Memory: 268_435_456
    });
    expect(engine.createNames()).toHaveLength(1);
    expect(engine.createNames()[0]).toMatch(/^sunabot-bash-[a-f0-9]{32}$/);
    expect(engine.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
    expect(body.Labels).toMatchObject({
      "io.sunabot.component": "workspace-bash",
      "io.sunabot.owner-id": "b".repeat(32),
      "io.sunabot.runtime-id": "sunabot-qq-runtime",
      "io.sunabot.workspace-id": "a".repeat(16)
    });
  });

  it("retries create once after reconciliation proves that no container exists", async () => {
    let createAttempts = 0;
    const delays: number[] = [];
    const engine = new StatefulDockerEngine(async (input) => {
      if (input.path.startsWith("/containers/create") && createAttempts++ === 0) {
        throw new DockerEngineClientError("timeout");
      }
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async (milliseconds) => { delays.push(milliseconds); },
      runtimeId: "c".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "printf ok" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ ok: true, stdout: "ok" });

    expect(createAttempts).toBe(2);
    expect(delays).toContain(300);
    expect(engine.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(1);
  });

  it("does not replay start when its response is lost and the container remains created", async () => {
    let startAttempts = 0;
    let currentTime = 5_000;
    const engine = new StatefulDockerEngine(async (input) => {
      if (input.path.endsWith("/start")) {
        startAttempts += 1;
        throw new DockerEngineClientError("timeout");
      }
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      now: () => currentTime,
      delay: async () => undefined,
      runtimeId: "d".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "touch must-not-repeat" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({
      ok: false,
      errorCode: "BASH_DOCKER_START_TIMEOUT",
      retryAfterMs: 3_000
    });
    expect(startAttempts).toBe(1);

    currentTime += 1_000;
    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "true" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({
      ok: false,
      errorCode: "BASH_DOCKER_CIRCUIT_OPEN",
      retryAfterMs: 2_000
    });
  });

  it("does not retry create when reconciliation itself is unavailable", async () => {
    let createAttempts = 0;
    const engine = new StatefulDockerEngine(async (input) => {
      if (input.path.startsWith("/containers/create")) {
        createAttempts += 1;
        throw new DockerEngineClientError("timeout");
      }
      if (input.path.endsWith("/json")) throw new DockerEngineClientError("timeout");
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "e".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "touch must-not-repeat" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({
      ok: false,
      errorCode: "BASH_EXECUTION_UNKNOWN"
    });
    expect(createAttempts).toBe(1);
    expect(engine.calls.filter((call) => call.path.endsWith("/start"))).toHaveLength(0);
  });

  it("fails closed and opens the circuit when command container cleanup is not confirmed", async () => {
    const engine = new StatefulDockerEngine(async (input) => (
      input.method === "DELETE" ? response(500, { message: "stuck" }) : undefined
    ));
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "f".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "printf ok" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({
      ok: false,
      errorCode: "BASH_DOCKER_CLEANUP_FAILED",
      cleanupAttempted: true,
      cleanupSucceeded: false,
      retryAfterMs: 3_000
    });
    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "true" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ errorCode: "BASH_DOCKER_CIRCUIT_OPEN" });
  });

  it("opens the circuit when cleanup also fails after a non-infrastructure command error", async () => {
    const engine = new StatefulDockerEngine(async (input) => {
      if (input.path.includes("/logs?")) throw new DockerEngineClientError("response_too_large");
      if (input.method === "DELETE") return response(500, { message: "stuck" });
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "0".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "yes" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({
      errorCode: "BASH_OUTPUT_LIMIT",
      cleanupAttempted: true,
      cleanupSucceeded: false,
      retryAfterMs: 3_000
    });
    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "true" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ errorCode: "BASH_DOCKER_CIRCUIT_OPEN" });
  });

  it("does not cache capability success when the probe container cleanup fails", async () => {
    const engine = new StatefulDockerEngine(async (input) => (
      input.method === "DELETE" ? response(500, { message: "stuck" }) : undefined
    ));
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "1".repeat(32)
    });

    await expect(runtime.capability(baseInput)).resolves.toEqual({
      available: false,
      retryAfterMs: 3_000
    });
  });

  it("schedules reconciliation when capability create state cannot be proved", async () => {
    vi.useFakeTimers();
    try {
      let inspectCalls = 0;
      const engine = new StatefulDockerEngine(async (input) => {
        if (input.path.startsWith("/containers/create")) {
          throw new DockerEngineClientError("timeout");
        }
        if (input.path.startsWith("/containers/") && input.path.endsWith("/json")) {
          inspectCalls += 1;
          if (inspectCalls <= 2) throw new DockerEngineClientError("timeout");
        }
        return undefined;
      });
      const runtime = createDockerBashSupervisor({
        clientFactory: async () => engine,
        delay: async () => undefined,
        runtimeId: "4".repeat(32)
      });

      await expect(runtime.capability(baseInput)).resolves.toMatchObject({ available: false });
      expect(inspectCalls).toBe(2);
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("reports oversized output without opening the Docker circuit", async () => {
    let oversized = true;
    const engine = new StatefulDockerEngine(async (input) => {
      if (oversized && input.path.includes("/logs?")) {
        oversized = false;
        throw new DockerEngineClientError("response_too_large");
      }
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "2".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "yes" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ errorCode: "BASH_OUTPUT_LIMIT" });
    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "printf ok" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ ok: true, stdout: "ok" });
  });

  it("retries a safe logs read once after a transient Engine 500", async () => {
    let logAttempts = 0;
    const engine = new StatefulDockerEngine(async (input) => {
      if (input.path.includes("/logs?")) {
        logAttempts += 1;
        if (logAttempts === 1) return response(500, { message: "temporary" });
      }
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "5".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "printf ok" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ ok: true, stdout: "ok" });
    expect(logAttempts).toBe(2);
  });

  it("maps the in-container output guard marker without opening the circuit", async () => {
    let limited = true;
    const engine = new StatefulDockerEngine(async (input) => {
      if (limited && input.path.includes("/wait?")) {
        return response(200, { StatusCode: BASH_OUTPUT_LIMIT_EXIT_CODE });
      }
      if (limited && input.path.includes("/logs?")) {
        limited = false;
        return response(200, dockerFrame(2, `${BASH_OUTPUT_LIMIT_MARKER}\n`));
      }
      return undefined;
    });
    const runtime = createDockerBashSupervisor({
      clientFactory: async () => engine,
      delay: async () => undefined,
      runtimeId: "3".repeat(32)
    });

    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "yes" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ errorCode: "BASH_OUTPUT_LIMIT", cleanupSucceeded: true });
    await expect(runtime.execute({
      ...baseInput,
      execution: { kind: "shell", command: "printf ok" },
      timeoutMs: 30_000
    })).resolves.toMatchObject({ ok: true, stdout: "ok" });
  });

  it("rate-limits failed stale-container sweeps and allows a later retry", async () => {
    let currentTime = 0;
    let calls = 0;
    const engine = new StatefulDockerEngine();
    const reaper = new DockerWorkspaceReaper(
      () => currentTime,
      2_000,
      async () => {
        calls += 1;
        if (calls === 1) throw new DockerEngineClientError("timeout");
        return response(200, []);
      }
    );

    await reaper.sweep(engine, "workspace", "sunabot-qq-runtime");
    currentTime = 2_999;
    await reaper.sweep(engine, "workspace", "sunabot-qq-runtime");
    expect(calls).toBe(1);
    currentTime = 3_000;
    await reaper.sweep(engine, "workspace", "sunabot-qq-runtime");
    expect(calls).toBe(2);
  });

  it("reaps only canonical ownership and schedules containers that expire later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const invocationId = "1".repeat(32);
      const futureInvocationId = "2".repeat(32);
      const invalidInvocationId = "3".repeat(32);
      const entries = new Map([
        ["a".repeat(64), reaperEntry("a".repeat(64), invocationId, 999)],
        ["b".repeat(64), reaperEntry("b".repeat(64), futureInvocationId, 3_000)],
        ["c".repeat(64), reaperEntry("c".repeat(64), invalidInvocationId, 999, {
          ownerId: "invalid",
          name: `sunabot-bash-${"4".repeat(32)}`
        })]
      ]);
      const deleted: string[] = [];
      const engine = new StatefulDockerEngine();
      const reaper = new DockerWorkspaceReaper(
        () => Date.now(),
        2_000,
        async (_client, input) => {
          if (input.method === "GET") return response(200, [...entries.values()]);
          const id = decodeURIComponent(input.path.match(/^\/containers\/([^?]+)/u)?.[1] ?? "");
          deleted.push(id);
          entries.delete(id);
          return response(204);
        }
      );

      await reaper.sweep(engine, "a".repeat(16), "sunabot-qq-runtime");
      expect(deleted).toEqual(["a".repeat(64)]);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(deleted).toEqual(["a".repeat(64), "b".repeat(64)]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("uses 3/10/30/60 second recovery windows and a single half-open probe", async () => {
    let currentTime = 0;
    const circuit = new DockerCircuit(() => currentTime, [3_000, 10_000, 30_000, 60_000], 300_000);
    circuit.infrastructureFailure();
    expect(circuit.retryAfterMs()).toBe(3_000);

    currentTime = 3_000;
    const recovery = deferred<void>();
    const probe = vi.fn(() => recovery.promise);
    const attempts = Array.from({ length: 20 }, () => circuit.beforeRequest(probe));
    expect(probe).toHaveBeenCalledOnce();
    recovery.resolve();
    await expect(Promise.all(attempts)).resolves.toEqual(Array.from({ length: 20 }, () => 1));

    circuit.infrastructureFailure();
    expect(circuit.retryAfterMs()).toBe(10_000);
    currentTime += 10_000;
    await expect(circuit.beforeRequest(async () => {
      throw new DockerEngineClientError("timeout");
    })).rejects.toMatchObject({ retryAfterMs: 30_000 });
    currentTime += 30_000;
    await expect(circuit.beforeRequest(async () => {
      throw new DockerEngineClientError("timeout");
    })).rejects.toMatchObject({ retryAfterMs: 60_000 });
    currentTime += 60_000;
    await expect(circuit.beforeRequest(async () => {
      throw new DockerEngineClientError("timeout");
    })).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("counts concurrent failures once and ignores success from an older circuit generation", async () => {
    let currentTime = 0;
    const circuit = new DockerCircuit(() => currentTime, [3_000, 10_000, 30_000, 60_000], 300_000);
    const firstGeneration = await circuit.beforeRequest(async () => undefined);
    const secondGeneration = await circuit.beforeRequest(async () => undefined);

    circuit.infrastructureFailure(firstGeneration);
    circuit.infrastructureFailure(secondGeneration);
    expect(circuit.retryAfterMs()).toBe(3_000);

    circuit.operationalSuccess(secondGeneration);
    await expect(circuit.beforeRequest(async () => undefined)).rejects.toMatchObject({ retryAfterMs: 3_000 });

    currentTime = 3_000;
    const recoveredGeneration = await circuit.beforeRequest(async () => undefined);
    circuit.infrastructureFailure(recoveredGeneration);
    expect(circuit.retryAfterMs()).toBe(10_000);
  });

  it("resets circuit escalation after five stable minutes", () => {
    let currentTime = 1;
    const circuit = new DockerCircuit(() => currentTime, [3_000, 10_000, 30_000, 60_000], 300_000);
    circuit.infrastructureFailure();
    currentTime += 3_000;
    circuit.operationalSuccess();
    circuit.infrastructureFailure();
    expect(circuit.retryAfterMs()).toBe(10_000);

    currentTime += 300_000;
    circuit.operationalSuccess();
    circuit.infrastructureFailure();
    expect(circuit.retryAfterMs()).toBe(3_000);
  });
});

class StatefulDockerEngine implements DockerEngineClientPort {
  readonly endpointId = "fixture-endpoint";
  readonly calls: DockerEngineRequest[] = [];
  private readonly containers = new Map<string, {
    labels: Record<string, string>;
    status: "created" | "exited" | "running";
    exitCode: number;
  }>();

  constructor(
    private readonly intercept?: (
      input: DockerEngineRequest
    ) => Promise<DockerEngineResponse | undefined>
  ) {}

  async request(input: DockerEngineRequest): Promise<DockerEngineResponse> {
    this.calls.push(input);
    const intercepted = await this.intercept?.(input);
    if (intercepted) return intercepted;
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
        exitCode: 0
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
      container.status = "running";
      return response(204);
    }
    if (input.path.includes("/wait?")) {
      if (!container) return response(404, { message: "absent" });
      container.status = "exited";
      return response(200, { StatusCode: container.exitCode });
    }
    if (input.path.includes("/logs?")) return response(200, dockerFrame(1, "ok"));
    if (input.path.includes("/kill?")) {
      if (container) {
        container.status = "exited";
        container.exitCode = 137;
      }
      return response(container ? 204 : 404);
    }
    if (input.method === "DELETE") {
      const removed = this.containers.delete(name);
      return response(removed ? 204 : 404);
    }
    return response(500, { message: "unexpected" });
  }

  createNames() {
    return this.calls
      .filter((call) => call.path.startsWith("/containers/create"))
      .map((call) => new URL(`http://fixture${call.path}`).searchParams.get("name") ?? "");
  }
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

function reaperEntry(
  id: string,
  invocationId: string,
  expiresAtMs: number,
  overrides: { ownerId?: string; name?: string } = {}
) {
  return {
    Id: id,
    Names: [`/${overrides.name ?? `sunabot-bash-${invocationId}`}`],
    Labels: {
      [LABEL_COMPONENT]: "workspace-bash",
      [LABEL_WORKSPACE]: "a".repeat(16),
      [LABEL_RUNTIME]: "sunabot-qq-runtime",
      [LABEL_OWNER]: overrides.ownerId ?? "f".repeat(32),
      [LABEL_INVOCATION]: invocationId,
      [LABEL_EXPIRES]: String(expiresAtMs)
    }
  };
}

function containerName(requestPath: string) {
  const match = requestPath.match(/^\/containers\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]!) : "";
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
