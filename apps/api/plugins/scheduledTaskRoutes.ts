import type { FastifyInstance } from "fastify";

export interface ScheduledTaskAdminRuntime {
  listScheduledTasks(): unknown;
  getScheduledTask(id: string): unknown;
  createScheduledTask(input: unknown): unknown | Promise<unknown>;
  updateScheduledTask(id: string, input: unknown): unknown | Promise<unknown>;
  deleteScheduledTask(id: string, input: unknown): unknown | Promise<unknown>;
}

export interface ScheduledTaskRouteOptions {
  runtime: ScheduledTaskAdminRuntime;
  getRuntime?: (agentId: string) => ScheduledTaskAdminRuntime;
}

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const taskParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 80 } },
  additionalProperties: false
} as const;

export function registerScheduledTaskRoutes(app: FastifyInstance, options: ScheduledTaskRouteOptions) {
  const runtimeFor = (request: { query: unknown }) => (
    options.getRuntime?.(requestAgentId(request.query)) ?? options.runtime
  );

  app.get("/api/scheduled-tasks", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => ({ tasks: await runtimeFor(request).listScheduledTasks() }));

  app.get("/api/scheduled-tasks/:id", {
    schema: { params: taskParams, querystring: openObject, response: { 200: openObject } }
  }, async (request) => ({
    task: await runtimeFor(request).getScheduledTask(taskId(request.params))
  }));

  app.post("/api/scheduled-tasks", {
    schema: { querystring: openObject, body: passthroughBody, response: { 201: openObject } }
  }, async (request, reply) => reply.status(201).send({
    task: await runtimeFor(request).createScheduledTask(request.body)
  }));

  app.put("/api/scheduled-tasks/:id", {
    schema: { params: taskParams, querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => ({
    task: await runtimeFor(request).updateScheduledTask(taskId(request.params), request.body)
  }));

  app.delete("/api/scheduled-tasks/:id", {
    schema: { params: taskParams, querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => ({
    ok: true,
    task: await runtimeFor(request).deleteScheduledTask(taskId(request.params), request.body)
  }));
}

function taskId(params: unknown) {
  const value = params && typeof params === "object" ? (params as { id?: unknown }).id : undefined;
  return String(value ?? "").trim();
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
}
