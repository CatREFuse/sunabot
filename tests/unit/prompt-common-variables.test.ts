// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROMPT_FILE_DEFINITIONS } from "../../services/agent/promptCatalog.js";
import { buildCommonPromptVariables } from "../../services/agent/persona.js";
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
      now
    })).toEqual({
      "bot.name": "测试 Bot",
      "user.name": "小猫",
      "runtime.current_time": "2026-07-14T08:09:10.123Z"
    });
    expect(buildCommonPromptVariables(config, {
      scope: "user_group",
      userName: "群成员",
      now
    })["user.name"]).toBe("");
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
