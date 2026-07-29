// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  migrateDreamMemoryContractTemplate,
  migrateDreamSchemaTemplate
} from "../../services/agent/dreamPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import {
  DREAM_CONTRACT,
  LEGACY_DREAM_CONTRACT_V3,
  dreamPromptTemplate
} from "../../services/memory/dream/public.js";

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

  it("upgrades the exact official memory contract while preserving administrator additions", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: `管理员前缀。\n\n${message.content.replace(DREAM_CONTRACT, LEGACY_DREAM_CONTRACT_V3)}\n\n管理员后缀。`
          }
        : message
    ));
    const migrated = migrateDreamMemoryContractTemplate({ ...original, messages });
    const system = migrated?.messages.find((message) => message.role === "system");

    expect(system?.content).toContain("管理员前缀。");
    expect(system?.content).toContain(DREAM_CONTRACT);
    expect(system?.content).toContain("管理员后缀。");
    expect(system?.content).not.toContain(LEGACY_DREAM_CONTRACT_V3);
    expect(migrated?.tools).toEqual(original.tools);
    expect(migrated?.response_format).toEqual(original.response_format);
    expect(migrateDreamMemoryContractTemplate(migrated!)).toBeUndefined();
  });

  it("does not overwrite a customized legacy contract", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: message.content.replace(
              DREAM_CONTRACT,
              LEGACY_DREAM_CONTRACT_V3.replace("每日睡眠窗口", "管理员自定义窗口")
            )
          }
        : message
    ));

    expect(migrateDreamMemoryContractTemplate({ ...original, messages })).toBeUndefined();
  });
});
