// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import { migrateConversationWebFetchTemplate } from "../../services/agent/webFetchPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("conversation WebFetch prompt migration", () => {
  const canonical = defaultFinalPromptTemplate("conversation.private-reply")!;

  it("adds canonical webfetch while preserving custom messages and tools", () => {
    const legacy = prompt([{ type: "function", function: {
      name: "custom_tool",
      description: "管理员自定义工具",
      parameters: { type: "object", properties: {} },
      strict: true
    } }]);

    const migrated = migrateConversationWebFetchTemplate(legacy, canonical)!;

    expect(migrated.messages).toEqual(legacy.messages);
    expect(migrated.tools?.map((tool) => tool.function.name)).toEqual(["custom_tool", "webfetch"]);
    expect(migrated.tools?.find((tool) => tool.function.name === "webfetch")).toMatchObject({
      function: {
        parameters: {
          properties: {
            url: expect.any(Object),
            semanticMatch: expect.any(Object),
            query: expect.any(Object)
          },
          required: ["url", "semanticMatch"]
        },
        strict: false
      }
    });
    expect(migrateConversationWebFetchTemplate(migrated, canonical)).toBeUndefined();
  });

  it("upgrades an existing webfetch schema while preserving its administrator description", () => {
    const custom = prompt([{ type: "function", function: {
      name: "webfetch",
      description: "保留管理员说明",
      parameters: { type: "object", oneOf: [] },
      strict: true
    } }]);

    const migrated = migrateConversationWebFetchTemplate(custom, canonical)!;
    expect(migrated.tools?.[0]?.function.description).toBe("保留管理员说明");
    expect(migrated.tools?.[0]?.function.parameters).toEqual(
      canonical.tools?.find((tool) => tool.function.name === "webfetch")?.function.parameters
    );
    expect(migrated.tools?.[0]?.function.strict).toBe(false);
  });
});

function prompt(tools: FinalPromptTemplate["tools"]): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: "保留管理员自定义系统提示词" },
      { role: "user", content: "<current_input>@{user.input}</current_input>" }
    ],
    tools,
    response_format: { type: "text" }
  };
}
