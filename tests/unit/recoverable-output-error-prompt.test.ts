// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { RECOVERABLE_OUTPUT_ERROR_CONTRACT } from "../../services/agent/recoverableOutputErrorPrompt.js";
import {
  migrateRecoverableOutputErrorPrompt,
  migrateRecoverableOutputErrorTemplate
} from "../../services/agent/recoverableOutputErrorPromptMigration.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "../../services/agent/promptSystem.js";

describe("recoverable output error prompt", () => {
  it.each([
    "conversation.private-reply",
    "conversation.group-reply",
    "conversation.tone-rewrite"
  ])("includes the shared contract in the %s default", (promptId) => {
    const content = defaultPromptContent(promptId);

    expect(content).toContain('<recoverable_output_error_contract version=\\"1\\">');
    expect(content).toContain("（错误：简短原因）");
    expect(content).toContain("不影响正文正确性、完整性与安全发送");
  });

  it("preserves customized messages and adds the contract only once", () => {
    const original: FinalPromptTemplate = {
      messages: [
        { role: "system", content: "保留管理员自定义规则" },
        { role: "user", content: "<current_input>@{user.input}</current_input>" }
      ],
      tools: [],
      response_format: { type: "text" }
    };

    const migrated = migrateRecoverableOutputErrorTemplate(original);

    expect(migrated).not.toBe(original);
    expect(migrated.messages).toHaveLength(original.messages.length);
    expect(migrated.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("保留管理员自定义规则")
    });
    expect(JSON.stringify(migrated)).toContain("recoverable_output_error_contract");
    expect(migrateRecoverableOutputErrorTemplate(migrated)).toBe(migrated);
  });

  it("writes a same-directory migration marker and does not refill after completion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-recoverable-error-prompt-"));
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = root;
    const fileName = "custom/tone_rewrite.json";
    const filePath = path.join(root, fileName);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      messages: [
        { role: "system", content: "自定义 Tone" },
        { role: "user", content: "@{tone.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    }), "utf8");

    try {
      await expect(migrateRecoverableOutputErrorPrompt(config, fileName)).resolves.toBe(true);
      const migrated = parseFinalPromptTemplate(await fs.readFile(filePath, "utf8"));
      expect(migrated.messages.some((message) => (
        typeof message === "object"
        && typeof message.content === "string"
        && message.content.includes(RECOVERABLE_OUTPUT_ERROR_CONTRACT)
      ))).toBe(true);
      expect(await fs.readFile(
        path.join(root, "custom/.tone_rewrite.json.recoverable-output-error-v1"),
        "utf8"
      )).toBe("recoverable-output-error-v1\n");

      const customized = JSON.stringify({
        ...migrated,
        messages: migrated.messages.map((message) => (
          typeof message === "object" && message.role === "system"
            ? { ...message, content: "管理员后来删除了约定" }
            : message
        ))
      });
      await fs.writeFile(filePath, customized, "utf8");
      await expect(migrateRecoverableOutputErrorPrompt(config, fileName)).resolves.toBe(false);
      expect(await fs.readFile(filePath, "utf8")).toBe(customized);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
