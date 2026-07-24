// @vitest-environment node
import { describe, expect, it } from "vitest";
import { migrateDreamSchemaTemplate } from "../../services/agent/dreamPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { dreamPromptTemplate } from "../../services/memory/dream/public.js";

function legacyTemplate(): FinalPromptTemplate {
  return {
    messages: [
      { role: "system", content: "保留管理员自定义的 Dream 正文。" },
      { role: "user", content: "@{dream.payload}" }
    ],
    tools: [],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "memory_dream",
        strict: true,
        schema: {
          type: "object",
          properties: {
            workingReviews: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sourceIds: { type: "array", items: { type: "string" } },
                  action: { type: "string" },
                  canonical: { type: ["object", "null"] }
                },
                required: ["sourceIds", "action", "canonical"]
              }
            }
          }
        }
      }
    }
  };
}

describe("Dream flexible-contract prompt migration", () => {
  it("uses text output for new prompt workspaces", () => {
    expect(dreamPromptTemplate().response_format).toEqual({ type: "text" });
  });

  it("changes only the Provider response format and preserves administrator messages", () => {
    const original = legacyTemplate();
    const migrated = migrateDreamSchemaTemplate(original);

    expect(migrated?.response_format).toEqual({ type: "text" });
    expect(migrated?.messages).toEqual(original.messages);
    expect(migrated?.tools).toEqual(original.tools);
    expect(original.response_format.type).toBe("json_schema");
  });

  it("is idempotent for an existing text response contract", () => {
    const migrated = migrateDreamSchemaTemplate(legacyTemplate());
    expect(migrated).toBeDefined();
    expect(migrateDreamSchemaTemplate(migrated!)).toBeUndefined();
  });
});
