import type { FastifyInstance } from "fastify";
import type { AdminAuthService } from "../../src/admin/auth.js";
import type { AgentRegistry } from "../../services/agents/agentRegistry.js";
import {
  buildAgentExtensionComposition,
  type AgentExtensionCompositionOptions,
  type McpRuntimeClientFactory,
  type RuntimeAgentExtensionsPort
} from "./agentExtensionComposition.js";
import { registerAgentExtensionRoutes } from "./plugins/agentExtensionRoutes.js";
import { registerAgentMcpOAuthRoutes } from "./plugins/agentMcpOAuthRoutes.js";
import { registerAgentMcpRuntimeRoutes } from "./plugins/agentMcpRuntimeRoutes.js";

type AgentExtensionComposition = ReturnType<typeof buildAgentExtensionComposition>;

export interface AgentExtensionApiOptions {
  workspaceRoot?: string;
  mcpClientFactory?: McpRuntimeClientFactory;
  runtime?: RuntimeAgentExtensionsPort;
  oauth?: AgentExtensionCompositionOptions["oauth"];
  mcpStdio?: AgentExtensionCompositionOptions["mcpStdio"];
}

export function buildAgentExtensionApiComposition(
  options: AgentExtensionApiOptions | undefined,
  defaultWorkspaceRoot: string,
  agentRegistry: Pick<AgentRegistry, "get">
) {
  return buildAgentExtensionComposition({
    workspaceRoot: options?.workspaceRoot ?? defaultWorkspaceRoot,
    agentExists: async (agentId) => {
      try { await agentRegistry.get(agentId); return true; } catch { return false; }
    },
    mcpClientFactory: options?.mcpClientFactory,
    runtime: options?.runtime,
    oauth: options?.oauth,
    mcpStdio: options?.mcpStdio
  });
}

export function registerAgentExtensionApi(
  app: FastifyInstance,
  agentExtensions: AgentExtensionComposition,
  adminAuth: Pick<AdminAuthService, "authorize" | "authorizationSessionBinding">
) {
  const adminGuard = async (request: Parameters<AdminAuthService["authorize"]>[0]) => adminAuth.authorize(request);
  registerAgentExtensionRoutes(app, {
    service: agentExtensions.service,
    adminGuard,
    onAgentExtensionsChanged: (agentId) => agentExtensions.notifyAgentChanged(agentId)
  });
  registerAgentMcpRuntimeRoutes(app, {
    service: agentExtensions.mcpRuntimeService,
    adminGuard
  });
  registerAgentMcpOAuthRoutes(app, {
    service: agentExtensions.mcpOAuthService,
    adminGuard,
    browserSessionId: (request) => adminAuth.authorizationSessionBinding(request)
  });
}
