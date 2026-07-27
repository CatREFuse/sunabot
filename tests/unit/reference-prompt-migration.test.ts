// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  migrateConversationReferenceToolDescriptions,
  migrateGroupReferenceResolutionPrompt
} from "../../services/agent/referencePromptMigration.js";
import { LEGACY_GENERATE_IMG_TOOL_DESCRIPTION } from "../../services/tools/generateImgTool.js";
import { generateImgTool } from "../../services/tools/generateImgTool.js";
import { defaultConfig } from "../../src/config.js";

let root = "";
let config = defaultConfig();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-reference-prompt-"));
  config = defaultConfig();
  config.persona.systemPromptWorkspace = path.join(root, "system");
  config.persona.agentWorkspace = path.join(root, "agent");
  await Promise.all([
    fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true }),
    fs.mkdir(config.persona.agentWorkspace, { recursive: true })
  ]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("reference prompt migrations", () => {
  it("adds file and media coreference rules while preserving administrator messages", async () => {
    await writeTemplate("group.json", {
      messages: [
        { role: "system", content: "管理员自定义开头。" },
        {
          role: "developer",
          content: "原始消息是事实依据。当 thread_context 与原始消息冲突、confidence 较低或 relation 为 unresolved 时，应根据完整原始消息完成本轮判断。"
        },
        { role: "user", content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    });

    await expect(migrateGroupReferenceResolutionPrompt(config, "group.json", "reply")).resolves.toBe(true);
    const migrated = await readTemplate("group.json");
    expect(migrated.messages[0]).toEqual({ role: "system", content: "管理员自定义开头。" });
    expect(migrated.messages[1].content).toContain("对文件或媒体的指代");
    expect(migrated.messages[1].content).toContain("图片替代文本");
    await expect(migrateGroupReferenceResolutionPrompt(config, "group.json", "reply")).resolves.toBe(false);
  });

  it("updates only exact legacy tool descriptions and keeps administrator overrides", async () => {
    await writeTemplate("tools.json", {
      messages: [
        { role: "system", content: "保留正文" },
        { role: "user", content: "@{user.input}" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "generate_img",
            description: LEGACY_GENERATE_IMG_TOOL_DESCRIPTION,
            strict: true,
            parameters: { type: "object", properties: {} }
          }
        },
        {
          type: "function",
          function: {
            name: "selfie",
            description: "管理员自定义自拍说明",
            strict: true,
            parameters: { type: "object", properties: {} }
          }
        }
      ],
      response_format: { type: "text" }
    });

    await expect(migrateConversationReferenceToolDescriptions(config, "tools.json")).resolves.toBe(true);
    const migrated = await readTemplate("tools.json");
    expect(migrated.messages).toEqual([
      { role: "system", content: "保留正文" },
      { role: "user", content: "@{user.input}" }
    ]);
    expect(migrated.tools[0].function.description).toBe(generateImgTool.description);
    expect(migrated.tools[1].function.description).toBe("管理员自定义自拍说明");
    await expect(migrateConversationReferenceToolDescriptions(config, "tools.json")).resolves.toBe(false);
  });
});

async function writeTemplate(fileName: string, value: unknown) {
  await fs.writeFile(
    path.join(config.persona.systemPromptWorkspace, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

async function readTemplate(fileName: string) {
  return JSON.parse(await fs.readFile(
    path.join(config.persona.systemPromptWorkspace, fileName),
    "utf8"
  ));
}
