import {
  DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE,
  DIRECTOR_SEED_VARIABLE,
  DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE
} from "./types.js";

const DIRECTOR_MODEL_TIME_CONTEXT = [
  "<time_context>当前系统时间与系统时区：@{runtime.current_time}。",
  "所有相对时间、日期、计划与时间判断都必须以该系统时间和系统时区为基准。",
  "输出时间必须携带 UTC 偏移或 IANA 时区，禁止使用无时区时间。</time_context>"
].join("");

const SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    timeZone: { type: "string", minLength: 1, maxLength: 80 },
    theme: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    items: {
      type: "array",
      minItems: 3,
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,47}$" },
          startAt: { type: "string", minLength: 20, maxLength: 40 },
          endAt: { type: "string", minLength: 20, maxLength: 40 },
          activity: { type: "string", minLength: 1, maxLength: 240 },
          location: { type: "string", minLength: 1, maxLength: 120 },
          participants: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 80 }
          },
          intent: { type: "string", minLength: 1, maxLength: 300 },
          variant: { type: "string", minLength: 1, maxLength: 120 },
          share: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              at: { type: ["string", "null"], maxLength: 40 },
              textIntent: { type: ["string", "null"], maxLength: 500 },
              selfiePrompt: { type: ["string", "null"], maxLength: 800 }
            },
            required: ["enabled", "at", "textIntent", "selfiePrompt"]
          }
        },
        required: [
          "id",
          "startAt",
          "endAt",
          "activity",
          "location",
          "participants",
          "intent",
          "variant",
          "share"
        ]
      }
    }
  },
  required: ["schemaVersion", "date", "timeZone", "theme", "summary", "items"]
} as const;

const SCHEDULE_CONTRACT = [
  "输出一份可执行的单日语义行程。所有时间使用带明确 UTC 偏移的 ISO 8601，且落在 payload.date 与 payload.timeZone 对应的同一个自然日。",
  "items 按 startAt 升序排列，互不重叠，覆盖起床后的日常、主要职责、饮食、休息和晚间收束；稳定循环优先，变种只从种子剧本允许的菜单中选择。",
  "活动必须符合角色可知信息、空间约束、职责与关联人物关系。不要制造重大事故、不可逆剧情、原作角色死亡、突然恋爱或改变核心身份。",
  "每天选择 1 至 3 个值得自然分享的轻量节点。share.enabled=true 时 at、textIntent、selfiePrompt 必须为非空字符串，at 必须落在所属事项的 startAt 与 endAt 之间；selfiePrompt 描述角色本人、现场、动作、表情、服装与光线，不写镜头外无法看到的事实。",
  "share.enabled=false 时 at、textIntent、selfiePrompt 必须全部为 null。",
  "id 使用稳定、简短的小写英文或数字标识。不要输出 Markdown、解释、注释或额外字段。"
].join("\n");

export function directorDailyPlanPromptTemplate() {
  return directorRequest(
    [
      "你是计划导演，负责根据角色的种子剧本安排今天的生活。",
      SCHEDULE_CONTRACT,
      "种子剧本是日常连续性的最高依据；随机变化只能从其中给出的菜单、概率和循环中产生。payload.generatedAt 之后必须保留至少一个尚未触发的分享节点。"
    ].join("\n\n"),
    DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE,
    "director_daily_plan"
  );
}

export function directorScheduleRevisionPromptTemplate() {
  return directorRequest(
    [
      "你是演绎导演，负责在角色主动提出变化后，修改今天尚未结束的行程。",
      SCHEDULE_CONTRACT,
      "保留 payload.currentSchedule 中已经结束或已经开始的事项；只修改当前时间之后的安排。角色传来的 request 只代表角色想做的事，仍需服从种子剧本、时间、地点、人物关系与安全边界。",
      "需要取消旧分享节点时直接从新行程中关闭或替换；新行程仍应形成完整的一天。尚未触发的分享节点应安排在 payload.now 之后。"
    ].join("\n\n"),
    DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE,
    "director_schedule_revision"
  );
}

function directorRequest(system: string, payloadVariable: string, name: string) {
  return {
    messages: [
      {
        role: "system",
        content: [
          system,
          `<director_seed>@{${DIRECTOR_SEED_VARIABLE}}</director_seed>`
        ].join("\n\n")
      },
      {
        role: "user",
        content: `${DIRECTOR_MODEL_TIME_CONTEXT}\n\n<director_payload>@{${payloadVariable}}</director_payload>`
      }
    ],
    tools: [],
    response_format: {
      type: "json_schema",
      json_schema: { name, strict: true, schema: SCHEDULE_SCHEMA }
    }
  };
}
