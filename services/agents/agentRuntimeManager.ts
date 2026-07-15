import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  InboundMessageV1,
  MessagingConnectionContextV1,
  MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../src/config.js";
import type { SunaRuntime } from "../../src/runtime.js";
import type { AppConfig } from "../../src/types.js";
import type { BroadcastStormDetector } from "../orchestration/public.js";
import type { AgentRegistry, AgentSummary } from "./agentRegistry.js";

export interface AgentRuntimeManagerOptions {
  defaultRuntime: SunaRuntime;
  createRuntime: (config: AppConfig) => SunaRuntime;
  initializeRuntime: boolean;
  broadcastStormDetector: BroadcastStormDetector;
}

export class AgentRuntimeManager {
  private readonly runtimes = new Map<string, SunaRuntime>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly options: AgentRuntimeManagerOptions
  ) {}

  async initialize() {
    const defaultId = this.options.defaultRuntime.config.persona.defaultAgentId;
    this.runtimes.set(defaultId, this.options.defaultRuntime);
    const agents = await this.registry.list();
    for (const agent of agents) {
      if (!agent.enabled || agent.id === defaultId) continue;
      await this.start(agent.id);
    }
  }

  async start(agentId: string) {
    const existing = this.runtimes.get(agentId);
    if (existing) return existing;
    const config = await this.registry.config(agentId);
    const runtime = this.options.createRuntime(config);
    try {
      if (this.options.initializeRuntime) await runtime.initialize();
      this.runtimes.set(agentId, runtime);
      return runtime;
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  async stop(agentId: string) {
    const runtime = this.runtimes.get(agentId);
    if (!runtime || runtime === this.options.defaultRuntime) return;
    runtime.close();
    this.runtimes.delete(agentId);
  }

  get(agentId: string) {
    return this.runtimes.get(agentId);
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

  resumeUserGroupOrchestrators(gateway: MessagingPort) {
    for (const runtime of this.runtimes.values()) runtime.resumeUserGroupOrchestrators(gateway);
  }

  suspendUserGroupOrchestrators() {
    for (const runtime of this.runtimes.values()) runtime.suspendUserGroupOrchestrators();
  }

  async close() {
    for (const runtime of this.runtimes.values()) runtime.close();
    this.runtimes.clear();
  }

  decorateAgents(agents: AgentSummary[], gatewayStatus: ReturnType<MessagingPort["getStatus"]>) {
    const connected = new Map((gatewayStatus.accounts ?? []).map((account) => [account.accountId, account]));
    return agents.map((agent) => ({
      ...agent,
      runtime: {
        loaded: this.runtimes.has(agent.id),
        persona: this.runtimes.get(agent.id)?.getPersonaStatus()
      },
      accounts: agent.accounts.map((account) => ({
        ...decorateAccountRuntime(agent.enabled, account, connected.get(account.id))
      }))
    }));
  }
}

function decorateAccountRuntime(
  agentEnabled: boolean,
  account: AgentSummary["accounts"][number],
  connection: { accountId: string; selfId?: string; connectedAt: string } | undefined
) {
  const accountRoot = getWorkspacePath(WORKSPACE_LAYOUT.napcatAccounts, account.id);
  const state = readAccountRuntimeState(path.join(accountRoot, "runtime-state.json"));
  const connected = Boolean(connection);
  const desiredState = account.enabled && agentEnabled ? "running" : "stopped";
  const observedState = connected ? "running" : state?.observedState ?? (
    existsSync(path.join(accountRoot, "config-full", "webui.json")) ? "unknown" : "missing"
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

function readAccountRuntimeState(filePath: string): {
  observedState?: "running" | "stopped" | "missing" | "unknown";
  reconcileRequired?: boolean;
  lastError?: string | null;
} | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    return value?.schemaVersion === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}
