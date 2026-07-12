import type { FastifyInstance } from "fastify";
import type { AgentFileRepository } from "../../../src/admin/agentFiles.js";
import type { AppConfig } from "../../../src/types.js";
import { parseFinalPromptTemplate } from "../../../services/agent/promptSystem.js";
import { listToolMetadata } from "../../../services/tools/toolRegistry.js";

export interface AgentToolRouteOptions {
  agentFiles: AgentFileRepository;
  getConfig: () => AppConfig;
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
  app.get("/api/agent-files", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => options.agentFiles.list());

  app.get("/api/agent-files/:id", {
    schema: { params: agentFileParams, querystring: openObject, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    return options.agentFiles.get(String(params.id ?? ""));
  });

  app.put("/api/agent-files/:id", {
    schema: { params: agentFileParams, body: passthroughBody, response: { 200: openObject } }
  }, async (request) => {
    const params = request.params as { id?: string };
    return options.agentFiles.put(String(params.id ?? ""), request.body);
  });

  app.get("/api/tools", {
    schema: { querystring: openObject, response: { 200: openObject } }
  }, async () => {
    const config = options.getConfig();
    const promptFile = await options.agentFiles.get("conversation.reply", config);
    const prompt = parseFinalPromptTemplate(promptFile.content);
    return {
      tools: listToolMetadata({
        onAssistantText: () => undefined,
        bash: {
          enabled: config.bot.bash.enabled,
          workspaceOnly: config.bot.bash.workspaceOnly,
          blockedKeywords: config.bot.bash.blockedKeywords
        },
        bot: config.bot,
        selfie: { enabled: true },
        memory: { enabled: true },
        asyncCodex: config.bot.tools.codex.enabled,
        asyncImage: true
      }, prompt.tools)
    };
  });
}
