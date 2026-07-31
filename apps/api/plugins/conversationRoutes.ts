import type { FastifyInstance } from "fastify";
import type { OneBotGateway } from "../../../adapters/onebot/onebotGateway.js";
import type { ConversationDirectory } from "../../../services/conversations/conversationDirectory.js";
import { WebChatService } from "../../../services/webChat/webChatService.js";
import { badRequest } from "../../../src/admin/errors.js";
import { readModelCallStats, readRequestLogs } from "../../../adapters/observability/requestLog.js";
import type { SunaRuntime } from "../../../src/runtime.js";
import type { AgentToolName } from "../../../packages/contracts/admin/public.js";
import { isAgentToolName } from "../../../services/tools/toolRegistry.js";
import { normalizeConversationLookupId } from "../../../src/runtime/messagingAttachmentHelpers.js";
import { requestAgentId } from "../requestAgentId.js";
import { withFastifyRequestSignal } from "./requestAbortSignal.js";

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
  const webChatShutdownController = new AbortController();
  const webChatFor = (request: { query: unknown }) => {
    const runtime = runtimeFor(request);
    const existing = webChats.get(runtime);
    if (existing) return existing;
    const webChat = new WebChatService(runtime, webChatShutdownController.signal);
    webChats.set(runtime, webChat);
    return webChat;
  };
  app.addHook("preClose", async () => {
    if (!webChatShutdownController.signal.aborted) {
      webChatShutdownController.abort(new Error("WEB_CHAT_SHUTTING_DOWN"));
    }
  });

  app.get("/api/web-chat/messages", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => webChatFor(request).messages());

  app.post("/api/web-chat/messages", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request, reply) => {
    const webChat = webChatFor(request);
    const text = String((request.body as { text?: unknown } | undefined)?.text ?? "").trim();
    if (!text || text.length > 16_000) {
      badRequest(
        "WEB_CHAT_MESSAGE_INVALID",
        text ? "消息不能超过 16000 个字符。" : "请输入消息。",
        "text"
      );
    }
    return withFastifyRequestSignal(
      request,
      reply,
      "WEB_CHAT_REQUEST_ABORTED",
      (signal) => webChat.send(text, signal)
    );
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

  app.get("/api/conversations/:id/tools", {
    schema: {
      params: conversationParams,
      response: { 200: openObject }
    }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const conversationId = validConversationId((request.params as { id?: string }).id);
    return runtime.getConversationToolPolicy(conversationId);
  });

  app.put("/api/conversations/:id/tools", {
    schema: {
      params: conversationParams,
      body: passthroughBody,
      response: { 200: openObject }
    }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const conversationId = validConversationId((request.params as { id?: string }).id);
    const disabledTools = validDisabledToolsBody(request.body);
    return runtime.setConversationToolPolicy({ id: conversationId, disabledTools });
  });

  app.put("/api/conversations/reply", {
    schema: { body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const runtime = runtimeFor(request);
    const body = request.body as {
      id?: string;
      scope?: string;
      title?: string;
      userId?: number;
      groupId?: number;
      replyEnabled?: boolean;
      orchestratorEnabled?: boolean;
      orchestratorResponseTimeOverrideEnabled?: boolean;
      orchestratorResponseTimeMs?: number;
      directorEventsEnabled?: boolean;
    };
    validateConversationOrchestratorResponseTime(body);
    const conversation = runtime.setConversationReplyEnabled(body);
    return { ok: true, conversation };
  });
}

function validateConversationOrchestratorResponseTime(body: {
  orchestratorResponseTimeOverrideEnabled?: unknown;
  orchestratorResponseTimeMs?: unknown;
}) {
  if (
    body.orchestratorResponseTimeOverrideEnabled !== undefined &&
    typeof body.orchestratorResponseTimeOverrideEnabled !== "boolean"
  ) {
    badRequest(
      "CONVERSATION_ORCHESTRATOR_RESPONSE_TIME_OVERRIDE_INVALID",
      "编排器时间覆盖设置无效。",
      "orchestratorResponseTimeOverrideEnabled"
    );
  }
  if (
    body.orchestratorResponseTimeMs !== undefined &&
    (
      !Number.isInteger(body.orchestratorResponseTimeMs) ||
      Number(body.orchestratorResponseTimeMs) < 1_000 ||
      Number(body.orchestratorResponseTimeMs) > 3_600_000
    )
  ) {
    badRequest(
      "CONVERSATION_ORCHESTRATOR_RESPONSE_TIME_INVALID",
      "编排器响应时间必须是 1 到 3600 秒之间的整数。",
      "orchestratorResponseTimeMs"
    );
  }
}

function validConversationId(value: unknown) {
  const id = normalizeConversationLookupId(value);
  if (!id) badRequest("CONVERSATION_ID_INVALID", "会话无效。", "id");
  return id;
}

function validDisabledToolsBody(value: unknown): AgentToolName[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest("CONVERSATION_TOOLS_INVALID", "工具选择无效。", "disabledTools");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "disabledTools") {
    badRequest("CONVERSATION_TOOLS_INVALID", "请求体必须只包含 disabledTools。", "disabledTools");
  }
  const disabledTools = (value as { disabledTools?: unknown }).disabledTools;
  return validDisabledTools(disabledTools);
}

function validDisabledTools(value: unknown): AgentToolName[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !isAgentToolName(name))) {
    badRequest("CONVERSATION_TOOLS_INVALID", "工具选择无效。", "disabledTools");
  }
  if (new Set(value).size !== value.length) {
    badRequest("CONVERSATION_TOOLS_INVALID", "工具不能重复。", "disabledTools");
  }
  return value as AgentToolName[];
}
