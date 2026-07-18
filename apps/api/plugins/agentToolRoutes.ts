import type { FastifyInstance } from "fastify";
import type { AgentFileRepository } from "../../../src/admin/agentFiles.js";
import type { AppConfig } from "../../../src/types.js";
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
    const privateBackend = config.bot.bash.adminOnly
      ? config.bot.bash.adminPrivateBackend
      : null;
    const capabilities = await context.resolveToolCapabilities(privateBackend);
    const groupCapabilities = config.bot.bash.adminOnly && config.bot.bash.allowGroup
      ? config.bot.bash.adminPrivateBackend === "docker"
        ? capabilities
        : await context.resolveToolCapabilities("docker")
      : undefined;
    const bashAvailable = config.bot.bash.adminOnly && (
      capabilities.workspaceBash || groupCapabilities?.workspaceBash === true
    );
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
      bashAvailable,
      bot: config.bot,
      selfie: { enabled: true },
      conversationAssets: { enabled: conversationAssetsAvailable },
      voice: voiceCapability,
      memory: { enabled: true },
      asyncCodex: capabilities.codex,
      asyncImage: true,
      skillCapabilities,
      systemConfig: {
        execute: async () => ({ ok: false, error: "System configuration is not executable from the tool catalog." }),
        mutationStaged: () => false,
        rejectTurn: () => undefined,
        turnRejected: () => false
      }
    }, prompt.tools).map((tool) => bashCatalogMetadata(
      tool,
      config,
      capabilities,
      groupCapabilities
    )).map((tool) => {
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

function bashCatalogMetadata(
  tool: ToolMetadata,
  config: AppConfig,
  privateCapabilities: RuntimeToolCapabilities,
  groupCapabilities: RuntimeToolCapabilities | undefined
): ToolMetadata {
  if (tool.name !== "workspace_bash") return tool;
  const backend = config.bot.bash.adminPrivateBackend;
  const privateReady = config.bot.bash.adminOnly && privateCapabilities.workspaceBash;
  const groupReady = config.bot.bash.adminOnly
    && config.bot.bash.allowGroup
    && groupCapabilities?.workspaceBash === true;
  const accessLabel = config.bot.bash.allowGroup
    ? "管理员 QQ 私聊与群聊"
    : "仅管理员 QQ 私聊";
  const reasonCode = privateCapabilities.workspaceBashReason
    ?? (backend === "native" ? "BASH_NATIVE_ISOLATION_UNAVAILABLE" : "BASH_DOCKER_ISOLATION_UNAVAILABLE");
  if (!config.bot.bash.adminOnly) {
    return {
      ...tool,
      accessLabel: "所有会话均不可用",
      accessDescription: "管理员身份门禁已关闭；开启后仅管理员 QQ 会话可使用 Bash。",
      executionBackend: backend,
      unavailabilityKind: "session",
      availabilityReason: "管理员身份门禁已关闭，所有会话均不可用。"
    };
  }
  return {
    ...tool,
    accessLabel,
    accessDescription: bashAccessDescription(config),
    executionBackend: backend,
    ...(privateReady || groupReady ? {} : {
      unavailabilityKind: "runtime" as const,
      runtimeReasonCode: reasonCode,
      availabilityReason: bashUnavailableMessage(
        reasonCode,
        config.bot.bash.allowGroup && groupCapabilities?.workspaceBash !== true
      )
    })
  };
}

function bashAccessDescription(config: AppConfig) {
  const details = [
    `管理员私聊使用${config.bot.bash.adminPrivateBackend === "docker" ? " Docker" : " Native"} 后端。`,
    config.bot.bash.allowGroup
      ? "管理员群聊固定使用 Docker 受限模式。"
      : "管理员群聊未启用。",
    "Web Chat 和普通用户不可用。"
  ];
  return details.join("");
}

function bashUnavailableMessage(reason: WorkspaceBashUnavailableReason, groupUnavailable = false) {
  const groupSuffix = groupUnavailable ? "管理员群聊的 Docker 受限模式也不可用。" : "";
  if (reason === "BASH_AUDIT_UNAVAILABLE") {
    return `独立 Bash 审计不可用，Bash 已安全关闭。${groupSuffix}`;
  }
  if (reason === "BASH_WORKBENCH_UNAVAILABLE") {
    return `当前 Agent workbench 不可用，Bash 已安全关闭。${groupSuffix}`;
  }
  if (reason === "BASH_NATIVE_ISOLATION_UNAVAILABLE") {
    return `Native 后端未通过强隔离检查，Bash 已安全关闭。可在“命令执行”切换 Docker 后端后重新检查。${groupSuffix}`;
  }
  return `Docker 后端未通过强隔离检查，Bash 已安全关闭。${groupSuffix}`;
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
