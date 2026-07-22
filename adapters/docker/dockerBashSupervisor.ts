import { randomBytes } from "node:crypto";
import type { WorkspaceBashExecution } from "../../services/tools/bashSandbox.js";
import type {
  WorkspaceBashRuntimeCapabilityInput,
  WorkspaceBashRuntimeCapabilityResult,
  WorkspaceBashRuntimeExecutionInput,
  WorkspaceBashRuntimeExecutionResult,
  WorkspaceBashRuntimePort
} from "../../services/tools/bashRuntime.js";
import {
  DockerEngineClientError,
  createDockerEngineClient,
  type DockerEngineClientPort,
  type DockerEngineRequest
} from "./dockerEngineClient.js";
import {
  BASH_CONTAINER_EXPIRY_MS,
  COMPONENT_BASH,
  CircuitOpenError,
  DockerCircuit,
  DockerContainerCleanup,
  DockerExecutionBulkhead,
  DockerWorkspaceReaper,
  ExecutionStateError,
  LABEL_COMPONENT,
  LABEL_EXPIRES,
  LABEL_INVOCATION,
  LABEL_OWNER,
  LABEL_RUNTIME,
  LABEL_WORKSPACE,
  buildContainerBody,
  capabilityKey,
  completedExecutionResult,
  decodeDockerStream,
  deploymentRuntimeId,
  deploymentWorkspaceId,
  dependencyProbeScript,
  environmentKey,
  failedResult,
  hasOwnedLabels,
  isCurrent,
  isInfrastructureError,
  jsonObject,
  objectValue,
  positiveInteger,
  responseError,
  runtimeErrorCode,
  validDelays,
  wait,
  type InspectedContainer,
  type OwnedContainer
} from "./dockerBashSupport.js";

const CONTROL_TIMEOUT_MS = 2_000;
const SAFE_RETRY_DELAY_MS = 300;
const TOTAL_EXECUTION_BUDGET_MS = 45_000;
const QUEUE_TIMEOUT_MS = 1_000;
const MAX_CONCURRENT_EXECUTIONS = 2;
const BREAKER_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const;
const BREAKER_STABLE_RESET_MS = 5 * 60_000;
const OUTPUT_LIMIT_BYTES = 256 * 1_024;

type Delay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type ClientFactory = (
  environment: Readonly<NodeJS.ProcessEnv>
) => Promise<DockerEngineClientPort>;

export interface DockerBashSupervisorOptions {
  clientFactory?: ClientFactory;
  now?: () => number;
  delay?: Delay;
  controlTimeoutMs?: number;
  retryDelayMs?: number;
  totalExecutionBudgetMs?: number;
  queueTimeoutMs?: number;
  maxConcurrentExecutions?: number;
  breakerDelaysMs?: readonly number[];
  stableResetMs?: number;
  runtimeId?: string;
}

export function createDockerBashSupervisor(
  options: DockerBashSupervisorOptions = {}
): WorkspaceBashRuntimePort {
  return new DockerBashSupervisor(options);
}

class DockerBashSupervisor implements WorkspaceBashRuntimePort {
  private readonly clientFactory: ClientFactory;
  private readonly now: () => number;
  private readonly delay: Delay;
  private readonly controlTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly totalExecutionBudgetMs: number;
  private readonly breakerDelaysMs: readonly number[];
  private readonly stableResetMs: number;
  private readonly ownerId: string;
  private readonly clients = new Map<string, Promise<DockerEngineClientPort>>();
  private readonly circuits = new Map<string, DockerCircuit>();
  private readonly capabilitySuccesses = new Set<string>();
  private readonly capabilityFlights = new Map<string, Promise<boolean>>();
  private readonly bulkhead: DockerExecutionBulkhead;
  private readonly reaper: DockerWorkspaceReaper;
  private readonly cleanup: DockerContainerCleanup;
  constructor(options: DockerBashSupervisorOptions) {
    this.clientFactory = options.clientFactory ?? ((environment) => createDockerEngineClient({ environment }));
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? wait;
    this.controlTimeoutMs = positiveInteger(options.controlTimeoutMs, CONTROL_TIMEOUT_MS);
    this.retryDelayMs = positiveInteger(options.retryDelayMs, SAFE_RETRY_DELAY_MS);
    this.totalExecutionBudgetMs = positiveInteger(options.totalExecutionBudgetMs, TOTAL_EXECUTION_BUDGET_MS);
    this.breakerDelaysMs = validDelays(options.breakerDelaysMs, BREAKER_DELAYS_MS);
    this.stableResetMs = positiveInteger(options.stableResetMs, BREAKER_STABLE_RESET_MS);
    this.ownerId = options.runtimeId && /^[a-f0-9]{32}$/.test(options.runtimeId)
      ? options.runtimeId
      : randomBytes(16).toString("hex");
    this.bulkhead = new DockerExecutionBulkhead(
      positiveInteger(options.maxConcurrentExecutions, MAX_CONCURRENT_EXECUTIONS),
      positiveInteger(options.queueTimeoutMs, QUEUE_TIMEOUT_MS)
    );
    this.reaper = new DockerWorkspaceReaper(
      this.now,
      this.controlTimeoutMs,
      (client, input) => this.safeRequest(client, input)
    );
    this.cleanup = new DockerContainerCleanup(
      this.now,
      this.controlTimeoutMs,
      (client, input, deadline) => this.safeRequest(client, deadline
        ? { ...input, timeoutMs: this.remainingControlBudget(deadline) }
        : input, deadline),
      (client, owned, deadline) => this.inspect(client, owned, deadline),
      this.reaper
    );
  }
  async capability(
    input: WorkspaceBashRuntimeCapabilityInput
  ): Promise<WorkspaceBashRuntimeCapabilityResult> {
    try {
      const client = await this.client(input.dockerEnvironment);
      const circuit = this.circuit(client);
      const key = capabilityKey(client.endpointId, input);
      const circuitGeneration = await circuit.beforeRequest(async () => {
        await this.runCapabilityProbe(client, input);
        this.capabilitySuccesses.add(key);
        void this.reaper.sweep(client, deploymentWorkspaceId(input), deploymentRuntimeId(input));
      });
      if (this.capabilitySuccesses.has(key)) return { available: true };
      let flight = this.capabilityFlights.get(key);
      if (!flight) {
        flight = this.runCapabilityProbe(client, input).then(
          () => {
            this.capabilitySuccesses.add(key);
            circuit.operationalSuccess(circuitGeneration);
            return true;
          },
          (error) => {
            if (isInfrastructureError(error)) {
              circuit.infrastructureFailure(circuitGeneration);
              this.invalidateEndpointCapabilities(client.endpointId);
            }
            return false;
          }
        ).finally(() => this.capabilityFlights.delete(key));
        this.capabilityFlights.set(key, flight);
      }
      const available = await flight;
      if (available) {
        void this.reaper.sweep(client, deploymentWorkspaceId(input), deploymentRuntimeId(input));
        return { available: true };
      }
      return { available: false, retryAfterMs: circuit.retryAfterMs() || undefined };
    } catch (error) {
      return {
        available: false,
        ...(error instanceof CircuitOpenError ? { retryAfterMs: error.retryAfterMs } : {})
      };
    }
  }
  async execute(
    input: WorkspaceBashRuntimeExecutionInput
  ): Promise<WorkspaceBashRuntimeExecutionResult> {
    const deadline = this.now() + this.totalExecutionBudgetMs;
    let release: (() => void) | undefined;
    try {
      release = await this.bulkhead.acquire(input.signal);
    } catch {
      return failedResult("BASH_BUSY");
    }
    try {
      return await this.executeWithSlot(input, deadline);
    } finally {
      release();
    }
  }
  private async executeWithSlot(
    input: WorkspaceBashRuntimeExecutionInput,
    deadline: number
  ): Promise<WorkspaceBashRuntimeExecutionResult> {
    if (input.signal?.aborted) return failedResult("BASH_EXECUTION_ABORTED");
    if (!isCurrent(input.isCurrent)) return failedResult("BASH_EXECUTION_ABORTED");
    let client: DockerEngineClientPort;
    try {
      client = await this.client(input.dockerEnvironment);
    } catch {
      return failedResult("BASH_DOCKER_UNAVAILABLE");
    }
    const circuit = this.circuit(client);
    let circuitGeneration: number;
    try {
      circuitGeneration = await circuit.beforeRequest(async () => {
        await this.runCapabilityProbe(client, input, deadline);
        this.capabilitySuccesses.add(capabilityKey(client.endpointId, input));
        void this.reaper.sweep(client, deploymentWorkspaceId(input), deploymentRuntimeId(input));
      });
    } catch (error) {
      return error instanceof CircuitOpenError
        ? failedResult("BASH_DOCKER_CIRCUIT_OPEN", error.retryAfterMs)
        : failedResult("BASH_DOCKER_UNAVAILABLE", circuit.retryAfterMs());
    }
    const invocationId = randomBytes(16).toString("hex");
    const owned: OwnedContainer = {
      name: `sunabot-bash-${invocationId}`,
      invocationId,
      workspaceId: deploymentWorkspaceId(input),
      labels: containerLabels(this.ownerId, invocationId, input, this.now())
    };
    let created = false;
    try {
      await this.createContainer(client, owned, buildContainerBody(input, owned), deadline, input.signal);
      created = true;
      if (!isCurrent(input.isCurrent)) throw new ExecutionStateError("BASH_EXECUTION_ABORTED");
      await this.startContainer(client, owned, deadline, input.signal);
      const completion = await this.waitForCompletion(client, owned, input, deadline);
      const logs = await this.readLogs(client, owned, deadline);
      const cleanup = await this.cleanup.remove(client, owned, deadline);
      if (!cleanup) {
        circuit.infrastructureFailure(circuitGeneration);
        this.invalidateEndpointCapabilities(client.endpointId);
      } else {
        circuit.operationalSuccess(circuitGeneration);
      }
      return completedExecutionResult(completion, logs, cleanup, circuit.retryAfterMs());
    } catch (error) {
      if (isInfrastructureError(error)) {
        circuit.infrastructureFailure(circuitGeneration);
        this.invalidateEndpointCapabilities(client.endpointId);
      }
      const code = runtimeErrorCode(error);
      if (!created && code === "BASH_EXECUTION_UNKNOWN") {
        this.cleanup.schedule(client, owned, 0, true);
      }
      const cleanupSucceeded = created
        ? await this.cleanup.remove(client, owned, deadline)
        : undefined;
      if (cleanupSucceeded === false) {
        circuit.infrastructureFailure(circuitGeneration);
        this.invalidateEndpointCapabilities(client.endpointId);
      }
      return {
        ...failedResult(code, error instanceof CircuitOpenError ? error.retryAfterMs : circuit.retryAfterMs()),
        ...(created ? { cleanupAttempted: true, cleanupSucceeded } : {})
      };
    }
  }
  private async runCapabilityProbe(
    client: DockerEngineClientPort,
    input: WorkspaceBashRuntimeCapabilityInput,
    executionDeadline?: number
  ) {
    await this.ping(client);
    const image = await this.safeRequest(client, {
      method: "GET",
      path: `/images/${encodeURIComponent(input.image)}/json`,
      timeoutMs: this.controlTimeoutMs
    });
    if (image.statusCode !== 200) throw responseError(image);
    const invocationId = randomBytes(16).toString("hex");
    const owned: OwnedContainer = {
      name: `sunabot-bash-probe-${invocationId}`,
      invocationId,
      workspaceId: deploymentWorkspaceId(input),
      labels: containerLabels(this.ownerId, invocationId, input, this.now())
    };
    const execution: WorkspaceBashExecution = {
      kind: "shell",
      command: dependencyProbeScript()
    };
    const deadline = Math.min(executionDeadline ?? Number.POSITIVE_INFINITY, this.now() + 10_000);
    let created = false;
    try {
      await this.createContainer(client, owned, buildContainerBody({
        ...input,
        execution,
        timeoutMs: 5_000
      }, owned), deadline);
      created = true;
      await this.startContainer(client, owned, deadline);
      const completion = await this.waitForCompletion(client, owned, { timeoutMs: 5_000 }, deadline);
      if (completion.exitCode !== 0) throw new ExecutionStateError("BASH_DOCKER_UNAVAILABLE");
    } catch (error) {
      if (!created && error instanceof ExecutionStateError && error.code === "BASH_EXECUTION_UNKNOWN") {
        this.cleanup.schedule(client, owned, 0, true);
      }
      throw error;
    } finally {
      if (created && !await this.cleanup.remove(client, owned, deadline)) {
        throw new ExecutionStateError("BASH_DOCKER_CLEANUP_FAILED", true);
      }
    }
  }
  private async createContainer(
    client: DockerEngineClientPort,
    owned: OwnedContainer,
    body: Record<string, unknown>,
    deadline: number,
    signal?: AbortSignal
  ) {
    const request = () => this.controlRequest(client, {
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(owned.name)}`,
      body,
      timeoutMs: this.remainingControlBudget(deadline),
      ...(signal ? { signal } : {})
    });
    try {
      const response = await request();
      if (response.statusCode === 201) return;
      if (response.statusCode !== 409) throw responseError(response);
      const inspected = await this.inspect(client, owned, deadline);
      if (inspected.ownership === "owned") return;
      throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN");
    } catch (error) {
      if (!isInfrastructureError(error)) throw error;
      let inspected: InspectedContainer;
      try {
        inspected = await this.inspect(client, owned, deadline);
      } catch {
        throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
      }
      if (inspected.ownership === "owned") return;
      if (inspected.ownership === "foreign") throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
      await this.delay(this.retryDelayWithin(deadline), signal);
      try {
        const retried = await request();
        if (retried.statusCode === 201) return;
        if (retried.statusCode !== 409) throw responseError(retried);
      } catch (retryError) {
        if (!isInfrastructureError(retryError)) throw retryError;
      }
      let reconciled: InspectedContainer;
      try {
        reconciled = await this.inspect(client, owned, deadline);
      } catch {
        throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
      }
      if (reconciled.ownership === "owned") return;
      throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
    }
  }
  private async startContainer(
    client: DockerEngineClientPort,
    owned: OwnedContainer,
    deadline: number,
    signal?: AbortSignal
  ) {
    try {
      const response = await this.controlRequest(client, {
        method: "POST",
        path: `/containers/${encodeURIComponent(owned.name)}/start`,
        timeoutMs: this.remainingControlBudget(deadline),
        ...(signal ? { signal } : {})
      });
      if (response.statusCode === 204 || response.statusCode === 304) return;
      throw responseError(response);
    } catch (error) {
      if (!isInfrastructureError(error)) throw error;
      const inspected = await this.inspect(client, owned, deadline).catch(() => ({ ownership: "absent" as const }));
      if (
        inspected.ownership === "owned"
        && (inspected.status === "running" || inspected.status === "exited")
      ) return;
      if (inspected.ownership === "owned" && inspected.status === "created") {
        throw new ExecutionStateError("BASH_DOCKER_START_TIMEOUT", true);
      }
      throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
    }
  }
  private async waitForCompletion(
    client: DockerEngineClientPort,
    owned: OwnedContainer,
    input: Pick<WorkspaceBashRuntimeExecutionInput, "signal" | "timeoutMs">,
    deadline: number
  ): Promise<{ exitCode: number; signal: string | null; timedOut: boolean }> {
    const waitTimeoutMs = Math.max(1, Math.min(
      input.timeoutMs + 2_500,
      this.remainingExecutionBudget(deadline)
    ));
    try {
      const response = await client.request({
        method: "POST",
        path: `/containers/${encodeURIComponent(owned.name)}/wait?condition=not-running`,
        timeoutMs: waitTimeoutMs,
        maxResponseBytes: 64 * 1_024,
        ...(input.signal ? { signal: input.signal } : {})
      });
      if (response.statusCode !== 200) throw responseError(response);
      const payload = jsonObject(response.body);
      const exitCode = payload.StatusCode;
      if (!Number.isSafeInteger(exitCode)) throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN");
      return { exitCode: Number(exitCode), signal: null, timedOut: Number(exitCode) === 124 };
    } catch (error) {
      if (error instanceof DockerEngineClientError && error.kind === "aborted") {
        await this.kill(client, owned, deadline);
        throw new ExecutionStateError("BASH_EXECUTION_ABORTED");
      }
      if (error instanceof DockerEngineClientError && error.kind === "timeout") {
        await this.kill(client, owned, deadline);
        const inspected = await this.inspect(client, owned, deadline).catch(() => undefined);
        return {
          exitCode: inspected?.exitCode ?? 124,
          signal: "SIGKILL",
          timedOut: true
        };
      }
      if (!isInfrastructureError(error)) throw error;
      await this.delay(this.retryDelayWithin(deadline), input.signal);
      const inspected = await this.inspect(client, owned, deadline);
      if (inspected.ownership !== "owned") throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
      if (inspected.status === "exited" && Number.isSafeInteger(inspected.exitCode)) {
        return { exitCode: inspected.exitCode!, signal: null, timedOut: inspected.exitCode === 124 };
      }
      throw new ExecutionStateError("BASH_EXECUTION_UNKNOWN", true);
    }
  }
  private async readLogs(
    client: DockerEngineClientPort,
    owned: OwnedContainer,
    deadline: number
  ) {
    const response = await this.safeRequest(client, {
      method: "GET",
      path: `/containers/${encodeURIComponent(owned.name)}/logs?stdout=1&stderr=1`,
      timeoutMs: this.remainingControlBudget(deadline),
      maxResponseBytes: OUTPUT_LIMIT_BYTES
    }, deadline);
    if (response.statusCode !== 200) throw responseError(response);
    return decodeDockerStream(response.body);
  }
  private async inspect(
    client: DockerEngineClientPort,
    owned: OwnedContainer,
    deadline: number
  ): Promise<InspectedContainer> {
    const response = await this.safeRequest(client, {
      method: "GET",
      path: `/containers/${encodeURIComponent(owned.name)}/json`,
      timeoutMs: this.remainingControlBudget(deadline),
      maxResponseBytes: 256 * 1_024
    }, deadline);
    if (response.statusCode === 404) return { ownership: "absent" };
    if (response.statusCode !== 200) throw responseError(response);
    const payload = jsonObject(response.body);
    const config = objectValue(payload.Config);
    const labels = objectValue(config?.Labels);
    if (!labels || !hasOwnedLabels(labels, owned)) return { ownership: "foreign" };
    const state = objectValue(payload.State);
    const rawStatus = state?.Status;
    const status = rawStatus === "created" || rawStatus === "running" || rawStatus === "exited"
      ? rawStatus
      : "unknown";
    const exitCode = Number.isSafeInteger(state?.ExitCode) ? Number(state?.ExitCode) : undefined;
    return { ownership: "owned", status, ...(exitCode === undefined ? {} : { exitCode }) };
  }
  private async kill(client: DockerEngineClientPort, owned: OwnedContainer, deadline: number) {
    try {
      const response = await this.safeRequest(client, {
        method: "POST",
        path: `/containers/${encodeURIComponent(owned.name)}/kill?signal=KILL`,
        timeoutMs: this.remainingControlBudget(deadline)
      }, deadline);
      if (![204, 404, 409].includes(response.statusCode)) throw responseError(response);
    } catch {
      // The in-container watchdog remains authoritative when the control plane is unavailable.
    }
  }
  private async ping(client: DockerEngineClientPort) {
    const response = await this.safeRequest(client, {
      method: "GET",
      path: "/_ping",
      timeoutMs: this.controlTimeoutMs,
      maxResponseBytes: 1_024
    });
    if (response.statusCode !== 200 || response.body.toString("utf8").trim() !== "OK") {
      throw responseError(response);
    }
  }
  private async safeRequest(
    client: DockerEngineClientPort,
    input: DockerEngineRequest,
    deadline = this.now() + this.controlTimeoutMs * 2 + this.retryDelayMs
  ) {
    try {
      const response = await this.controlRequest(client, input);
      if (response.statusCode >= 500 || response.statusCode === 0) throw responseError(response);
      return response;
    } catch (error) {
      if (!isInfrastructureError(error) || error instanceof DockerEngineClientError && error.kind === "aborted") {
        throw error;
      }
      await this.delay(this.retryDelayWithin(deadline), input.signal);
      const response = await this.controlRequest(client, {
        ...input,
        timeoutMs: this.remainingControlBudget(deadline)
      });
      if (response.statusCode >= 500 || response.statusCode === 0) throw responseError(response);
      return response;
    }
  }
  private controlRequest(client: DockerEngineClientPort, input: DockerEngineRequest) {
    return client.request({
      ...input,
      timeoutMs: Math.min(this.controlTimeoutMs, positiveInteger(input.timeoutMs, this.controlTimeoutMs))
    });
  }
  private remainingControlBudget(deadline: number) {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new DockerEngineClientError("timeout");
    return Math.max(1, Math.min(this.controlTimeoutMs, remaining));
  }
  private remainingExecutionBudget(deadline: number) {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new DockerEngineClientError("timeout");
    return remaining;
  }
  private retryDelayWithin(deadline: number) {
    return Math.max(1, Math.min(this.retryDelayMs, this.remainingExecutionBudget(deadline)));
  }
  private async client(environment: Readonly<NodeJS.ProcessEnv> = process.env) {
    if (!environment.SUNABOT_DOCKER_SOCKET?.trim()) return this.clientFactory(environment);
    const key = environmentKey(environment);
    let client = this.clients.get(key);
    if (!client) {
      client = this.clientFactory(environment).catch((error) => {
        this.clients.delete(key);
        throw error;
      });
      this.clients.set(key, client);
    }
    return client;
  }
  private circuit(client: DockerEngineClientPort) {
    let circuit = this.circuits.get(client.endpointId);
    if (!circuit) {
      circuit = new DockerCircuit(
        this.now,
        this.breakerDelaysMs,
        this.stableResetMs
      );
      this.circuits.set(client.endpointId, circuit);
    }
    return circuit;
  }
  private invalidateEndpointCapabilities(endpointId: string) {
    for (const key of this.capabilitySuccesses) {
      if (key.startsWith(`${endpointId}\0`)) this.capabilitySuccesses.delete(key);
    }
  }
}

function containerLabels(
  ownerId: string,
  invocationId: string,
  input: WorkspaceBashRuntimeCapabilityInput,
  now: number
) {
  return {
    [LABEL_COMPONENT]: COMPONENT_BASH,
    [LABEL_INVOCATION]: invocationId,
    [LABEL_OWNER]: ownerId,
    [LABEL_RUNTIME]: deploymentRuntimeId(input),
    [LABEL_WORKSPACE]: deploymentWorkspaceId(input),
    [LABEL_EXPIRES]: String(now + BASH_CONTAINER_EXPIRY_MS)
  };
}
