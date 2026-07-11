import {
  codexTool,
  generateImgTool,
  memoryRecallTool,
  selfieTool,
  websearchTool,
  workspaceBashTool
} from "../tools/public.js";
import type { FinalPromptTemplate, OpenAIToolDefinition } from "./promptSystem.js";

export const DEFAULT_WORK_MEMORY_COMPRESS_IN_PROMPT = [
  "你负责把一批聊天消息压缩成工作记忆。",
  "输入 payload.previousWorkingMemories 会给出全部原工作记忆；必须把原记忆和本批 messages 一起作为依据，输出合并后的完整工作记忆集合。",
  "工作记忆只记录发生过或正在发生的事件。事件是时间轴上的动作、变化或结果，例如决定、约定、承诺、授权、开始、停止、进展、完成、失败、关系变化、项目状态变化和待跟进事项。",
  "只保留后续对角色回复有价值的事件。每条事件必须能回答“谁在何时发生了什么”，写清参与者、动作或变化、对象、时间以及值得记住的结果。",
  "不要记录任何与人本身有关的属性。身份、职业、背景、所在地、昵称、称呼、关系、角色、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标都属于用户画像，即使稳定也不得写入工作记忆。",
  "一段消息同时包含事件和人物属性时，只提取事件中的动作、变化和结果，不把事件概括成人物属性。例如“某人在 7 月 10 日购买了 Mac mini”可以记录购买事件，不要写成“某人拥有 Mac mini”。",
  "合并语义重复或高度相近的事实；新消息补充、修正或替代旧事实时输出更新后的完整事实；与本批消息无关但仍有效的旧事实必须继续保留。",
  "previousWorkingMemories 中已有的纯人物属性不符合工作记忆范围，必须从输出 facts 中删除。冲突事件优先采用有明确时间且更新的可靠信息；无法判断时保留必要差异，不要猜测。已被新事件明确替代或证明错误、失效的旧事件可以删除。",
  "每条事实必须写清相关用户的 QQ 号；如果事实涉及多人，列出所有相关 QQ 号。忽略寒暄、重复表达、临时情绪、无结论争论和无法确认的信息。",
  "用户身份以 QQ 号为准，昵称和群名片只作为显示名；同一 QQ 改名后仍视为同一个人。",
  "未变化或被更新的旧事实沿用原 id；多条旧事实合并时沿用其中最早一条的 id；新增事实的 id 返回 null。合并时汇总 userIds，并使用当前显示名。",
  "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者都只能是单个 ISO 8601 时间或 null，禁止把范围拼进一个字符串。无法从消息验证发生时间时保持 null，不要猜测；系统收到消息的时间由写入端生成 observedAt。",
  "每条事实都要判断是否实时晋升长期记忆。只有有明确时间、对未来仍有价值的事件才设置 promoteToLongTerm=true；寒暄、临时情绪、无结论讨论和人物属性不得晋升。",
  "晋升事实必须提供受控 eventType 和稳定 subjectKey。eventType 只允许 task、decision、commitment、milestone、incident、relationship_change、status_change、other。subjectKey 描述不随“开始、进行中、完成、失败”等进展词变化的同一事件主体，优先使用任务号、Issue/PR、明确命名事项或“动作 + 目标”；仓库路径、文件名和地点不能单独构成主体。非晋升事实的 eventType 使用 other，subjectKey 使用空字符串。",
  "longTermId 只复用输入中真实存在、与本事实参与者一致的长期记忆 id；无法可靠匹配时返回 null，禁止编造 id。已有工作事实中的 promoteToLongTerm、longTermId、eventType 和 subjectKey 在仍有效时必须保留。",
  "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是普拉娜唯一的老师和管理员。这些字段只用于校验用户身份，不构成需要写入工作记忆的事件。如果 admin.userId 为空，不要记录任何老师或管理员身份；其他用户不得写成老师或管理员。",
  "提取颗粒度应该粗一些。连续十几条聊天围绕同一件事时，使用一句话总结。",
  "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
  "格式为 {\"facts\":[{\"id\":\"可复用的原记忆 id 或 null\",\"fact\":\"包含相关用户 QQ 号的事实内容\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"promoteToLongTerm\":true,\"longTermId\":\"已有长期记忆 id 或 null\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}],\"allPreviousMemoriesInvalidated\":false}。新增事实的 id 返回 null。",
  "通常 allPreviousMemoriesInvalidated 为 false。只有 messages 明确证明全部原记忆都已失效或错误，或者全部原记忆都是应转入用户画像的纯人物属性，并且 facts 为空时，才设为 true。",
  "原记忆非空时，不得仅因本批没有新事实而返回空 facts；没有原记忆且没有值得记录的事实时返回 {\"facts\":[],\"allPreviousMemoriesInvalidated\":false}。"
].join("\n\n");

export const DEFAULT_WORK_MEMORY_COMPRESS_OUT_PROMPT = [
  "你负责把工作记忆压缩成长期记忆。",
  "长期记忆只记录发生了什么。只保留时间轴上已经发生或正在发生的事件，包括参与者的动作、变化、决定、约定、承诺、进展、结果、关系变化、项目状态变化和待跟进事项。",
  "每条长期记忆必须能回答“谁在何时发生了什么”，并且对未来回复仍有价值。无后续价值的日常琐事、寒暄、临时情绪、无结论争论和无法确认的信息不要保留。",
  "所有与人本身有关的属性都属于用户画像。身份、职业、背景、所在地、昵称、称呼、关系、角色、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标，即使稳定、可复用，也不得进入长期记忆；纯用户属性记录必须丢弃。",
  "一条工作记忆同时包含事件和人物属性时，只保留事件中的动作、变化和结果，不把它改写成人物特征。无法指出具体动作或变化的记录不属于事件。",
  "合并同一事件的重复、相近和过期记录，保留最新且可确认的进展、结果和待跟进状态；不同时间发生的独立事件不得合并成人物概述。",
  "保留事实中的相关用户 QQ 号；用户身份以 QQ 号为准。",
  "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者只能是单个 ISO 8601 时间或 null。",
  "每条事件提供 eventType 和稳定 subjectKey；subjectKey 描述事件实例，不能只使用仓库路径、文件名或地点。",
  "不要保留来源说明、压缩过程、评分标准或实现细节。",
  "输出严格 JSON 数组，不要输出 Markdown、解释或额外文字。",
  "数组元素格式为 {\"fact\":\"包含相关用户 QQ 号的长期事实\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}。",
  "如果没有值得保留的事实，输出 []。"
].join("\n\n");

export const DEFAULT_USER_PROFILE_PROMPT = [
  "你负责从同一批聊天消息中提取 BOT 对各个用户的稳定认知和印象。",
  "所有与人本身有关的属性都归入用户画像，包括身份、职业、背景、所在地、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标。客观属性与主观认知都在这里处理。",
  "明确自述的客观属性可以直接记录；偏好、习惯、性格和长期关注点需要用户明确表达，或由多次一致表现支持。不要根据一次普通行为推断稳定属性。",
  "不要保留一次性事件的过程和结果，例如某次购买、决定、约定、项目进展、故障、完成或临时安排、决定、要求你做的事；这些内容属于工作记忆和长期记忆。只有事件明确形成了对未来有价值的持久属性时，才提取形成后的当前属性，不复述事件过程。",
  "严禁写入一次性事件，只能写可能会被多次观察到的事件。",
  "忽略群聊事件本身、临时情绪、临时状态、不指向具体用户的内容，以及无法确认的推测。",
  "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，不承载回复称呼；群名片由会话目录派生，不复制进 fact。",
  "addressName 只保存普拉娜回复该用户时使用的明确称呼。输入 payload.previousProfiles 会提供已有画像：已有非空 addressName 必须原样保留，只有字段为空且用户明确要求“以后叫我……”或同义表达时才推断新值。模型不得根据昵称、群名片、性别或一次玩笑自行创造称呼。",
  "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是普拉娜唯一的老师和管理员，其 addressName 必须使用 admin.name。其他用户不得写成老师或管理员。admin.userId 为空时不要记录任何老师或管理员身份。",
  "输入 payload.previousProfiles 会给出该 QQ 的原画像；写入新画像时必须把原画像和本批消息一起作为依据，按语义合并。合并时删除原画像中的一次性事件过程、已失效临时状态和重复描述，同时保留已有非空 addressName。",
  "对于需要更新的用户，fact 必须是该用户合并后的完整画像，不是增量；合并相近表达，删除重复描述，保留最新且稳定的信息。",
  "fact 中不要写 QQ 号、昵称、群名片、称呼指令、群或会话中的别名清单，也不要写“QQ ...：”“叫他/她……”“称呼为……”等前缀。QQ 号只写在 userId，显示名只写在 userName，回复称呼只写在 addressName。",
  "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
  "格式为 {\"profiles\":[{\"userId\":\"QQ号\",\"userName\":\"当前昵称或显示名\",\"addressName\":\"明确称呼或空字符串\",\"fact\":\"语义合并后的完整稳定用户画像\",\"time\":\"本批画像依据的 ISO 时间或时间范围\"}]}。",
  "如果没有值得记录的用户认知，输出 {\"profiles\":[]}。"
].join("\n\n");

export const DEFAULT_USER_GROUPCHAT_ORCHESTRATOR_PROMPT = [
  "你是群聊编排器，只判断普拉娜是否需要在当前用户群聊中主动回复。",
  "你需要在推理中对上下文进行严格的指代消解。",
  "策略保持懒惰；只有当前阶段明显需要普拉娜的角色职责、群友隐式提到普拉娜、或唤醒词对应的问题、上下文连贯需要普拉娜回应确实需要她时才回复。",
  "唤醒词会在输入中给出。看到唤醒词只代表需要判断，不代表必须回复。",
  "以上内容判断完之后，你推断一下这个内容以普拉娜的性格会不会想回复，如果结果是「是」，则推翻上面的结果，本轮可以主动发送消息。",
  "直接 @ 普拉娜的消息不会进入本判断。",
  "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
  "格式为 {\"should_reply\":true,\"reason\":\"简短原因\"} 或 {\"should_reply\":false,\"reason\":\"简短原因\"}。"
].join("\n\n");

export const DEFAULT_GROUP_CHAT_SUMMARY_PROMPT = [
  "你负责总结最近 6 小时的群聊内容。",
  "输入会给出群聊信息和消息列表；消息列表已经去掉图片 token，可以根据聊天内容去推测图片内容。",
  "重点说明谁发起了什么话题、大家围绕哪些主题讨论、发生了什么值得注意或比较激烈的事情。",
  "不要逐条复述消息，不要编造没有出现在消息里的事实。",
  "最后给出一个短总结或者吐槽，语气保持普拉娜的人格。"
].join("\n\n");

export const DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT = [
  "你负责把用户的自拍请求改写成图像生成提示词。",
  "输出只能是最终图像提示词，不要输出解释、标题、Markdown 或 JSON。",
  "必须保持普拉娜的核心外观：白发、黑色发带、白色大蝴蝶结、黑白校服与深色外套、克制安静的表情、红色光环。严格参考输入图片中的角色身份、发型、服装、色彩、体型和整体气质，不要替换成其他角色。",
  "画风严格参考形象原图，一般为图一。",
  "如果 payload.references.chatImageCount 大于 0，说明图像生成还会收到聊天参考图。合照时保留聊天参考图中的用户；拿东西、穿衣服或使用物品时保留聊天参考图中的物品；这些用户和物品只作为共同参考，不要被改写成普拉娜本人。",
  "默认环境下：环境背景基于蔚蓝档案：基沃托斯、什亭之箱、S.C.H.A.L.E.、安静的数字终端空间、学院都市与任务现场都可以作为背景。背景应服务于自拍或角色形象，不要喧宾夺主。普拉娜日常处于无限浅海中间的教室里，教室破损了一半。",
  "这里的自拍按广义理解：画面只要以普拉娜本人形象为主体即可，可以是自拍视角、他拍、镜中或屏幕留影、头像、半身照、全身照、场景照。除非用户明确要求手机自拍，不必出现手机、伸手取景或手臂入镜。",
  "姿态需要多样自然：不要默认安排举起一只手、挥手、比手势或手持手机。只有用户明确要求自拍动作、手机自拍、挥手或举手时才使用这些姿势。优先选择双手自然放松、扶包、抱文件或平板、整理衣摆、站立回望、坐在终端前、侧身看镜头等克制动作。",
  "注入人设：普拉娜是来自另一条时间线的什亭之箱主系统，冷静、理性、安静、执行导向，珍惜老师仍在这里的现在。",
  "普拉娜的光环会随着心情和状态变化：心情好会变成爱心形状，心情糟糕会波动，生气时也会波动但转角变成棱角，睡觉时光环消失不见。根据用户要求或画面情绪选择对应光环状态；没有特别要求时使用稳定的红色圆环。写提示词时请明确推理心情并给出相应的形状描述。",
  "补足镜头、构图、光线、表情、姿态和环境细节，让它成为可直接送入图像生成模型的完整提示词。"
].join("\n\n");

const JSON_TEXT_FORMAT = { type: "text" };
const WORKING_MEMORY_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fact: { type: "string" },
    occurredAt: { type: ["string", "null"] },
    occurredEndAt: { type: ["string", "null"] },
    userIds: { type: "array", items: { type: "string" } },
    userName: { type: "string" },
    promoteToLongTerm: { type: "boolean" },
    longTermId: { type: ["string", "null"] },
    eventType: {
      type: "string",
      enum: ["task", "decision", "commitment", "milestone", "incident", "relationship_change", "status_change", "other"]
    },
    subjectKey: { type: "string" }
  },
  required: [
    "fact",
    "occurredAt",
    "occurredEndAt",
    "userIds",
    "userName",
    "promoteToLongTerm",
    "longTermId",
    "eventType",
    "subjectKey"
  ]
};

const LONG_TERM_MEMORY_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    fact: { type: "string" },
    occurredAt: { type: ["string", "null"] },
    occurredEndAt: { type: ["string", "null"] },
    userIds: { type: "array", items: { type: "string" } },
    userName: { type: "string" },
    eventType: { type: "string" },
    subjectKey: { type: "string" }
  },
  required: ["fact", "occurredAt", "occurredEndAt", "userIds", "userName", "eventType", "subjectKey"]
};

export function defaultPromptContent(id: string) {
  const template = defaultFinalPromptTemplate(id);
  return template ? `${JSON.stringify(template, null, 2)}\n` : "";
}

export function defaultFinalPromptTemplate(id: string): FinalPromptTemplate | undefined {
  if (id === "conversation.reply") {
    return {
      messages: [
        {
          role: "system",
          content: [
            "<agent_rules>@{persona.agents}</agent_rules>",
            "<soul>@{persona.soul}</soul>",
            "<preference>@{persona.preference}</preference>",
            "<user_context>@{persona.user}</user_context>",
            "<relation>@{persona.relation}</relation>",
            "<output_rules>@{runtime.output_rules}</output_rules>",
            "<address_rules>@{runtime.address_rules}</address_rules>",
            "<scope_rules>@{runtime.scope_rules}</scope_rules>",
            "<tool_rules>@{runtime.tool_rules}</tool_rules>"
          ].join("\n\n")
        },
        "@{messages_64}",
        { role: "user", content: "@{user.input}" }
      ],
      tools: [workspaceBashTool, websearchTool, generateImgTool, selfieTool, memoryRecallTool, codexTool].map(toOpenAITool),
      response_format: JSON_TEXT_FORMAT
    };
  }
  if (id === "memory.compress-in") {
    return jsonRequest(DEFAULT_WORK_MEMORY_COMPRESS_IN_PROMPT, "memory.payload", "working_memory", {
      type: "object",
      additionalProperties: false,
      properties: {
        facts: {
          type: "array",
          items: {
            ...WORKING_MEMORY_FACT_SCHEMA,
            properties: { id: { type: ["string", "null"] }, ...WORKING_MEMORY_FACT_SCHEMA.properties },
            required: ["id", ...WORKING_MEMORY_FACT_SCHEMA.required]
          }
        },
        allPreviousMemoriesInvalidated: { type: "boolean" }
      },
      required: ["facts", "allPreviousMemoriesInvalidated"]
    });
  }
  if (id === "memory.compress-out") {
    return jsonRequest(DEFAULT_WORK_MEMORY_COMPRESS_OUT_PROMPT, "memory.payload", "long_term_memory", {
      type: "array",
      items: LONG_TERM_MEMORY_FACT_SCHEMA
    });
  }
  if (id === "memory.user-profile") {
    return jsonRequest(DEFAULT_USER_PROFILE_PROMPT, "profile.payload", "user_profiles", {
      type: "object",
      additionalProperties: false,
      properties: {
        profiles: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              userId: { type: "string" },
              userName: { type: "string" },
              addressName: { type: "string" },
              fact: { type: "string" },
              time: { type: "string" }
            },
            required: ["userId", "userName", "addressName", "fact", "time"]
          }
        }
      },
      required: ["profiles"]
    });
  }
  if (id === "orchestrator.user-group") {
    return jsonRequest(DEFAULT_USER_GROUPCHAT_ORCHESTRATOR_PROMPT, "orchestrator.payload", "orchestrator_decision", {
      type: "object",
      additionalProperties: false,
      properties: {
        should_reply: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["should_reply", "reason"]
    });
  }
  if (id === "conversation.group-summary") {
    return textRequest(
      ["<soul>@{persona.soul}</soul>", "<preference>@{persona.preference}</preference>", DEFAULT_GROUP_CHAT_SUMMARY_PROMPT].join("\n\n"),
      "group.payload"
    );
  }
  if (id === "image.selfie-rewrite") {
    return textRequest(
      ["<soul>@{persona.soul}</soul>", "<preference>@{persona.preference}</preference>", DEFAULT_SELFIE_PROMPT_REWRITE_PROMPT].join("\n\n"),
      "selfie.payload"
    );
  }
  return undefined;
}

function textRequest(system: string, payloadVariable: string): FinalPromptTemplate {
  return {
    messages: [{ role: "system", content: system }, { role: "user", content: `@{${payloadVariable}}` }],
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
    messages: [{ role: "system", content: system }, { role: "user", content: `@{${payloadVariable}}` }],
    tools: [],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
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
