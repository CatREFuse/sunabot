import type { FastifyInstance } from "fastify";
import type {
  KnowledgeBaseService,
  KnowledgeSearchInput,
  KnowledgeUploadInput
} from "../../../services/knowledge/public.js";

type KnowledgeRouteService = Pick<
  KnowledgeBaseService,
  "list" | "reindex" | "search" | "uploadMarkdown" | "deleteDocument"
>;

export interface KnowledgeRouteOptions {
  getService(agentId: string): KnowledgeRouteService;
}

const openObject = { type: "object", additionalProperties: true } as const;
const agentQuery = {
  type: "object",
  additionalProperties: false,
  properties: { agentId: { type: "string", minLength: 1, maxLength: 32 } }
} as const;
const searchQuery = {
  type: "object",
  additionalProperties: false,
  required: ["q"],
  properties: {
    agentId: { type: "string", minLength: 1, maxLength: 32 },
    q: { type: "string", minLength: 1, maxLength: 1_000 },
    limit: { type: "integer", minimum: 1, maximum: 20 }
  }
} as const;
const uploadBody = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 512 },
    content: { type: "string", minLength: 1, maxLength: 8 * 1024 * 1024 }
  }
} as const;
const deleteBody = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: { type: "string", minLength: 1, maxLength: 512 } }
} as const;

export function registerKnowledgeRoutes(app: FastifyInstance, options: KnowledgeRouteOptions) {
  const serviceFor = (request: { query: unknown }) => options.getService(requestAgentId(request.query));

  app.get("/api/knowledge", {
    schema: { querystring: agentQuery, response: { 200: openObject } }
  }, async (request) => serviceFor(request).list());

  app.get("/api/knowledge/search", {
    schema: { querystring: searchQuery, response: { 200: openObject } }
  }, async (request) => {
    const query = request.query as { q?: string; limit?: number };
    return serviceFor(request).search({ query: query.q, limit: query.limit } satisfies KnowledgeSearchInput);
  });

  app.post("/api/knowledge/reindex", {
    schema: { querystring: agentQuery, response: { 200: openObject } }
  }, async (request) => serviceFor(request).reindex());

  app.post("/api/knowledge/documents", {
    schema: { querystring: agentQuery, body: uploadBody, response: { 201: openObject } }
  }, async (request, reply) => reply.status(201).send(
    await serviceFor(request).uploadMarkdown(request.body as KnowledgeUploadInput)
  ));

  app.delete("/api/knowledge/documents", {
    schema: { querystring: agentQuery, body: deleteBody, response: { 200: openObject } }
  }, async (request) => {
    const body = request.body as { path?: string };
    return serviceFor(request).deleteDocument(body.path);
  });
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
}
