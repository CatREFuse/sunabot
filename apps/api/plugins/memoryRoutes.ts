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
  properties: { source: { type: "string" }, agentId: { type: "string" } }
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
  getAgentContext?: (agentId: string) => { config: AppConfig; runtime: MemoryRouteRuntime };
  operations?: Partial<typeof operations>;
}

export function registerMemoryRoutes(app: FastifyInstance, dependencies: MemoryRouteDependencies) {
  const memory = { ...operations, ...dependencies.operations };
  const contextFor = (request: { query: unknown }) => dependencies.getAgentContext?.(requestAgentId(request.query)) ?? {
    config: dependencies.getConfig(),
    runtime: dependencies.runtime
  };

  app.get("/api/memory", {
    schema: { querystring: sourceQuery, response: { 200: openObject } }
  }, async (request) => {
    const query = request.query as { source?: string };
    const context = contextFor(request);
    const payload = await memory.listMemoryEntries(context.config, query.source);
    return { ...payload, entries: context.runtime.enrichMemoryEntries(payload.entries) };
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
    const context = contextFor(request);
    const payload = await memory.recallMemory(context.config, request.body as {
      query?: string;
      source?: string;
      limit?: number;
    });
    return { ...payload, matches: context.runtime.enrichMemoryEntries(payload.matches) };
  });

  app.post("/api/memory", {
    schema: { body: { ...memoryWriteBody, properties: createProperties }, response: { 200: openObject } }
  }, async (request) => {
    const { config, runtime } = contextFor(request);
    const entry = await memory.createMemoryEntry(config, request.body as {
      source?: string;
      text?: string;
      userId?: string;
      userName?: string;
      addressName?: string;
    });
    await runtime.reload(config);
    return { ok: true, entry };
  });

  app.put("/api/memory", {
    schema: { body: { ...memoryWriteBody, properties: updateProperties }, response: { 200: openObject } }
  }, async (request) => {
    const { config, runtime } = contextFor(request);
    const entry = await memory.updateMemoryEntry(config, request.body as {
      source?: string;
      id?: string;
      text?: string;
      addressName?: string;
    });
    await runtime.reload(config);
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
    const { config, runtime } = contextFor(request);
    const result = await memory.deleteMemoryEntry(config, request.body as { source?: string; id?: string });
    await runtime.reload(config);
    return result;
  });
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
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
