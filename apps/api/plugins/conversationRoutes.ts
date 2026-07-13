import type { FastifyInstance } from "fastify";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import type { ConversationDirectory } from "../../../services/conversations/conversationDirectory.js";
import { WebChatService } from "../../../services/webChat/webChatService.js";
import { badRequest } from "../../../src/admin/errors.js";
import { readModelCallStats, readRequestLogs } from "../../../src/requestLog.js";
import type { SunaRuntime } from "../../../src/runtime.js";

export interface ConversationRouteOptions {
  runtime: SunaRuntime;
  getRuntime?: (agentId: string) => SunaRuntime;
  onebotGateway: OneBotGateway;
  conversationDirectory: ConversationDirectory;
}

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const conversationParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
  additionalProperties: true
} as const;

export function registerConversationRoutes(app: FastifyInstance, options: ConversationRouteOptions) {
  const { onebotGateway, conversationDirectory } = options;
  const runtimeFor = (request: { query: unknown }) => options.getRuntime?.(requestAgentId(request.query)) ?? options.runtime;
  const webChats = new WeakMap<SunaRuntime, WebChatService>();
  const webChatFor = (request: { query: unknown }) => {
    const runtime = runtimeFor(request);
    const existing = webChats.get(runtime);
    if (existing) return existing;
    const webChat = new WebChatService(runtime);
    webChats.set(runtime, webChat);
    return webChat;
  };

  app.get("/api/web-chat/messages", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => webChatFor(request).messages());

  app.post("/api/web-chat/messages", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const webChat = webChatFor(request);
    const text = String((request.body as { text?: unknown } | undefined)?.text ?? "").trim();
    if (!text || text.length > 16_000) {
      badRequest(
        "WEB_CHAT_MESSAGE_INVALID",
        text ? "消息不能超过 16000 个字符。" : "请输入消息。",
        "text"
      );
    }
    return webChat.send(text);
  });

  app.get("/api/conversations", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const records = runtime.getConversationRecords();
    if (onebotGateway.getStatus().connected) {
      void runtime.hydrateConversationRecords(onebotGateway).catch((error) => {
        console.error("[server] hydrate conversations failed", error);
      });
      return { conversations: await conversationDirectory.enrich(records, onebotGateway) };
    }
    return { conversations: conversationDirectory.describe(records) };
  });

  app.get("/api/conversations/:id/messages", {
    schema: {
      params: conversationParams,
      querystring: openObject,
      response: { 200: openObject }
    }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const params = request.params as { id?: string };
    const query = request.query as { before?: string; limit?: string };
    const conversationId = String(params.id ?? "");
    if (onebotGateway.getStatus().connected) {
      await runtime.hydrateConversationIdentities(conversationId, onebotGateway);
    }
    return runtime.getConversationMessages(conversationId, {
      beforeSequence: query.before == null ? undefined : Number(query.before),
      limit: query.limit == null ? undefined : Number(query.limit)
    });
  });

  app.get("/api/conversations/:id/logs", {
    schema: {
      params: conversationParams,
      querystring: openObject,
      response: { 200: openObject }
    }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const params = request.params as { id?: string };
    const query = request.query as { runId?: string; limit?: string };
    const runId = String(query.runId ?? "").trim();
    const conversationId = String(params.id ?? "").trim();
    const q = runId || conversationId;
    return {
      logs: q ? await readRequestLogs({ query: q, limit: query.limit == null ? 200 : Number(query.limit), config: runtime.config }) : []
    };
  });

  app.get("/api/conversations/:id/stats", {
    schema: {
      params: conversationParams,
      response: { 200: openObject }
    }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const conversationId = String((request.params as { id?: string }).id ?? "").trim();
    return {
      conversationId,
      messages: runtime.getConversationMessageStats(conversationId),
      modelCalls: readModelCallStats({ conversationId, config: runtime.config })
    };
  });

  app.put("/api/conversations/reply", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const conversation = runtime.setConversationReplyEnabled(request.body as {
      id?: string;
      scope?: string;
      title?: string;
      userId?: number;
      groupId?: number;
      replyEnabled?: boolean;
      orchestratorEnabled?: boolean;
    });
    return { ok: true, conversation };
  });
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
}
