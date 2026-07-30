import type { FastifyInstance } from "fastify";
import { ServiceError } from "../../../packages/contracts/errors/serviceError.js";
import {
  createMemoryEntry,
  deleteMemoryEntry,
  listMemoryEntries,
  listMemoryOperationLogs,
  readMemoryProcessingHealth,
  recallMemory,
  updateMemoryEntry,
  type MemoryEntry
} from "../../../services/memory/public.js";
import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import type { DreamHistoryEnvelope, DreamHistoryItem } from "../../../services/memory/dream/public.js";
import { requestAgentId } from "../requestAgentId.js";

const openObject = { type: "object", additionalProperties: true } as const;
const sourceQuery = {
  type: "object",
  additionalProperties: false,
  properties: { source: { type: "string" }, agentId: { type: "string" } }
} as const;

const operations = {
  listMemoryEntries,
  listMemoryOperationLogs,
  readMemoryProcessingHealth,
  recallMemory,
  createMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry
};

export interface MemoryRouteRuntime {
  enrichMemoryEntries(entries: MemoryEntry[]): MemoryEntry[];
  memoryProcessingPendingCount(): Promise<number>;
  reload(config: AppConfig): Promise<void>;
  listDreamHistory?(limit: number): DreamHistoryEnvelope | Promise<DreamHistoryEnvelope>;
  forceDream?(input: { accountId: string }): Promise<{
    ok: true;
    notificationQueued: true;
    run: DreamHistoryItem;
  }>;
}

export interface MemoryRouteDependencies {
  getConfig(): AppConfig;
  runtime: MemoryRouteRuntime;
  getAgentContext?: (agentId: string) => { config: AppConfig; runtime: MemoryRouteRuntime };
  resolveDreamAccountId?: (agentId: string) => Promise<string | undefined> | string | undefined;
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
    const [payload, pending] = await Promise.all([
      memory.listMemoryEntries(context.config, query.source),
      context.runtime.memoryProcessingPendingCount()
    ]);
    return {
      ...payload,
      entries: context.runtime.enrichMemoryEntries(payload.entries),
      health: memory.readMemoryProcessingHealth(context.config, { pending })
    };
  });

  app.get("/api/memory/operations", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentId: { type: "string" },
          page: { type: "integer", minimum: 1, maximum: 100_000, default: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 100, default: 50 }
        }
      },
      response: { 200: openObject }
    }
  }, async (request) => {
    const query = request.query as { page?: number; pageSize?: number };
    const context = contextFor(request);
    return memory.listMemoryOperationLogs(context.config, {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50
    });
  });

  app.get("/api/memory/dreams", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 30 }
        }
      },
      response: { 200: openObject }
    }
  }, async (request) => {
    const context = contextFor(request);
    if (!context.runtime.listDreamHistory) throw new Error("Dream history runtime is unavailable.");
    const query = request.query as { limit?: number };
    return context.runtime.listDreamHistory(query.limit ?? 30);
  });

  app.post("/api/memory/dreams/trigger", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: { agentId: { type: "string" } }
      },
      response: { 200: openObject }
    }
  }, async (request) => {
    const agentId = requestAgentId(request.query);
    const context = contextFor(request);
    if (!context.runtime.forceDream) {
      throw new ServiceError(503, "DREAM_RUNTIME_UNAVAILABLE", "Dream 暂不可用。");
    }
    const accountId = await dependencies.resolveDreamAccountId?.(agentId);
    if (!accountId) {
      throw new ServiceError(409, "DREAM_ACCOUNT_OFFLINE", "当前 Agent 没有在线 QQ，无法发送入睡消息。");
    }
    try {
      return await context.runtime.forceDream({ accountId });
    } catch (error) {
      throw dreamTriggerError(error);
    }
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
      addressNames?: string[];
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
      addressNames?: string[];
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

function dreamTriggerError(error: unknown) {
  if (error instanceof ServiceError) return error;
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : "";
  if (code === "DREAM_ALREADY_COMPLETED" || code === "DREAM_BUSY" || code === "DREAM_ADMIN_QQ_UNAVAILABLE") {
    return new ServiceError(
      409,
      code,
      error instanceof Error && error.message.trim() ? error.message : "Dream 目前无法触发。"
    );
  }
  return error;
}

const memoryWriteBody = { type: "object", additionalProperties: false } as const;
const createProperties = {
  source: { type: "string" },
  text: { type: "string" },
  userId: { type: "string" },
  userName: { type: "string" },
  addressNames: { type: "array", items: { type: "string" } },
  addressName: { type: "string" }
} as const;
const updateProperties = {
  source: { type: "string" },
  id: { type: "string" },
  text: { type: "string" },
  addressNames: { type: "array", items: { type: "string" } },
  addressName: { type: "string" }
} as const;
