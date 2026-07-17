import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { ServiceError } from "../../../packages/contracts/errors/serviceError.js";
import type { McpRuntimeService } from "../../../src/admin/mcpRuntimeService.js";
import { withFastifyRequestSignal } from "./requestAbortSignal.js";

export interface AgentMcpRuntimeRouteOptions {
  service: McpRuntimeService;
  adminGuard: preHandlerHookHandler;
}

const agentId = { type: "string", pattern: "^[a-z][a-z0-9-]{1,31}$", maxLength: 32 } as const;
const extensionId = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 } as const;
const approvalId = { type: "string", pattern: "^mcpa_[A-Za-z0-9_-]{24}$", maxLength: 29 } as const;
const serverTargetProperties = { agentId, serverId: extensionId } as const;
const openResponse = { type: "object", additionalProperties: true } as const;
const approvalTicket = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "agentId", "accountId", "transport", "conversationId", "userId", "serverId", "toolName",
    "snapshotDigest", "catalogGeneration", "argumentsDigest", "arguments", "status", "createdAt", "expiresAt"
  ],
  properties: {
    id: approvalId,
    agentId,
    accountId: { type: "string", minLength: 1, maxLength: 128 },
    transport: { type: "string", enum: ["onebot", "web"] },
    conversationId: { type: "string", minLength: 1, maxLength: 256 },
    userId: { type: "integer", minimum: 1 },
    serverId: extensionId,
    toolName: { type: "string", minLength: 1, maxLength: 256 },
    snapshotDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    catalogGeneration: { type: "integer", minimum: 1 },
    argumentsDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    arguments: {},
    status: { type: "string", enum: ["pending", "approved"] },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" }
  }
} as const;
const approvalListResponse = {
  type: "object",
  additionalProperties: false,
  required: ["approvals"],
  properties: { approvals: { type: "array", maxItems: 256, items: approvalTicket } }
} as const;
const serverTarget = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "serverId"],
  properties: serverTargetProperties
} as const;
const resourceBody = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "serverId", "uri"],
  properties: {
    ...serverTargetProperties,
    uri: { type: "string", minLength: 1, maxLength: 8_192 }
  }
} as const;

export function registerAgentMcpRuntimeRoutes(app: FastifyInstance, options: AgentMcpRuntimeRouteOptions) {
  const guarded = { preHandler: options.adminGuard };
  app.get("/api/agent-extensions/mcp/runtime/status", {
    ...guarded,
    preValidation: strictRequestObject("query", ["agentId"]),
    schema: {
      querystring: {
        type: "object", additionalProperties: false, required: ["agentId"], properties: { agentId }
      },
      response: { 200: openResponse }
    }
  }, async (request) => options.service.status((request.query as { agentId: string }).agentId));

  app.get("/api/agent-extensions/mcp/runtime/catalog", {
    ...guarded,
    preValidation: strictRequestObject("query", ["agentId", "serverId"]),
    schema: { querystring: serverTarget, response: { 200: openResponse } }
  }, async (request) => {
    const target = request.query as { agentId: string; serverId: string };
    return options.service.catalog(target);
  });

  app.get("/api/agent-extensions/mcp/runtime/approvals", {
    ...guarded,
    preValidation: strictRequestObject("query", ["agentId"]),
    schema: {
      querystring: {
        type: "object", additionalProperties: false, required: ["agentId"], properties: { agentId }
      },
      response: { 200: approvalListResponse }
    }
  }, async (request) => options.service.pendingApprovals((request.query as { agentId: string }).agentId));

  app.post("/api/agent-extensions/mcp/runtime/approvals/approve", {
    ...guarded,
    preValidation: strictRequestObject("body", ["agentId", "ticketId"]),
    schema: {
      body: {
        type: "object", additionalProperties: false, required: ["agentId", "ticketId"],
        properties: { agentId, ticketId: approvalId }
      },
      response: { 200: openResponse }
    }
  }, async (request) => options.service.approveTool(
    request.body as { agentId: string; ticketId: string }
  ));

  app.post("/api/agent-extensions/mcp/runtime/tools/call", {
    ...guarded,
    preValidation: strictRequestObject("body", ["agentId", "serverId", "toolName", "arguments"]),
    bodyLimit: 1024 * 1024,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "serverId", "toolName", "arguments"],
        properties: {
          ...serverTargetProperties,
          toolName: { type: "string", minLength: 1, maxLength: 128 },
          arguments: { type: "object", maxProperties: 256, additionalProperties: true }
        }
      },
      response: { 200: openResponse }
    }
  }, async (request, reply) => withFastifyRequestSignal(request, reply, "MCP_REQUEST_ABORTED", (signal) => options.service.callTool({
    ...(request.body as {
      agentId: string;
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }),
    signal
  })));

  resourceRoute(app, options, "read", (body, signal) => options.service.readResource({ ...body, signal }));
  resourceRoute(app, options, "subscribe", (body, signal) => options.service.subscribeResource({ ...body, signal }));
  resourceRoute(app, options, "unsubscribe", (body, signal) => options.service.unsubscribeResource({ ...body, signal }));

  app.post("/api/agent-extensions/mcp/runtime/prompts/get", {
    ...guarded,
    preValidation: strictRequestObject("body", ["agentId", "serverId", "name", "arguments"]),
    bodyLimit: 256 * 1024,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "serverId", "name", "arguments"],
        properties: {
          ...serverTargetProperties,
          name: { type: "string", minLength: 1, maxLength: 128 },
          arguments: {
            type: "object",
            maxProperties: 64,
            propertyNames: { maxLength: 128 },
            additionalProperties: { type: "string", maxLength: 8_192 }
          }
        }
      },
      response: { 200: openResponse }
    }
  }, async (request, reply) => withFastifyRequestSignal(request, reply, "MCP_REQUEST_ABORTED", (signal) => options.service.getPrompt({
    ...(request.body as {
      agentId: string;
      serverId: string;
      name: string;
      arguments: Record<string, string>;
    }),
    signal
  })));
}

function resourceRoute(
  app: FastifyInstance,
  options: AgentMcpRuntimeRouteOptions,
  operation: "read" | "subscribe" | "unsubscribe",
  run: (body: { agentId: string; serverId: string; uri: string }, signal: AbortSignal) => Promise<unknown>
) {
  app.post(`/api/agent-extensions/mcp/runtime/resources/${operation}`, {
    preHandler: options.adminGuard,
    preValidation: strictRequestObject("body", ["agentId", "serverId", "uri"]),
    bodyLimit: 64 * 1024,
    schema: { body: resourceBody, response: { 200: openResponse } }
  }, async (request, reply) => withFastifyRequestSignal(request, reply, "MCP_REQUEST_ABORTED", (signal) => run(
    request.body as { agentId: string; serverId: string; uri: string },
    signal
  )));
}

function strictRequestObject(location: "body" | "query", allowed: string[]) {
  return async (request: { body: unknown; query: unknown }) => {
    const value = request[location];
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))) {
      throw new ServiceError(400, "MCP_RUNTIME_REQUEST_INVALID", "请求字段无效。");
    }
  };
}
