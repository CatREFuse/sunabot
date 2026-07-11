import type { FastifyInstance } from "fastify";
import {
  createMemoryEntry,
  deleteMemoryEntry,
  listMemoryEntries,
  recallMemory,
  updateMemoryEntry,
  type MemoryEntry
} from "../../../services/memory/public.js";
import type { AppConfig } from "../../../src/types.js";

const openObject = { type: "object", additionalProperties: true } as const;
const sourceQuery = {
  type: "object",
  additionalProperties: false,
  properties: { source: { type: "string" } }
} as const;

const operations = {
  listMemoryEntries,
  recallMemory,
  createMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry
};

export interface MemoryRouteRuntime {
  enrichMemoryEntries(entries: MemoryEntry[]): MemoryEntry[];
  reload(config: AppConfig): Promise<void>;
}

export interface MemoryRouteDependencies {
  getConfig(): AppConfig;
  runtime: MemoryRouteRuntime;
  operations?: Partial<typeof operations>;
}

export function registerMemoryRoutes(app: FastifyInstance, dependencies: MemoryRouteDependencies) {
  const memory = { ...operations, ...dependencies.operations };

  app.get("/api/memory", {
    schema: { querystring: sourceQuery, response: { 200: openObject } }
  }, async (request) => {
    const query = request.query as { source?: string };
    const payload = await memory.listMemoryEntries(dependencies.getConfig(), query.source);
    return { ...payload, entries: dependencies.runtime.enrichMemoryEntries(payload.entries) };
  });

  app.post("/api/memory/recall", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          source: { type: "string" },
          limit: { type: "integer", minimum: 1 }
        }
      },
      response: { 200: openObject }
    }
  }, async (request) => {
    const payload = await memory.recallMemory(dependencies.getConfig(), request.body as {
      query?: string;
      source?: string;
      limit?: number;
    });
    return { ...payload, matches: dependencies.runtime.enrichMemoryEntries(payload.matches) };
  });

  app.post("/api/memory", {
    schema: { body: { ...memoryWriteBody, properties: createProperties }, response: { 200: openObject } }
  }, async (request) => {
    const config = dependencies.getConfig();
    const entry = await memory.createMemoryEntry(config, request.body as {
      source?: string;
      text?: string;
      userId?: string;
      userName?: string;
      addressName?: string;
    });
    await dependencies.runtime.reload(config);
    return { ok: true, entry };
  });

  app.put("/api/memory", {
    schema: { body: { ...memoryWriteBody, properties: updateProperties }, response: { 200: openObject } }
  }, async (request) => {
    const config = dependencies.getConfig();
    const entry = await memory.updateMemoryEntry(config, request.body as {
      source?: string;
      id?: string;
      text?: string;
      addressName?: string;
    });
    await dependencies.runtime.reload(config);
    return { ok: true, entry };
  });

  app.delete("/api/memory", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          id: { type: "string" }
        }
      },
      response: { 200: openObject }
    }
  }, async (request) => {
    const config = dependencies.getConfig();
    const result = await memory.deleteMemoryEntry(config, request.body as { source?: string; id?: string });
    await dependencies.runtime.reload(config);
    return result;
  });
}

const memoryWriteBody = { type: "object", additionalProperties: false } as const;
const createProperties = {
  source: { type: "string" },
  text: { type: "string" },
  userId: { type: "string" },
  userName: { type: "string" },
  addressName: { type: "string" }
} as const;
const updateProperties = {
  source: { type: "string" },
  id: { type: "string" },
  text: { type: "string" },
  addressName: { type: "string" }
} as const;
