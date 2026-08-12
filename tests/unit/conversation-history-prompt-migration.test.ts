// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_MESSAGE_32_MIGRATION_VERSION,
  migrateConversationMessage32Prompt,
  migrateConversationMessage32Template
} from "../../services/agent/conversationHistoryPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { defaultConfig } from "../../src/config.js";
import { planRuntimePromptMigrations } from "../../src/runtime/promptMigrations.js";
import {
  GROUP_CONVERSATION_REPLY_PROMPT_FILE,
  PRIVATE_CONVERSATION_REPLY_PROMPT_FILE
} from "../../src/runtime/runtimeContracts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

describe("conversation message_32 prompt migration", () => {
  it("renames one exact history slot and known group contract text without changing administrator structure", () => {
    const tools = [{
      type: "function" as const,
      function: {
        name: "keep_me",
        description: "管理员工具",
        parameters: { type: "object", properties: {} }
      }
    }];
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "custom_reply",
        schema: { type: "object" }
      }
    };
    const customRoot = { owner: "administrator", revision: 7 };
    const legacy: FinalPromptTemplate = {
      messages: [
        {
          role: "system",
          content: [
            "管理员开头",
            "<group_context_contract>",
            "messages_64 是本轮注入窗口内当前消息之前最近最多 64 条完整原始群聊消息，数组顺序就是原始时间顺序。不得删除、替换或重排原始消息。",
            "管理员保留段落。",
            "生成回复前，在内部按 messages_64 的原始顺序梳理并行话题，结合紧邻消息、发送者、时间与 reply_to_message_id 判断当前输入延续、切换或连接的话题，再据此组织本轮回复。",
            "</group_context_contract>",
            "管理员结尾"
          ].join("\n"),
          customMessageField: true
        },
        { role: "developer", content: "保持原位", priority: 3 },
        "@{messages_64}",
        { role: "user", content: "@{user.input}", customInputField: "keep" }
      ],
      tools,
      response_format: responseFormat,
      customRoot
    };

    const migrated = migrateConversationMessage32Template(legacy);

    expect(migrated).not.toBe(legacy);
    expect(migrated.messages).toHaveLength(legacy.messages.length);
    expect(migrated.messages[1]).toBe(legacy.messages[1]);
    expect(migrated.messages[2]).toBe("@{message_32}");
    expect(migrated.messages[3]).toBe(legacy.messages[3]);
    expect(migrated.tools).toBe(tools);
    expect(migrated.response_format).toBe(responseFormat);
    expect(migrated.customRoot).toBe(customRoot);
    expect(migrated.messages[0]).toEqual(expect.objectContaining({
      role: "system",
      customMessageField: true,
      content: expect.stringContaining("管理员开头")
    }));
    const migratedContent = String((migrated.messages[0] as { content: string }).content);
    expect(migratedContent).toContain(
      "message_32 是本轮注入窗口内当前消息之前最近最多 32 条完整原始群聊消息"
    );
    expect(migratedContent).toContain("在内部按 message_32 的原始顺序梳理并行话题");
    expect(migratedContent).toContain("管理员保留段落。");
    expect(migratedContent).not.toContain("messages_64");
    expect(migrateConversationMessage32Template(migrated)).toBe(migrated);
  });

  it.each([
    {
      name: "a configurable conversation.messages slot beside the legacy slot",
      messages: ["@{messages_64}", "{{ conversation.messages }}"]
    },
    {
      name: "no legacy history slot",
      messages: []
    },
    {
      name: "an existing message_32 slot beside the legacy slot",
      messages: ["@{messages_64}", "@{message_32}"]
    },
    {
      name: "multiple legacy slots",
      messages: ["@{messages_64}", "@{messages_64}"]
    },
    {
      name: "only embedded and non-exact legacy references",
      messages: [
        { role: "developer", content: "prefix @{messages_64}" },
        "@{ messages_64 }"
      ]
    }
  ])("leaves a template with $name untouched", ({ messages }) => {
    const template: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "管理员系统提示词" },
        ...messages,
        { role: "user", content: "@{user.input}" }
      ],
      response_format: { type: "text" },
      customRoot: "keep"
    };

    expect(migrateConversationMessage32Template(template)).toBe(template);
  });

  it("writes the migrated template and marker once, then preserves later administrator edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-message-32-migration-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = root;
    const fileName = "nested/private.json";
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    const filePath = path.join(root, fileName);
    await fs.writeFile(filePath, JSON.stringify({
      messages: [
        { role: "system", content: "管理员系统提示词" },
        "@{messages_64}",
        { role: "user", content: "@{user.input}" }
      ],
      response_format: { type: "text" },
      customRoot: true
    }), "utf8");

    await expect(migrateConversationMessage32Prompt(config, fileName)).resolves.toBe(true);
    const migrated = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(migrated)).toEqual(expect.objectContaining({
      messages: [
        { role: "system", content: "管理员系统提示词" },
        "@{message_32}",
        { role: "user", content: "@{user.input}" }
      ],
      customRoot: true
    }));
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    const markerPath = path.join(
      root,
      "nested",
      `.private.json.${CONVERSATION_MESSAGE_32_MIGRATION_VERSION}`
    );
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe(
      `${CONVERSATION_MESSAGE_32_MIGRATION_VERSION}\n`
    );

    const administratorEdit = migrated.replace("管理员系统提示词", "管理员迁移后调整");
    await fs.writeFile(filePath, administratorEdit, "utf8");
    await expect(migrateConversationMessage32Prompt(config, fileName)).resolves.toBe(false);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(administratorEdit);
  });

  it("registers the private and group migrations after their cache-layout migrations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-message-32-registry-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = path.join(root, "system");
    config.persona.agentWorkspace = path.join(root, "persona");
    await Promise.all([
      fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true }),
      fs.mkdir(config.persona.agentWorkspace, { recursive: true })
    ]);

    const report = await planRuntimePromptMigrations(config);
    const ids = report.map((entry) => entry.id);
    for (const file of [
      PRIVATE_CONVERSATION_REPLY_PROMPT_FILE,
      GROUP_CONVERSATION_REPLY_PROMPT_FILE
    ]) {
      const cacheId = `conversation-cache-layout-v1:system:${file}`;
      const message32Id =
        `${CONVERSATION_MESSAGE_32_MIGRATION_VERSION}:system:${file}`;
      expect(ids).toContain(cacheId);
      expect(ids).toContain(message32Id);
      expect(ids.indexOf(message32Id)).toBeGreaterThan(ids.indexOf(cacheId));
    }
  });
});
