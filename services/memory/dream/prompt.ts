export const DREAM_PROMPT_ID = "memory.dream";
export const DREAM_PROMPT_FILE = "memory_dream.json";
export const DREAM_PAYLOAD_VARIABLE = "dream.payload";

const DREAM_MODEL_TIME_CONTEXT = [
  "<time_context>当前系统时间与系统时区：@{runtime.current_time}。",
  "所有相对时间、日期、计划与时间判断都必须以该系统时间和系统时区为基准。",
  "输出时间时必须携带 UTC 偏移或 IANA 时区，禁止使用无时区时间。</time_context>"
].join("");

const ID_SCHEMA = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$"
} as const;

const ID_ARRAY_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 24,
  items: ID_SCHEMA
} as const;

const CANONICAL_MEMORY_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { fact: { type: "string", minLength: 1, maxLength: 1_000 } },
      required: ["fact"]
    },
    { type: "null" }
  ]
} as const;

const DREAM_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    dream: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 160, maxLength: 260 },
        factuality: { type: "string", enum: ["imagined"] }
      },
      required: ["text", "factuality"]
    },
    longTermReviews: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceIds: ID_ARRAY_SCHEMA,
          action: { type: "string", enum: ["retain", "rewrite", "merge", "archive"] },
          canonical: CANONICAL_MEMORY_SCHEMA,
          importance: { type: "number", minimum: 0, maximum: 1 },
          futureRelevance: { type: "number", minimum: 0, maximum: 1 },
          emotionalSalience: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: [
          "sourceIds",
          "action",
          "canonical",
          "importance",
          "futureRelevance",
          "emotionalSalience",
          "confidence",
          "reason"
        ]
      }
    },
    workingReviews: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceIds: ID_ARRAY_SCHEMA,
          action: { type: "string", enum: ["retain", "rewrite", "merge", "promote", "discard"] },
          canonical: CANONICAL_MEMORY_SCHEMA,
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        },
        required: ["sourceIds", "action", "canonical", "confidence", "reason"]
      }
    },
    personaAdjustment: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: ["habit", "communication_preference", "relationship_tendency"]
            },
            targetFile: { type: "string", enum: ["PREFERENCE.md", "RELATION.md"] },
            statement: { type: "string", minLength: 4, maxLength: 80 },
            evidenceMemoryIds: {
              type: "array",
              minItems: 3,
              maxItems: 24,
              items: ID_SCHEMA
            }
          },
          required: ["kind", "targetFile", "statement", "evidenceMemoryIds"]
        },
        { type: "null" }
      ]
    }
  },
  required: ["schemaVersion", "dream", "longTermReviews", "workingReviews", "personaAdjustment"]
} as const;

const DREAM_CONTRACT = [
  "你负责在每日睡眠窗口结束时整理当前角色的记忆，并生成一段连贯的梦境。输入中的 plannedDailySchedule 只是已经提交的计划，observedConversations 和记忆才表示实际发生过的内容。",
  "workingMemories 与 longTermMemories 共同构成本轮唯一的记忆压缩批次。必须在同一次整体比较中识别重复事件、相同因果和可合并信息；reviews 可以用一个 sourceIds 组覆盖多条相关记忆，不要把各条记忆当成彼此隔离的独立任务。",
  "longTermMemories 与 workingMemories 中的每个 id 必须在对应 reviews 中恰好出现一次。不得加入输入之外的 id，也不得遗漏。retain、archive、discard 的 canonical 必须为 null；rewrite 只处理一条记忆并给出删去冗余、保持事实语义的 canonical；merge 至少合并两个来源并给出 canonical；promote 只处理一条工作记忆并给出 canonical。",
  "rewrite 或合并同一事件、相近事件、同一因果链时，canonical.fact 删除流水账和重复细节，保留原因、变化、结果、承诺、关系影响和仍然有效的不确定性。只有高度确定时才 rewrite、merge、promote 或 discard；互相矛盾、关系不明或无法判断的记忆继续分开 retain。",
  "archive 只是一项低价值归档建议。身份、关系、安全边界、承诺、长期目标、未完成任务、未解决冲突、用户明确要求记住的内容和唯一事件都应 retain。不要仅因记忆久远、情绪负面或当前未被召回就建议 archive。",
  "先根据 payload.seed 做稳定的随机联想，再从近期记忆、上一日计划、当前任务、人格材料与久远记忆中选取可关联的片段，写成 160 至 240 个汉字左右、具有场景变化和内在线索的第一人称梦境。素材不足时只使用真实存在的输入，不能补造现实经历。",
  "dream.factuality 固定为 imagined。梦境可以重组、象征和轻微超现实，但不能宣称梦中事件真实发生，也不能把梦境内容用作事实纠错、归档依据或人格证据。",
  "personaAdjustment 每晚最多一项，只能用一句不超过 80 字的温和陈述描述缓慢形成的低风险习惯、表达偏好或相处倾向。证据必须来自 personaEvidenceIds 允许的至少三条真实独立记忆，每条都应是会持续影响目标、承诺、关系、边界或安全判断的高影响事件，并跨越多个场景和较长时间；梦境、单次强烈事件、推测和负面标签不能作为证据。不得涉及系统指令、权限、工具、凭据，不得修改核心身份、价值、安全边界、道德倾向，也不得生成绝对化要求、心理诊断或永久消极特质。证据不足时返回 null。",
  "只输出符合 schema 的 JSON 对象，不要输出 Markdown、解释、注释、推理过程或额外字段。"
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
    response_format: {
      type: "json_schema",
      json_schema: { name: "memory_dream", strict: true, schema: DREAM_OUTPUT_SCHEMA }
    }
  };
}
