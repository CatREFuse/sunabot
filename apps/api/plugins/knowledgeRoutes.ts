import type { FastifyInstance } from "fastify";
import type {
  KnowledgeBaseService,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  KnowledgeSearchInput,
  KnowledgeUploadInput
} from "../../../services/knowledge/public.js";
import { requestAgentId } from "../requestAgentId.js";
import type { AgentWorkbenchBackend } from "../../../packages/platform/agentResourceLayout.js";

type KnowledgeRouteService = Pick<
  KnowledgeBaseService,
  "list" | "reindex" | "search" | "uploadMarkdown" | "deleteDocument"
>;

export interface KnowledgeRouteOptions {
  getService(agentId: string, backend: AgentWorkbenchBackend): KnowledgeRouteService;
}

const openObject = { type: "object", additionalProperties: true } as const;
const agentQuery = {
  type: "object",
  required: ["agentId"],
  additionalProperties: false,
  properties: {
    agentId: { type: "string", minLength: 1, maxLength: 32 },
    workbench: { type: "string", enum: ["native", "docker", "all"] }
  }
} as const;
const mutationAgentQuery = {
  ...agentQuery,
  properties: {
    ...agentQuery.properties,
    workbench: { type: "string", enum: ["native", "docker"] }
  }
} as const;
const searchQuery = {
  type: "object",
  additionalProperties: false,
  required: ["q"],
  properties: {
    agentId: { type: "string", minLength: 1, maxLength: 32 },
    workbench: { type: "string", enum: ["native", "docker", "all"] },
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
  const serviceFor = (request: { query: unknown }) => options.getService(
    requestAgentId(request.query),
    requestWorkbenchBackend(request.query)
  );
  const servicesForRead = (query: unknown) => {
    const agentId = requestAgentId(query);
    const scope = requestWorkbenchScope(query);
    return scope === "all"
      ? (["native", "docker"] as const).map((backend) => ({ backend, service: options.getService(agentId, backend) }))
      : [{ backend: scope, service: options.getService(agentId, scope) }];
  };

  app.get("/api/knowledge", {
    schema: { querystring: agentQuery, response: { 200: openObject } }
  }, async (request) => {
    const sources = servicesForRead(request.query);
    const snapshots = await Promise.all(sources.map(async ({ backend, service }) => ({
      backend,
      snapshot: await service.list()
    })));
    return mergeKnowledgeSnapshots(snapshots);
  });

  app.get("/api/knowledge/search", {
    schema: { querystring: searchQuery, response: { 200: openObject } }
  }, async (request) => {
    const query = request.query as { q?: string; limit?: number };
    const input = { query: query.q, limit: query.limit } satisfies KnowledgeSearchInput;
    const sources = servicesForRead(request.query);
    const results = await Promise.all(sources.map(async ({ backend, service }) => ({
      backend,
      result: await service.search(input)
    })));
    return mergeKnowledgeSearchResults(results, query.limit);
  });

  app.post("/api/knowledge/reindex", {
    schema: { querystring: agentQuery, response: { 200: openObject } }
  }, async (request) => {
    const sources = servicesForRead(request.query);
    const snapshots = await Promise.all(sources.map(async ({ backend, service }) => ({
      backend,
      snapshot: await service.reindex()
    })));
    return mergeKnowledgeSnapshots(snapshots);
  });

  app.post("/api/knowledge/documents", {
    schema: { querystring: mutationAgentQuery, body: uploadBody, response: { 201: openObject } }
  }, async (request, reply) => reply.status(201).send(
    await serviceFor(request).uploadMarkdown(request.body as KnowledgeUploadInput)
  ));

  app.delete("/api/knowledge/documents", {
    schema: { querystring: mutationAgentQuery, body: deleteBody, response: { 200: openObject } }
  }, async (request) => {
    const body = request.body as { path?: string };
    return serviceFor(request).deleteDocument(body.path);
  });
}

function requestWorkbenchBackend(query: unknown): AgentWorkbenchBackend {
  const value = query && typeof query === "object" && !Array.isArray(query)
    ? (query as { workbench?: unknown }).workbench
    : undefined;
  return value === "docker" ? "docker" : "native";
}

function requestWorkbenchScope(query: unknown): AgentWorkbenchBackend | "all" {
  const value = query && typeof query === "object" && !Array.isArray(query)
    ? (query as { workbench?: unknown }).workbench
    : undefined;
  return value === "all" ? "all" : requestWorkbenchBackend(query);
}

function mergeKnowledgeSnapshots(
  sources: Array<{ backend: AgentWorkbenchBackend; snapshot: KnowledgeSnapshot }>
) {
  const indexedAt = sources.map(({ snapshot }) => snapshot.indexedAt).sort().at(-1) ?? "";
  const documents = sources.flatMap(({ backend, snapshot }) => (
    snapshot.documents.map((document) => ({ ...document, workbench: backend }))
  ));
  return {
    ok: true as const,
    root: "knowledge" as const,
    documents,
    fileCount: documents.length,
    chunkCount: sources.reduce((sum, { snapshot }) => sum + snapshot.chunkCount, 0),
    errorCount: sources.reduce((sum, { snapshot }) => sum + snapshot.errorCount, 0),
    indexedAt
  };
}

function mergeKnowledgeSearchResults(
  sources: Array<{ backend: AgentWorkbenchBackend; result: KnowledgeSearchResult }>,
  limit: number | undefined
) {
  const matches = sources
    .flatMap(({ backend, result }) => result.matches.map((match) => ({ ...match, workbench: backend })))
    .sort((left, right) => right.score - left.score
      || left.workbench.localeCompare(right.workbench)
      || left.path.localeCompare(right.path)
      || left.ordinal - right.ordinal)
    .slice(0, limit ?? 12);
  const firstError = sources.find(({ result }) => !result.ok)?.result.error;
  return {
    ok: sources.every(({ result }) => result.ok),
    query: sources[0]?.result.query ?? "",
    matches,
    indexedAt: sources.map(({ result }) => result.indexedAt).filter(Boolean).sort().at(-1),
    ...(firstError ? { error: firstError } : {})
  };
}
