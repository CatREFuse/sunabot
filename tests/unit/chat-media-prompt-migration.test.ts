// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CHAT_MEDIA_EXPORT_CONTRACT,
  migrateConversationChatMediaTemplate
} from "../../services/agent/chatMediaPromptMigration.js";
import { CONFIGURATION_DIRECTORY_INDEX_CONTRACT } from "../../services/agent/bashWorkbenchPromptMigration.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("chat media system prompt contract", () => {
  it.each(["conversation.private-reply", "conversation.group-reply"])(
    "includes the media export rules in %s",
    (promptId) => {
      const template = defaultFinalPromptTemplate(promptId)!;
      const system = template.messages.find((message) => (
        typeof message === "object" && message.role === "system"
      )) as { content: string };

      expect(system.content).toContain(CHAT_MEDIA_EXPORT_CONTRACT);
      expect(system.content).toContain("`export_chat_media`");
      expect(system.content).toContain("`import_chat_emoji`");
      expect(system.content).toContain("不得猜测");
      expect(system.content).toContain("管理员 QQ 私聊");
    }
  );

  it("preserves custom content, appends after the workbench index rule, and is idempotent", () => {
    const template: FinalPromptTemplate = {
      messages: [{
        role: "system",
        content: `管理员自定义规则\n\n${CONFIGURATION_DIRECTORY_INDEX_CONTRACT}`
      }, {
        role: "user",
        content: "@{user.input}"
      }],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateConversationChatMediaTemplate(template);
    const content = (migrated.messages[0] as { content: string }).content;

    expect(content).toContain("管理员自定义规则");
    expect(content.indexOf(CONFIGURATION_DIRECTORY_INDEX_CONTRACT))
      .toBeLessThan(content.indexOf(CHAT_MEDIA_EXPORT_CONTRACT));
    expect(migrateConversationChatMediaTemplate(migrated)).toBe(migrated);
  });

  it("uses a developer message when no system message exists", () => {
    const template: FinalPromptTemplate = {
      messages: [{ role: "user", content: "@{user.input}" }],
      tools: [],
      response_format: { type: "text" }
    };

    expect(migrateConversationChatMediaTemplate(template).messages).toEqual([
      { role: "developer", content: CHAT_MEDIA_EXPORT_CONTRACT },
      { role: "user", content: "@{user.input}" }
    ]);
  });
});
