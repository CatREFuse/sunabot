import type { FastifyInstance } from "fastify";
import {
  SelfieReferenceRepository,
  type SelfieReferenceEnvelope,
  type SelfieReferenceImage,
  type SelfieReferenceVariant
} from "../../../src/admin/selfieReferences.js";
import { badRequest } from "../../../src/admin/errors.js";
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
  getRepository?: (agentId: string) => SelfieReferenceRepository;
}

export function registerSelfieReferenceRoutes(app: FastifyInstance, options: SelfieReferenceRouteOptions) {
  app.get("/api/selfie-references", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const context = repositoryContext(options, request.query);
    return withContentUrls(await context.repository.list(), context.agentId);
  });

  app.post("/api/selfie-references", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { querystring: openObject, body: passthroughBody, response: { 201: openObject } }
  }, async (request, reply) => {
    const context = repositoryContext(options, request.query);
    const envelope = await context.repository.create(request.body);
    return reply.status(201).send(withContentUrls(envelope, context.agentId));
  });

  app.patch("/api/selfie-references/:id", {
    schema: { params: referenceParams, querystring: openObject, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    const context = repositoryContext(options, request.query);
    const envelope = await context.repository.updateNote(String(params.id ?? ""), request.body);
    return withContentUrls(envelope, context.agentId);
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
  rejectRetiredWorkbenchQuery(query);
  if (!options.getRepository) return { repository: options.repository, agentId: undefined };
  const agentId = requestAgentId(query);
  return { agentId, repository: options.getRepository(agentId) };
}

function rejectRetiredWorkbenchQuery(query: unknown) {
  if (query && typeof query === "object" && !Array.isArray(query) && "workbench" in query) {
    badRequest("WORKBENCH_SOURCE_RETIRED", "Workbench 来源参数已停用。", "workbench");
  }
}

function withContentUrls(
  envelope: SelfieReferenceEnvelope,
  agentId: string | undefined
) {
  return {
    maxImages: envelope.maxImages,
    images: envelope.images.map((image) => publicImage(image, agentId))
  };
}

function publicImage(
  image: SelfieReferenceImage,
  agentId: string | undefined
) {
  const base = `/api/selfie-references/${encodeURIComponent(image.id)}/content`;
  const scope = agentId ? `&agentId=${encodeURIComponent(agentId)}` : "";
  return {
    ...image,
    originalUrl: `${base}?variant=original${scope}`,
    displayUrl: `${base}?variant=display${scope}`,
    placeholderUrl: `${base}?variant=placeholder${scope}`
  };
}

function parseVariant(value: string | undefined): SelfieReferenceVariant {
  if (value === "original" || value === "display" || value === "placeholder") return value;
  badRequest("SELFIE_REFERENCE_VARIANT_INVALID", "自拍参考图尺寸无效。", "variant");
}
