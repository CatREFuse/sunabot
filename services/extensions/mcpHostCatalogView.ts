import type { AgentMcpServerDescriptor } from "../../packages/contracts/extensions/agentExtensions.js";
import type { McpCatalogSnapshot } from "./mcpCatalogSnapshot.js";
import {
  buildMcpProviderToolCatalog,
  isMcpProviderToolAlias,
  type McpToolAliasDigest
} from "./mcpToolCatalog.js";

interface McpHostCatalogState {
  descriptor: AgentMcpServerDescriptor;
  client: {
    capabilities: {
      resources?: boolean;
      prompts?: boolean;
    };
    instructions?: string;
  };
  snapshot: McpCatalogSnapshot | null;
  catalogGeneration: number;
  status: "ready" | "degraded";
}

interface McpHostCatalogFailure {
  descriptor: AgentMcpServerDescriptor;
  errorCode: string;
}

export class McpHostCatalogView<
  TState extends McpHostCatalogState,
  TFailure extends McpHostCatalogFailure
> {
  constructor(
    private readonly states: ReadonlyMap<string, TState>,
    private readonly starts: ReadonlyMap<string, unknown>,
    private readonly failures: ReadonlyMap<string, TFailure>,
    private readonly aliasDigest: McpToolAliasDigest | undefined,
    private readonly serverKey: (agentId: string, serverId: string) => string
  ) {}

  stateEntries(agentId: string) {
    return [...this.states.entries()].filter(([stateKey]) => stateKey.startsWith(`${agentId}\0`));
  }

  failureEntries(agentId: string) {
    return [...this.failures.entries()].filter(([stateKey]) => stateKey.startsWith(`${agentId}\0`));
  }

  buildToolCatalog(agentId: string) {
    const candidates = [];
    for (const [stateKey, state] of this.states) {
      if (!stateKey.startsWith(`${agentId}\0`) || this.starts.has(stateKey) ||
          state.status !== "ready" || !state.snapshot) {
        continue;
      }
      for (const tool of state.snapshot.tools) {
        const name = tool.name;
        if (typeof name !== "string" || !toolAllowed(state.descriptor, name)) continue;
        candidates.push({
          agentId,
          serverId: state.descriptor.id,
          toolName: name,
          snapshotDigest: state.snapshot.digestSha256,
          description: externalMcpDescription(tool.description),
          parameters: tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
            ? tool.inputSchema as Record<string, unknown>
            : { type: "object", additionalProperties: false, properties: {} }
        });
      }
    }
    return buildMcpProviderToolCatalog(candidates, this.aliasDigest);
  }

  toolDefinitions(agentId: string) {
    return this.buildToolCatalog(agentId).definitions;
  }

  toolAlias(agentId: string, serverId: string, toolName: string) {
    const catalog = this.buildToolCatalog(agentId);
    for (const [alias, target] of catalog.aliases) {
      if (target.serverId === serverId && target.toolName === toolName) return alias;
    }
    throw new Error("MCP_TOOL_UNAVAILABLE");
  }

  resolveTool(agentId: string, value: string) {
    if (!isMcpProviderToolAlias(value)) throw new Error("MCP_TOOL_UNAVAILABLE");
    const parsed = this.buildToolCatalog(agentId).aliases.get(value);
    if (!parsed) throw new Error("MCP_TOOL_UNAVAILABLE");
    const stateKey = this.serverKey(agentId, parsed.serverId);
    const state = this.states.get(stateKey);
    if (this.starts.has(stateKey) || !state || state.status !== "ready" ||
        !toolAllowed(state.descriptor, parsed.toolName) ||
        !state.snapshot?.tools.some((tool) => tool.name === parsed.toolName) ||
        state.snapshot.digestSha256 !== parsed.snapshotDigest) {
      throw new Error("MCP_TOOL_UNAVAILABLE");
    }
    return { parsed, state };
  }

  describeToolAlias(agentId: string, value: string) {
    const { parsed, state } = this.resolveTool(agentId, value);
    return {
      ...parsed,
      approvalMode: state.descriptor.approvalMode ?? "always",
      ordinaryUserAllowed: state.descriptor.approvalMode === "never" &&
        credentiallessServer(state.descriptor) &&
        Array.isArray(state.descriptor.enabledTools) && state.descriptor.enabledTools.includes(parsed.toolName) &&
        state.descriptor.ordinaryUserTools?.includes(parsed.toolName) === true &&
        !state.descriptor.disabledTools?.includes(parsed.toolName),
      transport: state.descriptor.transport,
      catalogGeneration: state.catalogGeneration
    };
  }

  requireState(agentId: string, serverId: string, capability: "resources" | "prompts") {
    const stateKey = this.serverKey(agentId, serverId);
    const state = this.states.get(stateKey);
    if (this.starts.has(stateKey) || !state || state.status !== "ready" ||
        state.client.capabilities[capability] !== true) {
      throw new Error("MCP_SERVER_UNAVAILABLE");
    }
    return state;
  }

  status(agentId: string) {
    const toolCatalog = this.buildToolCatalog(agentId);
    const ready = this.stateEntries(agentId).map(([, state]) => ({
      serverId: state.descriptor.id,
      status: state.status,
      toolCatalogStatus: toolCatalog.degradedServerIds.has(state.descriptor.id) ? "degraded" : "ready",
      instructions: state.client.instructions ? externalMcpDescription(state.client.instructions, 512) : undefined
    }));
    const unavailable = this.failureEntries(agentId)
      .filter(([stateKey]) => !this.states.has(stateKey))
      .map(([, failure]) => ({
        serverId: failure.descriptor.id,
        status: "unavailable" as const,
        toolCatalogStatus: "unavailable" as const,
        errorCode: failure.errorCode
      }));
    return [...ready, ...unavailable].sort((left, right) => compareText(left.serverId, right.serverId));
  }

  catalog(agentId: string, serverId: string) {
    const stateKey = this.serverKey(agentId, serverId);
    const state = this.states.get(stateKey);
    if (this.starts.has(stateKey) || !state || state.status !== "ready" || !state.snapshot) {
      throw new Error("MCP_SERVER_UNAVAILABLE");
    }
    return structuredClone(state.snapshot);
  }
}

export function externalMcpDescription(value: unknown, max = 1_024) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim() : "";
  return `[External MCP input] ${text.slice(0, max)}`;
}

function toolAllowed(server: AgentMcpServerDescriptor, toolName: string) {
  const allowed = server.enabledTools;
  if (allowed !== undefined && !allowed.includes(toolName)) return false;
  return !(server.disabledTools ?? []).includes(toolName);
}

function credentiallessServer(server: AgentMcpServerDescriptor) {
  return server.transport === "stdio" ? server.envKeys.length === 0 : server.auth.kind === "none";
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
