import { createHash } from "node:crypto";
import {
  WORKSPACE_BASH_ADMIN_EXECUTABLE,
  WORKSPACE_BASH_RESTRICTED_EXECUTABLES
} from "../../services/tools/bashPolicy.js";
import {
  WORKSPACE_BASH_MCP_ROOT,
  WORKSPACE_BASH_NATIVE_PROJECTION_ROOT,
  WORKSPACE_BASH_SKILLS_ROOT,
  WORKSPACE_BASH_VIRTUAL_ROOT,
  type WorkspaceBashExecution,
  type WorkspaceBashResourceMounts,
  type WorkspaceBashReadOnlyMounts
} from "../../services/tools/bashSandbox.js";
import type {
  WorkspaceBashRuntimeCapabilityInput,
  WorkspaceBashRuntimeErrorCode,
  WorkspaceBashRuntimeExecutionInput,
  WorkspaceBashRuntimeExecutionResult
} from "../../services/tools/bashRuntime.js";
import {
  DockerEngineClientError,
  type DockerEngineClientPort,
  type DockerEngineRequest,
  type DockerEngineResponse
} from "./dockerEngineClient.js";

export const LABEL_COMPONENT = "io.sunabot.component";
export const LABEL_INVOCATION = "io.sunabot.invocation-id";
export const LABEL_OWNER = "io.sunabot.owner-id";
export const LABEL_RUNTIME = "io.sunabot.runtime-id";
export const LABEL_WORKSPACE = "io.sunabot.workspace-id";
export const LABEL_EXPIRES = "io.sunabot.expires-at-ms";
export const COMPONENT_BASH = "workspace-bash";
export const BASH_CONTAINER_EXPIRY_MS = 2 * 60_000;
export const BASH_OUTPUT_LIMIT_EXIT_CODE = 125;
export const BASH_OUTPUT_LIMIT_MARKER = "SUNABOT_BASH_OUTPUT_LIMIT";
const CLEANUP_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const OUTPUT_LIMIT_BYTES = 256 * 1_024;
const OUTPUT_CAPTURE_LIMIT_BYTES = 240 * 1_024;
const TARGET_PATH = "/usr/local/bin:/usr/bin:/bin";
const TARGET_ENVIRONMENT = [
  "HOME=/workbench",
  "PWD=/workbench",
  `PATH=${TARGET_PATH}`,
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "TMPDIR=/tmp",
  "TMP=/tmp",
  "TEMP=/tmp",
  "SHELL=/bin/bash",
  "USER=sunabot",
  `SUNABOT_SKILLS=${WORKSPACE_BASH_SKILLS_ROOT}`,
  `SUNABOT_MCP_CONFIG=${WORKSPACE_BASH_MCP_ROOT}`,
  `SUNABOT_NATIVE_WORKBENCH=${WORKSPACE_BASH_NATIVE_PROJECTION_ROOT}`
] as const;
const PROXY_VARIABLES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy"
] as const;
const OUTPUT_GUARD_SCRIPT = [
  "set +e",
  "stdout_path=/tmp/.sunabot-stdout",
  "stderr_path=/tmp/.sunabot-stderr",
  ': > "$stdout_path"',
  ': > "$stderr_path"',
  `"$@" > >(/usr/bin/head -c ${OUTPUT_CAPTURE_LIMIT_BYTES + 1} > "$stdout_path") 2> >(/usr/bin/head -c ${OUTPUT_CAPTURE_LIMIT_BYTES + 1} > "$stderr_path")`,
  "status=$?",
  "wait",
  'stdout_bytes=$(/usr/bin/wc -c < "$stdout_path")',
  'stderr_bytes=$(/usr/bin/wc -c < "$stderr_path")',
  `if [ "$((stdout_bytes + stderr_bytes))" -gt ${OUTPUT_CAPTURE_LIMIT_BYTES} ]; then`,
  `  printf '%s\\n' '${BASH_OUTPUT_LIMIT_MARKER}' >&2`,
  `  exit ${BASH_OUTPUT_LIMIT_EXIT_CODE}`,
  "fi",
  '/usr/bin/cat "$stdout_path"',
  '/usr/bin/cat "$stderr_path" >&2',
  'exit "$status"'
].join("\n");

export interface OwnedContainer {
  name: string;
  invocationId: string;
  workspaceId: string;
  labels: Record<string, string>;
}

export interface InspectedContainer {
  ownership: "absent" | "foreign" | "owned";
  status?: "created" | "exited" | "running" | "unknown";
  exitCode?: number;
}

export class CircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Docker Bash circuit is open.");
  }
}

export class ExecutionStateError extends Error {
  constructor(
    readonly code: WorkspaceBashRuntimeErrorCode,
    readonly infrastructure = false
  ) {
    super(code);
  }
}

export class DockerCircuit {
  private failureLevel = 0;
  private generation = 0;
  private openedUntil = 0;
  private lastFailureAt = 0;
  private recovery?: Promise<number>;

  constructor(
    private readonly now: () => number,
    private readonly delays: readonly number[],
    private readonly stableResetMs: number
  ) {}

  async beforeRequest(probe: () => Promise<void>) {
    if (!this.openedUntil) return this.generation;
    const currentTime = this.now();
    if (currentTime < this.openedUntil) throw new CircuitOpenError(this.openedUntil - currentTime);
    const recoveryGeneration = this.generation;
    this.recovery ??= probe().then(
      () => {
        this.operationalSuccess(recoveryGeneration);
        return recoveryGeneration;
      },
      (error) => {
        this.infrastructureFailure(recoveryGeneration);
        throw error;
      }
    ).finally(() => { this.recovery = undefined; });
    try {
      return await this.recovery;
    } catch {
      throw new CircuitOpenError(this.retryAfterMs());
    }
  }

  infrastructureFailure(generation = this.generation) {
    if (generation !== this.generation) return;
    const currentTime = this.now();
    if (this.lastFailureAt && currentTime - this.lastFailureAt >= this.stableResetMs) {
      this.failureLevel = 0;
    }
    this.failureLevel = Math.min(this.failureLevel + 1, this.delays.length);
    this.generation += 1;
    this.lastFailureAt = currentTime;
    const delay = this.delays[Math.max(0, this.failureLevel - 1)] ?? this.delays.at(-1) ?? 60_000;
    this.openedUntil = currentTime + delay;
  }

  operationalSuccess(generation = this.generation) {
    if (generation !== this.generation) return;
    this.openedUntil = 0;
    if (this.lastFailureAt && this.now() - this.lastFailureAt >= this.stableResetMs) {
      this.failureLevel = 0;
      this.lastFailureAt = 0;
    }
  }

  retryAfterMs() {
    return Math.max(0, this.openedUntil - this.now());
  }
}

export class DockerExecutionBulkhead {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: () => void;
    signal?: AbortSignal;
    timer: NodeJS.Timeout;
    abortListener?: () => void;
  }> = [];

  constructor(
    private readonly maximum: number,
    private readonly queueTimeoutMs: number
  ) {}

  async acquire(signal?: AbortSignal) {
    if (this.active < this.maximum) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: typeof this.queue[number];
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        if (waiter.abortListener && signal) signal.removeEventListener("abort", waiter.abortListener);
      };
      const fail = () => {
        remove();
        reject(new ExecutionStateError("BASH_BUSY"));
      };
      const timer = setTimeout(fail, this.queueTimeoutMs);
      timer.unref();
      waiter = { resolve: (release) => { remove(); resolve(release); }, reject: fail, signal, timer };
      if (signal) {
        waiter.abortListener = fail;
        signal.addEventListener("abort", fail, { once: true });
      }
      this.queue.push(waiter);
      if (signal?.aborted) fail();
    });
  }

  private release() {
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.resolve(() => this.release());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export class DockerWorkspaceReaper {
  private readonly nextSweepAt = new Map<string, number>();
  private readonly scheduledSweeps = new Map<string, { at: number; timer: NodeJS.Timeout }>();

  constructor(
    private readonly now: () => number,
    private readonly controlTimeoutMs: number,
    private readonly request: (
      client: DockerEngineClientPort,
      input: DockerEngineRequest
    ) => Promise<DockerEngineResponse>
  ) {}

  async sweep(client: DockerEngineClientPort, targetWorkspaceId: string, targetRuntimeId: string) {
    const key = `${client.endpointId}\0${targetWorkspaceId}\0${targetRuntimeId}`;
    if ((this.nextSweepAt.get(key) ?? 0) > this.now()) return;
    this.nextSweepAt.set(key, this.now() + 60_000);
    try {
      const filters = encodeURIComponent(JSON.stringify({
        label: [
          `${LABEL_COMPONENT}=${COMPONENT_BASH}`,
          `${LABEL_WORKSPACE}=${targetWorkspaceId}`,
          `${LABEL_RUNTIME}=${targetRuntimeId}`
        ]
      }));
      const response = await this.request(client, {
        method: "GET",
        path: `/containers/json?all=1&filters=${filters}`,
        timeoutMs: this.controlTimeoutMs,
        maxResponseBytes: 512 * 1_024
      });
      if (response.statusCode !== 200) throw responseError(response);
      const containers = jsonArray(response.body);
      let earliestFutureExpiry: number | undefined;
      let deleteFailed = false;
      for (const entry of containers) {
        const labels = objectValue(entry.Labels);
        const names = Array.isArray(entry.Names) ? entry.Names : [];
        const expiresAt = Number(labels?.[LABEL_EXPIRES]);
        const invocationId = labels?.[LABEL_INVOCATION];
        const ownerId = labels?.[LABEL_OWNER];
        const containerId = entry.Id;
        const name = typeof names[0] === "string" ? names[0].replace(/^\//, "") : "";
        if (
          !labels
          || typeof containerId !== "string"
          || !/^[a-f0-9]{12,64}$/.test(containerId)
          || labels[LABEL_COMPONENT] !== COMPONENT_BASH
          || labels[LABEL_WORKSPACE] !== targetWorkspaceId
          || labels[LABEL_RUNTIME] !== targetRuntimeId
          || typeof ownerId !== "string"
          || !/^[a-f0-9]{32}$/.test(ownerId)
          || typeof invocationId !== "string"
          || !/^[a-f0-9]{32}$/.test(invocationId)
          || !Number.isSafeInteger(expiresAt)
          || expiresAt <= 0
          || (name !== `sunabot-bash-${invocationId}`
            && name !== `sunabot-bash-probe-${invocationId}`)
        ) continue;
        if (expiresAt > this.now()) {
          earliestFutureExpiry = Math.min(earliestFutureExpiry ?? expiresAt, expiresAt);
          continue;
        }
        try {
          const deletion = await this.request(client, {
            method: "DELETE",
            path: `/containers/${encodeURIComponent(containerId)}?force=1&v=1`,
            timeoutMs: this.controlTimeoutMs,
            maxResponseBytes: 64 * 1_024
          });
          if (deletion.statusCode !== 204 && deletion.statusCode !== 404) deleteFailed = true;
        } catch {
          deleteFailed = true;
        }
      }
      if (deleteFailed) {
        const retryAt = this.now() + 3_000;
        this.nextSweepAt.set(key, retryAt);
        this.scheduleAt(key, client, targetWorkspaceId, targetRuntimeId, retryAt);
      } else if (earliestFutureExpiry !== undefined) {
        const expirySweepAt = Math.max(this.now() + 1, earliestFutureExpiry + 1);
        this.nextSweepAt.set(key, expirySweepAt);
        this.scheduleAt(key, client, targetWorkspaceId, targetRuntimeId, expirySweepAt);
      }
    } catch {
      const retryAt = this.now() + 3_000;
      this.nextSweepAt.set(key, retryAt);
      this.scheduleAt(key, client, targetWorkspaceId, targetRuntimeId, retryAt);
    }
  }

  schedule(
    client: DockerEngineClientPort,
    targetWorkspaceId: string,
    targetRuntimeId: string,
    delayMs: number
  ) {
    const key = `${client.endpointId}\0${targetWorkspaceId}\0${targetRuntimeId}`;
    this.scheduleAt(key, client, targetWorkspaceId, targetRuntimeId, this.now() + delayMs);
  }

  private scheduleAt(
    key: string,
    client: DockerEngineClientPort,
    targetWorkspaceId: string,
    targetRuntimeId: string,
    targetAt: number
  ) {
    const scheduled = this.scheduledSweeps.get(key);
    if (scheduled && scheduled.at <= targetAt) return;
    if (scheduled) clearTimeout(scheduled.timer);
    const timer = setTimeout(() => {
      this.scheduledSweeps.delete(key);
      void this.sweep(client, targetWorkspaceId, targetRuntimeId);
    }, Math.max(1, targetAt - this.now()));
    timer.unref();
    this.scheduledSweeps.set(key, { at: targetAt, timer });
  }
}

export class DockerContainerCleanup {
  constructor(
    private readonly now: () => number,
    private readonly controlTimeoutMs: number,
    private readonly request: (
      client: DockerEngineClientPort,
      input: DockerEngineRequest,
      deadline?: number
    ) => Promise<DockerEngineResponse>,
    private readonly inspect: (
      client: DockerEngineClientPort,
      owned: OwnedContainer,
      deadline: number
    ) => Promise<InspectedContainer>,
    private readonly reaper: DockerWorkspaceReaper
  ) {}

  async remove(client: DockerEngineClientPort, owned: OwnedContainer, deadline: number) {
    try {
      const inspected = await this.inspect(client, owned, deadline);
      if (inspected.ownership === "absent") return true;
      if (inspected.ownership !== "owned") {
        this.schedule(client, owned, 0);
        return false;
      }
      const response = await this.request(client, {
        method: "DELETE",
        path: `/containers/${encodeURIComponent(owned.name)}?force=1&v=1`,
        timeoutMs: this.controlTimeoutMs,
        maxResponseBytes: 64 * 1_024
      }, deadline);
      if (response.statusCode === 204 || response.statusCode === 404) return true;
    } catch {
      // The bounded background path below owns reconciliation.
    }
    this.schedule(client, owned, 0);
    return false;
  }

  schedule(client: DockerEngineClientPort, owned: OwnedContainer, attempt: number, reconcileAbsent = false) {
    if (attempt === 0) {
      this.reaper.schedule(
        client,
        owned.workspaceId,
        String(owned.labels[LABEL_RUNTIME]),
        BASH_CONTAINER_EXPIRY_MS + 1_000
      );
    }
    const delayMs = CLEANUP_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) return;
    const timer = setTimeout(() => {
      void this.inspect(client, owned, this.now() + this.controlTimeoutMs * 3).then(async (inspected) => {
        if (inspected.ownership === "foreign") return;
        if (inspected.ownership === "absent") {
          if (reconcileAbsent) this.schedule(client, owned, attempt + 1, true);
          return;
        }
        const response = await this.request(client, {
          method: "DELETE",
          path: `/containers/${encodeURIComponent(owned.name)}?force=1&v=1`,
          timeoutMs: this.controlTimeoutMs,
          maxResponseBytes: 64 * 1_024
        });
        if (response.statusCode !== 204 && response.statusCode !== 404) {
          this.schedule(client, owned, attempt + 1, reconcileAbsent);
        }
      }).catch(() => this.schedule(client, owned, attempt + 1, reconcileAbsent));
    }, delayMs);
    timer.unref();
  }
}

export function buildContainerBody(
  input: WorkspaceBashRuntimeExecutionInput,
  owned: OwnedContainer
) {
  const uid = safeRuntimeId(input.effectiveUid, typeof process.getuid === "function" ? process.getuid() : 65_534);
  const gid = safeRuntimeId(input.effectiveGid, typeof process.getgid === "function" ? process.getgid() : uid);
  const execution = executionArguments(input.execution);
  const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
  return {
    Image: input.image,
    User: `${uid}:${gid}`,
    Entrypoint: ["/usr/bin/env"],
    Cmd: [
      "-i",
      ...TARGET_ENVIRONMENT,
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=2s",
      `${timeoutSeconds}s`,
      WORKSPACE_BASH_ADMIN_EXECUTABLE,
      "--noprofile",
      "--norc",
      "-c",
      OUTPUT_GUARD_SCRIPT,
      "sunabot-output-guard",
      ...execution
    ],
    Env: PROXY_VARIABLES.map((name) => `${name}=`),
    WorkingDir: WORKSPACE_BASH_VIRTUAL_ROOT,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: false,
    Tty: false,
    Labels: owned.labels,
    StopTimeout: 2,
    HostConfig: {
      AutoRemove: false,
      Init: true,
      LogConfig: {
        Type: "local",
        Config: { "max-size": "512k", "max-file": "1", compress: "false" }
      },
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 64,
      Memory: 256 * 1_024 * 1_024,
      NanoCpus: 1_000_000_000,
      Ulimits: [{ Name: "fsize", Soft: 268_435_456, Hard: 268_435_456 }],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m,mode=1777" },
      Mounts: [
        { Type: "bind", Source: input.workbenchRoot, Target: WORKSPACE_BASH_VIRTUAL_ROOT, ReadOnly: false },
        ...(input.readOnlyMounts ? readOnlyMounts(input.readOnlyMounts) : []),
        ...(input.resourceMounts ? resourceMounts(input.resourceMounts) : [])
      ]
    }
  };
}

export function dependencyProbeScript() {
  const dependencies = [...new Set([
    "/usr/bin/env",
    "/usr/bin/cat",
    "/usr/bin/head",
    "/usr/bin/test",
    "/usr/bin/timeout",
    "/usr/bin/wc",
    WORKSPACE_BASH_ADMIN_EXECUTABLE,
    ...WORKSPACE_BASH_RESTRICTED_EXECUTABLES
  ])];
  return `for executable in ${dependencies.join(" ")}; do /usr/bin/test -x "$executable" || exit 1; done`;
}

export function decodeDockerStream(body: Buffer) {
  if (!body.length) return { stdout: "", stderr: "" };
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (body.length - offset < 8) throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN");
    const stream = body[offset];
    const length = body.readUInt32BE(offset + 4);
    offset += 8;
    if (length > OUTPUT_LIMIT_BYTES || offset + length > body.length) {
      throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN");
    }
    const chunk = body.subarray(offset, offset + length);
    offset += length;
    if (stream === 1) stdout.push(chunk);
    else if (stream === 2) stderr.push(chunk);
    else throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN");
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  };
}

export function responseError(response: DockerEngineResponse) {
  return response.statusCode >= 500 || response.statusCode === 0
    ? new DockerEngineClientError("socket")
    : new ExecutionStateError("BASH_DOCKER_UNAVAILABLE");
}

export function runtimeErrorCode(error: unknown): WorkspaceBashRuntimeErrorCode {
  if (error instanceof CircuitOpenError) return "BASH_DOCKER_CIRCUIT_OPEN";
  if (error instanceof ExecutionStateError) return error.code;
  if (error instanceof DockerEngineClientError && error.kind === "aborted") return "BASH_EXECUTION_ABORTED";
  if (error instanceof DockerEngineClientError && error.kind === "response_too_large") return "BASH_OUTPUT_LIMIT";
  return "BASH_DOCKER_UNAVAILABLE";
}

export function failedResult(
  code: WorkspaceBashRuntimeErrorCode,
  retryAfterMs?: number
): WorkspaceBashRuntimeExecutionResult {
  const messages: Record<WorkspaceBashRuntimeErrorCode, string> = {
    BASH_BUSY: "BASH_BUSY: Docker Bash is busy; retry shortly.",
    BASH_DOCKER_CIRCUIT_OPEN: "BASH_DOCKER_CIRCUIT_OPEN: Docker Bash is recovering; retry later.",
    BASH_DOCKER_UNAVAILABLE: "BASH_DOCKER_UNAVAILABLE: Docker Engine is unavailable.",
    BASH_DOCKER_START_TIMEOUT: "BASH_DOCKER_START_TIMEOUT: container start could not be verified.",
    BASH_EXECUTION_ABORTED: "BASH_EXECUTION_ABORTED: sandboxed command was aborted.",
    BASH_EXECUTION_TIMEOUT: "BASH_EXECUTION_TIMEOUT: sandboxed command exceeded the fixed deadline.",
    BASH_EXECUTION_UNKNOWN: "BASH_EXECUTION_UNKNOWN: command execution state could not be verified; it was not replayed.",
    BASH_OUTPUT_LIMIT: "BASH_OUTPUT_LIMIT: sandboxed command output exceeded the fixed limit.",
    BASH_DOCKER_CLEANUP_FAILED: "BASH_DOCKER_CLEANUP_FAILED: Docker container cleanup could not be verified."
  };
  return {
    ok: false,
    exitCode: null,
    signal: null,
    timedOut: code === "BASH_EXECUTION_TIMEOUT",
    stdout: "",
    stderr: messages[code],
    errorCode: code,
    ...(retryAfterMs && retryAfterMs > 0 ? { retryAfterMs } : {})
  };
}

export function completedExecutionResult(
  completion: { exitCode: number; signal: string | null; timedOut: boolean },
  logs: { stdout: string; stderr: string },
  cleanupSucceeded: boolean,
  retryAfterMs: number
): WorkspaceBashRuntimeExecutionResult {
  const timedOut = completion.timedOut || completion.exitCode === 124;
  const outputLimited = completion.exitCode === BASH_OUTPUT_LIMIT_EXIT_CODE
    && logs.stderr.trim() === BASH_OUTPUT_LIMIT_MARKER;
  const errorCode = timedOut
    ? "BASH_EXECUTION_TIMEOUT" as const
    : outputLimited
      ? "BASH_OUTPUT_LIMIT" as const
      : cleanupSucceeded
        ? undefined
        : "BASH_DOCKER_CLEANUP_FAILED" as const;
  return {
    ok: completion.exitCode === 0 && !timedOut && !outputLimited && cleanupSucceeded,
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut,
    stdout: logs.stdout,
    stderr: timedOut
      ? "BASH_EXECUTION_TIMEOUT: sandboxed command exceeded the fixed deadline."
      : outputLimited
        ? "BASH_OUTPUT_LIMIT: sandboxed command output exceeded the fixed limit."
        : cleanupSucceeded
          ? logs.stderr
          : "BASH_DOCKER_CLEANUP_FAILED: Docker container cleanup could not be verified.",
    ...(errorCode ? { errorCode } : {}),
    ...(!cleanupSucceeded && retryAfterMs > 0 ? { retryAfterMs } : {}),
    cleanupAttempted: true,
    cleanupSucceeded
  };
}

export function hasOwnedLabels(labels: Record<string, unknown>, owned: OwnedContainer) {
  return labels[LABEL_COMPONENT] === COMPONENT_BASH
    && labels[LABEL_INVOCATION] === owned.invocationId
    && labels[LABEL_OWNER] === owned.labels[LABEL_OWNER]
    && labels[LABEL_RUNTIME] === owned.labels[LABEL_RUNTIME]
    && labels[LABEL_WORKSPACE] === owned.workspaceId;
}

export function isInfrastructureError(error: unknown) {
  return error instanceof ExecutionStateError
    ? error.infrastructure
    : error instanceof DockerEngineClientError
      && (error.kind === "socket" || error.kind === "timeout");
}

export function isCurrent(check?: () => boolean) {
  if (!check) return true;
  try {
    return check() === true;
  } catch {
    return false;
  }
}

export function workspaceId(workbenchRoot: string) {
  return createHash("sha256").update(workbenchRoot).digest("hex").slice(0, 32);
}

export function deploymentWorkspaceId(input: WorkspaceBashRuntimeCapabilityInput) {
  const configured = input.dockerEnvironment?.SUNABOT_WORKSPACE_ID?.trim();
  return configured && /^[a-f0-9]{16,64}$/.test(configured)
    ? configured
    : workspaceId(input.workbenchRoot);
}

export function deploymentRuntimeId(input: WorkspaceBashRuntimeCapabilityInput) {
  const configured = input.dockerEnvironment?.SUNABOT_RUNTIME_ID?.trim();
  return configured && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(configured)
    ? configured
    : "sunabot-qq-runtime";
}

export function capabilityKey(endpointId: string, input: WorkspaceBashRuntimeCapabilityInput) {
  return [
    endpointId,
    input.image,
    String(input.effectiveUid ?? ""),
    String(input.effectiveGid ?? ""),
    deploymentWorkspaceId(input),
    deploymentRuntimeId(input),
    input.readOnlyMounts?.skills ?? "",
    input.readOnlyMounts?.mcp ?? "",
    input.resourceMounts?.nativeWorkbench ?? "",
    input.resourceMounts?.dockerWorkbench ?? ""
  ].join("\0");
}

export function environmentKey(environment: Readonly<NodeJS.ProcessEnv>) {
  return createHash("sha256").update(JSON.stringify([
    environment.DOCKER_HOST ?? "",
    environment.DOCKER_CONTEXT ?? "",
    environment.DOCKER_CONFIG ?? "",
    environment.SUNABOT_DOCKER_SOCKET ?? "",
    environment.SUNABOT_RUNTIME_ID ?? "",
    environment.SUNABOT_WORKSPACE_ID ?? "",
    environment.HOME ?? ""
  ])).digest("hex");
}

export function jsonObject(body: Buffer) {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN");
  }
}

export function jsonArray(body: Buffer) {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is Record<string, unknown> => Boolean(
      entry && typeof entry === "object" && !Array.isArray(entry)
    ));
  } catch {
    return [];
  }
}

export function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function positiveInteger(value: unknown, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export function validDelays(value: readonly number[] | undefined, fallback: readonly number[]) {
  return value?.length && value.every((item) => Number.isSafeInteger(item) && item > 0)
    ? [...value]
    : fallback;
}

export function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DockerEngineClientError("aborted"));
      return;
    }
    let abortListener: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      resolve();
    }, milliseconds);
    timer.unref();
    if (signal) {
      abortListener = () => {
        clearTimeout(timer);
        reject(new DockerEngineClientError("aborted"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

function readOnlyMounts(mounts: WorkspaceBashReadOnlyMounts) {
  return [
    { Type: "bind", Source: mounts.skills, Target: WORKSPACE_BASH_SKILLS_ROOT, ReadOnly: true },
    { Type: "bind", Source: mounts.mcp, Target: WORKSPACE_BASH_MCP_ROOT, ReadOnly: true }
  ];
}

function resourceMounts(mounts: WorkspaceBashResourceMounts) {
  return mounts.nativeWorkbench ? [{
    Type: "bind",
    Source: mounts.nativeWorkbench,
    Target: `${WORKSPACE_BASH_VIRTUAL_ROOT}/native-workbench`,
    ReadOnly: true
  }] : [];
}

function executionArguments(execution: WorkspaceBashExecution) {
  return execution.kind === "argv"
    ? [execution.executable, ...execution.args]
    : [WORKSPACE_BASH_ADMIN_EXECUTABLE, "--noprofile", "--norc", "-lc", execution.command];
}

function safeRuntimeId(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
