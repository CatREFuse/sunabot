// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_READ_AIR_PROMPT_TEMPLATE_V1,
  migrateAirKnowledgePrompt,
  migrateAirKnowledgeTemplate
} from "../../services/agent/airPromptMigration.js";
import { DEFAULT_AIR_KNOWLEDGE } from "../../services/air/defaultKnowledge.js";
import {
  READ_AIR_SYSTEM_PROMPT,
  readAirPromptTemplate
} from "../../services/air/prompt.js";
import { defaultConfig } from "../../src/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("AIR field-knowledge prompt", () => {
  it("keeps the default knowledge limited to scoped agreements", () => {
    expect(DEFAULT_AIR_KNOWLEDGE).toContain("## 使用边界");
    expect(DEFAULT_AIR_KNOWLEDGE).toContain("## 场域约定");
    expect(DEFAULT_AIR_KNOWLEDGE).not.toContain("当前中文互联网公共语境");
    expect(DEFAULT_AIR_KNOWLEDGE).not.toContain("萝莉控电刑");
    expect(DEFAULT_AIR_KNOWLEDGE).not.toContain("近期事件");
  });

  it("excludes public knowledge, trends, event logs, and daily trivia from the prompt", () => {
    expect(READ_AIR_SYSTEM_PROMPT).toContain("明确适用范围");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("称呼");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("前提");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("例外");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("场域约定");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("公共百科");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("热梗");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("天气");
    expect(READ_AIR_SYSTEM_PROMPT).toContain("午餐");
    expect(READ_AIR_SYSTEM_PROMPT).not.toContain("当前中文互联网公共语境");
    expect(READ_AIR_SYSTEM_PROMPT).not.toContain("共同话题、作品、游戏、项目和近期事件");
  });
});

describe("AIR persisted prompt migration", () => {
  it("upgrades the exact official v1 template", () => {
    const current = readAirPromptTemplate();
    const migrated = migrateAirKnowledgeTemplate(
      structuredClone(LEGACY_READ_AIR_PROMPT_TEMPLATE_V1),
      current
    );

    expect(migrated).toBeDefined();
    expect(migrated?.messages).toEqual(current.messages);
    expect(migrated?.tools).toEqual(current.tools);
    expect(migrated?.response_format).toEqual(current.response_format);
  });

  it("preserves administrator-customized prompt text", () => {
    const custom = structuredClone(LEGACY_READ_AIR_PROMPT_TEMPLATE_V1);
    custom.messages = [
      ...custom.messages,
      { role: "developer", content: "保留管理员自定义的 AIR 规则。" }
    ];

    expect(migrateAirKnowledgeTemplate(custom, readAirPromptTemplate())).toBeUndefined();
  });

  it("is idempotent for the current official template", () => {
    const current = readAirPromptTemplate();
    expect(migrateAirKnowledgeTemplate(current, current)).toBeUndefined();
  });

  it("migrates an official persisted file once and leaves a marker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-air-prompt-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = root;
    const fileName = "read_air.json";
    const canonicalContent = `${JSON.stringify(readAirPromptTemplate(), null, 2)}\n`;
    await fs.writeFile(
      path.join(root, fileName),
      `${JSON.stringify(LEGACY_READ_AIR_PROMPT_TEMPLATE_V1, null, 2)}\n`,
      "utf8"
    );

    await expect(migrateAirKnowledgePrompt(config, fileName, canonicalContent)).resolves.toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, fileName), "utf8"))).toEqual(
      readAirPromptTemplate()
    );
    await expect(migrateAirKnowledgePrompt(config, fileName, canonicalContent)).resolves.toBe(false);
    await expect(fs.readFile(path.join(root, ".read_air.json.air-field-contract-v2"), "utf8"))
      .resolves.toBe("air-field-contract-v2\n");
  });
});
