// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BASH_WORKBENCH_CONTRACT,
  migrateConversationBashWorkbenchTemplate
} from "../../services/agent/bashWorkbenchPromptMigration.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("conversation Bash workbench prompt contract", () => {
  it.each(["conversation.private-reply", "conversation.group-reply"])(
    "includes the workbench rule in the %s preset",
    (promptId) => {
      const template = defaultFinalPromptTemplate(promptId)!;
      const system = template.messages.find((message) => (
        typeof message === "object" && message.role === "system"
      ));

      expect(system).toBeDefined();
      expect((system as { content: string }).content).toContain(BASH_WORKBENCH_CONTRACT);
      expect((system as { content: string }).content).toContain("`index.md`");
      expect((system as { content: string }).content).toContain("`/workbench`");
      expect((system as { content: string }).content).toContain("当前 Agent 的 `workbench/`");
      expect((system as { content: string }).content).toContain("独立 `docker-workbench/`");
    }
  );

  it("preserves a customized system message and is idempotent", () => {
    const template: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "管理员自定义规则" },
        { role: "user", content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateConversationBashWorkbenchTemplate(template);

    expect(migrated).not.toBe(template);
    expect((migrated.messages[0] as { content: string }).content).toContain("管理员自定义规则");
    expect((migrated.messages[0] as { content: string }).content).toContain(BASH_WORKBENCH_CONTRACT);
    expect(migrateConversationBashWorkbenchTemplate(migrated)).toBe(migrated);
  });

  it("inserts a developer contract when no system message exists", () => {
    const template: FinalPromptTemplate = {
      messages: [{ role: "user", content: "@{user.input}" }],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateConversationBashWorkbenchTemplate(template);

    expect(migrated.messages).toEqual([
      { role: "developer", content: BASH_WORKBENCH_CONTRACT },
      { role: "user", content: "@{user.input}" }
    ]);
  });
});
