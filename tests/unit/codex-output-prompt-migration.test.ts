// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CODEX_OUTPUT_CONTRACT,
  migrateConversationCodexOutputTemplate
} from "../../services/agent/codexOutputPromptMigration.js";
import { CHAT_MEDIA_EXPORT_CONTRACT } from "../../services/agent/chatMediaPromptMigration.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import {
  CODEX_TOOL_DESCRIPTION,
  LEGACY_CODEX_TOOL_DESCRIPTION,
  LEGACY_CODEX_TOOL_DESCRIPTION_V0
} from "../../services/tools/definitions.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("Codex output system prompt contract", () => {
  it.each(["conversation.private-reply", "conversation.group-reply"])(
    "includes the Codex cwd and target-output rules in %s",
    (promptId) => {
      const template = defaultFinalPromptTemplate(promptId)!;
      const system = template.messages.find((message) => (
        typeof message === "object" && message.role === "system"
      )) as { content: string };
      const codex = template.tools?.find((tool) => tool.function.name === "codex");

      expect(system.content).toContain(CODEX_OUTPUT_CONTRACT);
      expect(system.content).toContain("当前工作目录（cwd）");
      expect(system.content).toContain("不得猜测或传入宿主内部输出目录");
      expect(codex?.function.description).toBe(CODEX_TOOL_DESCRIPTION);
    }
  );

  it.each([
    LEGACY_CODEX_TOOL_DESCRIPTION,
    LEGACY_CODEX_TOOL_DESCRIPTION_V0
  ])("upgrades a known legacy description while preserving content and idempotency", (legacyDescription) => {
    const template = conversationTemplate({
      system: `管理员自定义规则\n\n${CHAT_MEDIA_EXPORT_CONTRACT}`,
      codexDescription: legacyDescription
    });

    const migrated = migrateConversationCodexOutputTemplate(template);
    const content = (migrated.messages[0] as { content: string }).content;
    const codex = migrated.tools?.find((tool) => tool.function.name === "codex");

    expect(content).toContain("管理员自定义规则");
    expect(content.indexOf(CHAT_MEDIA_EXPORT_CONTRACT))
      .toBeLessThan(content.indexOf(CODEX_OUTPUT_CONTRACT));
    expect(codex?.function.description).toBe(CODEX_TOOL_DESCRIPTION);
    expect(migrateConversationCodexOutputTemplate(migrated)).toBe(migrated);
  });

  it("keeps an administrator-customized Codex description", () => {
    const template = conversationTemplate({
      system: "管理员自定义规则",
      codexDescription: "管理员自定义 Codex 说明"
    });

    const migrated = migrateConversationCodexOutputTemplate(template);
    const codex = migrated.tools?.find((tool) => tool.function.name === "codex");

    expect(codex?.function.description).toBe("管理员自定义 Codex 说明");
    expect((migrated.messages[0] as { content: string }).content)
      .toContain(CODEX_OUTPUT_CONTRACT);
  });
});

function conversationTemplate(input: {
  system: string;
  codexDescription: string;
}): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: "@{user.input}" }
    ],
    tools: [{
      type: "function",
      function: {
        name: "codex",
        description: input.codexDescription,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        },
        strict: true
      }
    }],
    response_format: { type: "text" }
  };
}
