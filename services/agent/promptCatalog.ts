import type { AppConfig } from "../../src/types.js";
import type { PromptFileKind, PromptVariableDefinition } from "./promptSystem.js";

export interface PromptFileDefinition {
  id: string;
  title: string;
  category: string;
  kind: PromptFileKind;
  allowBlank: boolean;
  variables: readonly PromptVariableDefinition[];
  fileName(config: AppConfig): string;
}

const fragmentVariables = [
  variable("persona.agents", "Agent 工作区规则", "string", "AGENTS.md"),
  variable("persona.soul", "角色身份、性格与表达方式", "string", "SOUL.md"),
  variable("persona.preference", "角色偏好与行为边界", "string", "PREFERENCE.md"),
  variable("persona.user", "角色对用户的称呼和认知", "string", "USER.md"),
  variable("persona.relation", "角色与其他人物的关系", "string", "RELATION.md")
] as const;

const conversationVariables = [
  variable("runtime.output_rules", "最终回复的通用输出规则", "string", "运行时"),
  variable("runtime.address_rules", "根据管理员配置生成的称呼规则", "string", "运行时"),
  variable("runtime.scope_rules", "私聊、用户群聊和 Bot 群聊的处理规则", "string", "运行时"),
  variable("runtime.tool_rules", "图像与自拍工具的调用规则", "string", "运行时"),
  variable("messages_64", "当前消息之前最近最多 64 条会话消息", "message[]", "会话上下文"),
  variable("conversation.messages", "当前消息之前可直接发送给模型的会话消息", "message[]", "会话上下文"),
  variable("memory.working", "工作记忆召回结果", "string", "记忆召回"),
  variable("memory.long_term", "长期记忆召回结果", "string", "记忆召回"),
  variable("memory.user_profile", "用户画像召回结果", "string", "记忆召回"),
  variable("user.input", "当前用户消息和附件正文组成的输入", "string", "当前请求")
] as const;

export const PROMPT_FILE_DEFINITIONS = [
  fragment("persona.agents", "Agent 规则", "人格", "AGENTS.md"),
  fragment("persona.soul", "核心人格", "人格", "SOUL.md"),
  fragment("persona.preference", "偏好", "人格", "PREFERENCE.md"),
  fragment("persona.user", "用户关系", "人格", "USER.md"),
  fragment("persona.relation", "关系", "人格", "RELATION.md"),
  final("conversation.reply", "对话回复", "对话", () => "conversation_reply.json", conversationVariables),
  final(
    "memory.compress-in",
    "工作记忆提取",
    "记忆",
    (config) => config.bot.memory.workMemoryCompressInPrompt,
    [variable("memory.payload", "原工作记忆、参与者和本批消息", "json", "记忆引擎")]
  ),
  final(
    "memory.compress-out",
    "长期记忆压缩",
    "记忆",
    (config) => config.bot.memory.workMemoryCompressOutPrompt,
    [variable("memory.payload", "待压缩的完整工作记忆", "json", "记忆引擎")]
  ),
  final(
    "memory.user-profile",
    "用户画像提取",
    "记忆",
    (config) => config.bot.memory.userProfilePrompt,
    [variable("profile.payload", "参与者、原画像和本批消息", "json", "用户画像引擎")]
  ),
  final(
    "orchestrator.user-group",
    "群聊编排",
    "编排器",
    (config) => config.bot.orchestrator.promptFile,
    [variable("orchestrator.payload", "群聊触发条件、上下文和当前消息", "json", "群聊编排器")]
  ),
  final(
    "conversation.group-summary",
    "群聊总结",
    "对话",
    () => "group_chat_summary.json",
    [
      ...fragmentVariables,
      variable("group.payload", "总结窗口、群聊信息和消息列表", "json", "会话上下文")
    ]
  ),
  final(
    "image.selfie-rewrite",
    "自拍提示词改写",
    "图像",
    () => "selfie_prompt_rewrite.json",
    [
      ...fragmentVariables,
      variable("selfie.payload", "自拍要求、尺寸和参考图信息", "json", "自拍工具")
    ]
  )
] as const satisfies readonly PromptFileDefinition[];

export type PromptFileId = (typeof PROMPT_FILE_DEFINITIONS)[number]["id"];

export function promptDefinitionById(id: string) {
  return PROMPT_FILE_DEFINITIONS.find((item) => item.id === id);
}

export function promptFragmentVariables() {
  return fragmentVariables;
}

function fragment(id: string, title: string, category: string, fileName: string): PromptFileDefinition {
  return {
    id,
    title,
    category,
    kind: "fragment",
    allowBlank: false,
    variables: fragmentVariables.filter((item) => item.name !== id),
    fileName: () => fileName
  };
}

function final(
  id: string,
  title: string,
  category: string,
  fileName: (config: AppConfig) => string,
  variables: readonly PromptVariableDefinition[]
): PromptFileDefinition {
  return {
    id,
    title,
    category,
    kind: "final",
    allowBlank: false,
    variables: mergeVariables(fragmentVariables, variables),
    fileName
  };
}

function mergeVariables(...groups: ReadonlyArray<readonly PromptVariableDefinition[]>) {
  const values = new Map<string, PromptVariableDefinition>();
  for (const group of groups) {
    for (const item of group) values.set(item.name, item);
  }
  return [...values.values()];
}

function variable(
  name: string,
  description: string,
  type: PromptVariableDefinition["type"],
  source: string
): PromptVariableDefinition {
  return { name, description, type, source, required: true };
}
