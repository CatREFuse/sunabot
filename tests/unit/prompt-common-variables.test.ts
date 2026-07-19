// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROMPT_FILE_DEFINITIONS } from "../../services/agent/promptCatalog.js";
import { buildCommonPromptVariables } from "../../services/agent/persona.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { migratePromptTimeContextTemplate } from "../../services/agent/promptWorkspace.js";
import { formatModelTimestamp } from "../../services/agent/modelTime.js";
import { defaultConfig } from "../../src/config.js";
import { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("common prompt variables", () => {
  it("exposes the common variables in every prompt template", () => {
    const expected = ["bot.name", "user.name", "runtime.current_time", "utils.roll"];

    for (const definition of PROMPT_FILE_DEFINITIONS) {
      expect(definition.variables.map((variable) => variable.name), definition.id)
        .toEqual(expect.arrayContaining(expected));
    }
  });

  it("resolves the bot name, private user name and current system time", () => {
    const config = defaultConfig();
    config.persona.name = "测试 Bot";
    const now = new Date("2026-07-14T08:09:10.123Z");

    expect(buildCommonPromptVariables(config, {
      scope: "private",
      userName: "  小猫  ",
      now,
      timeZone: "Asia/Shanghai"
    })).toEqual({
      "bot.name": "测试 Bot",
      "user.name": "小猫",
      "runtime.current_time": "2026-07-14T16:09:10.123+08:00 [system_timezone=Asia/Shanghai]"
    });
    expect(buildCommonPromptVariables(config, {
      scope: "user_group",
      userName: "群成员",
      now
    })["user.name"]).toBe("");
  });

  it("references the system time contract from every final prompt", () => {
    for (const definition of PROMPT_FILE_DEFINITIONS.filter((item) => item.kind === "final")) {
      expect(defaultPromptContent(definition.id), definition.id).toContain("@{runtime.current_time}");
    }
  });

  it("adds the system time contract to an existing customized prompt without replacing its content", () => {
    const original = {
      messages: [
        { role: "system" as const, content: "自定义规则" },
        { role: "user" as const, content: "@{user.input}" }
      ],
      tools: [],
      response_format: { type: "text" }
    };
    const migrated = migratePromptTimeContextTemplate(original);

    expect(migrated.messages).toEqual([
      original.messages[0],
      expect.objectContaining({
        role: "user",
        content: expect.stringMatching(/@\{runtime\.current_time\}[\s\S]*@\{user\.input\}/)
      })
    ]);
    expect(migratePromptTimeContextTemplate(migrated)).toBe(migrated);
  });

  it("formats model timestamps with the selected IANA time zone and its active UTC offset", () => {
    expect(formatModelTimestamp("2026-01-15T12:00:00.000Z", "America/New_York"))
      .toBe("2026-01-15T07:00:00.000-05:00");
    expect(formatModelTimestamp("2026-07-15T12:00:00.000Z", "America/New_York"))
      .toBe("2026-07-15T08:00:00.000-04:00");
  });

  it("generates one immutable 1-100 roll for each prompt request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prompt-utils-"));
    const config = createAdminTestConfig(root);
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });

    try {
      await runtime.ensureAgentPromptFiles(config);
      await fs.writeFile(
        path.join(config.persona.systemPromptWorkspace, "conversation_private_reply.json"),
        JSON.stringify({
          messages: [
            { role: "system", content: "@{utils.roll}/{{ utils.roll }}" },
            { role: "user", content: "测试" }
          ],
          response_format: { type: "text" }
        }),
        "utf8"
      );
      const random = vi.spyOn(Math, "random")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0.999999);

      const first = await runtime.renderPromptRequest("conversation.private-reply", { "utils.roll": 55 });
      const second = await runtime.renderPromptRequest("conversation.private-reply", { "utils.roll": 55 });

      expect(first.messages[0]?.content).toBe("1/1");
      expect(second.messages[0]?.content).toBe("100/100");
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      runtime.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
