// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import { migrateConversationVoiceTemplate } from "../../services/agent/promptWorkspace.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("conversation voice prompt migration", () => {
  const canonical = defaultFinalPromptTemplate("conversation.private-reply")!;

  it("adds voice context variables and the canonical tool to an existing prompt", () => {
    const legacy = prompt([]);
    const migrated = migrateConversationVoiceTemplate(legacy, canonical)!;
    const serialized = JSON.stringify(migrated);

    expect(serialized).toContain("conversation.voice.settings");
    expect(serialized).toContain("conversation.voice.trigger_policy");
    expect(
      migrated.tools?.find(
        (tool) => tool.function.name === "send_voice_message",
      ),
    ).toMatchObject({
      function: {
        parameters: {
          additionalProperties: false,
          required: ["text", "language"],
        },
        strict: true,
      },
    });
    expect(
      migrateConversationVoiceTemplate(migrated, canonical),
    ).toBeUndefined();
  });

  it("preserves an administrator description while upgrading its schema and variable context", () => {
    const oldVoice = {
      type: "function" as const,
      function: {
        name: "send_voice_message",
        description: "保留这段管理员说明。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: true,
      },
    };
    const migrated = migrateConversationVoiceTemplate(
      prompt([oldVoice]),
      canonical,
    )!;
    const voice = migrated.tools?.find(
      (tool) => tool.function.name === "send_voice_message",
    )!;

    expect(voice.function.description).toContain("保留这段管理员说明。");
    expect(voice.function.description).toContain(
      "@{conversation.voice.settings}",
    );
    expect(voice.function.description).toContain(
      "@{conversation.voice.trigger_policy}",
    );
    expect(voice.function.parameters).not.toHaveProperty("properties.path");
    expect(voice.function.parameters).toHaveProperty("properties.text");
    expect(voice.function.parameters).toHaveProperty("properties.language");
  });
});

function prompt(tools: FinalPromptTemplate["tools"]): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: "旧系统提示词" },
      { role: "user", content: "<current_input>@{user.input}</current_input>" },
    ],
    tools,
    response_format: { type: "text" },
  };
}
