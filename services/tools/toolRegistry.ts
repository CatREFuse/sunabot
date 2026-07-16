import type { OpenAIToolDefinition } from "../agent/public.js";
import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type BotConfig,
  type BotToolOverride
} from "../../src/types.js";
import { createWorkspaceBashTool, WORKSPACE_BASH_TOOL_NAME } from "./bashTool.js";
import {
  CODEX_TOOL_NAME,
  codexTool,
  MEMORY_RECALL_TOOL_NAME,
  memoryRecallTool,
  WEBSEARCH_TOOL_NAME,
  websearchTool
} from "./definitions.js";
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
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  readFileTool,
  writeFileTool
} from "./workbenchFileTool.js";
import { withRequiredDispatchMessage, withoutDispatchMessage } from "./deferredDispatch.js";

export interface ToolAvailability {
  onAssistantText?: unknown;
  allowNoReply?: boolean;
  workbenchFiles?: {
    read(input: unknown): Promise<unknown>;
    write(input: unknown): Promise<unknown>;
  };
  bash?: { enabled: boolean; workspaceOnly?: boolean; blockedKeywords?: string[] };
  bot?: Pick<BotConfig, "tools">;
  selfie?: { enabled: boolean };
  memory?: { enabled: boolean };
  asyncCodex?: boolean;
  asyncImage?: boolean;
  imageTools?: boolean;
  systemConfig?: SystemConfigToolPort;
}

export type ToolExecution = "inline" | "deferred";
export type ToolDescriptionSource = "override" | "prompt" | "default";

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
    name: WEBSEARCH_TOOL_NAME,
    title: "网页搜索",
    summary: "搜索网页并返回结果。",
    definition: () => websearchTool,
    available: (options) => Boolean(options.bot?.tools.websearch),
    unavailableReason: "网页搜索配置不可用。",
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
    defaultEnabled: true,
    execution: "inline"
  },
  {
    name: WORKSPACE_BASH_TOOL_NAME,
    title: "Bash",
    summary: "在 Agent workspace 内执行 Bash 命令。",
    definition: (options) => createWorkspaceBashTool(options.bash),
    available: (options) => options.bash?.enabled === true,
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
    name: SYSTEM_CONFIG_TOOL_NAME,
    title: "系统设置",
    summary: "查询状态并调整当前 Agent 的受控行为设置。",
    definition: () => systemConfigTool,
    available: (options) => Boolean(options.systemConfig),
    unavailableReason: "仅管理员私聊和管理员 Web Chat 可以使用。",
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
      normalizedDescription(override?.description) ?? promptDescription ?? defaultDescription
    );
    const descriptionSource: ToolDescriptionSource = normalizedDescription(override?.description)
      ? "override"
      : promptDescription != null
        ? "prompt"
        : "default";
    const execution = effectiveExecution(entry, options);
    const effectiveDefinition = applyDispatchSchema({ ...selected, description }, execution);
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
      effectiveEnabled: enabled && available,
      ...(!available && entry.unavailableReason ? { availabilityReason: entry.unavailableReason } : {}),
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
    if (!(entry.available?.(options) ?? true)) return [];
    const override = toolOverride(options, entry.name);
    if (override?.enabled === false) return [];
    const prompt = promptByName?.get(entry.name);
    if (promptByName && !prompt && override?.enabled !== true && entry.defaultEnabled !== true) return [];
    const canonical = entry.definition(options);
    const definition = applyRuntimeToolContract(entry, prompt ?? canonical, canonical);
    const description = runtimeToolDescription(
      entry,
      normalizedDescription(override?.description) ?? readDescription(definition)
    );
    return [{ ...definition, description }];
  });
}

export function providerToolExecutionMode(name: string, options: ToolAvailability = {}) {
  if (!isAgentToolName(name) || toolOverride(options, name)?.enabled === false) return undefined;
  const entry = catalog.find((candidate) => candidate.name === name);
  return entry ? effectiveExecution(entry, options) : undefined;
}

export function isProviderToolAvailable(name: string, options: ToolAvailability = {}) {
  if (!isAgentToolName(name) || toolOverride(options, name)?.enabled === false) return false;
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
    && entry.name !== GENERATE_IMG_TOOL_NAME
    && entry.name !== SELFIE_TOOL_NAME
    && entry.name !== READ_FILE_TOOL_NAME
    && entry.name !== WRITE_FILE_TOOL_NAME
  ) return selected;
  return {
    ...selected,
    parameters: readParameters(canonical),
    strict: canonical.strict === true
  };
}

function runtimeToolDescription(entry: ToolCatalogEntry, description: string) {
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
