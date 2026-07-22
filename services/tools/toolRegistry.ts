import type { OpenAIToolDefinition } from "../agent/public.js";
import type { WorkspaceBashUnavailableReason } from "./bashCapability.js";
import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type BotConfig,
  type BotToolOverride
} from "../../src/types.js";
import {
  createWorkspaceBashTool,
  isWorkspaceBashProviderOptions,
  WORKSPACE_BASH_TOOL_NAME,
  type WorkspaceBashProviderOptions
} from "./bashTool.js";
import {
  CODEX_TOOL_NAME,
  codexTool,
  MEMORY_RECALL_TOOL_NAME,
  memoryRecallTool,
  WEBSEARCH_TOOL_NAME,
  websearchTool
} from "./definitions.js";
import { WEBFETCH_TOOL_NAME, webfetchTool } from "./webFetchTool.js";
import {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  knowledgeSearchTool,
  type KnowledgeSearchToolPort
} from "./knowledgeSearchTool.js";
import { GENERATE_IMG_TOOL_NAME, generateImgTool } from "./generateImgTool.js";
import { SELFIE_TOOL_NAME, selfieTool } from "./selfieTool.js";
import { ASSISTANT_TEXT_TOOL_NAME, assistantTextTool } from "./assistantTextTool.js";
import { NO_REPLY_TOOL_NAME, noReplyTool } from "./noReplyTool.js";
import {
  SYSTEM_CONFIG_TOOL_NAME,
  systemConfigTool,
  type SystemConfigToolPort
} from "./systemConfigTool.js";
import {
  CRON_TOOL_NAME,
  cronTool,
  type CronToolPort
} from "./cronTool.js";
import {
  CALL_DIRECTOR_TOOL_NAME,
  callDirectorTool,
  type CallDirectorToolPort
} from "./callDirectorTool.js";
import { READ_AIR_TOOL_NAME, readAirTool, type ReadAirToolPort } from "./readAirTool.js";
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  readFileTool,
  writeFileTool
} from "./workbenchFileTool.js";
import {
  SEND_FILE_TOOL_NAME,
  SEND_VOICE_MESSAGE_TOOL_NAME,
  createSendVoiceMessageTool,
  sendFileTool,
} from "./sendConversationAssetTool.js";
import type { VoiceLanguage } from "../voice/public.js";
import { withRequiredDispatchMessage, withoutDispatchMessage } from "./deferredDispatch.js";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  createActivateSkillTool,
} from "./activateSkillTool.js";
import {
  READ_SKILL_RESOURCE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
  createReadSkillResourceTool,
  createRunSkillScriptTool,
  type SkillToolCapabilitySnapshot,
  type SkillRuntimeToolPort
} from "./skillRuntimeTool.js";
import { isConversationToolEnabled } from "./conversationToolPolicy.js";

export interface ToolAvailability {
  onAssistantText?: unknown;
  allowNoReply?: boolean;
  workbenchFiles?: {
    read(input: unknown): Promise<unknown>;
    write(input: unknown): Promise<unknown>;
  };
  bash?: WorkspaceBashProviderOptions;
  bashAvailable?: boolean;
  bot?: Pick<BotConfig, "tools">;
  selfie?: { enabled: boolean };
  memory?: { enabled: boolean };
  knowledge?: KnowledgeSearchToolPort;
  conversationAssets?: { enabled: boolean };
  voice?: { enabled: boolean; languages: readonly VoiceLanguage[]; defaultLanguage: VoiceLanguage };
  asyncCodex?: boolean;
  asyncImage?: boolean;
  imageTools?: boolean;
  systemConfig?: SystemConfigToolPort;
  cron?: CronToolPort;
  director?: CallDirectorToolPort;
  air?: ReadAirToolPort;
  skills?: SkillRuntimeToolPort;
  skillCapabilities?: SkillToolCapabilitySnapshot;
  disabledTools?: readonly AgentToolName[];
}

export type ToolExecution = "inline" | "deferred";
export type ToolDescriptionSource = "override" | "prompt" | "default";
export type ToolUnavailabilityKind = "runtime" | "session";

export interface ToolMetadata {
  name: AgentToolName;
  title: string;
  summary: string;
  description: string;
  defaultDescription: string;
  promptDescription?: string;
  descriptionSource: ToolDescriptionSource;
  configuredEnabled: boolean | null;
  promptEnabled: boolean;
  enabled: boolean;
  available: boolean;
  effectiveEnabled: boolean;
  availabilityReason?: string;
  unavailabilityKind?: ToolUnavailabilityKind;
  accessLabel?: string;
  accessDescription?: string;
  executionBackend?: "native" | "docker";
  bashEnvironments?: {
    docker: { started: boolean; reasonCode?: WorkspaceBashUnavailableReason };
  };
  runtimeReasonCode?: WorkspaceBashUnavailableReason;
  execution: ToolExecution;
  parameters: Record<string, unknown>;
  strict: boolean;
}

interface ToolCatalogEntry {
  name: AgentToolName;
  title: string;
  summary: string;
  definition: (options: ToolAvailability) => Record<string, unknown>;
  available?: (options: ToolAvailability) => boolean;
  unavailableReason?: string;
  unavailabilityKind?: ToolUnavailabilityKind;
  accessLabel?: string;
  accessDescription?: string;
  defaultEnabled?: boolean;
  execution: ToolExecution;
}

const catalog: readonly ToolCatalogEntry[] = [
  {
    name: ASSISTANT_TEXT_TOOL_NAME,
    title: "行动中消息",
    summary: "在多轮行动中发送一条助手消息。",
    definition: () => assistantTextTool,
    available: (options) => typeof options.onAssistantText === "function",
    unavailableReason: "当前会话不支持行动中消息。",
    execution: "inline"
  },
  {
    name: NO_REPLY_TOOL_NAME,
    title: "静默结束",
    summary: "结束本轮且不发送任何消息。",
    definition: () => noReplyTool,
    available: (options) => options.allowNoReply === true,
    unavailableReason: "当前请求不支持静默结束。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: MEMORY_RECALL_TOOL_NAME,
    title: "记忆召回",
    summary: "从 Agent 记忆中召回相关内容。",
    definition: () => memoryRecallTool,
    available: (options) => options.memory?.enabled === true,
    unavailableReason: "当前请求未启用记忆召回。",
    execution: "inline"
  },
  {
    name: READ_AIR_TOOL_NAME,
    title: "读空气",
    summary: "更新当前 Agent 的场域知识。",
    definition: () => readAirTool,
    available: (options) => Boolean(options.air),
    unavailableReason: "当前会话未提供场域知识更新能力。",
    unavailabilityKind: "session",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: KNOWLEDGE_SEARCH_TOOL_NAME,
    title: "知识库检索",
    summary: "从当前 Agent 的知识库召回相关段落。",
    definition: () => knowledgeSearchTool,
    available: (options) => options.knowledge?.enabled === true,
    unavailableReason: "当前 Agent 的知识库不可用。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: WEBSEARCH_TOOL_NAME,
    title: "网页搜索",
    summary: "搜索网页并返回结果。",
    definition: () => websearchTool,
    available: (options) => Boolean(options.bot?.tools.websearch),
    unavailableReason: "网页搜索配置不可用。",
    execution: "inline"
  },
  {
    name: WEBFETCH_TOOL_NAME,
    title: "网页读取",
    summary: "读取单个公开网页并返回有界正文。",
    definition: () => webfetchTool,
    available: (options) => Boolean(options.bot),
    unavailableReason: "当前请求未提供网页读取能力。",
    execution: "inline"
  },
  {
    name: GENERATE_IMG_TOOL_NAME,
    title: "生图",
    summary: "生成图片并保存结果。",
    definition: () => generateImgTool,
    available: (options) => Boolean(
      options.imageTools !== false &&
      options.bot?.tools.generateImg &&
      options.bot.tools.generateImg.provider !== "custom"
    ),
    unavailableReason: "当前图像生成 Provider 不可用。",
    execution: "inline"
  },
  {
    name: SELFIE_TOOL_NAME,
    title: "自拍",
    summary: "生成 Bot 自己的形象图。",
    definition: () => selfieTool,
    available: (options) => options.imageTools !== false && options.selfie?.enabled === true,
    unavailableReason: "当前请求未启用自拍生成。",
    execution: "inline"
  },
  {
    name: READ_FILE_TOOL_NAME,
    title: "读取文件",
    summary: "读取当前 Agent workbench 内的 UTF-8 文本文件。",
    definition: () => readFileTool,
    available: (options) => typeof options.workbenchFiles?.read === "function",
    unavailableReason: "当前会话不允许读取 Agent workbench 文件。",
    unavailabilityKind: "session",
    accessLabel: "管理员 QQ 私聊可用",
    accessDescription: "Web Chat、群聊和普通用户私聊不可用。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    title: "写入文件",
    summary: "原子写入当前 Agent workbench 内的 UTF-8 文本文件。",
    definition: () => writeFileTool,
    available: (options) => typeof options.workbenchFiles?.write === "function",
    unavailableReason: "当前会话不允许写入 Agent workbench 文件。",
    unavailabilityKind: "session",
    accessLabel: "管理员 QQ 私聊可用",
    accessDescription: "Web Chat、群聊和普通用户私聊不可用。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: SEND_FILE_TOOL_NAME,
    title: "发送文件",
    summary: "向当前单聊或群聊发送 Agent workbench 中的文件或图片。",
    definition: () => sendFileTool,
    available: (options) => options.conversationAssets?.enabled === true,
    unavailableReason: "当前会话不支持文件发送。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: SEND_VOICE_MESSAGE_TOOL_NAME,
    title: "发送语音",
    summary: "合成克隆语音并发送到当前单聊或群聊。",
    definition: (options) => createSendVoiceMessageTool(
      options.voice?.languages,
      options.voice?.defaultLanguage
    ),
    available: (options) => options.voice?.enabled === true && options.voice.languages.length > 0,
    unavailableReason: "当前 Agent 未配置可用的在线音色。",
    execution: "inline"
  },
  {
    name: WORKSPACE_BASH_TOOL_NAME,
    title: "Bash",
    summary: "在 Agent workspace 内执行 Bash 命令。",
    definition: (options) => createWorkspaceBashTool(options.bash),
    available: (options) => isWorkspaceBashProviderOptions(options.bash) || options.bashAvailable === true,
    unavailableReason: "当前环境未通过 Bash 隔离检查。",
    execution: "inline"
  },
  {
    name: CODEX_TOOL_NAME,
    title: "Codex",
    summary: "把长任务交给异步 Codex worker。",
    definition: () => codexTool,
    available: (options) => options.asyncCodex === true,
    unavailableReason: "Codex CLI 未安装或未登录。",
    execution: "deferred"
  },
  {
    name: ACTIVATE_SKILL_TOOL_NAME,
    title: "启用 Skill",
    summary: "为当前会话加载一个已审批 Skill。",
    definition: (options) => createActivateSkillTool(skillIds(options)),
    available: (options) => skillCapability(options, "activate"),
    unavailableReason: "当前环境未启用 Skill 激活能力。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: READ_SKILL_RESOURCE_TOOL_NAME,
    title: "读取 Skill 资源",
    summary: "读取当前会话已启用 Skill 的一个有界资源。",
    definition: (options) => createReadSkillResourceTool(skillIds(options)),
    available: (options) => skillCapability(options, "readResource"),
    unavailableReason: "当前环境未启用 Skill 资源读取能力。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: RUN_SKILL_SCRIPT_TOOL_NAME,
    title: "运行 Skill 脚本",
    summary: "通过审计和强隔离运行当前会话已启用 Skill 的脚本。",
    definition: (options) => createRunSkillScriptTool(skillIds(options)),
    available: (options) => skillCapability(options, "runScript"),
    unavailableReason: "当前环境没有可用的 Skill 脚本审计执行器。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: SYSTEM_CONFIG_TOOL_NAME,
    title: "系统设置",
    summary: "查询状态并调整当前 Agent 的受控行为设置。",
    definition: () => systemConfigTool,
    available: (options) => Boolean(options.systemConfig),
    unavailableReason: "仅管理员私聊和管理员 Web Chat 可以使用。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: CRON_TOOL_NAME,
    title: "定时任务",
    summary: "管理当前 Agent 的主动定时回调。",
    definition: () => cronTool,
    available: (options) => Boolean(options.cron),
    unavailableReason: "当前会话未提供定时任务能力。",
    unavailabilityKind: "session",
    accessLabel: "全部群聊、管理员私聊与 Web Chat 可用",
    accessDescription: "群聊成员均可使用；私聊与 Web Chat 仅管理员可用。",
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: CALL_DIRECTOR_TOOL_NAME,
    title: "日常导演",
    summary: "让角色请求演绎导演调整今天尚未结束的行程。",
    definition: () => callDirectorTool,
    available: (options) => Boolean(options.director),
    unavailableReason: "当前 Agent 的日常导演不可用。",
    defaultEnabled: true,
    execution: "inline"
  }
];

validateCatalog(catalog);

export function isAgentToolName(value: string): value is AgentToolName {
  return (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

export function listToolMetadata(
  options: ToolAvailability = {},
  promptDefinitions?: OpenAIToolDefinition[]
): ToolMetadata[] {
  const promptByName = promptDefinitionMap(promptDefinitions);
  return catalog.map((entry) => {
    const canonical = entry.definition(options);
    const prompt = promptByName?.get(entry.name);
    const override = toolOverride(options, entry.name);
    const available = entry.available?.(options) ?? true;
    const promptEnabled = promptByName == null || Boolean(prompt) || entry.defaultEnabled === true;
    const enabled = override?.enabled ?? promptEnabled;
    const selected = applyRuntimeToolContract(entry, prompt ?? canonical, canonical);
    const defaultDescription = readDescription(canonical);
    const promptDescription = prompt ? readDescription(prompt) : undefined;
    const description = runtimeToolDescription(
      entry,
      normalizedDescription(override?.description) ?? promptDescription ?? defaultDescription,
      options
    );
    const descriptionSource: ToolDescriptionSource = normalizedDescription(override?.description)
      ? "override"
      : promptDescription != null
        ? "prompt"
        : "default";
    const execution = effectiveExecution(entry, options);
    const effectiveDefinition = applyDispatchSchema({ ...selected, description }, execution);
    const conversationEnabled = isConversationToolEnabled(options.disabledTools, entry.name);
    return {
      name: entry.name,
      title: entry.title,
      summary: entry.summary,
      description,
      defaultDescription,
      ...(promptDescription == null ? {} : { promptDescription }),
      descriptionSource,
      configuredEnabled: override?.enabled ?? null,
      promptEnabled,
      enabled,
      available,
      effectiveEnabled: enabled && available && conversationEnabled && metadataContextReady(entry.name, options),
      ...(!available && entry.unavailableReason ? {
        availabilityReason: entry.unavailableReason,
        unavailabilityKind: entry.unavailabilityKind ?? "runtime"
      } : {}),
      ...(entry.accessLabel ? { accessLabel: entry.accessLabel } : {}),
      ...(entry.accessDescription ? { accessDescription: entry.accessDescription } : {}),
      execution,
      parameters: readParameters(effectiveDefinition),
      strict: effectiveDefinition.strict === true
    };
  });
}

export function resolveProviderToolDefinitions(
  options: ToolAvailability,
  promptDefinitions?: OpenAIToolDefinition[]
) {
  const promptByName = promptDefinitionMap(promptDefinitions);
  return catalog.flatMap((entry) => {
    if (!isConversationToolEnabled(options.disabledTools, entry.name)) return [];
    if (entry.name === WORKSPACE_BASH_TOOL_NAME && !isWorkspaceBashProviderOptions(options.bash)) return [];
    if (!providerContextReady(entry.name, options)) return [];
    if (!(entry.available?.(options) ?? true)) return [];
    const override = toolOverride(options, entry.name);
    if (override?.enabled === false) return [];
    const prompt = promptByName?.get(entry.name);
    if (promptByName && !prompt && override?.enabled !== true && entry.defaultEnabled !== true) return [];
    const canonical = entry.definition(options);
    const definition = applyRuntimeToolContract(entry, prompt ?? canonical, canonical);
    const description = runtimeToolDescription(
      entry,
      normalizedDescription(override?.description) ?? readDescription(definition),
      options
    );
    return [{ ...definition, description }];
  });
}

export function providerToolExecutionMode(name: string, options: ToolAvailability = {}) {
  if (!isAgentToolName(name) || toolOverride(options, name)?.enabled === false) return undefined;
  if (!isConversationToolEnabled(options.disabledTools, name)) return undefined;
  const entry = catalog.find((candidate) => candidate.name === name);
  return entry ? effectiveExecution(entry, options) : undefined;
}

export function isProviderToolAvailable(name: string, options: ToolAvailability = {}) {
  if (!isAgentToolName(name) || toolOverride(options, name)?.enabled === false) return false;
  if (!isConversationToolEnabled(options.disabledTools, name)) return false;
  if (name === WORKSPACE_BASH_TOOL_NAME) return isWorkspaceBashProviderOptions(options.bash);
  if (!providerContextReady(name, options)) return false;
  const entry = catalog.find((candidate) => candidate.name === name);
  return Boolean(entry && (entry.available?.(options) ?? true));
}

export function isProviderDeferredTool(name: string, options: ToolAvailability = {}) {
  return providerToolExecutionMode(name, options) === "deferred";
}

function promptDefinitionMap(definitions: OpenAIToolDefinition[] | undefined) {
  if (definitions == null) return undefined;
  return new Map(definitions.map((tool) => [tool.function.name, {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    ...(typeof tool.function.strict === "boolean" ? { strict: tool.function.strict } : {})
  } satisfies Record<string, unknown>]));
}

function skillIds(options: ToolAvailability) {
  return [...(options.skills?.skillIds ?? options.skillCapabilities?.skillIds ?? [])];
}

function skillCapability(
  options: ToolAvailability,
  capability: "activate" | "readResource" | "runScript"
) {
  const projected = options.skillCapabilities?.[capability];
  if (projected != null) return projected;
  if (capability === "activate") return typeof options.skills?.activate === "function";
  if (capability === "readResource") return typeof options.skills?.readResource === "function";
  return typeof options.skills?.runScript === "function";
}

function metadataContextReady(name: AgentToolName, options: ToolAvailability) {
  return isSkillTool(name) ? skillIds(options).length > 0 : true;
}

function providerContextReady(name: AgentToolName, options: ToolAvailability) {
  return isSkillTool(name) ? Boolean(options.skills?.skillIds.length) : true;
}

function isSkillTool(name: AgentToolName) {
  return name === ACTIVATE_SKILL_TOOL_NAME
    || name === READ_SKILL_RESOURCE_TOOL_NAME
    || name === RUN_SKILL_SCRIPT_TOOL_NAME;
}

function toolOverride(options: ToolAvailability, name: AgentToolName): BotToolOverride | undefined {
  const override = options.bot?.tools.overrides?.[name];
  if (!override || (name !== WORKSPACE_BASH_TOOL_NAME && name !== CODEX_TOOL_NAME)) return override;
  return override.description == null ? undefined : { description: override.description };
}

function effectiveExecution(entry: ToolCatalogEntry, options: ToolAvailability): ToolExecution {
  if (options.asyncImage && (entry.name === GENERATE_IMG_TOOL_NAME || entry.name === SELFIE_TOOL_NAME)) {
    return "deferred";
  }
  return entry.execution;
}

function applyRuntimeToolContract(
  entry: ToolCatalogEntry,
  selected: Record<string, unknown>,
  canonical: Record<string, unknown>
) {
  if (
    entry.name !== SYSTEM_CONFIG_TOOL_NAME
    && entry.name !== CRON_TOOL_NAME
    && entry.name !== CALL_DIRECTOR_TOOL_NAME
    && entry.name !== READ_AIR_TOOL_NAME
    && entry.name !== WEBFETCH_TOOL_NAME
    && entry.name !== GENERATE_IMG_TOOL_NAME
    && entry.name !== SELFIE_TOOL_NAME
    && entry.name !== READ_FILE_TOOL_NAME
    && entry.name !== WRITE_FILE_TOOL_NAME
    && entry.name !== SEND_FILE_TOOL_NAME
    && entry.name !== SEND_VOICE_MESSAGE_TOOL_NAME
    && entry.name !== ACTIVATE_SKILL_TOOL_NAME
    && entry.name !== READ_SKILL_RESOURCE_TOOL_NAME
    && entry.name !== RUN_SKILL_SCRIPT_TOOL_NAME
  ) return selected;
  return {
    ...selected,
    parameters: readParameters(canonical),
    strict: canonical.strict === true
  };
}

function runtimeToolDescription(entry: ToolCatalogEntry, description: string, _options: ToolAvailability) {
  if (
    (entry.name !== GENERATE_IMG_TOOL_NAME && entry.name !== SELFIE_TOOL_NAME) ||
    description.includes("historical media handles")
  ) {
    return description;
  }
  return `${description.trim()} Prefer exact historical media handles shown in conversation history; use the reference source only as a fallback.`.trim();
}

function applyDispatchSchema(tool: Record<string, unknown>, execution: ToolExecution) {
  return execution === "deferred" ? withRequiredDispatchMessage(tool) : withoutDispatchMessage(tool);
}

function readDescription(tool: Record<string, unknown>) {
  return String(tool.description ?? "");
}

function normalizedDescription(value: unknown) {
  if (typeof value !== "string") return undefined;
  const description = value.trim();
  return description || undefined;
}

function readParameters(tool: Record<string, unknown>) {
  const parameters = tool.parameters;
  return parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? structuredClone(parameters as Record<string, unknown>)
    : {};
}

function validateCatalog(entries: readonly ToolCatalogEntry[]) {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate tool registry entry: ${entry.name}`);
    names.add(entry.name);
  }
  const missing = AGENT_TOOL_NAMES.find((name) => !names.has(name));
  if (missing || names.size !== AGENT_TOOL_NAMES.length) {
    throw new Error(`Tool registry does not match Agent tool names${missing ? `: ${missing}` : ""}.`);
  }
}
