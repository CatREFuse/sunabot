import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import type { AgentMcpServerIndex } from "../../packages/contracts/extensions/agentExtensions.js";
import {
  AgentMcpHost,
  type McpToolApprovalTransactions
} from "../../services/extensions/public.js";

export interface McpRuntimeAdminRepository {
  ensureLayout(agentId: string): Promise<void>;
  readMcpServerIndex(agentId: string): Promise<AgentMcpServerIndex>;
}

export interface AgentExtensionReadinessResult {
  status: "ready" | "degraded" | "not_ready";
  code: "AGENT_REQUIRED_MCP_UNAVAILABLE" | "AGENT_OPTIONAL_MCP_DEGRADED" | null;
  requiredMcpServers: string[];
  degradedMcpServers: string[];
}

export class McpRuntimeService {
  constructor(
    private readonly repository: McpRuntimeAdminRepository,
    private readonly host: AgentMcpHost,
    private readonly agentExists: (agentId: string) => boolean | Promise<boolean>,
    private readonly approvals?: McpToolApprovalTransactions
  ) {}

  setReadinessInvalidationHandler(handler: (agentId: string) => void | Promise<void>) {
    this.host.setReadinessInvalidationHandler(handler);
  }

  async catalog(input: { agentId: string; serverId: string }) {
    await this.ready(input.agentId);
    return this.call(() => this.host.catalog(input.agentId, input.serverId));
  }

  async status(agentId: string) {
    await this.ready(agentId, false);
    return { servers: this.host.status(agentId) };
  }

  async readiness(agentId: string): Promise<AgentExtensionReadinessResult> {
    await this.assertAgent(agentId);
    await this.repository.ensureLayout(agentId);
    const index = await this.repository.readMcpServerIndex(agentId);
    const reconciliation = await this.host.reconcileAgent(agentId, index.servers);
    const runtimeStatus = this.host.status(agentId);
    const required = new Set(reconciliation.requiredFailures);
    const degraded = runtimeStatus
      .filter((server) => server.status !== "ready" || server.toolCatalogStatus !== "ready")
      .map((server) => server.serverId)
      .filter((serverId) => !required.has(serverId))
      .sort();
    if (required.size) {
      return {
        status: "not_ready",
        code: "AGENT_REQUIRED_MCP_UNAVAILABLE",
        requiredMcpServers: [...required].sort(),
        degradedMcpServers: degraded
      };
    }
    if (degraded.length) {
      return {
        status: "degraded",
        code: "AGENT_OPTIONAL_MCP_DEGRADED",
        requiredMcpServers: [],
        degradedMcpServers: degraded
      };
    }
    return {
      status: "ready",
      code: null,
      requiredMcpServers: [],
      degradedMcpServers: []
    };
  }

  async callTool(input: {
    agentId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }) {
    await this.ready(input.agentId);
    const alias = await this.call(() => this.host.toolAlias(input.agentId, input.serverId, input.toolName));
    return this.call(() => this.host.callTool({
      agentId: input.agentId,
      alias,
      arguments: input.arguments,
      approved: true,
      signal: input.signal
    }));
  }

  async pendingApprovals(agentId: string) {
    await this.assertAgent(agentId);
    return { approvals: this.approvals?.list(agentId) ?? [] };
  }

  async approveTool(input: { agentId: string; ticketId: string }) {
    await this.assertAgent(input.agentId);
    if (!this.approvals) unavailable("MCP_TOOL_APPROVAL_UNAVAILABLE");
    return this.call(() => this.approvals!.approve(input));
  }

  async readResource(input: { agentId: string; serverId: string; uri: string; signal?: AbortSignal }) {
    await this.ready(input.agentId);
    return this.call(() => this.host.readResource(input));
  }

  async subscribeResource(input: { agentId: string; serverId: string; uri: string; signal?: AbortSignal }) {
    await this.ready(input.agentId);
    return this.call(() => this.host.subscribeResource(input));
  }

  async unsubscribeResource(input: { agentId: string; serverId: string; uri: string; signal?: AbortSignal }) {
    await this.ready(input.agentId);
    return this.call(() => this.host.unsubscribeResource(input));
  }

  async getPrompt(input: {
    agentId: string;
    serverId: string;
    name: string;
    arguments: Record<string, string>;
    signal?: AbortSignal;
  }) {
    await this.ready(input.agentId);
    return this.call(() => this.host.getPrompt({ ...input, userExplicit: true }));
  }

  async closeAgent(agentId: string) {
    this.approvals?.clearAgent(agentId);
    await this.host.closeAgent(agentId);
  }

  private async ready(agentId: string, requireRequiredServers = true) {
    await this.assertAgent(agentId);
    await this.repository.ensureLayout(agentId);
    const index = await this.repository.readMcpServerIndex(agentId);
    const reconciliation = await this.host.reconcileAgent(agentId, index.servers);
    if (requireRequiredServers && reconciliation.requiredFailures.length) {
      throw new ServiceError(503, "AGENT_REQUIRED_MCP_UNAVAILABLE", "必需的 MCP 服务不可用。");
    }
  }

  private async assertAgent(agentId: string) {
    if (!await this.agentExists(agentId)) throw new ServiceError(404, "AGENT_NOT_FOUND", "Agent 不存在。");
  }

  private async call<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const code = stableMcpCode(error);
      throw new ServiceError(
        code === "MCP_TOOL_APPROVAL_NOT_FOUND" ? 404 : code.endsWith("UNAVAILABLE") ? 503 : 400,
        code,
        "MCP 请求失败。"
      );
    }
  }
}

function stableMcpCode(error: unknown) {
  const value = error instanceof Error ? error.message : "";
  return /^MCP_[A-Z0-9_]+$/u.test(value) ? value : "MCP_REQUEST_FAILED";
}

function unavailable(code: string): never {
  throw new ServiceError(404, code, "MCP 工具不可用。");
}
