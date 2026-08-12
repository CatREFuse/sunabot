import type { FastifyInstance } from "fastify";
import type { AgentFileRepository } from "../../../src/admin/agentFiles.js";
import type { AppConfig } from "../../../packages/contracts/admin/public.js";
import { parseFinalPromptTemplate } from "../../../services/agent/promptSystem.js";
import { promptDefinitionById } from "../../../services/agent/promptCatalog.js";
import { listToolMetadata, type ToolAvailability, type ToolMetadata } from "../../../services/tools/toolRegistry.js";
import {
  UNAVAILABLE_SKILL_TOOL_CAPABILITIES,
  type SkillToolCapabilitySnapshot
} from "../../../services/tools/skillRuntimeTool.js";
import type {
  RuntimeToolCapabilities,
  RuntimeToolCapabilitySnapshotResolver,
  WorkspaceBashUnavailableReason
} from "../../../services/tools/bashCapability.js";
import { badRequest, notFound } from "../../../src/admin/errors.js";
import { requestAgentId } from "../requestAgentId.js";

export interface AgentToolRouteOptions {
  agentFiles: AgentFileRepository;
  resolveToolCapabilities: RuntimeToolCapabilitySnapshotResolver;
  resolveConversationAssetCapability?: () => boolean | Promise<boolean>;
  resolveVoiceCapability?: () => AgentVoiceCapability | Promise<AgentVoiceCapability>;
  resolveSkillToolCapabilities?: () => SkillToolCapabilitySnapshot | Promise<SkillToolCapabilitySnapshot>;
  getConfig: () => AppConfig;
  getAgentContext?: (agentId: string) => {
    config: AppConfig;
    agentFiles: AgentFileRepository;
    resolveToolCapabilities: RuntimeToolCapabilitySnapshotResolver;
    resolveConversationAssetCapability?: () => boolean | Promise<boolean>;
    resolveVoiceCapability?: () => AgentVoiceCapability | Promise<AgentVoiceCapability>;
    resolveSkillToolCapabilities?: () => SkillToolCapabilitySnapshot | Promise<SkillToolCapabilitySnapshot>;
  };
}

export type AgentVoiceCapability = NonNullable<ToolAvailability["voice"]>;

const UNAVAILABLE_VOICE_CAPABILITY: AgentVoiceCapability = {
  enabled: false,
  languages: [],
  defaultLanguage: "ja"
};

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
    resolveToolCapabilities: options.resolveToolCapabilities,
    resolveConversationAssetCapability: options.resolveConversationAssetCapability,
    resolveVoiceCapability: options.resolveVoiceCapability,
    resolveSkillToolCapabilities: options.resolveSkillToolCapabilities
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
    const nativeCapabilities = await context.resolveToolCapabilities();
    const skillCapabilities = await context.resolveSkillToolCapabilities?.()
      ?? UNAVAILABLE_SKILL_TOOL_CAPABILITIES;
    let conversationAssetsAvailable = false;
    try {
      conversationAssetsAvailable = await context.resolveConversationAssetCapability?.() ?? false;
    } catch {
      conversationAssetsAvailable = false;
    }
    let voiceCapability = UNAVAILABLE_VOICE_CAPABILITY;
    try {
      voiceCapability = await context.resolveVoiceCapability?.() ?? UNAVAILABLE_VOICE_CAPABILITY;
    } catch {
      voiceCapability = UNAVAILABLE_VOICE_CAPABILITY;
    }
    const tools = listToolMetadata({
      onAssistantText: () => undefined,
      allowNoReply: true,
      bashAvailable: nativeCapabilities.workspaceBash,
      bot: config.bot,
      selfie: { enabled: true },
      conversationAssets: { enabled: conversationAssetsAvailable },
      voice: voiceCapability,
      memory: { enabled: true },
      knowledge: { enabled: true, search: async () => ({ ok: false, matches: [] }) },
      asyncCodex: nativeCapabilities.codex,
      asyncImage: true,
      skillCapabilities,
      systemConfig: {
        execute: async () => ({ ok: false, error: "System configuration is not executable from the tool catalog." }),
        mutationStaged: () => false
      },
      director: {
        execute: async () => ({ ok: false, error: "Daily director is not executable from the tool catalog." })
      }
    }, prompt.tools).map((tool) => bashCatalogMetadata(tool, nativeCapabilities)).map((tool) => {
      const configured = tool.name === "native_bash"
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

function bashCatalogMetadata(
  tool: ToolMetadata,
  nativeCapabilities: RuntimeToolCapabilities
): ToolMetadata {
  if (tool.name !== "native_bash") return tool;
  const available = nativeCapabilities.workspaceBash;
  const reason = nativeCapabilities.workspaceBashReason
    ?? (available ? undefined : "BASH_NATIVE_ISOLATION_UNAVAILABLE");
  return {
    ...tool,
    executionBackend: "native",
    description: `${tool.description.trim()} Native Bash ${available ? "可用" : "不可用"}。`.trim(),
    accessLabel: "按平台授权会话",
    accessDescription: "Linux 与 WSL 使用 Bubblewrap；macOS 仅管理员 QQ 私聊和管理 Web Chat 可用。",
    bashEnvironments: {
      native: { available, ...(reason ? { reasonCode: reason } : {}) }
    },
    ...(available ? {} : {
      unavailabilityKind: "runtime" as const,
      runtimeReasonCode: reason,
      availabilityReason: bashUnavailableMessage(reason)
    })
  };
}

function bashUnavailableMessage(
  reason: WorkspaceBashUnavailableReason | undefined
) {
  if (reason === "BASH_AUDIT_UNAVAILABLE") {
    return "Native Bash 对抗审批 Agent 不可用。";
  }
  if (reason === "BASH_WORKBENCH_UNAVAILABLE") {
    return "Native Bash 工作目录不可用。";
  }
  return "Native Bash 当前不可用。";
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
