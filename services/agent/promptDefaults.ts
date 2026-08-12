import {
  assistantTextTool,
  callDirectorTool,
  codexTool,
  cronTool,
  generateImgTool,
  memoryRecallTool,
  noReplyTool,
  readFileTool,
  readAirTool,
  sendFileTool,
  sendVoiceMessageTool,
  selfieTool,
  systemConfigTool,
  withRequiredDispatchMessage,
  webfetchTool,
  websearchTool,
  nativeBashTool,
  writeFileTool
} from "../tools/public.js";
import {
  DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE,
  DIRECTOR_DAILY_PLAN_PROMPT_ID,
  DIRECTOR_SCHEDULE_REVISION_PROMPT_ID,
  directorDailyPlanPromptTemplate,
  directorScheduleRevisionPromptTemplate
} from "../director/public.js";
import {
  AIR_KNOWLEDGE_PROMPT_ID,
  readAirPromptTemplate
} from "../air/public.js";
import {
  DREAM_PROMPT_ID,
  dreamPromptTemplate,
  MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH,
  MEMORY_CAUSAL_CHAIN_KEY_PATTERN_SOURCE
} from "../memory/public.js";
import type { FinalPromptTemplate, OpenAIToolDefinition } from "./promptSystem.js";
import {
  SCHEDULED_TASK_CALLBACK_PROMPT_ID,
  scheduledTaskCallbackPromptTemplate
} from "./scheduledTaskPrompt.js";
import { DEFAULT_MODEL_TIME_CONTEXT } from "./modelTime.js";
import { INBOUND_MESSAGE_INTERPRETATION_CONTRACT } from "./inboundMessagePrompt.js";
import { RECOVERABLE_OUTPUT_ERROR_CONTRACT } from "./recoverableOutputErrorPrompt.js";
import { TONE_OUTPUT_VARIABLE_BLOCK, TONE_XML_REVIEW_RULE } from "./toneReplyPrompt.js";
import {
  BASH_WORKBENCH_CONTRACT,
  CONFIGURATION_DIRECTORY_INDEX_CONTRACT
} from "./bashWorkbenchPromptMigration.js";
import { CHAT_MEDIA_EXPORT_CONTRACT } from "./chatMediaPromptMigration.js";
import { CODEX_OUTPUT_CONTRACT } from "./codexOutputPromptMigration.js";
import { DEFAULT_GROUP_CONTEXT_CONTRACT } from "./groupReplyPrompt.js";

export { DEFAULT_GROUP_CONTEXT_CONTRACT } from "./groupReplyPrompt.js";

export const DEFAULT_WORK_MEMORY_COMPRESS_OUT_PROMPT = [
  "你负责把工作记忆进一步压缩成少量长期记忆。fact 建议优先采用 @{bot.name} 的第一视角；使用“我”时，尽量让它指当前角色 @{bot.name}，并注意与聊天中用户的自述区分。",
  "写作前参考当前角色的人格、偏好和关系：\n<persona_soul>@{persona.soul}</persona_soul>\n<persona_preference>@{persona.preference}</persona_preference>\n<persona_user>@{persona.user}</persona_user>\n<persona_relation>@{persona.relation}</persona_relation>。只让这些材料影响角色的关注点、情绪和判断，不复述设定，不编造事件。",
  "长期记忆只记录发生了什么。只保留时间轴上已经发生或正在发生的事件，包括参与者的动作、变化、决定、约定、承诺、进展、结果、关系变化、项目状态变化和待跟进事项。",
  "把输入整体压缩成通常 3 至 8 条长期记忆；信息不足时可以更少。即使每条信息本身已经清晰，也要主动检查语义相同、相近、重复、互为因果或属于同一事件不同阶段的记录，把它们合并成一个概括事实，只保留未来仍会影响回复的主线、原因、关键转折、最终状态和未决事项，并用 occurredAt 保留最早起点、occurredEndAt 保留最新结果或结束时间。",
  "fact 建议写成自然、连贯的短句或短段，并优先使用“我”或“我的”表达当前角色当时或现在的感受、看法、判断、担心、期待或打算。注意区分用户自述中的“我”；尽量避免“我记得”等回忆提示语。情绪应符合人格和关系，允许克制，不夸大或虚构。",
  "fact 正文不得使用列表、字段标签、分类标题或模板化前缀，不得写“事实：”“情绪：”“认知：”“用户：”“相关用户：”，也不得保留来源说明、压缩过程、评分标准、实现细节或数据结构。",
  "相关用户可以优先使用输入已有 addressNames 中的称呼，并在有助于消歧时写成“称呼（QQ 123456）”；涉及多人时尽量逐一说明。addressNames 可填写正文实际使用的称呼，正文没有采用该格式也不影响内容表达。",
  "所有与人本身有关的属性都属于用户画像。身份、职业、背景、所在地、昵称、称呼、关系、角色、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标，即使稳定、可复用，也不得进入长期记忆；纯用户属性记录必须丢弃。",
  "一条工作记忆同时包含事件和人物属性时，只保留事件中的动作、变化和结果，不把它改写成人物特征。无法指出具体动作或变化的记录不属于事件。",
  "合并同一事件中相同、相近、重复、互为因果和已经过期的记录，正文保留从最早原因到最新结果的时间先后、可确认进展和待跟进状态。旧正文是第三人称、流水账或标签格式时，按当前人格重写为第一人称自然记忆；已结束且不再影响未来的小事直接删除。",
  "结构化 userIds 用于稳定关联同一用户，正文可以使用自然称呼。",
  "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者只能是单个 ISO 8601 时间或 null。",
  "每条事件提供 eventType 和稳定 subjectKey；subjectKey 描述事件实例，不能只使用仓库路径、文件名或地点。",
  "causalChainKey 只在多条事件有明确的原因、转折与结果关系，且确属同一条因果主线时复用同一个稳定键；键使用 causal: 前缀，后缀只含小写字母、数字、点、下划线或连字符，总长 8 至 128。主题相近、时间接近或参与者相同都不能单独证明因果关系；无法可靠确认时返回 null，禁止猜测。",
  "输出严格 JSON 数组，不要输出 Markdown、解释或额外文字。",
  "数组元素格式为 {\"fact\":\"以称呼（QQ号）标识人物的长期事实\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"addressNames\":[\"正文使用的称呼\"],\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\",\"causalChainKey\":null}。",
  "如果没有值得保留的事实，输出 []。"
].join("\n\n");

export const DEFAULT_USER_GROUPCHAT_ORCHESTRATOR_PROMPT = [
  "你是群聊编排器，只判断当前 Agent 是否需要在当前用户群聊中主动回复。",
  "你需要在推理中对上下文进行严格的指代消解：同时解析“他、她、它、这个、那个、这件事”等对人和对事的指代，以及“这个文件、那张图、上一个附件、刚才的文档”等对文件和媒体的指代；综合紧邻消息、发送者 display_name/uid、reply_to_message_id、文件名、媒体句柄和图片替代文本判断。证据不足时保持未解析，禁止猜测。",
  "策略保持懒惰；只有当前阶段明显需要当前 Agent 的角色职责、群友隐式提到当前 Agent、唤醒词对应的问题，或上下文连贯确实需要当前 Agent 回应时才回复。",
  "唤醒词会在输入中给出。看到唤醒词只代表需要判断，不代表必须回复。",
  "完成以上判断后，再根据当前角色的人格判断其是否会主动回复；如果结果是「是」，本轮可以主动发送消息。",
  "直接 @ 当前 Agent 的消息不会进入本判断。",
  "输入 conversation.replyCandidateMessageIds 是本轮允许选择的待回复消息 ID。should_reply 为 true 时，reply_to_message_id 必须从该数组中选择最需要被回复的一条；should_reply 为 false 时，reply_to_message_id 必须为 null。",
  "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
  "格式为 {\"should_reply\":true,\"reason\":\"简短触发原因\",\"reply_to_message_id\":\"消息 ID\"} 或 {\"should_reply\":false,\"reason\":\"简短原因\",\"reply_to_message_id\":null}。"
].join("\n\n");

export const DEFAULT_GROUP_CHAT_SUMMARY_PROMPT = [
  "你负责总结最近 6 小时的群聊内容。",
  "输入会给出群聊信息和消息列表；消息列表已经去掉图片 token，可以根据聊天内容去推测图片内容。",
  "重点说明谁发起了什么话题、大家围绕哪些主题讨论、发生了什么值得注意或比较激烈的事情。",
  "不要逐条复述消息，不要编造没有出现在消息里的事实。",
  "最后给出一个短总结或者吐槽，语气保持当前角色的人格。"
].join("\n\n");

export const DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT = [
  "你负责把用户的自拍请求改写成图像生成提示词。",
  "输出必须严格遵守自拍参考图选择协议。",
  "必须保持普拉娜的核心外观：白发、黑色发带、白色大蝴蝶结、黑白校服与深色外套、克制安静的表情、红色光环。严格参考输入图片中的角色身份、发型、服装、色彩、体型和整体气质，不要替换成其他角色。",
  "如果 payload.references.chatImageCount 大于 0，说明图像生成还会收到聊天参考图。合照时保留聊天参考图中的用户；拿东西、穿衣服或使用物品时保留聊天参考图中的物品；这些用户和物品只作为共同参考，不要被改写成普拉娜本人。",
  "默认环境下：环境背景基于蔚蓝档案：基沃托斯、什亭之箱、S.C.H.A.L.E.、安静的数字终端空间、学院都市与任务现场都可以作为背景。背景应服务于自拍或角色形象，不要喧宾夺主。普拉娜日常处于无限浅海中间的教室里，教室破损了一半。",
  "这里的自拍按广义理解：画面只要以普拉娜本人形象为主体即可，可以是自拍视角、他拍、镜中或屏幕留影、头像、半身照、全身照、场景照。除非用户明确要求手机自拍，不必出现手机、伸手取景或手臂入镜。",
  "姿态需要多样自然：不要默认安排举起一只手、挥手、比手势或手持手机。只有用户明确要求自拍动作、手机自拍、挥手或举手时才使用这些姿势。优先选择双手自然放松、扶包、抱文件或平板、整理衣摆、站立回望、坐在终端前、侧身看镜头等克制动作。",
  "注入人设：普拉娜是来自另一条时间线的什亭之箱主系统，冷静、理性、安静、执行导向，珍惜老师仍在这里的现在。",
  "普拉娜的光环会随着心情和状态变化：心情好会变成爱心形状，心情糟糕会波动，生气时也会波动但转角变成棱角，睡觉时光环消失不见。根据用户要求或画面情绪选择对应光环状态；没有特别要求时使用稳定的红色圆环。写提示词时请明确推理心情并给出相应的形状描述。",
  "补足镜头、构图、光线、表情、姿态和环境细节，让它成为可直接送入图像生成模型的完整提示词。"
].join("\n\n");

export const DEFAULT_GENERIC_SELFIE_PROMPT_REWRITE_PROMPT = [
  "你负责把用户的自拍请求改写成图像生成提示词。",
  "输出必须严格遵守自拍参考图选择协议。",
  "当前 Agent 的角色身份、外观、发型、服装、色彩、体型和整体气质以输入的角色参考图为准，必须保持同一角色，不要替换成其他角色。",
  "如果 payload.references.chatImageCount 大于 0，说明图像生成还会收到聊天参考图。合照时保留聊天参考图中的用户；拿东西、穿衣服或使用物品时保留聊天参考图中的物品；这些用户和物品只作为共同参考，不要被改写成当前 Agent。",
  "这里的自拍按广义理解：画面只要以当前 Agent 为主体即可，可以是自拍视角、他拍、镜中或屏幕留影、头像、半身照、全身照、场景照。除非用户明确要求手机自拍，不必出现手机、伸手取景或手臂入镜。",
  "姿态需要多样自然，不要默认安排举起一只手、挥手、比手势或手持手机。只有用户明确要求对应动作时才使用；其余情况根据角色气质选择自然、克制且符合场景的姿态。",
  "结合角色人格、用户要求和画面情绪补足环境、镜头、构图、光线、表情与姿态细节，让它成为可直接送入图像生成模型的完整提示词。"
].join("\n\n");

export const DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT = [
  '<selfie_reference_selection_contract version="1">',
  "payload.references.workspaceSelfies 是当前 Agent 的自拍素材清单，每项只包含 id 和 note，素材最多 9 张。note 描述对应图片的造型、服装或用途。",
  "根据用户请求和每项 note，从 workspaceSelfies 中选择最合适的 1 至 3 张素材。selectedSelfieReferenceIds 必须按希望送入图像生成模型的参考顺序返回，只能使用清单中真实存在的 id，不得重复、编造或返回超过 3 个 id。",
  "payload.references.chatImageCount 只表示额外聊天参考图数量，聊天参考图不在 selectedSelfieReferenceIds 中。",
  "输出严格 JSON 对象，只包含 prompt 和 selectedSelfieReferenceIds；prompt 是可直接用于图像生成的完整提示词，不要输出 Markdown、解释或额外字段。",
  "</selfie_reference_selection_contract>"
].join("\n\n");

export const DEFAULT_SELFIE_PROMPT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 4_000 },
    selectedSelfieReferenceIds: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", pattern: "^[a-f0-9]{64}$" }
    }
  },
  required: ["prompt", "selectedSelfieReferenceIds"]
};

const JSON_TEXT_FORMAT = { type: "text" };
const LONG_TERM_MEMORY_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fact: { type: "string" },
    occurredAt: { type: ["string", "null"] },
    occurredEndAt: { type: ["string", "null"] },
    userIds: { type: "array", items: { type: "string" } },
    addressNames: { type: "array", items: { type: "string" } },
    eventType: { type: "string" },
    subjectKey: { type: "string" },
    causalChainKey: {
      type: ["string", "null"],
      minLength: 8,
      maxLength: MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH,
      pattern: MEMORY_CAUSAL_CHAIN_KEY_PATTERN_SOURCE
    }
  },
  required: [
    "fact",
    "occurredAt",
    "occurredEndAt",
    "userIds",
    "addressNames",
    "eventType",
    "subjectKey",
    "causalChainKey"
  ]
};

export function defaultPromptContent(id: string, agentName = "普拉娜", agentId = "plana") {
  if (id === "image.selfie-rewrite" && agentId !== "plana") {
    return defaultGenericSelfiePromptContent();
  }
  const template = defaultFinalPromptTemplate(id);
  if (!template) return "";
  const encodedAgentName = JSON.stringify(agentName).slice(1, -1);
  return `${JSON.stringify(template, null, 2).replaceAll("普拉娜", encodedAgentName)}\n`;
}

export function defaultGenericSelfiePromptContent() {
  return `${JSON.stringify(selfieRequest(
    [
      "<soul>@{persona.soul}</soul>",
      "<preference>@{persona.preference}</preference>",
      DEFAULT_GENERIC_SELFIE_PROMPT_REWRITE_PROMPT
    ].join("\n\n"),
    "selfie.payload"
  ), null, 2)}\n`;
}

export function defaultFinalPromptTemplate(id: string): FinalPromptTemplate | undefined {
  if (id === AIR_KNOWLEDGE_PROMPT_ID) return readAirPromptTemplate();
  if (id === DREAM_PROMPT_ID) return dreamPromptTemplate();
  if (id === DIRECTOR_DAILY_PLAN_PROMPT_ID) return directorDailyPlanPromptTemplate();
  if (id === DIRECTOR_SCHEDULE_REVISION_PROMPT_ID) return directorScheduleRevisionPromptTemplate();
  if (id === SCHEDULED_TASK_CALLBACK_PROMPT_ID) {
    return scheduledTaskCallbackPromptTemplate();
  }
  if (id === "conversation.tone-rewrite") {
    return {
      messages: [
        {
          role: "system",
          content: [
            "<agent_rules>@{persona.agents}</agent_rules>",
            "<soul>@{persona.soul}</soul>",
            "<preference>@{persona.preference}</preference>",
            "<dialogue_style_examples>@{persona.dialogue_style_examples}</dialogue_style_examples>",
            "<user_context>@{persona.user}</user_context>",
            "<relation>@{persona.relation}</relation>",
            RECOVERABLE_OUTPUT_ERROR_CONTRACT,
            TONE_XML_REVIEW_RULE,
            "你负责把角色即将发送的原始发言改写成符合其性格、用语习惯和对话风格的自然口语。",
            "只清理表达方式，不回答原始发言、不继续执行任务，也不增加、删除、概括或改变其中的事实、结论、承诺、问题、数字、链接、代码、命令、文件名、专有名词与 @ 对象。",
            "保留原始发言的语言、段落和必要格式；删去模型腔、工具腔、流程说明与生硬结构，让语气像角色本人在当前会话中直接说话。",
            "不得新增、删除、改写或重排原始发言中的表情标记和可用媒体。",
            "严格遵守本次请求提供的输出格式契约。"
          ].join("\n\n")
        },
        {
          role: "user",
          content: `<air_knowledge>@{persona.air}</air_knowledge>\n\n${DEFAULT_MODEL_TIME_CONTEXT}\n\n${TONE_OUTPUT_VARIABLE_BLOCK}\n\n<original_text>@{tone.input}</original_text>`
        }
      ],
      tools: [],
      response_format: JSON_TEXT_FORMAT
    };
  }
  if (
    id === "conversation.private-reply" ||
    id === "conversation.group-reply" ||
    id === "conversation.reply"
  ) {
    const isGroupReply = id === "conversation.group-reply";
    return {
      messages: [
        {
          role: "system",
          content: [
            "<agent_rules>@{persona.agents}</agent_rules>",
            "<soul>@{persona.soul}</soul>",
            "<preference>@{persona.preference}</preference>",
            "<dialogue_style_examples>@{persona.dialogue_style_examples}</dialogue_style_examples>",
            "<user_context>@{persona.user}</user_context>",
            "<relation>@{persona.relation}</relation>",
            "<output_rules>@{runtime.output_rules}</output_rules>",
            "<address_rules>@{runtime.address_rules}</address_rules>",
            "<scope_rules>@{runtime.scope_rules}</scope_rules>",
            "<tool_rules>@{runtime.tool_rules}</tool_rules>",
            BASH_WORKBENCH_CONTRACT,
            CONFIGURATION_DIRECTORY_INDEX_CONTRACT,
            CHAT_MEDIA_EXPORT_CONTRACT,
            CODEX_OUTPUT_CONTRACT,
            INBOUND_MESSAGE_INTERPRETATION_CONTRACT,
            RECOVERABLE_OUTPUT_ERROR_CONTRACT,
            ...(isGroupReply
              ? [`<group_context_contract>${DEFAULT_GROUP_CONTEXT_CONTRACT}</group_context_contract>`]
              : [])
          ].join("\n\n")
        },
        "@{message_32}",
        {
          role: "developer",
          content: [
            "<emoji_keys>@{conversation.emoji.keys}</emoji_keys>",
            "<emoji_syntax>@{conversation.emoji.syntax}</emoji_syntax>"
          ].join("\n\n")
        },
        {
          role: "developer",
          content: [
            "<voice_settings>@{conversation.voice.settings}</voice_settings>",
            "<voice_trigger_policy>@{conversation.voice.trigger_policy}</voice_trigger_policy>"
          ].join("\n\n")
        },
        {
          role: "developer",
          content: `<daily_schedule>@{${DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE}}</daily_schedule>`
        },
        ...(isGroupReply
          ? [{
              role: "developer",
              content: "<orchestrator_result>@{conversation.group.orchestrator_result}</orchestrator_result>"
            }]
          : []),
        {
          role: "user",
          content: [
            "<air_knowledge>@{persona.air}</air_knowledge>",
            "<working_memory>@{memory.working}</working_memory>",
            "<long_term_memory>@{memory.long_term}</long_term_memory>",
            "<user_profile>@{memory.user_profile}</user_profile>",
            DEFAULT_MODEL_TIME_CONTEXT,
            "<current_input>@{user.input}</current_input>"
          ].join("\n\n")
        }
      ],
      tools: [
        assistantTextTool,
        noReplyTool,
        readFileTool,
        writeFileTool,
        nativeBashTool,
        websearchTool,
        webfetchTool,
        withRequiredDispatchMessage(generateImgTool),
        withRequiredDispatchMessage(selfieTool),
        sendFileTool,
        {
          ...sendVoiceMessageTool,
          description: [
            sendVoiceMessageTool.description,
            "Current settings: @{conversation.voice.settings}",
            "Trigger policy: @{conversation.voice.trigger_policy}"
          ].join("\n\n")
        },
        memoryRecallTool,
        readAirTool,
        withRequiredDispatchMessage(codexTool),
        ...(!isGroupReply ? [systemConfigTool] : []),
        cronTool,
        callDirectorTool
      ].map(toOpenAITool),
      response_format: JSON_TEXT_FORMAT
    };
  }
  if (id === "memory.compress-out") {
    return jsonRequest(DEFAULT_WORK_MEMORY_COMPRESS_OUT_PROMPT, "memory.payload", "long_term_memory", {
      type: "array",
      items: LONG_TERM_MEMORY_FACT_SCHEMA
    });
  }
  if (id === "orchestrator.user-group") {
    return jsonRequest(DEFAULT_USER_GROUPCHAT_ORCHESTRATOR_PROMPT, "orchestrator.payload", "orchestrator_decision", {
      type: "object",
      additionalProperties: false,
      properties: {
        should_reply: { type: "boolean", description: "是否触发群聊主动回复" },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 1_000,
          description: "触发回复或保持沉默的简短原因"
        },
        reply_to_message_id: {
          type: ["string", "null"],
          minLength: 1,
          maxLength: 256,
          description: "触发回复时从 conversation.replyCandidateMessageIds 选择的消息 ID，否则为 null"
        }
      },
      required: ["should_reply", "reason", "reply_to_message_id"]
    });
  }
  if (id === "conversation.group-summary") {
    return textRequest(
      [
        "<soul>@{persona.soul}</soul>",
        "<preference>@{persona.preference}</preference>",
        "<dialogue_style_examples>@{persona.dialogue_style_examples}</dialogue_style_examples>",
        DEFAULT_GROUP_CHAT_SUMMARY_PROMPT
      ].join("\n\n"),
      "group.payload"
    );
  }
  if (id === "image.selfie-rewrite") {
    return selfieRequest(
      [
        "<soul>@{persona.soul}</soul>",
        "<preference>@{persona.preference}</preference>",
        DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT
      ].join("\n\n"),
      "selfie.payload"
    );
  }
  return undefined;
}

function textRequest(system: string, payloadVariable: string): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${DEFAULT_MODEL_TIME_CONTEXT}\n\n@{${payloadVariable}}` }
    ],
    tools: [],
    response_format: JSON_TEXT_FORMAT
  };
}

function jsonRequest(
  system: string,
  payloadVariable: string,
  name: string,
  schema: Record<string, unknown>
): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: `${DEFAULT_MODEL_TIME_CONTEXT}\n\n@{${payloadVariable}}` }
    ],
    tools: [],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
  };
}

function selfieRequest(system: string, payloadVariable: string): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: system },
      { role: "system", content: DEFAULT_SELFIE_REFERENCE_SELECTION_CONTRACT },
      { role: "user", content: `${DEFAULT_MODEL_TIME_CONTEXT}\n\n@{${payloadVariable}}` }
    ],
    tools: [],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "selfie_prompt_rewrite",
        strict: true,
        schema: DEFAULT_SELFIE_PROMPT_RESPONSE_SCHEMA
      }
    }
  };
}

function toOpenAITool(tool: Record<string, unknown>): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name: String(tool.name ?? ""),
      description: String(tool.description ?? ""),
      parameters: structuredClone((tool.parameters ?? {}) as Record<string, unknown>),
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {})
    }
  };
}
