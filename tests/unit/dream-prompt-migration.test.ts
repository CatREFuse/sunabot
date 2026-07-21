// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrateDreamSchemaPrompt,
  migrateDreamSchemaTemplate
} from "../../services/agent/dreamPromptMigration.js";
import { defaultConfig } from "../../src/config.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { parseFinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("Dream prompt schema migration", () => {
  it("removes unsupported uniqueness keywords while preserving custom prompt content", () => {
    const legacy = parseFinalPromptTemplate(defaultPromptContent("memory.dream"));
    const responseFormat = legacy.response_format as Record<string, any>;
    const longTermIds = responseFormat.json_schema.schema.properties.longTermReviews.items.properties.sourceIds;
    const workingIds = responseFormat.json_schema.schema.properties.workingReviews.items.properties.sourceIds;
    const evidenceIds = responseFormat.json_schema.schema.properties.personaAdjustment.anyOf[0]
      .properties.evidenceMemoryIds;
    longTermIds.uniqueItems = true;
    workingIds.uniqueItems = true;
    evidenceIds.uniqueItems = true;
    legacy.messages[0] = { role: "system", content: "custom Dream instructions" };

    const migrated = migrateDreamSchemaTemplate(legacy)!;
    expect(JSON.stringify(migrated)).not.toContain('"uniqueItems"');
    expect(migrated.messages[0]).toEqual({ role: "system", content: "custom Dream instructions" });
    expect(JSON.stringify(legacy)).toContain('"uniqueItems":true');
    expect(migrateDreamSchemaTemplate(migrated)).toBeUndefined();
  });

  it("migrates an existing persisted prompt once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-dream-prompt-"));
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = root;
    const filePath = path.join(root, "memory_dream.json");
    const legacy = parseFinalPromptTemplate(defaultPromptContent("memory.dream"));
    const responseFormat = legacy.response_format as Record<string, any>;
    responseFormat.json_schema.schema.properties.longTermReviews.items.properties.sourceIds.uniqueItems = true;
    legacy.messages[0] = { role: "system", content: "persisted custom Dream instructions" };
    await fs.writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    try {
      await expect(migrateDreamSchemaPrompt(config, "memory_dream.json")).resolves.toBe(true);
      const migrated = await fs.readFile(filePath, "utf8");
      expect(migrated).not.toContain('"uniqueItems"');
      expect(migrated).toContain("persisted custom Dream instructions");

      await expect(migrateDreamSchemaPrompt(config, "memory_dream.json")).resolves.toBe(false);
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(migrated);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
