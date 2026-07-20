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
          required: ["text"],
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
    expect(voice.function.parameters).not.toHaveProperty("properties.language");
  });

  it("replaces the generated legacy ordering description without overwriting administrator text", () => {
    const legacyVoice = structuredClone(
      canonical.tools?.find((tool) => tool.function.name === "send_voice_message")!,
    );
    legacyVoice.function.description = [
      "Create a cloned-voice reading of the same visible assistant message and send it immediately after that text. Use it at most once, only for a meaningful greeting, intimate or loving expression, intense emotion, shyness, or an important milestone. Never use it for routine facts, progress, errors, code, URLs, or long content. The text must exactly match the accompanying human-readable assistant text, excluding emoji markers.",
      "Current settings: @{conversation.voice.settings}",
      "Trigger policy: @{conversation.voice.trigger_policy}",
    ].join("\n\n");

    const migrated = migrateConversationVoiceTemplate(prompt([legacyVoice]), canonical)!;
    const description = migrated.tools?.find(
      (tool) => tool.function.name === "send_voice_message",
    )?.function.description;

    expect(description).toBe(
      canonical.tools?.find((tool) => tool.function.name === "send_voice_message")
        ?.function.description,
    );
    expect(description).toContain("Voice Profile selects the synthesis language");
    expect(description).not.toContain("immediately after that text");
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
