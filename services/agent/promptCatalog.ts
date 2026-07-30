import type { AppConfig } from "../../packages/contracts/admin/public.js";
import type { PromptFileKind, PromptVariableDefinition } from "./promptSystem.js";
import {
  SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
  SCHEDULED_TASK_CALLBACK_PROMPT_ID,
  SCHEDULED_TASK_PAYLOAD_VARIABLE
} from "./scheduledTaskPrompt.js";
import {
  TONE_AVAILABLE_ASSETS_VARIABLE,
  TONE_MODE_VARIABLE,
  TONE_OUTPUT_CONTRACT_VARIABLE
} from "./toneReplyPrompt.js";
import {
  DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE,
  DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE,
  DIRECTOR_DAILY_PLAN_PROMPT_FILE,
  DIRECTOR_DAILY_PLAN_PROMPT_ID,
  DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE,
  DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE,
  DIRECTOR_SCHEDULE_REVISION_PROMPT_ID,
  DIRECTOR_SEED_FILE,
  DIRECTOR_SEED_PROMPT_ID,
  DIRECTOR_SEED_VARIABLE
} from "../director/public.js";
import {
  AIR_CONVERSATION_VARIABLE,
  AIR_INSIGHT_VARIABLE,
  AIR_KNOWLEDGE_FILE,
  AIR_KNOWLEDGE_PROMPT_FILE,
  AIR_KNOWLEDGE_PROMPT_ID,
  AIR_KNOWLEDGE_VARIABLE,
  AIR_PERSONA_VARIABLE
} from "../air/public.js";
import {
  DREAM_PAYLOAD_VARIABLE,
  DREAM_PROMPT_FILE,
  DREAM_PROMPT_ID
} from "../memory/public.js";

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
  variable("runtime.current_time", "当前系统时间（含 UTC 偏移与系统 IANA 时区）", "string", "系统时钟与系统时区"),
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
  variable("persona.relation", "角色与其他人物的关系", "string", "RELATION.md"),
  variable(AIR_PERSONA_VARIABLE, "角色在社交场域中的实时知识", "string", AIR_KNOWLEDGE_FILE)
] as const;

const conversationVariables = [
  variable("runtime.output_rules", "最终回复的通用输出规则", "string", "运行时"),
  variable("runtime.address_rules", "根据管理员配置生成的称呼规则", "string", "运行时"),
  variable("runtime.scope_rules", "私聊、用户群聊和 Bot 群聊的处理规则", "string", "运行时"),
  variable("runtime.tool_rules", "图像与自拍工具的调用规则", "string", "运行时"),
  variable("conversation.emoji.keys", "当前 Agent 已配置且可发送的表情 key 列表", "json", "Agent 表情库"),
  variable("conversation.emoji.syntax", "表情发送标记规则", "string", "Agent 表情库"),
  variable("conversation.voice.settings", "当前 Agent 的语音开关、默认语言和在线音色状态", "json", "Agent 语音设置"),
  variable("conversation.voice.trigger_policy", "语音伴生消息的触发边界", "string", "Agent 语音设置"),
  variable("messages_64", "当前消息之前最近最多 64 条完整会话消息；群聊消息包含时间、顺序、消息 ID、显示名、uid 和引用目标", "message[]", "会话上下文"),
  variable("conversation.messages", "当前消息之前可直接发送给模型的会话消息", "message[]", "会话上下文"),
  variable("memory.working", "工作记忆召回结果", "string", "记忆召回"),
  variable("memory.long_term", "长期记忆召回结果", "string", "记忆召回"),
  variable("memory.user_profile", "用户画像召回结果", "string", "记忆召回"),
  variable(
    DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE,
    "日常导演已提交的当日语义行程",
    "string",
    "日常导演"
  ),
  variable("user.input", "当前用户消息，或声明 role=callback 的系统回调输入", "string", "当前请求")
] as const;

const groupConversationVariables = [
  ...conversationVariables,
  variable(
    "conversation.group.orchestrator_result",
    "主动群聊编排器的触发原因与回复消息 ID；非编排器触发时为空字符串",
    "string",
    "群聊编排器"
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
  fragment(AIR_PERSONA_VARIABLE, "场域知识", "人格", AIR_KNOWLEDGE_FILE),
  fragment(DIRECTOR_SEED_PROMPT_ID, "导演种子剧本", "导演", DIRECTOR_SEED_FILE),
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
    [
      variable("tone.input", "即将发送到会话的原始文本", "string", "出站消息"),
      variable(TONE_MODE_VARIABLE, "当前 Tone 请求是否使用分段 XML", "boolean", "语气处理设置"),
      variable(TONE_OUTPUT_CONTRACT_VARIABLE, "当前回复方式的完整输出格式契约", "string", "语气处理设置"),
      variable(TONE_AVAILABLE_ASSETS_VARIABLE, "本轮允许原样引用的媒体句柄", "json", "出站消息包")
    ]
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
    DREAM_PROMPT_ID,
    "梦境整理",
    "记忆",
    () => DREAM_PROMPT_FILE,
    [variable(DREAM_PAYLOAD_VARIABLE, "记忆、日常、任务、人格证据与稳定随机种子", "json", "睡眠记忆整理器")]
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
    SCHEDULED_TASK_CALLBACK_PROMPT_ID,
    "定时任务回调",
    "调度",
    () => SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
    [variable(SCHEDULED_TASK_PAYLOAD_VARIABLE, "任务背景、计划触发时间和回调目标", "json", "定时任务调度器")]
  ),
  final(
    DIRECTOR_DAILY_PLAN_PROMPT_ID,
    "计划导演",
    "导演",
    () => DIRECTOR_DAILY_PLAN_PROMPT_FILE,
    [
      variable(DIRECTOR_SEED_VARIABLE, "当前角色的导演种子剧本", "string", DIRECTOR_SEED_FILE),
      variable(DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE, "日期、时区、星期和会话概况", "json", "日常导演")
    ]
  ),
  final(
    DIRECTOR_SCHEDULE_REVISION_PROMPT_ID,
    "演绎导演",
    "导演",
    () => DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE,
    [
      variable(DIRECTOR_SEED_VARIABLE, "当前角色的导演种子剧本", "string", DIRECTOR_SEED_FILE),
      variable(
        DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE,
        "当前行程、角色请求和当前时间",
        "json",
        "日常导演"
      )
    ]
  ),
  final(
    AIR_KNOWLEDGE_PROMPT_ID,
    "读空气提示词",
    "场域知识",
    () => AIR_KNOWLEDGE_PROMPT_FILE,
    [
      variable(AIR_KNOWLEDGE_VARIABLE, "原有的完整场域知识", "string", AIR_KNOWLEDGE_FILE),
      variable(AIR_CONVERSATION_VARIABLE, "当前会话的最新聊天记录与范围", "json", "当前会话"),
      variable(AIR_INSIGHT_VARIABLE, "角色调用读空气时注入的想法和理解", "string", "read_air")
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

export function promptDefinitionById(id: string) {
  return PROMPT_FILE_DEFINITIONS.find((item) => item.id === id);
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
