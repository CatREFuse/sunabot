import type { FastifyInstance } from "fastify";
import {
  SelfieReferenceRepository,
  type SelfieReferenceEnvelope,
  type SelfieReferenceImage,
  type SelfieReferenceVariant
} from "../../../src/admin/selfieReferences.js";
import { badRequest } from "../../../src/admin/errors.js";
import type { AgentWorkbenchBackend } from "../../../packages/platform/agentResourceLayout.js";
import { requestAgentId } from "../requestAgentId.js";

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const referenceParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
  additionalProperties: false
} as const;

export interface SelfieReferenceRouteOptions {
  repository: SelfieReferenceRepository;
  getRepository?: (agentId: string, backend: AgentWorkbenchBackend) => SelfieReferenceRepository;
}

export function registerSelfieReferenceRoutes(app: FastifyInstance, options: SelfieReferenceRouteOptions) {
  app.get("/api/selfie-references", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    if (requestWorkbenchScope(request.query) === "all") {
      const agentId = requestAgentId(request.query);
      if (!options.getRepository) {
        badRequest("WORKBENCH_BACKEND_UNAVAILABLE", "当前接口未配置双 Workbench。", "workbench");
      }
      const [native, docker] = await Promise.all([
        options.getRepository(agentId, "native").list(),
        options.getRepository(agentId, "docker").list()
      ]);
      return {
        maxImages: Math.max(native.maxImages, docker.maxImages),
        images: [
          ...native.images.map((image) => ({
            ...publicImage(image, agentId, "native"),
            workbench: "native" as const
          })),
          ...docker.images.map((image) => ({
            ...publicImage(image, agentId, "docker"),
            workbench: "docker" as const
          }))
        ]
      };
    }
    const context = repositoryContext(options, request.query);
    return withContentUrls(await context.repository.list(), context.agentId, context.backend);
  });

  app.post("/api/selfie-references", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { querystring: openObject, body: passthroughBody, response: { 201: openObject } }
  }, async (request, reply) => {
    const context = repositoryContext(options, request.query);
    const envelope = await context.repository.create(request.body);
    return reply.status(201).send(withContentUrls(envelope, context.agentId, context.backend));
  });

  app.patch("/api/selfie-references/:id", {
    schema: { params: referenceParams, querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    const context = repositoryContext(options, request.query);
    const envelope = await context.repository.updateNote(String(params.id ?? ""), request.body);
    return withContentUrls(envelope, context.agentId, context.backend);
  });

  app.get("/api/selfie-references/:id/content", {
    schema: { params: referenceParams, querystring: openObject, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const params = request.params as { id?: string };
    const query = request.query as { variant?: string; agentId?: string };
    const context = repositoryContext(options, query);
    const variant = parseVariant(query.variant);
    const content = await context.repository.content(String(params.id ?? ""), variant);
    reply.header("content-type", content.contentType);
    reply.header("cache-control", "private, max-age=604800, immutable");
    reply.header("vary", "Authorization");
    reply.header("x-content-type-options", "nosniff");
    return content.bytes;
  });

  app.delete("/api/selfie-references/:id", {
    schema: { params: referenceParams, querystring: openObject, response: { 204: { type: "null" } } }
  }, async (request, reply) => {
    const params = request.params as { id?: string };
    const context = repositoryContext(options, request.query);
    await context.repository.remove(String(params.id ?? ""));
    return reply.status(204).send();
  });
}

function repositoryContext(options: SelfieReferenceRouteOptions, query: unknown) {
  const backend = requestWorkbenchBackend(query);
  if (!options.getRepository) {
    if (backend === "docker") {
      badRequest("WORKBENCH_BACKEND_UNAVAILABLE", "当前接口未配置 Docker Workbench。", "workbench");
    }
    return { repository: options.repository, backend };
  }
  const agentId = requestAgentId(query);
  return { agentId, backend, repository: options.getRepository(agentId, backend) };
}

function withContentUrls(
  envelope: SelfieReferenceEnvelope,
  agentId: string | undefined,
  backend: AgentWorkbenchBackend
) {
  return {
    maxImages: envelope.maxImages,
    images: envelope.images.map((image) => publicImage(image, agentId, backend))
  };
}

function publicImage(
  image: SelfieReferenceImage,
  agentId: string | undefined,
  backend: AgentWorkbenchBackend
) {
  const base = `/api/selfie-references/${encodeURIComponent(image.id)}/content`;
  const scope = agentId ? `&agentId=${encodeURIComponent(agentId)}` : "";
  const workbench = backend === "docker" ? "&workbench=docker" : "";
  return {
    ...image,
    originalUrl: `${base}?variant=original${scope}${workbench}`,
    displayUrl: `${base}?variant=display${scope}${workbench}`,
    placeholderUrl: `${base}?variant=placeholder${scope}${workbench}`
  };
}

function requestWorkbenchBackend(query: unknown): AgentWorkbenchBackend {
  const value = query && typeof query === "object" && !Array.isArray(query)
    ? (query as { workbench?: unknown }).workbench
    : undefined;
  if (value === undefined || value === "" || value === "native") return "native";
  if (value === "docker") return "docker";
  badRequest("WORKBENCH_BACKEND_INVALID", "Workbench 参数无效。", "workbench");
}

function requestWorkbenchScope(query: unknown): AgentWorkbenchBackend | "all" {
  const value = query && typeof query === "object" && !Array.isArray(query)
    ? (query as { workbench?: unknown }).workbench
    : undefined;
  return value === "all" ? "all" : requestWorkbenchBackend(query);
}

function parseVariant(value: string | undefined): SelfieReferenceVariant {
  if (value === "original" || value === "display" || value === "placeholder") return value;
  badRequest("SELFIE_REFERENCE_VARIANT_INVALID", "自拍参考图尺寸无效。", "variant");
}
