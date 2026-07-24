import { readCallbackInput } from "../../services/agent/callbackInput.js";
import { DIRECTOR_SCHEDULED_TASK_ID_PREFIX } from "../../services/scheduling/public.js";

export function isDirectorScheduledTaskId(taskId: string) {
  return taskId.startsWith(DIRECTOR_SCHEDULED_TASK_ID_PREFIX);
}

export function scheduledCallbackTaskId(text: string) {
  const callback = readCallbackInput(text);
  if (callback?.kind !== "scheduled_task" || !isRecord(callback.payload)) return undefined;
  const messages = callback.payload.promptMessages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (!isRecord(message) || typeof message.content !== "string") continue;
    const open = "<cron_payload>";
    const close = "</cron_payload>";
    const start = message.content.indexOf(open);
    const end = message.content.indexOf(close, start + open.length);
    if (start < 0 || end < 0) continue;
    try {
      const payload = JSON.parse(message.content.slice(start + open.length, end)) as unknown;
      if (!isRecord(payload) || !isRecord(payload.task) || typeof payload.task.id !== "string") continue;
      return payload.task.id;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
