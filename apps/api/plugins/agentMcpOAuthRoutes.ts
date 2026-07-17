import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { ServiceError } from "../../../packages/contracts/errors/serviceError.js";
import type { McpOAuthAdminService } from "../../../src/admin/mcpOAuthAdminService.js";
import { withFastifyRequestSignal } from "./requestAbortSignal.js";

export interface AgentMcpOAuthRouteOptions {
  service?: McpOAuthAdminService;
  adminGuard: preHandlerHookHandler;
  browserSessionId(request: FastifyRequest): string;
}

const agentId = { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$", maxLength: 32 } as const;
const extensionId = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 } as const;
const targetProperties = { agentId, serverId: extensionId } as const;
const targetBody = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "serverId"],
  properties: targetProperties
} as const;
const okResponse = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { const: true }, expiresAt: { type: "string" } }
} as const;

export function registerAgentMcpOAuthRoutes(app: FastifyInstance, options: AgentMcpOAuthRouteOptions) {
  const guarded = { preHandler: options.adminGuard };
  app.post("/api/agent-extensions/mcp/oauth/begin", {
    ...guarded,
    preValidation: strictBody([
      "agentId", "serverId", "authorizationEndpoint", "tokenEndpoint", "clientId", "scopes"
    ]),
    bodyLimit: 64 * 1024,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "serverId", "authorizationEndpoint", "tokenEndpoint", "clientId", "scopes"],
        properties: {
          ...targetProperties,
          authorizationEndpoint: { type: "string", minLength: 1, maxLength: 2_048 },
          tokenEndpoint: { type: "string", minLength: 1, maxLength: 2_048 },
          clientId: { type: "string", minLength: 1, maxLength: 256 },
          scopes: {
            type: "array", maxItems: 32, uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 256 }
          }
        }
      },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["authorizationUrl", "authorizationOrigin", "expiresAt"],
          properties: {
            authorizationUrl: { type: "string", minLength: 1, maxLength: 8_192 },
            authorizationOrigin: { type: "string", minLength: 1, maxLength: 2_048 },
            expiresAt: { type: "string" }
          }
        }
      }
    }
  }, async (request, reply) => withFastifyRequestSignal(request, reply, "MCP_OAUTH_REQUEST_ABORTED", (signal) => requireService(options).begin({
    ...(request.body as {
      agentId: string;
      serverId: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      clientId: string;
      scopes: string[];
    }),
    browserSessionId: options.browserSessionId(request),
    signal
  })));

  app.post("/api/agent-extensions/mcp/oauth/refresh", {
    ...guarded,
    preValidation: strictBody(["agentId", "serverId"]),
    schema: { body: targetBody, response: { 200: okResponse } }
  }, async (request, reply) => withFastifyRequestSignal(request, reply, "MCP_OAUTH_REQUEST_ABORTED", (signal) => requireService(options).refresh({
    ...(request.body as { agentId: string; serverId: string }), signal
  })));

  app.post("/api/agent-extensions/mcp/oauth/revoke", {
    ...guarded,
    preValidation: strictBody(["agentId", "serverId"]),
    schema: { body: targetBody, response: { 200: okResponse } }
  }, async (request) => requireService(options).revoke(
    request.body as { agentId: string; serverId: string }
  ));
}

function requireService(options: AgentMcpOAuthRouteOptions) {
  if (!options.service) {
    throw new ServiceError(503, "MCP_OAUTH_UNAVAILABLE", "MCP OAuth 尚未配置。");
  }
  return options.service;
}

function strictBody(allowed: string[]) {
  return async (request: { body: unknown }) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) ||
        Object.keys(request.body).some((key) => !allowed.includes(key))) {
      throw new ServiceError(400, "MCP_OAUTH_REQUEST_INVALID", "请求字段无效。");
    }
  };
}
