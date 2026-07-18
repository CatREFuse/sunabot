// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUserGroupOrchestratorResultSchema } from "../../services/agent/promptWorkspace.js";
import { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
let systemPromptDir = "";
let runtime: SunaRuntime;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-prompt-"));
  const config = createAdminTestConfig(root);
  systemPromptDir = config.persona.systemPromptWorkspace;
  runtime = new SunaRuntime(config, { attachmentService: {} as never });
  await runtime.ensureAgentPromptFiles(config);
});

afterAll(async () => {
  runtime.close();
  await fs.rm(root, { recursive: true, force: true });
});

const promptFiles = [
  ["memory.compress-in", "work_memory_compress_in.json"],
  ["memory.compress-out", "work_memory_compress_out.json"],
  ["memory.user-profile", "user_profile_prompt.json"]
] as const;

describe("memory prompt routing contract", () => {
  it("copies the legacy shared reply prompt and migrates the group template to the editable Thread variable", async () => {
    const migrationRoot = path.join(root, "legacy-split");
    const config = createAdminTestConfig(migrationRoot);
    await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });
    const legacyContent = `${runtime.defaultPromptContent("conversation.private-reply").trim()}\n`;
    await fs.writeFile(path.join(config.persona.systemPromptWorkspace, "conversation_reply.json"), legacyContent, "utf8");
    const migrationRuntime = new SunaRuntime(config, { attachmentService: {} as never });

    await migrationRuntime.ensureAgentPromptFiles(config);

    await expect(fs.readFile(
      path.join(config.persona.systemPromptWorkspace, "conversation_private_reply.json"),
      "utf8"
    )).resolves.toBe(legacyContent);
    const groupContent = await fs.readFile(
      path.join(config.persona.systemPromptWorkspace, "conversation_group_reply.json"),
      "utf8"
    );
    const groupDocument = JSON.parse(groupContent);
    expect(JSON.stringify(groupDocument)).toContain("conversation.group.thread_context");
    expect(JSON.stringify(groupDocument)).toContain("conversation.group.orchestrator_result");
    expect(groupDocument.messages.filter((message: unknown) => (
      JSON.stringify(message).includes("conversation.group.thread_context")
    ))).toHaveLength(1);
    expect(groupDocument.messages.filter((message: unknown) => (
      JSON.stringify(message).includes("conversation.group.orchestrator_result")
    ))).toHaveLength(1);
    migrationRuntime.close();
  });

  it("migrates the user-group orchestrator response schema once", async () => {
    const migrationRoot = path.join(root, "orchestrator-result-migration");
    const config = createAdminTestConfig(migrationRoot);
    await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });
    const promptPath = path.join(
      config.persona.systemPromptWorkspace,
      config.bot.orchestrator.promptFile
    );
    const legacy = JSON.parse(runtime.defaultPromptContent("orchestrator.user-group"));
    delete legacy.response_format.json_schema.schema.properties.reply_to_message_id;
    legacy.response_format.json_schema.schema.required = ["should_reply", "reason"];
    legacy.response_format.json_schema.schema.properties.reason.description =
      "伪装成已经迁移：reply_to_message_id";
    await fs.writeFile(promptPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(
      config.persona.systemPromptWorkspace,
      `.${path.basename(config.bot.orchestrator.promptFile)}.reply-target-v1`
    ), "reply-target-v1\n", "utf8");
    const migrationRuntime = new SunaRuntime(config, { attachmentService: {} as never });

    await migrationRuntime.ensureAgentPromptFiles(config);
    const migrated = JSON.parse(await fs.readFile(promptPath, "utf8"));
    expect(migrated.response_format.json_schema.schema.required).toEqual([
      "should_reply",
      "reason",
      "reply_to_message_id"
    ]);
    await expect(fs.readFile(path.join(
      config.persona.systemPromptWorkspace,
      `.${path.basename(config.bot.orchestrator.promptFile)}.reply-target-v2`
    ), "utf8")).resolves.toBe("reply-target-v2\n");
    migrated.response_format.json_schema.schema.properties.reason.description = "管理员自定义说明";
    await fs.writeFile(promptPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");

    await migrationRuntime.ensureAgentPromptFiles(config);
    expect(JSON.parse(await fs.readFile(promptPath, "utf8"))
      .response_format.json_schema.schema.properties.reason.description).toBe("管理员自定义说明");
    migrationRuntime.close();
  });

  it("scopes reply-target markers to nested prompt directories with the same basename", async () => {
    const migrationRoot = path.join(root, "orchestrator-result-nested-markers");
    const config = createAdminTestConfig(migrationRoot);
    const canonicalContent = runtime.defaultPromptContent("orchestrator.user-group");
    const legacy = JSON.parse(canonicalContent);
    delete legacy.response_format.json_schema.schema.properties.reply_to_message_id;
    legacy.response_format.json_schema.schema.required = ["should_reply", "reason"];
    const fileNames = ["first/shared.json", "second/shared.json"];

    for (const fileName of fileNames) {
      const promptPath = path.join(config.persona.systemPromptWorkspace, fileName);
      await fs.mkdir(path.dirname(promptPath), { recursive: true });
      await fs.writeFile(promptPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
      await expect(migrateUserGroupOrchestratorResultSchema(
        config,
        fileName,
        canonicalContent
      )).resolves.toBe(true);
      await expect(fs.readFile(path.join(
        path.dirname(promptPath),
        ".shared.json.reply-target-v2"
      ), "utf8")).resolves.toBe("reply-target-v2\n");
    }

    for (const fileName of fileNames) {
      const migrated = JSON.parse(await fs.readFile(
        path.join(config.persona.systemPromptWorkspace, fileName),
        "utf8"
      ));
      expect(migrated.response_format.json_schema.schema.required).toContain("reply_to_message_id");
    }

    const administratorPath = path.join(config.persona.systemPromptWorkspace, fileNames[0]);
    const administratorDocument = JSON.parse(await fs.readFile(administratorPath, "utf8"));
    administratorDocument.response_format.json_schema.schema.properties.reason.description =
      "管理员自定义说明";
    await fs.writeFile(
      administratorPath,
      `${JSON.stringify(administratorDocument, null, 2)}\n`,
      "utf8"
    );

    await expect(migrateUserGroupOrchestratorResultSchema(
      config,
      fileNames[0],
      canonicalContent
    )).resolves.toBe(false);
    expect(JSON.parse(await fs.readFile(administratorPath, "utf8"))).toEqual(administratorDocument);
  });

  it("does not restore migrated group variables after an administrator removes them", async () => {
    const migrationRoot = path.join(root, "custom-thread-migration");
    const config = createAdminTestConfig(migrationRoot);
    await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });
    const promptPath = path.join(config.persona.systemPromptWorkspace, "conversation_group_reply.json");
    await fs.writeFile(promptPath, JSON.stringify({
      messages: [
        { role: "system", content: "自定义系统规则" },
        { role: "user", content: "@{user.input}" }
      ],
      response_format: { type: "text" }
    }), "utf8");
    const migrationRuntime = new SunaRuntime(config, { attachmentService: {} as never });

    await migrationRuntime.ensureAgentPromptFiles(config);
    const migrated = JSON.parse(await fs.readFile(promptPath, "utf8"));
    expect(JSON.stringify(migrated)).toContain("conversation.group.thread_context");
    expect(JSON.stringify(migrated)).toContain("conversation.group.orchestrator_result");
    migrated.messages = migrated.messages.filter((message: unknown) => (
      !JSON.stringify(message).includes("conversation.group.thread_context")
      && !JSON.stringify(message).includes("conversation.group.orchestrator_result")
    ));
    await fs.writeFile(promptPath, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");

    await migrationRuntime.ensureAgentPromptFiles(config);
    expect(await fs.readFile(promptPath, "utf8")).not.toContain("conversation.group.thread_context");
    expect(await fs.readFile(promptPath, "utf8")).not.toContain("conversation.group.orchestrator_result");
    migrationRuntime.close();
  });

  it.each(promptFiles)("keeps %s aligned with %s", async (id, fileName) => {
    const workspacePrompt = await fs.readFile(path.join(systemPromptDir, fileName), "utf8");
    expect(JSON.parse(workspacePrompt)).toEqual(JSON.parse(runtime.defaultPromptContent(id)));
  });

  it("routes timeline events to working and long-term memory", async () => {
    const compressIn = await readPrompt("work_memory_compress_in.json");
    const compressOut = await readPrompt("work_memory_compress_out.json");

    expect(compressIn).toContain("工作记忆只记录发生过或正在发生的事件");
    expect(compressIn).toContain("即使稳定也不得写入工作记忆");
    expect(compressOut).toContain("长期记忆只记录发生了什么");
    expect(compressOut).toContain("纯用户属性记录必须丢弃");
  });

  it("routes every durable person attribute to the user profile", async () => {
    const userProfile = await readPrompt("user_profile_prompt.json");

    expect(userProfile).toContain("所有与人本身有关的属性都归入用户画像");
    expect(userProfile).toContain("userName 只保存 payload 中当前观测到的 QQ 昵称或显示名");
    expect(userProfile).toContain("addressName 只保存 @{bot.name} 回复该用户时使用的明确称呼");
    expect(userProfile).toContain("不要保留一次性事件的过程和结果");
  });
});

async function readPrompt(fileName: string) {
  const document = JSON.parse(await fs.readFile(path.join(systemPromptDir, fileName), "utf8"));
  return document.messages.find((message: { role?: string }) => message.role === "system")?.content ?? "";
}
