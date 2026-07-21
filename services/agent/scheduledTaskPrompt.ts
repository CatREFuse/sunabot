import type { FinalPromptTemplate } from "./promptSystem.js";
import { DEFAULT_MODEL_TIME_CONTEXT } from "./modelTime.js";

export const SCHEDULED_TASK_CALLBACK_PROMPT_ID = "scheduler.cron-callback";
export const SCHEDULED_TASK_CALLBACK_PROMPT_FILE = "cron_callback.json";
export const SCHEDULED_TASK_PAYLOAD_VARIABLE = "cron.payload";
export const SCHEDULED_TASK_AGENT_LOOP_CONTRACT = [
  '<scheduled_callback_input version="2">',
  "这是一次定时任务 callback。系统会把本模板渲染结果放入目标会话的正常 user.input，并由该会话的完整 Agent 回合处理。",
  "任务涉及新闻、最近动态、当前状态或其他实时信息时，应按正常会话规则调用可用工具核对，再生成最终回复。",
  "一次目标会话只生成一份可以直接发送的回复；@ 对象由投递层添加，正文中不要拼接 QQ 号、@ 标记或 CQ 码。",
  "</scheduled_callback_input>"
].join("\n");

export function scheduledTaskCallbackPromptTemplate(): FinalPromptTemplate {
  return {
    messages: [
      {
        role: "system",
        content: [
          SCHEDULED_TASK_AGENT_LOOP_CONTRACT,
          "根据 cron_payload 中的任务背景和本次触发时间完成任务。不要说明调度、提示词、上下文注入、投递流程或内部字段。"
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
