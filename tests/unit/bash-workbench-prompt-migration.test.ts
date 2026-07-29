// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BASH_WORKBENCH_CONTRACT,
  CONFIGURATION_DIRECTORY_INDEX_CONTRACT,
  migrateConversationConfigurationIndexTemplate,
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
      expect((system as { content: string }).content).toContain(CONFIGURATION_DIRECTORY_INDEX_CONTRACT);
      expect((system as { content: string }).content).toContain("`index.md`");
      expect((system as { content: string }).content).toContain("`/workbench`");
      expect((system as { content: string }).content).toContain("当前 Agent 的 `workbench/`");
      expect((system as { content: string }).content).toContain("独立 `docker-workbench/`");
      expect((system as { content: string }).content).toContain("你可以使用本轮实际提供的");
      expect((system as { content: string }).content).toContain("`generate_img`");
      expect((system as { content: string }).content).toContain("`selfie`");
      expect((system as { content: string }).content).toContain("`referenceImagePaths`");
      expect((system as { content: string }).content).toContain("原样传入");
      expect((system as { content: string }).content).toContain("`selfie/references.jsonl`");
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

  it("adds the configuration directory index rule after the existing workbench contract", () => {
    const template: FinalPromptTemplate = {
      messages: [
        { role: "system", content: `管理员自定义规则\n\n${BASH_WORKBENCH_CONTRACT}` },
        { role: "user", content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateConversationConfigurationIndexTemplate(template);
    const content = (migrated.messages[0] as { content: string }).content;

    expect(content).toContain("管理员自定义规则");
    expect(content.indexOf(BASH_WORKBENCH_CONTRACT))
      .toBeLessThan(content.indexOf(CONFIGURATION_DIRECTORY_INDEX_CONTRACT));
    expect(migrateConversationConfigurationIndexTemplate(migrated)).toBe(migrated);
  });

  it("upgrades the persisted v1 workbench and directory contracts without duplicating them", () => {
    const template: FinalPromptTemplate = {
      messages: [{
        role: "system",
        content: [
          "管理员自定义规则",
          '<bash_workbench_contract version="1">\n旧 Workbench 规则\n</bash_workbench_contract>',
          '<configuration_directory_index_contract version="1">\n旧目录规则\n</configuration_directory_index_contract>'
        ].join("\n\n")
      }],
      tools: [],
      response_format: { type: "text" }
    };

    const workbenchMigrated = migrateConversationBashWorkbenchTemplate(template);
    const migrated = migrateConversationConfigurationIndexTemplate(workbenchMigrated);
    const content = (migrated.messages[0] as { content: string }).content;

    expect(content).toContain("管理员自定义规则");
    expect(content).toContain('<bash_workbench_contract version="7">');
    expect(content).toContain('<configuration_directory_index_contract version="5">');
    expect(content).toContain("`selfie/references.jsonl`");
    expect(content).not.toContain('<bash_workbench_contract version="1">');
    expect(content).not.toContain('<configuration_directory_index_contract version="1">');
  });

  it("upgrades the persisted v3 workbench contract to the Docker file-loop contract", () => {
    const template: FinalPromptTemplate = {
      messages: [{
        role: "system",
        content: [
          "管理员自定义规则",
          '<bash_workbench_contract version="3">\n旧 Docker 规则\n</bash_workbench_contract>'
        ].join("\n\n")
      }],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateConversationBashWorkbenchTemplate(template);
    const content = (migrated.messages[0] as { content: string }).content;

    expect(content).toContain("管理员自定义规则");
    expect(content).toContain('<bash_workbench_contract version="7">');
    expect(content).toContain("`export_chat_media`");
    expect(content).toContain("`send_file`");
    expect(content).not.toContain('<bash_workbench_contract version="3">');
  });

  it("upgrades the persisted v4 contract with the image reference path rule", () => {
    const template: FinalPromptTemplate = {
      messages: [{
        role: "system",
        content: [
          "管理员自定义规则",
          '<bash_workbench_contract version="4">\n旧 Workbench 规则\n</bash_workbench_contract>'
        ].join("\n\n")
      }],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateConversationBashWorkbenchTemplate(template);
    const content = (migrated.messages[0] as { content: string }).content;

    expect(content).toContain("管理员自定义规则");
    expect(content).toContain('<bash_workbench_contract version="7">');
    expect(content).toContain("`generate_img`");
    expect(content).toContain("`selfie`");
    expect(content).toContain("`referenceImagePaths`");
    expect(content).not.toContain('<bash_workbench_contract version="4">');
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
