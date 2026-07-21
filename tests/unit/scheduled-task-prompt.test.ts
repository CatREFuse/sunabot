import { describe, expect, it } from "vitest";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { extractPromptVariables } from "../../services/agent/promptSystem.js";
import { migrateScheduledTaskAgentLoopTemplate } from "../../services/agent/promptWorkspace.js";
import {
  SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
  SCHEDULED_TASK_CALLBACK_PROMPT_ID,
  scheduledTaskCallbackPromptTemplate
} from "../../services/agent/scheduledTaskPrompt.js";

describe("scheduled task callback prompt", () => {
  it("renders an editable callback input template without owning an Agent tool set", () => {
    const template = scheduledTaskCallbackPromptTemplate();
    expect(SCHEDULED_TASK_CALLBACK_PROMPT_ID).toBe("scheduler.cron-callback");
    expect(SCHEDULED_TASK_CALLBACK_PROMPT_FILE).toBe("cron_callback.json");
    expect(template.tools).toEqual([]);
    expect(extractPromptVariables(JSON.stringify(template))).toContain("cron.payload");
    expect(JSON.stringify(template)).toContain("正常 user.input");
    expect(JSON.stringify(template)).toContain("实时信息");
  });

  it("migrates existing callback prompts into an editable callback input without replacing custom content", () => {
    const original = {
      messages: [
        { role: "system" as const, content: "保留自定义定时规则" },
        { role: "user" as const, content: "<cron_payload>@{cron.payload}</cron_payload>" }
      ],
      tools: [],
      response_format: { type: "text" }
    };
    const canonical = scheduledTaskCallbackPromptTemplate();
    const migrated = migrateScheduledTaskAgentLoopTemplate(original, canonical)!;

    expect(migrated.messages[0]).toEqual(original.messages[0]);
    expect(migrated.messages.at(-1)).toEqual(original.messages[1]);
    expect(JSON.stringify(migrated.messages)).toContain("实时信息");
    expect(migrated.tools).toEqual([]);
    expect(migrateScheduledTaskAgentLoopTemplate(migrated, canonical)).toBeUndefined();
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
