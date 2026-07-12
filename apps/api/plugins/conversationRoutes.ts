import type { FastifyInstance } from "fastify";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import type { ConversationDirectory } from "../../../services/conversations/conversationDirectory.js";
import { WebChatService } from "../../../services/webChat/webChatService.js";
import { badRequest } from "../../../src/admin/errors.js";
import { readModelCallStats, readRequestLogs } from "../../../src/requestLog.js";
import type { SunaRuntime } from "../../../src/runtime.js";

export interface ConversationRouteOptions {
  runtime: SunaRuntime;
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
  const { runtime, onebotGateway, conversationDirectory } = options;
  const webChat = new WebChatService(runtime);

  app.get("/api/web-chat/messages", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => webChat.messages());

  app.post("/api/web-chat/messages", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const text = String((request.body as { text?: unknown } | undefined)?.text ?? "").trim();
    if (!text || text.length > 16_000) {
      badRequest(
        "WEB_CHAT_MESSAGE_INVALID",
        text ? "消息不能超过 16000 个字符。" : "请输入消息。",
        "text"
      );
    }
    return webChat.send(text, request.signal);
  });

  app.get("/api/conversations", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => {
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
    const params = request.params as { id?: string };
    const query = request.query as { runId?: string; limit?: string };
    const runId = String(query.runId ?? "").trim();
    const conversationId = String(params.id ?? "").trim();
    const q = runId || conversationId;
    return {
      logs: q ? await readRequestLogs({ query: q, limit: query.limit == null ? 200 : Number(query.limit) }) : []
    };
  });

  app.get("/api/conversations/:id/stats", {
    schema: {
      params: conversationParams,
      response: { 200: openObject }
    }
  }, async (request) => {
    const conversationId = String((request.params as { id?: string }).id ?? "").trim();
    const conversation = runtime.getConversationRecords().find((item) => item.id === conversationId);
    return {
      conversationId,
      messages: conversation?.messageCount ?? 0,
      modelCalls: readModelCallStats({ conversationId })
    };
  });

  app.put("/api/conversations/reply", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
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
