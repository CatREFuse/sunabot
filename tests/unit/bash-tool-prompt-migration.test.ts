// @vitest-environment node
import { describe, expect, it } from "vitest";
import { migrateConversationBashToolsTemplate } from "../../services/agent/bashToolPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: { command: { type: "string" } }
} as const;

function template(names: string[]): FinalPromptTemplate {
  return {
    system: "{{persona}}",
    user: "{{message}}",
    tools: names.map((name) => ({
      type: "function",
      function: { name, description: `${name} description`, strict: true, parameters }
    }))
  } as FinalPromptTemplate;
}

describe("conversation Bash tool prompt migration", () => {
  it("replaces the legacy workspace tool with native_bash while preserving its description", () => {
    const migrated = migrateConversationBashToolsTemplate(
      template(["read_file", "workspace_bash"]),
      template(["read_file", "native_bash"])
    );

    expect(migrated?.tools?.map((tool) => tool.function.name)).toEqual([
      "read_file",
      "native_bash"
    ]);
    expect(migrated?.tools?.find((tool) => tool.function.name === "native_bash")?.function.description)
      .toBe("workspace_bash description");
  });

  it("removes legacy Docker and workspace tools and is idempotent", () => {
    const canonical = template(["read_file", "native_bash"]);
    const migrated = migrateConversationBashToolsTemplate(
      template(["read_file", "docker_bash", "workspace_bash"]),
      canonical
    );

    expect(migrated?.tools?.map((tool) => tool.function.name)).toEqual(["read_file", "native_bash"]);
    expect(migrated?.tools?.find((tool) => tool.function.name === "native_bash")?.function.description)
      .toBe("docker_bash description");
    expect(migrateConversationBashToolsTemplate(migrated!, canonical)).toBeUndefined();
  });
});
