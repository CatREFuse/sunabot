// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  migrateConversationInboundMessageTemplate
} from "../../services/agent/inboundMessagePromptMigration.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("conversation inbound message prompt migration", () => {
  it.each(["conversation.private-reply", "conversation.group-reply"])(
    "includes the public interpretation contract in %s",
    (promptId) => {
      const content = defaultPromptContent(promptId);

      expect(content).toContain('<inbound_message_contract version=\\"1\\">');
      expect(content).toContain("内容图片#N");
      expect(content).toContain("表情图片#N");
      expect(content).toContain("聊天记录开始");
    }
  );

  it("adds the public interpretation contract without replacing customized rules", () => {
    const template: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "保留管理员自定义规则" },
        { role: "user", content: "<current_input>@{user.input}</current_input>" }
      ],
      tools: []
    };

    const migrated = migrateConversationInboundMessageTemplate(template);

    expect(migrated).not.toBe(template);
    expect(migrated.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("保留管理员自定义规则")
    });
    expect(JSON.stringify(migrated)).toContain('<inbound_message_contract version=\\"1\\">');
    expect(JSON.stringify(migrated)).toContain("内容图片#N");
    expect(JSON.stringify(migrated)).toContain("表情图片#N");
    expect(JSON.stringify(migrated)).toContain("聊天记录开始");
  });

  it("inserts a developer contract when a template has no system message", () => {
    const template: FinalPromptTemplate = {
      messages: [{ role: "user", content: "@{user.input}" }],
      tools: []
    };

    const migrated = migrateConversationInboundMessageTemplate(template);

    expect(migrated.messages[0]).toMatchObject({
      role: "developer",
      content: expect.stringContaining('<inbound_message_contract version="1">')
    });
    expect(migrated.messages[1]).toEqual(template.messages[0]);
  });

  it("is idempotent once the contract is present", () => {
    const template: FinalPromptTemplate = {
      messages: [{
        role: "system",
        content: '<inbound_message_contract version="1">\n已有规则\n</inbound_message_contract>'
      }],
      tools: []
    };

    expect(migrateConversationInboundMessageTemplate(template)).toBe(template);
  });
});
