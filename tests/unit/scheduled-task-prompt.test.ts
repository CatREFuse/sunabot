import { describe, expect, it } from "vitest";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { extractPromptVariables } from "../../services/agent/promptSystem.js";
import {
  SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
  SCHEDULED_TASK_CALLBACK_PROMPT_ID,
  scheduledTaskCallbackPromptTemplate
} from "../../services/agent/scheduledTaskPrompt.js";

describe("scheduled task callback prompt", () => {
  it("uses one opaque payload and disables callback tools", () => {
    const template = scheduledTaskCallbackPromptTemplate();
    expect(SCHEDULED_TASK_CALLBACK_PROMPT_ID).toBe("scheduler.cron-callback");
    expect(SCHEDULED_TASK_CALLBACK_PROMPT_FILE).toBe("cron_callback.json");
    expect(template.tools).toEqual([]);
    expect(extractPromptVariables(JSON.stringify(template))).toContain("cron.payload");
    expect(JSON.stringify(template)).toContain("结构化消息段");
  });

  it("is registered as an editable system prompt with the canonical default", () => {
    const definition = promptDefinitionById(SCHEDULED_TASK_CALLBACK_PROMPT_ID);
    expect(definition).toMatchObject({
      id: SCHEDULED_TASK_CALLBACK_PROMPT_ID,
      title: "定时任务回调",
      category: "调度",
      kind: "final",
      scope: "system"
    });
    expect(definition?.fileName({} as never)).toBe(SCHEDULED_TASK_CALLBACK_PROMPT_FILE);
    expect(definition?.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "cron.payload", type: "json", required: true })
    ]));
    expect(defaultFinalPromptTemplate(SCHEDULED_TASK_CALLBACK_PROMPT_ID))
      .toEqual(scheduledTaskCallbackPromptTemplate());
  });
});
