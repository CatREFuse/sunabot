import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentRegistry } from "../../../services/agents/agentRegistry.js";
import { AdminApiError, badRequest } from "../../../src/admin/errors.js";
import type { AgentSummary } from "../../../services/agents/agentRegistry.js";
import type { AccountRuntimeState } from "../../../services/agents/accountRuntimeReconciler.js";

const openObject = { type: "object", additionalProperties: true } as const;

export interface AgentRouteOptions {
  decorateAgents?: (agents: AgentSummary[]) => unknown;
  onAgentCreated?: (agentId: string) => Promise<void>;
  onAgentUpdated?: (agentId: string, enabled: boolean) => Promise<void>;
  onPromptSettingsUpdated?: (agentId: string) => Promise<void>;
  isAccountConnected?: (accountId: string) => boolean;
  reconcileAccount?: (accountId: string) => Promise<AccountRuntimeState>;
}

export function registerAgentRoutes(app: FastifyInstance, registry: AgentRegistry, options: AgentRouteOptions = {}) {
  app.get("/api/agents", { schema: { response: { 200: openObject } } }, async () => ({
    agents: options.decorateAgents?.(await registry.list()) ?? await registry.list()
  }));

  app.post("/api/agents", { schema: { response: { 200: openObject } } }, async (request) => {
    const body = object(request.body);
    const created = await registry.create({
      id: text(body.id, "id"),
      name: text(body.name, "name"),
      ...(body.avatar == null ? {} : { avatar: avatar(body.avatar) })
    });
    try {
      await options.onAgentCreated?.(created.id);
    } catch (error) {
      await registry.rollbackCreatedAgent(created);
      throw error;
    }
    return created;
  });

  app.get("/api/agents/:agentId", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    return registry.get(agentId);
  });

  app.patch("/api/agents/:agentId", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const body = object(request.body);
    if (body.name == null && body.enabled == null) badRequest("AGENT_UPDATE_EMPTY", "没有需要保存的修改。");
    if (body.enabled != null && typeof body.enabled !== "boolean") {
      badRequest("AGENT_ENABLED_INVALID", "启用状态无效。", "enabled");
    }
    const updated = await registry.update(agentId, {
      ...(body.name == null ? {} : { name: text(body.name, "name") }),
      ...(body.enabled == null ? {} : { enabled: body.enabled as boolean })
    });
    await options.onAgentUpdated?.(agentId, updated.enabled);
    return updated;
  });

  app.get("/api/agents/:agentId/avatar", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const filePath = registry.avatarFile(agentId);
    reply.header("cache-control", "private, max-age=300");
    return reply.type(contentType(filePath)).send(fs.createReadStream(filePath));
  });

  app.put("/api/agents/:agentId/avatar", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const body = object(request.body);
    return registry.updateAvatar(agentId, avatar(body.avatar));
  });

  app.get("/api/agents/:agentId/prompt-settings", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    return registry.promptSettings(agentId);
  });

  app.patch("/api/agents/:agentId/prompt-settings", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const body = object(request.body);
    if (typeof body.overrideSystem !== "boolean") {
      badRequest("AGENT_PROMPT_SETTINGS_INVALID", "系统提示词覆盖状态无效。", "overrideSystem");
    }
    const settings = await registry.setSystemPromptOverride(agentId, body.overrideSystem as boolean);
    await options.onPromptSettingsUpdated?.(agentId);
    return settings;
  });

  app.get("/api/agents/:agentId/accounts", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    return { accounts: (await registry.get(agentId)).accounts };
  });

  app.post("/api/agents/:agentId/accounts", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const body = object(request.body);
    const account = await registry.createAccount(agentId, { label: text(body.label, "label") });
    const state = await options.reconcileAccount?.(account.id);
    return { ...account, ...state };
  });

  app.patch("/api/agents/:agentId/accounts/:accountId", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId, accountId } = request.params as { agentId: string; accountId: string };
    const body = object(request.body);
    if (typeof body.enabled !== "boolean") badRequest("AGENT_ACCOUNT_ENABLED_INVALID", "启用状态无效。", "enabled");
    const account = await registry.updateAccountEnabled(agentId, accountId, body.enabled as boolean);
    const state = await options.reconcileAccount?.(account.id);
    return { ...account, ...state };
  });

  app.post("/api/agents/:agentId/accounts/:accountId/runtime/start", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId, accountId } = request.params as { agentId: string; accountId: string };
    if (!options.reconcileAccount) {
      throw new AdminApiError(503, "ACCOUNT_RUNTIME_UNAVAILABLE", "QQ 运行时服务不可用。请执行 ./sunabot.sh restart。");
    }
    const account = await registry.updateAccountEnabled(agentId, accountId, true);
    const state = await options.reconcileAccount(account.id);
    return { ...account, ...state };
  });

  app.delete("/api/agents/:agentId/accounts/:accountId", { schema: { response: { 200: openObject } } }, async (request) => {
    const { agentId, accountId } = request.params as { agentId: string; accountId: string };
    if (options.isAccountConnected?.(accountId)) badRequest("AGENT_ACCOUNT_CONNECTED", "请先退出 QQ 再移除账号。");
    if (accountId === "primary") await registry.removeAccount(agentId, accountId);
    const disabled = await registry.updateAccountEnabled(agentId, accountId, false);
    const stopped = await options.reconcileAccount?.(accountId);
    if (stopped?.reconcileRequired) return { ok: false, account: { ...disabled, ...stopped } };
    await registry.removeAccount(agentId, accountId);
    const removed = await options.reconcileAccount?.(accountId);
    return { ok: true, runtime: removed };
  });
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest("REQUEST_BODY_INVALID", "请求体必须是对象。");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string) {
  if (typeof value !== "string") badRequest("REQUEST_FIELD_INVALID", "字段必须是文本。", field);
  return value;
}

function avatar(value: unknown) {
  const input = object(value);
  return {
    fileName: text(input.fileName, "avatar.fileName"),
    dataBase64: text(input.dataBase64, "avatar.dataBase64")
  };
}

function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}
