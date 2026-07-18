// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import {
  TONE_EMOJI_MARKER_RULE,
  migrateConversationEmojiVariables,
  migrateConversationEmojiTemplate,
  migrateToneEmojiMarkerRule,
  migrateToneEmojiMarkerTemplate
} from "../../services/agent/promptWorkspace.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("emoji prompt contract", () => {
  it("registers both variables for private and group replies", () => {
    for (const id of ["conversation.private-reply", "conversation.group-reply"]) {
      const names = promptDefinitionById(id)?.variables.map((variable) => variable.name);
      expect(names).toContain("conversation.emoji.keys");
      expect(names).toContain("conversation.emoji.syntax");
      const serialized = JSON.stringify(defaultFinalPromptTemplate(id));
      expect(serialized).toContain("@{conversation.emoji.keys}");
      expect(serialized).toContain("@{conversation.emoji.syntax}");
    }
  });

  it("adds missing variables immediately before the current input without reordering existing messages", () => {
    const original = {
      messages: [
        { role: "system", content: "custom" },
        "@{messages_64}",
        { role: "user", content: "<current>@{user.input}</current>" }
      ],
      tools: [],
      response_format: { type: "json_schema", json_schema: { name: "text", strict: true, schema: {} } }
    } as unknown as FinalPromptTemplate;
    const migrated = migrateConversationEmojiTemplate(original);
    expect(migrated.messages[0]).toEqual(original.messages[0]);
    expect(migrated.messages[1]).toBe(original.messages[1]);
    expect(JSON.stringify(migrated.messages[2])).toContain("conversation.emoji.keys");
    expect(JSON.stringify(migrated.messages[2])).toContain("conversation.emoji.syntax");
    expect(migrated.messages[3]).toEqual(original.messages[2]);
    expect(migrateConversationEmojiTemplate(migrated)).toBe(migrated);
  });

  it("adds the exact marker preservation rule to tone templates once", () => {
    const original = defaultFinalPromptTemplate("conversation.tone-rewrite")!;
    const withoutRule = structuredClone(original);
    const system = withoutRule.messages[0] as { content: string };
    system.content = system.content.replace(`\n\n${TONE_EMOJI_MARKER_RULE}`, "");
    const migrated = migrateToneEmojiMarkerTemplate(withoutRule);
    expect(JSON.stringify(migrated)).toContain(TONE_EMOJI_MARKER_RULE);
    expect(migrateToneEmojiMarkerTemplate(migrated)).toBe(migrated);
  });

  it("ignores response-schema disguises and adds only variables missing from valid message content", () => {
    const descriptionOnly = promptTemplate([
      { role: "system", content: "custom" },
      { role: "user", content: "@{user.input}" }
    ], "schema mentions @{conversation.emoji.keys} and @{conversation.emoji.syntax}");
    const migratedDescription = migrateConversationEmojiTemplate(descriptionOnly);
    expect(validMessageVariableCount(migratedDescription, "conversation.emoji.keys")).toBe(1);
    expect(validMessageVariableCount(migratedDescription, "conversation.emoji.syntax")).toBe(1);

    const halfMigrated = promptTemplate([
      { role: "system", content: "<emoji_keys>@{conversation.emoji.keys}</emoji_keys>" },
      { role: "user", content: "@{user.input}" }
    ], "schema mentions @{conversation.emoji.syntax}");
    const migratedHalf = migrateConversationEmojiTemplate(halfMigrated);
    expect(validMessageVariableCount(migratedHalf, "conversation.emoji.keys")).toBe(1);
    expect(validMessageVariableCount(migratedHalf, "conversation.emoji.syntax")).toBe(1);
    expect(JSON.stringify(migratedHalf.messages.filter((message) => (
      typeof message === "object" && message.role === "developer"
    )))).not.toContain("conversation.emoji.keys");
    expect(migrateConversationEmojiTemplate(migratedHalf)).toBe(migratedHalf);
  });

  it("requires the tone marker rule in a system message", () => {
    const userOnly = promptTemplate([
      { role: "system", content: "保留管理员的语气规则" },
      { role: "user", content: TONE_EMOJI_MARKER_RULE },
      { role: "user", content: "@{tone.payload}" }
    ], TONE_EMOJI_MARKER_RULE);
    const migrated = migrateToneEmojiMarkerTemplate(userOnly);
    expect(migrated.messages.filter((message) => (
      typeof message === "object"
      && message.role === "system"
      && typeof message.content === "string"
      && message.content.includes(TONE_EMOJI_MARKER_RULE)
    ))).toHaveLength(1);
    expect(migrateToneEmojiMarkerTemplate(migrated)).toBe(migrated);
  });

  it("repairs bad v1 markers once with v2 and preserves later administrator overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-emoji-prompt-v2-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    const nested = path.join(config.persona.systemPromptWorkspace, "nested");
    await fs.mkdir(nested, { recursive: true });

    const conversationFile = "nested/private.json";
    const conversationPath = path.join(config.persona.systemPromptWorkspace, conversationFile);
    const disguised = promptTemplate([
      { role: "system", content: "管理员规则" },
      { role: "user", content: "@{user.input}" }
    ], "@{conversation.emoji.keys} @{conversation.emoji.syntax}");
    await fs.writeFile(conversationPath, `${JSON.stringify(disguised, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(config.persona.systemPromptWorkspace, ".private.json.emoji-v1"), "emoji-v1\n", "utf8");

    await expect(migrateConversationEmojiVariables(config, conversationFile)).resolves.toBe(true);
    const migratedConversation = JSON.parse(await fs.readFile(conversationPath, "utf8")) as FinalPromptTemplate;
    expect(validMessageVariableCount(migratedConversation, "conversation.emoji.keys")).toBe(1);
    expect(validMessageVariableCount(migratedConversation, "conversation.emoji.syntax")).toBe(1);
    await expect(fs.readFile(path.join(nested, ".private.json.emoji-v2"), "utf8")).resolves.toBe("emoji-v2\n");

    const administratorConversation = promptTemplate([
      { role: "system", content: "管理员 v2 后主动移除表情变量" },
      { role: "user", content: "@{user.input}" }
    ]);
    await fs.writeFile(conversationPath, `${JSON.stringify(administratorConversation, null, 2)}\n`, "utf8");
    await expect(migrateConversationEmojiVariables(config, conversationFile)).resolves.toBe(false);
    expect(JSON.parse(await fs.readFile(conversationPath, "utf8"))).toEqual(administratorConversation);

    const toneFile = "nested/tone.json";
    const tonePath = path.join(config.persona.systemPromptWorkspace, toneFile);
    const userOnlyTone = promptTemplate([
      { role: "system", content: "保留管理员的语气规则" },
      { role: "user", content: TONE_EMOJI_MARKER_RULE },
      { role: "user", content: "@{tone.payload}" }
    ]);
    await fs.writeFile(tonePath, `${JSON.stringify(userOnlyTone, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(config.persona.systemPromptWorkspace, ".tone.json.emoji-marker-v1"), "emoji-marker-v1\n", "utf8");

    await expect(migrateToneEmojiMarkerRule(config, toneFile)).resolves.toBe(true);
    const migratedTone = JSON.parse(await fs.readFile(tonePath, "utf8")) as FinalPromptTemplate;
    expect(migratedTone.messages.some((message) => (
      typeof message === "object"
      && message.role === "system"
      && typeof message.content === "string"
      && message.content.includes(TONE_EMOJI_MARKER_RULE)
    ))).toBe(true);
    await expect(fs.readFile(path.join(nested, ".tone.json.emoji-marker-v2"), "utf8"))
      .resolves.toBe("emoji-marker-v2\n");

    await fs.writeFile(tonePath, `${JSON.stringify(userOnlyTone, null, 2)}\n`, "utf8");
    await expect(migrateToneEmojiMarkerRule(config, toneFile)).resolves.toBe(false);
    expect(JSON.parse(await fs.readFile(tonePath, "utf8"))).toEqual(userOnlyTone);
  });
});

function promptTemplate(
  messages: FinalPromptTemplate["messages"],
  schemaDescription = ""
): FinalPromptTemplate {
  return {
    messages,
    tools: [],
    response_format: schemaDescription
      ? {
          type: "json_schema",
          json_schema: {
            name: "test",
            strict: true,
            description: schemaDescription,
            schema: { type: "object", additionalProperties: false, properties: {} }
          }
        }
      : { type: "text" }
  };
}

function validMessageVariableCount(template: FinalPromptTemplate, variable: string) {
  return template.messages.filter((message) => (
    typeof message === "object"
    && ["system", "developer", "user"].includes(message.role)
    && typeof message.content === "string"
    && message.content.includes(`@{${variable}}`)
  )).length;
}
