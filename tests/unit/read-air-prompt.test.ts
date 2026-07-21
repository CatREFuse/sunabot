// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { migrateConversationAirTemplate } from "../../services/agent/airPromptMigration.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type FinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import { readAirPromptTemplate } from "../../services/air/prompt.js";

describe("read-air prompt", () => {
  it("renders the old knowledge, recent chat and character insight without tools", () => {
    const rendered = renderFinalPromptTemplate(readAirPromptTemplate(), {
      "runtime.current_time": "2026-07-20T20:00:00+08:00 [system_timezone=Asia/Shanghai]",
      "air.knowledge": "# 场域知识\n旧内容",
      "air.conversation": { conversation: { id: "group:1" }, messages: [{ role: "user", content: "不要叫我老板" }] },
      "air.insight": "对方明确拒绝这个称呼"
    }, { opaqueVariables: ["air.knowledge", "air.conversation", "air.insight"] });

    expect(rendered.messages.at(-1)?.content).toContain("# 场域知识\n旧内容");
    expect(rendered.messages.at(-1)?.content).toContain("不要叫我老板");
    expect(rendered.messages.at(-1)?.content).toContain("对方明确拒绝这个称呼");
    expect(rendered.tools).toEqual([]);
  });

  it("adds AIR.md and read_air to customized conversation prompts without replacing custom content", () => {
    const legacy: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "管理员自定义系统提示词" },
        { role: "user", content: "<current_input>@{user.input}</current_input>" }
      ],
      tools: [{
        type: "function",
        function: {
          name: "custom_tool",
          description: "custom",
          parameters: { type: "object", additionalProperties: false, properties: {} },
          strict: true
        }
      }],
      response_format: { type: "text" }
    };
    const canonical = parseFinalPromptTemplate(defaultPromptContent("conversation.private-reply"));

    const migrated = migrateConversationAirTemplate(legacy, canonical)!;
    expect((migrated.messages[0] as Record<string, string>).content).toContain("管理员自定义系统提示词");
    expect((migrated.messages[0] as Record<string, string>).content)
      .toContain("<air_knowledge>@{persona.air}</air_knowledge>");
    expect(migrated.tools?.map((tool) => tool.function.name)).toEqual(["custom_tool", "read_air"]);
    expect(migrateConversationAirTemplate(migrated, canonical)).toBeUndefined();
  });
});
