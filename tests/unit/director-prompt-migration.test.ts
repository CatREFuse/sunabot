// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  migrateConversationDirectorTemplate,
  migrateDirectorScheduleSchemaTemplate
} from "../../services/agent/directorPromptMigration.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "../../services/agent/promptSystem.js";

describe("Director conversation prompt migration", () => {
  it("adds the committed schedule before current input and appends call_director without replacing custom content", () => {
    const legacy: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "custom system" },
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

    const migrated = migrateConversationDirectorTemplate(legacy, canonical)!;
    expect(migrated.messages).toEqual([
      { role: "system", content: "custom system" },
      { role: "developer", content: "<daily_schedule>@{conversation.director.schedule}</daily_schedule>" },
      { role: "user", content: "<current_input>@{user.input}</current_input>" }
    ]);
    expect(migrated.tools?.map((tool) => tool.function.name)).toEqual(["custom_tool", "call_director"]);
    expect(legacy.messages).toHaveLength(2);
    expect(legacy.tools?.map((tool) => tool.function.name)).toEqual(["custom_tool"]);
    expect(migrateConversationDirectorTemplate(migrated, canonical)).toBeUndefined();
  });

  it("removes only the unsupported participants uniqueness keyword from persisted Director schemas", () => {
    const legacy = parseFinalPromptTemplate(defaultPromptContent("director.daily-plan"));
    const responseFormat = legacy.response_format as {
      json_schema: { schema: { properties: { items: { items: { properties: { participants: Record<string, unknown> } } } } } };
    };
    responseFormat.json_schema.schema.properties.items.items.properties.participants.uniqueItems = true;
    legacy.messages[0] = { role: "system", content: "custom Director instructions" };

    const migrated = migrateDirectorScheduleSchemaTemplate(legacy)!;
    expect(JSON.stringify(migrated)).not.toContain('"uniqueItems"');
    expect(migrated.messages[0]).toEqual({ role: "system", content: "custom Director instructions" });
    expect(JSON.stringify(legacy)).toContain('"uniqueItems":true');
    expect(migrateDirectorScheduleSchemaTemplate(migrated)).toBeUndefined();
  });
});
