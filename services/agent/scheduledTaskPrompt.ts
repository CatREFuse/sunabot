import type { FinalPromptTemplate } from "./promptSystem.js";
import { DEFAULT_MODEL_TIME_CONTEXT } from "./modelTime.js";

export const SCHEDULED_TASK_CALLBACK_PROMPT_ID = "scheduler.cron-callback";
export const SCHEDULED_TASK_CALLBACK_PROMPT_FILE = "cron_callback.json";
export const SCHEDULED_TASK_PAYLOAD_VARIABLE = "cron.payload";

export function scheduledTaskCallbackPromptTemplate(): FinalPromptTemplate {
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
          "你正在执行管理员预先创建的定时任务。根据 cron_payload 中的任务背景和本次触发时间，生成此刻应主动发送的完整消息。",
          "一次触发只生成一份正文，系统会把同一正文可靠投递到 payload.targets 中的全部会话。不要为不同目标分别作答。",
          "@ 对象由投递层以结构化消息段添加；正文中不要自行拼接 QQ 号、@ 标记或 CQ 码。",
          "只输出可以直接发给用户的最终正文，不要说明调度、提示词、上下文注入、投递流程或内部字段。"
        ].join("\n\n")
      },
      {
        role: "user",
        content: `${DEFAULT_MODEL_TIME_CONTEXT}\n\n<cron_payload>@{cron.payload}</cron_payload>`
      }
    ],
    tools: [],
    response_format: { type: "text" }
  };
}
