import type {
  InboundMessageV1,
  MessagingConnectionContextV1,
  MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import type { BroadcastStormDetector } from "../orchestration/public.js";
import type { AgentRegistry, AgentSummary } from "./agentRegistry.js";

type AgentRuntimeConfig = Awaited<ReturnType<AgentRegistry["config"]>>;

export interface AgentRuntimePort {
  config: AgentRuntimeConfig;
  initialize(): Promise<unknown>;
  close(): unknown;
  handleInboundMessage(message: InboundMessageV1, gateway: MessagingPort): Promise<unknown>;
  resumeUserGroupOrchestrators(gateway: MessagingPort): unknown;
  suspendUserGroupOrchestrators(): unknown;
  getPersonaStatus(): unknown;
}

export interface AgentRuntimeManagerOptions<TRuntime extends AgentRuntimePort> {
  defaultRuntime: TRuntime;
  createRuntime: (config: AgentRuntimeConfig) => TRuntime;
  initializeRuntime: boolean;
  broadcastStormDetector: BroadcastStormDetector;
  probeExtensionReadiness?(agentId: string): Promise<AgentRuntimeReadiness>;
  readAccountRuntimeStatus?(accountId: string): AccountRuntimeStatusSnapshot;
}

export interface AccountRuntimeStatusSnapshot {
  configured: boolean;
  observedState?: "running" | "stopped" | "missing" | "unknown";
  reconcileRequired?: boolean;
  lastError?: string | null;
}

export interface AgentRuntimeReadiness {
  status: "ready" | "degraded" | "not_ready";
  code: string | null;
  requiredMcpServers: string[];
  degradedMcpServers: string[];
}

interface OrchestratorActivation {
  generation: number;
  gateway: MessagingPort;
}

export class AgentRuntimeManager<TRuntime extends AgentRuntimePort> {
  private readonly runtimes = new Map<string, TRuntime>();
  private readonly readiness = new Map<string, AgentRuntimeReadiness>();
  private readonly agentOperations = new Map<string, Promise<unknown>>();
  private readonly runtimeOrchestratorGenerations = new WeakMap<TRuntime, number>();
  private orchestratorGeneration = 0;
  private orchestratorActivation?: OrchestratorActivation;
  private closed = false;
  private closeOperation?: Promise<void>;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly options: AgentRuntimeManagerOptions<TRuntime>
  ) {}

  async initialize() {
    const defaultId = this.options.defaultRuntime.config.persona.defaultAgentId;
    const agents = await this.registry.list();
    await this.start(defaultId);
    for (const agent of agents) {
      if (!agent.enabled || agent.id === defaultId) continue;
      await this.start(agent.id);
    }
  }

  async start(agentId: string) {
    if (this.closed) return undefined;
    return this.runAgentOperation(agentId, () => this.startAgent(agentId));
  }

  private async startAgent(agentId: string) {
    if (this.closed) return undefined;
    const existing = this.runtimes.get(agentId);
    const previousReadiness = this.readiness.get(agentId);
    const readiness = await this.probeReadiness(agentId);
    if (this.closed) return undefined;
    this.readiness.set(agentId, readiness);
    if (readiness.status === "not_ready") {
      if (existing && existing !== this.options.defaultRuntime) {
        existing.close();
        this.runtimes.delete(agentId);
      } else if (previousReadiness?.status !== "not_ready") {
        const defaultId = this.options.defaultRuntime.config.persona.defaultAgentId;
        if (agentId === defaultId) {
          this.options.defaultRuntime.suspendUserGroupOrchestrators();
          this.runtimeOrchestratorGenerations.delete(this.options.defaultRuntime);
        }
      }
      return undefined;
    }
    if (existing) {
      if (previousReadiness?.status === "not_ready") this.resumeRuntimeIfActive(existing);
      return existing;
    }
    const defaultId = this.options.defaultRuntime.config.persona.defaultAgentId;
    const runtime = agentId === defaultId
      ? this.options.defaultRuntime
      : this.options.createRuntime(await this.registry.config(agentId));
    try {
      if (this.options.initializeRuntime) await runtime.initialize();
      if (this.closed) {
        try {
          runtime.close();
        } catch (error) {
          this.runtimes.set(agentId, runtime);
          throw error;
        }
        return undefined;
      }
      this.runtimes.set(agentId, runtime);
      this.resumeRuntimeIfActive(runtime);
      return runtime;
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  async stop(agentId: string) {
    if (this.closed) return;
    await this.runAgentOperation(agentId, async () => {
      const runtime = this.runtimes.get(agentId);
      if (!runtime || runtime === this.options.defaultRuntime) return;
      this.readiness.set(agentId, stoppedReadiness());
      runtime.close();
      this.runtimes.delete(agentId);
    });
  }

  get(agentId: string) {
    return this.closed || this.readiness.get(agentId)?.status === "not_ready"
      ? undefined
      : this.runtimes.get(agentId);
  }

  entries() {
    return [...this.runtimes.entries()];
  }

  require(agentId: string) {
    const runtime = this.get(agentId);
    if (!runtime) throw new Error(`Agent runtime is not available: ${agentId}`);
    return runtime;
  }

  async handleInboundMessage(
    message: InboundMessageV1,
    gateway: MessagingPort,
    connection: MessagingConnectionContextV1
  ) {
    const account = this.registry.account(connection.accountId);
    if (!account || !account.enabled) throw new Error(`OneBot account is not registered: ${connection.accountId}`);
    const agent = await this.registry.get(account.agentId);
    if (!agent.enabled) throw new Error(`Agent is disabled: ${agent.id}`);
    const runtime = this.require(agent.id);
    if (connection.selfId && account.qqId !== connection.selfId) {
      await this.registry.updateAccountIdentity(account.id, connection.selfId);
    }
    await this.observeBroadcastStorm(message, gateway);
    await runtime.handleInboundMessage({
      ...message,
      agentId: agent.id,
      accountId: account.id
    }, gateway);
  }

  private async observeBroadcastStorm(message: InboundMessageV1, gateway: MessagingPort) {
    const detector = this.options.broadcastStormDetector;
    if (!detector.enabled() || !message.groupId || !message.replyMessageIds.length) return;
    const sourceActorId = this.broadcastStormActorId(String(message.userId));
    if (!sourceActorId) return;

    for (const replyMessageId of message.replyMessageIds) {
      let targetActorId: string | undefined;
      try {
        const quoted = await gateway.getMessage(replyMessageId, {
          ...(message.accountId ? { accountId: message.accountId } : {}),
          source: "quote",
          groupId: message.groupId,
          userId: message.userId
        });
        targetActorId = this.broadcastStormActorId(quoted.sender.id);
      } catch (error) {
        console.error("[broadcast-storm] quoted message lookup failed", {
          groupId: message.groupId,
          messageId: message.messageId,
          replyMessageId,
          error
        });
        continue;
      }
      if (!targetActorId || targetActorId === sourceActorId) continue;

      const result = detector.observe({
        messageKey: `${message.groupId}:${message.messageId ?? `${message.userId}:${message.time}:${replyMessageId}`}`,
        groupId: message.groupId,
        sourceActorId,
        targetActorId,
        occurredAt: message.time
      });
      if (result.triggered) {
        console.warn("[broadcast-storm] new reply task gate activated", {
          groupId: message.groupId,
          sourceActorId,
          targetActorId,
          blockedUntil: result.blockedUntil
        });
      }
      return;
    }
  }

  private broadcastStormActorId(qqId: string) {
    const normalized = qqId.trim();
    if (!normalized) return undefined;
    const agentId = this.registry.agentIdForQqId(normalized);
    if (agentId) return `agent:${agentId}`;
    return this.options.broadcastStormDetector.isAdditionalQqId(normalized)
      ? `qq:${normalized}`
      : undefined;
  }

  async resumeUserGroupOrchestrators(gateway: MessagingPort) {
    const activation = {
      generation: this.orchestratorGeneration + 1,
      gateway
    };
    this.orchestratorGeneration = activation.generation;
    this.orchestratorActivation = activation;
    try {
      const agentIds = new Set([...this.readiness.keys(), ...this.runtimes.keys()]);
      for (const agentId of agentIds) await this.refreshReadiness(agentId);
      if (this.orchestratorActivation?.generation !== activation.generation) return;
      for (const [agentId, runtime] of this.runtimes) {
        if (this.readiness.get(agentId)?.status !== "not_ready") this.resumeRuntimeIfActive(runtime);
      }
    } catch (error) {
      if (this.orchestratorActivation?.generation === activation.generation) {
        this.clearOrchestratorActivation();
        for (const runtime of this.runtimes.values()) runtime.suspendUserGroupOrchestrators();
      }
      throw error;
    }
  }

  suspendUserGroupOrchestrators() {
    this.clearOrchestratorActivation();
    for (const runtime of this.runtimes.values()) runtime.suspendUserGroupOrchestrators();
  }

  async close() {
    if (this.closeOperation) return this.closeOperation;
    this.closed = true;
    this.clearOrchestratorActivation();
    const operation = this.closeAll();
    this.closeOperation = operation;
    try {
      await operation;
    } catch (error) {
      if (this.closeOperation === operation) this.closeOperation = undefined;
      throw error;
    }
  }

  async refreshReadiness(agentId: string) {
    return this.start(agentId);
  }

  decorateAgents(agents: AgentSummary[], gatewayStatus: ReturnType<MessagingPort["getStatus"]>) {
    const connected = new Map((gatewayStatus.accounts ?? []).map((account) => [account.accountId, account]));
    return agents.map((agent) => ({
      ...agent,
      runtime: {
        loaded: this.runtimes.has(agent.id) && this.readiness.get(agent.id)?.status !== "not_ready",
        readiness: this.readiness.get(agent.id) ?? stoppedReadiness(),
        persona: this.readiness.get(agent.id)?.status === "not_ready"
          ? undefined
          : this.runtimes.get(agent.id)?.getPersonaStatus()
      },
      accounts: agent.accounts.map((account) => ({
        ...decorateAccountRuntime(
          agent.enabled,
          account,
          connected.get(account.id),
          this.options.readAccountRuntimeStatus?.(account.id)
        )
      }))
    }));
  }

  private async probeReadiness(agentId: string): Promise<AgentRuntimeReadiness> {
    if (!this.options.probeExtensionReadiness) return readyReadiness();
    try {
      return await this.options.probeExtensionReadiness(agentId);
    } catch {
      return {
        status: "not_ready",
        code: "AGENT_EXTENSION_READINESS_UNAVAILABLE",
        requiredMcpServers: [],
        degradedMcpServers: []
      };
    }
  }

  private runAgentOperation<T>(agentId: string, operation: () => Promise<T>) {
    const previous = this.agentOperations.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.agentOperations.set(agentId, current);
    void current.then(() => undefined, () => undefined).then(() => {
      if (this.agentOperations.get(agentId) === current) this.agentOperations.delete(agentId);
    });
    return current;
  }

  private resumeRuntimeIfActive(runtime: TRuntime) {
    const activation = this.orchestratorActivation;
    if (!activation || this.runtimeOrchestratorGenerations.get(runtime) === activation.generation) return;
    runtime.resumeUserGroupOrchestrators(activation.gateway);
    this.runtimeOrchestratorGenerations.set(runtime, activation.generation);
  }

  private clearOrchestratorActivation() {
    this.orchestratorGeneration += 1;
    this.orchestratorActivation = undefined;
  }

  private async closeAll() {
    const pendingResults = await Promise.allSettled([...this.agentOperations.values()]);
    const entries = [...this.runtimes.entries()];
    const closeResults = await Promise.allSettled(entries.map(async ([, runtime]) => runtime.close()));
    for (let index = 0; index < entries.length; index += 1) {
      if (closeResults[index]?.status === "fulfilled") this.runtimes.delete(entries[index]![0]);
    }
    if (this.runtimes.size === 0) this.readiness.clear();
    this.agentOperations.clear();
    const failure = [...pendingResults, ...closeResults]
      .find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

function readyReadiness(): AgentRuntimeReadiness {
  return { status: "ready", code: null, requiredMcpServers: [], degradedMcpServers: [] };
}

function stoppedReadiness(): AgentRuntimeReadiness {
  return {
    status: "not_ready",
    code: "AGENT_RUNTIME_STOPPED",
    requiredMcpServers: [],
    degradedMcpServers: []
  };
}

function decorateAccountRuntime(
  agentEnabled: boolean,
  account: AgentSummary["accounts"][number],
  connection: { accountId: string; selfId?: string; connectedAt: string } | undefined,
  state: AccountRuntimeStatusSnapshot | undefined
) {
  const connected = Boolean(connection);
  const desiredState = account.enabled && agentEnabled ? "running" : "stopped";
  const observedState = connected ? "running" : state?.observedState ?? (
    state?.configured ? "unknown" : "missing"
  );
  return {
    ...account,
    connected,
    selfId: connection?.selfId,
    desiredState,
    observedState,
    reconcileRequired: state?.reconcileRequired === true || (
      desiredState === "running" ? observedState === "missing" || observedState === "stopped" : observedState === "running"
    ),
    lastError: state?.lastError ?? null,
    runtimeReady: connected || observedState === "running"
  };
}
