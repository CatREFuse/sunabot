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
  it("replaces the legacy private tool with Native and Docker Bash while preserving its description", () => {
    const migrated = migrateConversationBashToolsTemplate(
      template(["read_file", "workspace_bash"]),
      template(["read_file", "native_bash", "docker_bash"])
    );

    expect(migrated?.tools?.map((tool) => tool.function.name)).toEqual([
      "read_file",
      "native_bash",
      "docker_bash"
    ]);
    expect(migrated?.tools?.find((tool) => tool.function.name === "docker_bash")?.function.description)
      .toBe("workspace_bash description");
  });

  it("keeps group prompts Docker-only and is idempotent", () => {
    const canonical = template(["read_file", "docker_bash"]);
    const migrated = migrateConversationBashToolsTemplate(
      template(["read_file", "native_bash", "workspace_bash"]),
      canonical
    );

    expect(migrated?.tools?.map((tool) => tool.function.name)).toEqual(["read_file", "docker_bash"]);
    expect(migrateConversationBashToolsTemplate(migrated!, canonical)).toBeUndefined();
  });
});
