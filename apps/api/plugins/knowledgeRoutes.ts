import type { FastifyInstance } from "fastify";
import type {
  KnowledgeBaseService,
  KnowledgeSearchInput,
  KnowledgeUploadInput
} from "../../../services/knowledge/public.js";
import { badRequest } from "../../../src/admin/errors.js";
import { requestAgentId } from "../requestAgentId.js";

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
  required: ["agentId"],
  additionalProperties: false,
  properties: {
    agentId: { type: "string", minLength: 1, maxLength: 32 },
    workbench: { type: "string" }
  }
} as const;
const searchQuery = {
  type: "object",
  additionalProperties: false,
  required: ["q"],
  properties: {
    agentId: { type: "string", minLength: 1, maxLength: 32 },
    workbench: { type: "string" },
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
  const serviceFor = (request: { query: unknown }) => {
    rejectRetiredWorkbenchQuery(request.query);
    return options.getService(requestAgentId(request.query));
  };

  app.get("/api/knowledge", {
    schema: { querystring: agentQuery, response: { 200: openObject } }
  }, async (request) => serviceFor(request).list());

  app.get("/api/knowledge/search", {
    schema: { querystring: searchQuery, response: { 200: openObject } }
  }, async (request) => {
    const query = request.query as { q?: string; limit?: number };
    const input = { query: query.q, limit: query.limit } satisfies KnowledgeSearchInput;
    return serviceFor(request).search(input);
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

function rejectRetiredWorkbenchQuery(query: unknown) {
  if (query && typeof query === "object" && !Array.isArray(query) && "workbench" in query) {
    badRequest("WORKBENCH_SOURCE_RETIRED", "Workbench 来源参数已停用。", "workbench");
  }
}
