import type { FastifyInstance } from "fastify";
import { requestAgentId } from "../requestAgentId.js";

export interface DirectorAdminRuntime {
  listDirectorSchedules(input: { page: number; pageSize: number }): unknown;
}

export interface DirectorRouteOptions {
  runtime: DirectorAdminRuntime;
  getRuntime?: (agentId: string) => DirectorAdminRuntime;
}

const openObject = { type: "object", additionalProperties: true } as const;
const querySchema = {
  type: "object",
  properties: {
    agentId: { type: "string" },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 31 }
  },
  additionalProperties: false
} as const;

export function registerDirectorRoutes(app: FastifyInstance, options: DirectorRouteOptions) {
  app.get("/api/director/schedules", {
    schema: { querystring: querySchema, response: { 200: openObject } }
  }, async (request) => {
    const query = request.query as { page?: number; pageSize?: number };
    const runtime = options.getRuntime?.(requestAgentId(request.query)) ?? options.runtime;
    return runtime.listDirectorSchedules({
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 14
    });
  });
}
