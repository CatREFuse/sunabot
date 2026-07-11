import type { FastifyInstance } from "fastify";
import type { AgentFileRepository } from "../../../src/admin/agentFiles.js";
import { defaultTools } from "../../../services/tools/tools.js";

export interface AgentToolRouteOptions {
  agentFiles: AgentFileRepository;
}

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const agentFileParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
  additionalProperties: true
} as const;

export function registerAgentToolRoutes(app: FastifyInstance, options: AgentToolRouteOptions) {
  app.get("/api/agent-files", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.agentFiles.list());

  app.get("/api/agent-files/:id", {
    schema: { params: agentFileParams, querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    return options.agentFiles.get(String(params.id ?? ""));
  });

  app.put("/api/agent-files/:id", {
    schema: { params: agentFileParams, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    return options.agentFiles.put(String(params.id ?? ""), request.body);
  });

  app.get("/api/tools", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => ({ tools: defaultTools }));
}
