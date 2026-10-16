// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTOR_SCHEDULE_OUTPUT_EXAMPLE,
  directorDailyPlanPromptTemplate,
  directorScheduleRevisionPromptTemplate
} from "../../services/director/prompt.js";
import {
  DIRECTOR_SOFT_OUTPUT_MIGRATION_VERSION,
  migrateDirectorSoftOutputPrompt,
  migrateDirectorSoftOutputTemplate
} from "../../services/agent/directorPromptMigration.js";
import { parseFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { planRuntimePromptMigrations } from "../../src/runtime/promptMigrations.js";
import { defaultConfig } from "../../src/config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Director soft output example migration", () => {
  it.each([
    ["plan", directorDailyPlanPromptTemplate],
    ["revision", directorScheduleRevisionPromptTemplate]
  ] as const)("updates only the known legacy %s messages and preserves the rest", (_name, create) => {
    const canonical = parseFinalPromptTemplate(JSON.stringify(create()));
    const legacy = legacyTemplate(canonical);
    const source = { ...legacy, administratorField: "preserved", response_format: { type: "text" } };
    const migrated = migrateDirectorSoftOutputTemplate(source, canonical);
    expect(migrated?.messages).toEqual(canonical.messages);
    expect(migrated).toMatchObject({ administratorField: "preserved", response_format: { type: "text" } });
    expect(migrated?.tools).toBe(source.tools);
    expect(migrateDirectorSoftOutputTemplate(migrated!, canonical)).toBeUndefined();
    expect(source.messages).toEqual(legacy.messages);
  });

  it("leaves custom content, message order and appended administrator messages untouched", () => {
    const canonical = parseFinalPromptTemplate(JSON.stringify(directorDailyPlanPromptTemplate()));
    const legacy = legacyTemplate(canonical);
    const edited = structuredClone(legacy);
    const first = edited.messages[0]!;
    if (typeof first === "string") throw new Error("expected object message");
    first.content = `${first.content}\n管理员补充要求`;
    expect(migrateDirectorSoftOutputTemplate(edited, canonical)).toBeUndefined();
    expect(migrateDirectorSoftOutputTemplate({ ...legacy, messages: [...legacy.messages].reverse() }, canonical)).toBeUndefined();
    expect(migrateDirectorSoftOutputTemplate({ ...legacy, messages: [...legacy.messages, { role: "user", content: "额外要求" }] }, canonical)).toBeUndefined();
  });

  it("writes its marker once and preserves edits after migration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-director-soft-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = root;
    const file = "nested/director.json";
    const filePath = path.join(root, file);
    const canonical = parseFinalPromptTemplate(JSON.stringify(directorDailyPlanPromptTemplate()));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacyTemplate(canonical)));
    await expect(migrateDirectorSoftOutputPrompt(config, file, JSON.stringify(canonical))).resolves.toBe(true);
    const migrated = await fs.readFile(filePath, "utf8");
    expect(migrated).toContain("字段示例");
    await expect(fs.readFile(path.join(root, "nested", `.director.json.${DIRECTOR_SOFT_OUTPUT_MIGRATION_VERSION}`), "utf8"))
      .resolves.toBe(`${DIRECTOR_SOFT_OUTPUT_MIGRATION_VERSION}\n`);
    const edited = migrated.replace("字段示例", "管理员修改后的示例");
    await fs.writeFile(filePath, edited);
    await expect(migrateDirectorSoftOutputPrompt(config, file, JSON.stringify(canonical))).resolves.toBe(false);
    expect(await fs.readFile(filePath, "utf8")).toBe(edited);
  });

  it("registers both migrations after their respective schema migrations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-director-soft-plan-"));
    roots.push(root);
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = path.join(root, "system");
    config.persona.agentWorkspace = path.join(root, "persona");
    const entries = await planRuntimePromptMigrations(config);
    for (const file of ["director_daily_plan.json", "director_schedule_revision.json"]) {
      const schema = entries.findIndex((entry) => entry.id.startsWith("director-schema-v1:system:") && entry.id.endsWith(file));
      const soft = entries.findIndex((entry) => entry.id.startsWith("director-soft-output-v1:system:") && entry.id.endsWith(file));
      expect(schema).toBeGreaterThanOrEqual(0);
      expect(soft).toBeGreaterThan(schema);
    }
  });
});

function legacyTemplate(canonical: ReturnType<typeof parseFinalPromptTemplate>) {
  return {
    ...canonical,
    messages: canonical.messages.map((message) => typeof message === "object" && typeof message.content === "string"
      ? { ...message, content: message.content.replace(`\n${DIRECTOR_SCHEDULE_OUTPUT_EXAMPLE}`, "") }
      : message)
  };
}
