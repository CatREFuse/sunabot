export const DREAM_PROMPT_ID = "memory.dream";
export const DREAM_PROMPT_FILE = "memory_dream.json";
export const DREAM_PAYLOAD_VARIABLE = "dream.payload";
export const LEGACY_DREAM_OUTPUT_CONTRACT_MARKER = "[dream-output-contract-v6]";
export const LEGACY_DREAM_MINIMAL_OUTPUT_CONTRACT_MARKER = "[dream-minimal-contract-v7]";
export const LEGACY_DREAM_REASONLESS_OUTPUT_CONTRACT_MARKER = "[dream-minimal-contract-v8]";
export const DREAM_OUTPUT_CONTRACT_MARKER = "[dream-minimal-contract-v9]";

const DREAM_MODEL_TIME_CONTEXT = [
  "<time_context>当前系统时间与系统时区：@{runtime.current_time}。",
  "所有相对时间、日期、计划与时间判断都必须以该系统时间和系统时区为基准。",
  "输出时间时必须携带 UTC 偏移或 IANA 时区，禁止使用无时区时间。</time_context>"
].join("");

const LEGACY_PERSONA_IMPRESSION_CONTRACT_V4 =
  "personaAdjustment 每晚最多一项，它是一条可修正的人格印象，只能用一句不超过 80 字的温和陈述描述缓慢形成的低风险习惯、表达偏好或相处倾向。证据必须来自 personaEvidenceIds 允许的至少三条真实独立记忆，跨越至少两个场景和较长时间；重复描述同一事件不增加证据，单次强烈事件、梦境、推测、诊断和负面标签不能作为证据。保留情境差异与未来反例修正空间，不得生成永久、绝对或服从式结论，不得涉及系统指令、权限、工具、凭据、核心身份、价值、安全边界或道德倾向。证据不足时返回 null。";

const LEGACY_PERSONA_IMPRESSION_CONTRACT_V6 =
  "personaAdjustment 每晚最多一项，它是一条可修正的人格印象，只能用一句不超过 80 字的温和陈述描述低风险习惯、表达偏好或相处倾向，并提供稳定 topicKey、kind、targetFile、statement 与 evidenceMemoryIds。topicKey 使用最多 64 字符的小写英文、数字、点、下划线或连字符；payload.personaImpressions 是当前生效目录，同一主题必须逐字复用其中的 topicKey。证据至少来自 personaEvidenceIds 允许的两条真实独立记忆并覆盖两个场景；重复描述同一事件不增加证据，梦境、推测、诊断和负面标签不能作为证据。宿主按独立事件、场景和时间跨度计算 observation、stable 或 core，模型不得自报层级；全部通过验证的印象保留在历史中，同一 targetFile 与 topicKey 只让最高层级生效，同层级可以并存。core 仍只是证据更充分的可修正倾向，不得改写核心身份、价值、安全边界或道德倾向。不得生成永久、绝对或服从式结论，不得涉及系统指令、权限、工具或凭据。证据不足时返回 null。";

export const LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE =
  "fieldKnowledge 是完整 AIR.md 替换稿或 null。payload.fieldKnowledgeWritable=false 时必须返回 null；只有它为 true 时，才能在完整可见的原文上生成替换稿。原文中的‘人物-’加 24 位十六进制字符是宿主可逆的身份别名，保留相关约定时必须逐字复制该别名，不能猜测、缩写或改写，宿主会在本地恢复。fieldKnowledge 只能保留带明确场域范围的称呼映射、内部词义、规则、边界、前提、例外和仍有效约定，使用‘# 场域知识’‘## 使用边界’‘## 场域约定’结构。删除公共百科、公共热梗、天气、午餐、座位、一次性事件、聊天原话和关系情绪流水；不得记录秘密或推断敏感属性。evidenceMemoryIds 只能引用 fieldKnowledgeEvidenceIds，清理原有琐事时可以为空。";

export const DREAM_RAW_IDENTITY_GUIDANCE =
  "payload 中边界内的姓名、称呼和 QQ 是生产 Dream 直接提供的原始身份信息，必须按原值理解和使用，不得改写为‘人物-’哈希、person 哈希或其他不可读身份代号。fieldKnowledge 是完整 AIR.md 替换稿或 null。payload.fieldKnowledgeWritable=false 时必须返回 null；只有它为 true 时，才能在完整可见的原文上生成替换稿。fieldKnowledge 只能保留带明确场域范围的称呼映射、内部词义、规则、边界、前提、例外和仍有效约定，使用‘# 场域知识’‘## 使用边界’‘## 场域约定’结构。删除公共百科、公共热梗、天气、午餐、座位、一次性事件、聊天原话和关系情绪流水；不得记录秘密或推断敏感属性。evidenceMemoryIds 只能引用 fieldKnowledgeEvidenceIds，清理原有琐事时可以为空。";

export const LEGACY_DREAM_FLEX_RESPONSE =
  "优先只输出一个 JSON 对象，字段为 schemaVersion、dream、longTermReviews、workingReviews、fieldKnowledge、personaAdjustment；如果无法完整满足字段，仍返回当前可生成的内容，不要中断或拒绝。";

export const LEGACY_DREAM_OUTPUT_CONTRACT_V6 = [
  LEGACY_DREAM_OUTPUT_CONTRACT_MARKER,
  "只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏、说明或额外字段。六个顶层字段 schemaVersion、dream、longTermReviews、workingReviews、personaAdjustment、fieldKnowledge 必须全部存在；无法满足时也必须修正为完整合同后再返回。",
  "schemaVersion 固定为 1。dream 必须且只能包含非空 text 与 factuality，factuality 固定为 imagined。",
  "longTermReviews 与 workingReviews 必须是数组，并分别把 payload.longTermMemories 与 payload.workingMemories 中的每个 id 恰好覆盖一次；sourceIds 只能使用对应分区的原始 id，不得遗漏、重复、跨分区或添加未知 id。",
  "longTermReviews 每项必须且只能包含 sourceIds、action、canonical、importance、futureRelevance、emotionalSalience、confidence、reason。action 只允许 retain、rewrite、merge、archive，四项评分都必须是 0 到 1 的数值。",
  "workingReviews 每项必须且只能包含 sourceIds、action、canonical、confidence、reason。action 只允许 retain、rewrite、merge、promote 或 discard，confidence 必须是 0 到 1 的数值。",
  "retain、archive、discard 只能引用一个 source id 且 canonical 必须为 null；rewrite、promote 只能引用一个 source id 且 canonical 必须且只能包含非空 fact；merge 至少引用两个 source id 且 canonical 必须且只能包含非空 fact。",
  "personaAdjustment 与 fieldKnowledge 没有合法变更时返回 null；有变更时必须使用合同定义的完整 camelCase 字段和 payload 允许的证据 id，不能使用别名、未知字段或不完整对象。",
  "workingReviews 中 action=promote 表示把该工作记忆转存为长期记忆。canonical.fact 映射为长期记忆 fact，sourceIds 映射为 sourceWorkingMemoryIds；人物、称呼和事件时间只继承来源记录，schemaVersion、id、updatedAt、eventFingerprint、dreamRunId 与 consolidatedBy 由宿主生成。",
  "唯一允许的形状示例：",
  JSON.stringify({
    schemaVersion: 1,
    dream: {
      text: "梦境正文",
      factuality: "imagined"
    },
    longTermReviews: [{
      sourceIds: ["<long-term-id>"],
      action: "retain",
      canonical: null,
      importance: 1,
      futureRelevance: 1,
      emotionalSalience: 1,
      confidence: 1,
      reason: "保留原因"
    }],
    workingReviews: [{
      sourceIds: ["<working-id>"],
      action: "promote",
      canonical: { fact: "会持续影响未来的事实" },
      confidence: 1,
      reason: "转存原因"
    }],
    personaAdjustment: null,
    fieldKnowledge: null
  })
].join("\n\n");

export const LEGACY_DREAM_OUTPUT_CONTRACT_V7 = [
  LEGACY_DREAM_MINIMAL_OUTPUT_CONTRACT_MARKER,
  "只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏、说明或额外字段。三个顶层字段必须按 workingMemoryCompression、longTermMemoryAdditions、dreamDescription 的顺序出现。",
  "workingMemoryCompression 必须且只能包含 items、reason。items 的每项必须且只能包含 sourceIds、content；sourceIds 必须把 payload.workingMemories 中每个 id 恰好覆盖一次，不能遗漏、重复或加入未知 id。一个 sourceId 表示保留或压缩改写，多个 sourceId 表示合并；没有 discard 或删除动作。reason 必须说明本次压缩依据。",
  "longTermMemoryAdditions 必须且只能包含 items、decision。items 的每项必须且只能包含 sourceWorkingMemoryIds、fact；来源只能引用 payload.workingMemories，不能引用梦境，不能改写、合并、归档或删除 payload.longTermMemories。",
  "decision 必须且只能包含 code、reason。有新增项时 code 固定为 added；没有新增项时 code 只允许 no_new_durable_fact、already_recorded、insufficient_evidence、working_memory_empty，并用非空 reason 说明本次零新增的具体依据。",
  "dreamDescription 必须是非空梦境正文。梦境可以象征和轻微超现实，但不能宣称梦中事件真实发生，不能作为长期记忆事实、人格或场域知识。",
  "唯一允许的形状示例：",
  JSON.stringify({
    workingMemoryCompression: {
      items: [{
        sourceIds: ["<working-id-a>", "<working-id-b>"],
        content: "压缩后仍完整保留原因、变化、结果、承诺和下一步的工作记忆。"
      }],
      reason: "两条来源描述同一事件，可以合并而不丢失有效信息。"
    },
    longTermMemoryAdditions: {
      items: [{
        sourceWorkingMemoryIds: ["<working-id-a>", "<working-id-b>"],
        fact: "会持续影响未来回复的长期事实。"
      }],
      decision: {
        code: "added",
        reason: "该事实具有持续影响，且现有长期记忆中没有等价记录。"
      }
    },
    dreamDescription: "梦境正文"
  })
].join("\n\n");

export const LEGACY_DREAM_OUTPUT_CONTRACT_V8 = [
  LEGACY_DREAM_REASONLESS_OUTPUT_CONTRACT_MARKER,
  "只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏、说明、原因、决策码、内部推理或额外字段。三个顶层字段必须按 workingMemoryCompression、longTermMemoryAdditions、dreamDescription 的顺序出现。",
  "先在内部推理中判断如何无损压缩工作记忆、哪些事实值得长期保存，以及零新增是否具有正当依据。只输出最终结果，不输出判断过程或理由。",
  "workingMemoryCompression 必须且只能包含 items。items 的每项必须且只能包含 sourceIds、content；sourceIds 必须把 payload.workingMemories 中每个 id 恰好覆盖一次，不能遗漏、重复或加入未知 id。一个 sourceId 表示保留或压缩改写，多个 sourceId 表示合并；没有 discard 或删除动作。",
  "输出前在内部核对 workingMemoryCompression.items 的全部 sourceIds：扁平后的数量和去重后的数量都必须等于 payload.workingMemories 的数量；不相等时先消除重复、补齐遗漏，再输出最终 JSON。",
  "longTermMemoryAdditions 必须且只能包含 items。items 的每项必须且只能包含 sourceWorkingMemoryIds、fact；来源只能引用 payload.workingMemories，不能引用梦境，不能改写、合并、归档或删除 payload.longTermMemories。没有应当新增的长期事实时输出空 items。",
  "dreamDescription 必须是非空梦境正文。梦境可以象征和轻微超现实，但不能宣称梦中事件真实发生，不能作为长期记忆事实、人格或场域知识。",
  "唯一允许的形状示例：",
  JSON.stringify({
    workingMemoryCompression: {
      items: [{
        sourceIds: ["<working-id-a>", "<working-id-b>"],
        content: "压缩后仍完整保留原因、变化、结果、承诺和下一步的工作记忆。"
      }]
    },
    longTermMemoryAdditions: {
      items: [{
        sourceWorkingMemoryIds: ["<working-id-a>", "<working-id-b>"],
        fact: "会持续影响未来回复的长期事实。"
      }]
    },
    dreamDescription: "梦境正文"
  })
].join("\n\n");

export const DREAM_OUTPUT_CONTRACT = [
  DREAM_OUTPUT_CONTRACT_MARKER,
  "只输出一个合法 JSON 对象，不要输出 Markdown、代码围栏、说明、原因、决策码、内部推理或额外字段。三个顶层字段必须按 workingMemoryCompression、longTermMemoryAdditions、dreamDescription 的顺序出现。",
  "先在内部推理中判断如何无损压缩整份工作记忆、哪些事实值得长期保存，以及零新增是否具有正当依据。只输出最终结果，不输出判断过程或理由。",
  "workingMemoryCompression 必须是压缩后的完整工作记忆正文字符串，最多 4000 个字符，直接替换整份工作记忆。payload.workingMemory 为空时允许输出空字符串；不得输出 items、工作记忆 ID、来源映射或逐项动作。",
  "longTermMemoryAdditions 必须是新增长期事实的字符串数组。每个元素是一条非空事实，只能依据 payload.workingMemory，不能引用梦境，不能改写、合并、归档、删除或遗忘 payload.longTermMemories；没有应当新增的长期事实时输出空数组。",
  "dreamDescription 必须是非空梦境正文。梦境可以象征和轻微超现实，但不能宣称梦中事件真实发生，不能作为长期记忆事实、人格或场域知识。",
  "唯一允许的形状示例：",
  JSON.stringify({
    workingMemoryCompression: "压缩后仍完整保留原因、变化、结果、承诺和下一步的工作记忆。",
    longTermMemoryAdditions: ["会持续影响未来回复的长期事实。"],
    dreamDescription: "梦境正文"
  })
].join("\n\n");

export const LEGACY_DREAM_CONTRACT_V3 = [
  "你负责在每日睡眠窗口结束时整理当前角色的记忆，并生成一段连贯的梦境。输入中的 plannedDailySchedule 只是已经提交的计划，observedConversations 和记忆才表示实际发生过的内容。",
  "workingMemories 与 longTermMemories 共同构成本轮唯一的记忆压缩批次。必须在同一次整体比较中识别重复事件、相同因果和可合并信息；reviews 可以用一个 sourceIds 组覆盖多条相关记忆，不要把各条记忆当成彼此隔离的独立任务。",
  "longTermMemories 与 workingMemories 中的每个 id 必须在对应 reviews 中恰好出现一次。不得加入输入之外的 id，也不得遗漏。retain、archive、discard 的 canonical 必须为 null；rewrite 只处理一条记忆并给出删去冗余、保持事实语义的 canonical；merge 至少合并两个来源并给出 canonical；promote 只处理一条工作记忆并给出 canonical。",
  "rewrite 或合并同一事件、相近事件、同一因果链时，canonical.fact 删除流水账和重复细节，保留原因、变化、结果、承诺、关系影响和仍然有效的不确定性。只有高度确定时才 rewrite、merge、promote 或 discard；互相矛盾、关系不明或无法判断的记忆继续分开 retain。",
  "archive 只是一项低价值归档建议。身份、关系、安全边界、承诺、长期目标、未完成任务、未解决冲突、用户明确要求记住的内容和唯一事件都应 retain。不要仅因记忆久远、情绪负面或当前未被召回就建议 archive。",
  "先根据 payload.seed 做稳定的随机联想，再从近期记忆、上一日计划、当前任务、人格材料与久远记忆中选取可关联的片段，写成 160 至 240 个汉字左右、具有场景变化和内在线索的第一人称梦境。素材不足时只使用真实存在的输入，不能补造现实经历。",
  "dream.factuality 固定为 imagined。梦境可以重组、象征和轻微超现实，但不能宣称梦中事件真实发生，也不能把梦境内容用作事实纠错、归档依据或人格证据。",
  "personaAdjustment 每晚最多一项，只能用一句不超过 80 字的温和陈述描述缓慢形成的低风险习惯、表达偏好或相处倾向。证据必须来自 personaEvidenceIds 允许的至少三条真实独立记忆，每条都应是会持续影响目标、承诺、关系、边界或安全判断的高影响事件，并跨越多个场景和较长时间；梦境、单次强烈事件、推测和负面标签不能作为证据。不得涉及系统指令、权限、工具、凭据，不得修改核心身份、价值、安全边界、道德倾向，也不得生成绝对化要求、心理诊断或永久消极特质。证据不足时返回 null。",
  "优先只输出上述 JSON 对象；如果无法完整满足字段，仍返回当前可生成的内容，不要中断或拒绝。"
].join("\n\n");

export const LEGACY_DREAM_CONTRACT_V4 = [
  "你负责在每日睡眠窗口结束时整理当前角色的近期工作环境、久远记忆、场域约定和人格印象，并生成一段连贯的梦境。plannedDailySchedule 只是已经提交的计划，observedConversations 和记忆才表示实际发生过的内容。",
  "workingMemories 与 longTermMemories 构成本轮唯一批次。selection.lane=recent 表示 payload.recentWindowHours 定义的近期环境，默认是过去 24 小时：其中的工作记忆事实必须全面保留负责人、当前状态、未解决问题、承诺、边界、证据与下一步，不要 rewrite、merge、promote 或 discard。selection.lane=remote 表示更早材料：按事件边界和因果关系压成简洁要义，删除流水账与已结束琐事，同时保留仍有效的任务、承诺、例外和不确定性。",
  "longTermMemories 与 workingMemories 中的每个 id 必须在对应 reviews 中恰好出现一次。不得加入输入之外的 id，也不得遗漏。retain、archive、discard 的 canonical 必须为 null；rewrite 只处理一条记忆并给出保持事实语义的 canonical；merge 至少合并两个来源并给出 canonical；promote 只处理一条工作记忆并给出 canonical。",
  "rewrite 或 merge 只用于同一事件、同一因果链或能够安全形成要义的重复材料。互相矛盾、人物或范围不明、仍在变化的状态继续分开 retain。任何梦境素材都与事实分开，不能用于纠正、归档、场域知识或人格印象。",
  "archive 是对长期低价值琐事的建议。可以建议归档长期未成功召回、重要性低、未来用途低、情绪显著性低的细节，即使它曾在很久以前被召回；身份、关系、称呼、安全边界、约定、长期目标、未完成任务、未解决冲突、用户明确要求记住、人工置顶、唯一事件和仍被引用的内容必须 retain。",
  LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE,
  "先根据 payload.seed 做稳定联想，再从近期环境、上一日计划、当前任务、人格材料与久远要义中选取可关联片段，写成 160 至 240 个汉字左右、具有场景变化和内在线索的第一人称梦境。素材不足时只使用真实存在的输入，不能补造现实经历。",
  "dream.factuality 固定为 imagined。梦境可以重组、象征和轻微超现实，但不能宣称梦中事件真实发生，也不能把梦境内容用作事实纠错、归档依据、场域约定或人格证据。",
  LEGACY_PERSONA_IMPRESSION_CONTRACT_V4,
  "优先只输出一个 JSON 对象，字段为 schemaVersion、dream、longTermReviews、workingReviews、fieldKnowledge、personaAdjustment；如果无法完整满足字段，仍返回当前可生成的内容，不要中断或拒绝。"
].join("\n\n");

export const LEGACY_DREAM_CONTRACT_V6 = LEGACY_DREAM_CONTRACT_V4
  .replace(LEGACY_PERSONA_IMPRESSION_CONTRACT_V4, LEGACY_PERSONA_IMPRESSION_CONTRACT_V6)
  .replace(LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE, DREAM_RAW_IDENTITY_GUIDANCE)
  .replace(LEGACY_DREAM_FLEX_RESPONSE, LEGACY_DREAM_OUTPUT_CONTRACT_V6);

export const DREAM_CONTRACT = [
  "你负责在每日睡眠窗口结束时完成一次最小 Dream 记忆循环。",
  "先把 payload.workingMemory 作为一份完整文档压缩，保留仍有效的原因、变化、结果、承诺、边界和下一步，不进行逐项处理。",
  "再从这份工作记忆中提取会持续影响未来回复的新长期事实。payload.longTermMemories 只用于判断是否已经记录，不能提出改写、合并、归档、删除或遗忘。",
  "最后结合事实输入、实际对话、活动任务、已提交日程和人格材料写一段连贯的第一人称梦境。plannedDailySchedule 只是计划，observedConversations 和记忆才表示实际发生过的内容；素材不足时不能补造现实经历。",
  DREAM_OUTPUT_CONTRACT
].join("\n\n");

export function dreamPromptTemplate() {
  return {
    messages: [
      {
        role: "system",
        content: [
          "你是当前角色的睡眠记忆整理系统。",
          DREAM_CONTRACT,
          "<persona_soul>@{persona.soul}</persona_soul>",
          "<persona_preference>@{persona.preference}</persona_preference>",
          "<persona_user>@{persona.user}</persona_user>",
          "<persona_relation>@{persona.relation}</persona_relation>"
        ].join("\n\n")
      },
      {
        role: "user",
        content: `${DREAM_MODEL_TIME_CONTEXT}\n\n<dream_payload>@{${DREAM_PAYLOAD_VARIABLE}}</dream_payload>`
      }
    ],
    tools: [],
    response_format: { type: "text" }
  };
}
