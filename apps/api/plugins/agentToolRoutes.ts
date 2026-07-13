import type { FastifyInstance } from "fastify";
import type { AgentFileRepository } from "../../../src/admin/agentFiles.js";
import type { AppConfig } from "../../../src/types.js";
import { parseFinalPromptTemplate } from "../../../services/agent/promptSystem.js";
import { promptDefinitionById } from "../../../services/agent/promptCatalog.js";
import { listToolMetadata } from "../../../services/tools/toolRegistry.js";
import type { RuntimeToolCapabilityResolver } from "../../../services/tools/bashCapability.js";
import { badRequest, notFound } from "../../../src/admin/errors.js";

export interface AgentToolRouteOptions {
  agentFiles: AgentFileRepository;
  resolveToolCapabilities: RuntimeToolCapabilityResolver;
  getConfig: () => AppConfig;
  getAgentContext?: (agentId: string) => {
    config: AppConfig;
    agentFiles: AgentFileRepository;
    resolveToolCapabilities: RuntimeToolCapabilityResolver;
  };
}

const openObject = { type: "object", additionalProperties: true } as const;
const passthroughBody = {} as const;
const agentFileParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
  additionalProperties: true
} as const;

export function registerAgentToolRoutes(app: FastifyInstance, options: AgentToolRouteOptions) {
  const contextFor = (request: { query: unknown }) => options.getAgentContext?.(requestAgentId(request.query)) ?? {
    config: options.getConfig(),
    agentFiles: options.agentFiles,
    resolveToolCapabilities: options.resolveToolCapabilities
  };
  app.get("/api/agent-files", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const context = contextFor(request);
    return context.agentFiles.list(context.config, context.config.persona.systemPromptOverride ? undefined : "persona");
  });

  app.get("/api/agent-files/:id", {
    schema: { params: agentFileParams, querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const context = contextFor(request);
    const params = request.params as { id?: string };
    const id = promptId(params.id, context.config.persona.systemPromptOverride ? undefined : "persona");
    return context.agentFiles.get(id, context.config);
  });

  app.put("/api/agent-files/:id", {
    schema: { params: agentFileParams, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const context = contextFor(request);
    const params = request.params as { id?: string };
    const id = promptId(params.id, context.config.persona.systemPromptOverride ? undefined : "persona");
    return options.getAgentContext
      ? context.agentFiles.put(id, request.body, context.config)
      : context.agentFiles.put(id, request.body);
  });

  app.get("/api/system-prompt-files", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.agentFiles.list(options.getConfig(), "system"));

  app.get("/api/system-prompt-files/:id", {
    schema: { params: agentFileParams, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    return options.agentFiles.get(promptId(params.id, "system"), options.getConfig());
  });

  app.put("/api/system-prompt-files/:id", {
    schema: { params: agentFileParams, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    return options.agentFiles.put(promptId(params.id, "system"), request.body, options.getConfig());
  });

  app.get("/api/tools", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const context = contextFor(request);
    const config = context.config;
    const promptFile = await context.agentFiles.get("conversation.private-reply", config);
    const prompt = parseFinalPromptTemplate(promptFile.content);
    const capabilities = await context.resolveToolCapabilities();
    const tools = listToolMetadata({
      onAssistantText: () => undefined,
      allowNoReply: true,
      bash: {
        enabled: capabilities.workspaceBash,
        workspaceOnly: config.bot.bash.workspaceOnly,
        blockedKeywords: config.bot.bash.blockedKeywords
      },
      bot: config.bot,
      selfie: { enabled: true },
      memory: { enabled: true },
      asyncCodex: capabilities.codex,
      asyncImage: true
    }, prompt.tools).map((tool) => {
      const configured = tool.name === "workspace_bash"
        ? config.bot.bash.enabled
        : tool.name === "codex"
          ? config.bot.tools.codex.enabled
          : undefined;
      return configured == null
        ? tool
        : {
            ...tool,
            configuredEnabled: configured,
            enabled: configured && tool.enabled,
            effectiveEnabled: configured && tool.effectiveEnabled
          };
    });
    return {
      tools
    };
  });
}

function requestAgentId(query: unknown) {
  const value = query && typeof query === "object" ? (query as { agentId?: unknown }).agentId : undefined;
  return String(value ?? "plana").trim() || "plana";
}

function promptId(value: unknown, scope?: "persona" | "system") {
  const id = String(value ?? "");
  const definition = promptDefinitionById(id);
  if (!definition) notFound("AGENT_FILE_NOT_FOUND", "提示词文件不存在。");
  if (scope && definition.scope !== scope) {
    badRequest(
      "PROMPT_SCOPE_INVALID",
      scope === "persona" ? "请先开启系统提示词覆盖。" : "该文件不属于系统提示词。"
    );
  }
  return id;
}
