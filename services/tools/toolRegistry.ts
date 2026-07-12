import { createWorkspaceBashTool, WORKSPACE_BASH_TOOL_NAME } from "./bashTool.js";
import { CODEX_TOOL_NAME, codexTool, MEMORY_RECALL_TOOL_NAME, memoryRecallTool, WEBSEARCH_TOOL_NAME, websearchTool } from "./definitions.js";
import { GENERATE_IMG_TOOL_NAME, generateImgTool } from "./generateImgTool.js";
import { SELFIE_TOOL_NAME, selfieTool } from "./selfieTool.js";
import { ASSISTANT_TEXT_TOOL_NAME, assistantTextTool } from "./assistantTextTool.js";

export interface ToolAvailability {
  onAssistantText?: unknown;
  bash?: { enabled: boolean; workspaceOnly?: boolean; blockedKeywords?: string[] };
  bot?: { tools: { websearch: unknown; generateImg: unknown } };
  selfie?: { enabled: boolean };
  memory?: { enabled: boolean };
  asyncCodex?: boolean;
  asyncImage?: boolean;
}

export interface ToolMetadata {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
}

interface ToolCatalogEntry {
  name: string;
  title: string;
  description: string;
  definition?: (options: ToolAvailability) => Record<string, unknown>;
  available?: (options: ToolAvailability) => boolean;
  execution: "inline" | "deferred" | "external";
}

const catalog: readonly ToolCatalogEntry[] = [
  { name: "system.time", title: "时间", description: "读取当前时间和时区。", execution: "external" },
  {
    name: MEMORY_RECALL_TOOL_NAME,
    title: "记忆召回",
    description: "从 Agent 记忆中召回相关内容。",
    definition: () => memoryRecallTool,
    available: (options) => options.memory?.enabled === true,
    execution: "inline"
  },
  { name: "onebot.send_message", title: "发送消息", description: "向 OneBot 私聊或群聊发送消息。", execution: "external" },
  {
    name: ASSISTANT_TEXT_TOOL_NAME,
    title: "行动中消息",
    description: "在多轮行动中发送一条助手消息。",
    definition: () => assistantTextTool,
    available: (options) => typeof options.onAssistantText === "function",
    execution: "inline"
  },
  {
    name: WEBSEARCH_TOOL_NAME,
    title: "网页搜索",
    description: "搜索网页并返回结果。",
    definition: () => websearchTool,
    available: (options) => Boolean(options.bot?.tools.websearch),
    execution: "inline"
  },
  {
    name: GENERATE_IMG_TOOL_NAME,
    title: "生图",
    description: "生成图片并保存结果。",
    definition: () => generateImgTool,
    available: (options) => Boolean(options.bot?.tools.generateImg),
    execution: "inline"
  },
  {
    name: SELFIE_TOOL_NAME,
    title: "自拍",
    description: "生成 Bot 自己的形象图。",
    definition: () => selfieTool,
    available: (options) => options.selfie?.enabled === true,
    execution: "inline"
  },
  {
    name: WORKSPACE_BASH_TOOL_NAME,
    title: "Bash",
    description: "在 Agent workspace 内执行 Bash 命令。",
    definition: (options) => createWorkspaceBashTool(options.bash),
    available: (options) => options.bash?.enabled === true,
    execution: "inline"
  },
  {
    name: CODEX_TOOL_NAME,
    title: "Codex",
    description: "把长任务交给异步 Codex worker。",
    definition: () => codexTool,
    available: (options) => options.asyncCodex === true,
    execution: "deferred"
  },
  { name: "provider.test", title: "模型检查", description: "检查当前 provider 的连接状态。", execution: "external" }
];

validateCatalog(catalog);

export function listToolMetadata(): ToolMetadata[] {
  return catalog.map(({ name, title, description }) => ({ name, title, description, enabled: true }));
}

export function resolveProviderToolDefinitions(options: ToolAvailability) {
  return catalog
    .filter((entry) => entry.definition && (entry.available?.(options) ?? true))
    .map((entry) => entry.definition!(options));
}

export function providerToolExecutionMode(name: string, options: ToolAvailability = {}) {
  const execution = catalog.find((entry) => entry.name === name)?.execution;
  if (options.asyncImage && (name === GENERATE_IMG_TOOL_NAME || name === SELFIE_TOOL_NAME)) {
    return "deferred" as const;
  }
  return execution;
}

export function isProviderDeferredTool(name: string, options: ToolAvailability = {}) {
  return providerToolExecutionMode(name, options) === "deferred";
}

function validateCatalog(entries: readonly ToolCatalogEntry[]) {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate tool registry entry: ${entry.name}`);
    names.add(entry.name);
    if (entry.definition && entry.execution === "external") {
      throw new Error(`Model tool ${entry.name} has no provider execution mode.`);
    }
  }
}
