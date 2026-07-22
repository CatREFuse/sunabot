import type { FastifyInstance } from "fastify";
import { RELEASE_CATALOG } from "../../../packages/platform/releaseCatalog.js";

const changeGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "items"],
  properties: {
    title: { type: "string" },
    items: { type: "array", items: { type: "string" } }
  }
} as const;

const releaseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "releasedAt", "title", "summary", "groups"],
  properties: {
    version: { type: "string" },
    releasedAt: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    groups: { type: "array", items: changeGroupSchema }
  }
} as const;

const releaseCatalogSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "currentVersion", "releases"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    currentVersion: { type: "string" },
    releases: { type: "array", items: releaseSchema }
  }
} as const;

export function registerReleaseRoutes(app: FastifyInstance) {
  app.get("/api/releases", {
    schema: {
      querystring: { type: "object", additionalProperties: false },
      response: { 200: releaseCatalogSchema }
    }
  }, async () => RELEASE_CATALOG);
}
