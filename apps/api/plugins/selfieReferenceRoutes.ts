import type { FastifyInstance } from "fastify";
import {
  SelfieReferenceRepository,
  type SelfieReferenceEnvelope,
  type SelfieReferenceImage,
  type SelfieReferenceVariant
} from "../../../src/admin/selfieReferences.js";
import { badRequest } from "../../../src/admin/errors.js";

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
}

export function registerSelfieReferenceRoutes(app: FastifyInstance, options: SelfieReferenceRouteOptions) {
  app.get("/api/selfie-references", {
    schema: { response: { 200: openObject } }
  }, async () => withContentUrls(await options.repository.list()));

  app.post("/api/selfie-references", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { body: passthroughBody, response: { 201: openObject } }
  }, async (request, reply) => {
    const envelope = await options.repository.create(request.body);
    return reply.status(201).send(withContentUrls(envelope));
  });

  app.get("/api/selfie-references/:id/content", {
    schema: { params: referenceParams, querystring: openObject, response: { 200: passthroughBody } }
  }, async (request, reply) => {
    const params = request.params as { id?: string };
    const query = request.query as { variant?: string };
    const variant = parseVariant(query.variant);
    const content = await options.repository.content(String(params.id ?? ""), variant);
    reply.header("content-type", content.contentType);
    reply.header("cache-control", "private, max-age=604800, immutable");
    reply.header("vary", "Authorization");
    reply.header("x-content-type-options", "nosniff");
    return content.bytes;
  });

  app.delete("/api/selfie-references/:id", {
    schema: { params: referenceParams, response: { 204: { type: "null" } } }
  }, async (request, reply) => {
    const params = request.params as { id?: string };
    await options.repository.remove(String(params.id ?? ""));
    return reply.status(204).send();
  });
}

function withContentUrls(envelope: SelfieReferenceEnvelope) {
  return {
    maxImages: envelope.maxImages,
    images: envelope.images.map(publicImage)
  };
}

function publicImage(image: SelfieReferenceImage) {
  const base = `/api/selfie-references/${encodeURIComponent(image.id)}/content`;
  return {
    ...image,
    originalUrl: `${base}?variant=original`,
    displayUrl: `${base}?variant=display`,
    placeholderUrl: `${base}?variant=placeholder`
  };
}

function parseVariant(value: string | undefined): SelfieReferenceVariant {
  if (value === "original" || value === "display" || value === "placeholder") return value;
  badRequest("SELFIE_REFERENCE_VARIANT_INVALID", "自拍参考图尺寸无效。", "variant");
}
