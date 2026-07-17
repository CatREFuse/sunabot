import type { AppConfig } from "../../src/types.js";
import type { PromptFileKind, PromptVariableDefinition } from "./promptSystem.js";

export interface PromptFileDefinition {
  id: string;
  title: string;
  category: string;
  kind: PromptFileKind;
  scope: "persona" | "system";
  allowBlank: boolean;
  variables: readonly PromptVariableDefinition[];
  fileName(config: AppConfig): string;
}

const commonVariables = [
  variable("bot.name", "Bot 名字", "string", "Agent 配置"),
  variable("user.name", "私聊中的用户名字；非私聊为空", "string", "当前会话"),
  variable("runtime.current_time", "当前系统时间（ISO 8601）", "string", "系统时钟"),
  variable("utils.roll", "本次提示词调用生成的 1～100 随机整数", "number", "运行时工具变量")
] as const;

const fragmentVariables = [
  variable("persona.agents", "Agent 工作区规则", "string", "AGENTS.md"),
  variable("persona.soul", "角色身份、性格与表达方式", "string", "SOUL.md"),
  variable("persona.preference", "角色偏好与行为边界", "string", "PREFERENCE.md"),
  variable(
    "persona.dialogue_style_examples",
    "角色必须严格遵从的对话风格示例",
    "string",
    "DIALOGUE_STYLE_EXAMPLES.md"
  ),
  variable("persona.user", "角色对用户的称呼和认知", "string", "USER.md"),
  variable("persona.relation", "角色与其他人物的关系", "string", "RELATION.md")
] as const;

const conversationVariables = [
  variable("runtime.output_rules", "最终回复的通用输出规则", "string", "运行时"),
  variable("runtime.address_rules", "根据管理员配置生成的称呼规则", "string", "运行时"),
  variable("runtime.scope_rules", "私聊、用户群聊和 Bot 群聊的处理规则", "string", "运行时"),
  variable("runtime.tool_rules", "图像与自拍工具的调用规则", "string", "运行时"),
  variable("messages_64", "当前消息之前最近最多 64 条完整会话消息；群聊消息包含时间、顺序、消息 ID、显示名、uid 和引用目标", "message[]", "会话上下文"),
  variable("conversation.messages", "当前消息之前可直接发送给模型的会话消息", "message[]", "会话上下文"),
  variable("memory.working", "工作记忆召回结果", "string", "记忆召回"),
  variable("memory.long_term", "长期记忆召回结果", "string", "记忆召回"),
  variable("memory.user_profile", "用户画像召回结果", "string", "记忆召回"),
  variable("user.input", "当前用户消息和附件正文组成的输入", "string", "当前请求")
] as const;

const groupConversationVariables = [
  ...conversationVariables,
  variable(
    "conversation.group.thread_context",
    "群聊 Thread 前置节点生成的安全序列化话题索引",
    "string",
    "群聊上下文前置节点"
  )
] as const;

export const PROMPT_FILE_DEFINITIONS = [
  fragment("persona.agents", "Agent 规则", "人格", "AGENTS.md"),
  fragment("persona.soul", "核心人格", "人格", "SOUL.md"),
  fragment("persona.preference", "偏好", "人格", "PREFERENCE.md"),
  fragment(
    "persona.dialogue_style_examples",
    "对话风格示例",
    "人格",
    "DIALOGUE_STYLE_EXAMPLES.md"
  ),
  fragment("persona.user", "用户关系", "人格", "USER.md"),
  fragment("persona.relation", "关系", "人格", "RELATION.md"),
  final("conversation.private-reply", "单聊回复", "对话", () => "conversation_private_reply.json", conversationVariables),
  final(
    "conversation.group-reply",
    "群聊回复",
    "对话",
    () => "conversation_group_reply.json",
    groupConversationVariables
  ),
  final(
    "conversation.tone-rewrite",
    "语气改写",
    "对话",
    () => "tone_rewrite.json",
    [variable("tone.input", "即将发送到会话的原始文本", "string", "出站消息")]
  ),
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
    "orchestrator.group-thread",
    "群聊 Thread 拆分",
    "编排器",
    () => "group_thread_context.json",
    [variable("thread.payload", "已有 Thread 状态和本次新增的完整群聊消息", "json", "群聊上下文前置节点")]
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
    ],
    "persona"
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
    scope: "persona",
    allowBlank: false,
    variables: mergeVariables(commonVariables, fragmentVariables.filter((item) => item.name !== id)),
    fileName: () => fileName
  };
}

function final(
  id: string,
  title: string,
  category: string,
  fileName: (config: AppConfig) => string,
  variables: readonly PromptVariableDefinition[],
  scope: PromptFileDefinition["scope"] = "system"
): PromptFileDefinition {
  return {
    id,
    title,
    category,
    kind: "final",
    scope,
    allowBlank: false,
    variables: mergeVariables(commonVariables, fragmentVariables, variables),
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
