// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertDreamCanonicalOutputContractTemplate,
  migrateDreamCanonicalOutputContractTemplate,
  migrateDreamMemoryContractTemplate,
  migrateDreamRawIdentityTemplate,
  migrateDreamSchemaTemplate
} from "../../services/agent/dreamPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import {
  DREAM_CONTRACT,
  DREAM_RAW_IDENTITY_GUIDANCE,
  DREAM_OUTPUT_CONTRACT,
  DREAM_OUTPUT_CONTRACT_MARKER,
  LEGACY_DREAM_FLEX_RESPONSE,
  LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE,
  LEGACY_DREAM_CONTRACT_V3,
  LEGACY_DREAM_CONTRACT_V4,
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
    expect(JSON.stringify(dreamPromptTemplate())).toContain(DREAM_OUTPUT_CONTRACT_MARKER);
    expect(() => assertDreamCanonicalOutputContractTemplate(dreamPromptTemplate())).not.toThrow();
  });

  it("appends the canonical output contract to a custom system prompt without replacing it", () => {
    const original = dreamPromptTemplate();
    const custom = {
      ...original,
      messages: original.messages.map((message) => message.role === "system"
        ? { ...message, content: "管理员自定义的 Dream 规则。" }
        : message)
    };
    const migrated = migrateDreamCanonicalOutputContractTemplate(custom);
    const system = migrated?.messages.find((message) => message.role === "system");

    expect(system?.content).toContain("管理员自定义的 Dream 规则。");
    expect(system?.content).toContain(DREAM_OUTPUT_CONTRACT_MARKER);
    expect(migrated?.tools).toEqual(custom.tools);
    expect(migrated?.response_format).toEqual(custom.response_format);
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated!)).not.toThrow();
    expect(migrateDreamCanonicalOutputContractTemplate(migrated!)).toBeUndefined();
  });

  it("rebuilds a partial marker into the complete output contract", () => {
    const original = dreamPromptTemplate();
    const partial = {
      ...original,
      messages: original.messages.map((message) => message.role === "system"
        ? {
            ...message,
            content: `管理员自定义规则。\n\n${DREAM_OUTPUT_CONTRACT_MARKER}\n\n仅保留 schemaVersion。`
          }
        : message)
    };

    expect(() => assertDreamCanonicalOutputContractTemplate(partial)).toThrow(
      "Dream prompt output contract is incomplete."
    );
    const migrated = migrateDreamCanonicalOutputContractTemplate(partial)!;
    const system = migrated.messages.find((message) => message.role === "system");
    expect(system?.content).toContain("管理员自定义规则。");
    expect(system?.content).toContain(DREAM_OUTPUT_CONTRACT);
    expect(system?.content).not.toContain("仅保留 schemaVersion。");
    expect(system?.content?.split(DREAM_OUTPUT_CONTRACT_MARKER)).toHaveLength(2);
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
    expect(migrateDreamCanonicalOutputContractTemplate(migrated)).toBeUndefined();
  });

  it("removes multiple partial markers before appending one complete contract", () => {
    const original = dreamPromptTemplate();
    const migrated = migrateDreamCanonicalOutputContractTemplate({
      ...original,
      messages: [
        {
          role: "system",
          content: [
            "第一段管理员规则。",
            DREAM_OUTPUT_CONTRACT_MARKER,
            "残缺合同 A。",
            DREAM_OUTPUT_CONTRACT_MARKER,
            "残缺合同 B。"
          ].join("\n\n")
        },
        {
          role: "system",
          content: `第二段管理员规则。\n\n${DREAM_OUTPUT_CONTRACT_MARKER}\n\n残缺合同 C。\n\n${LEGACY_DREAM_FLEX_RESPONSE}`
        },
        ...original.messages.filter((message) => message.role !== "system")
      ]
    })!;
    const systems = migrated.messages.filter((message) => message.role === "system");
    const combined = systems.map((message) => message.content).join("\n");

    expect(systems[0]?.content).toContain("第一段管理员规则。");
    expect(systems[1]?.content).toBe("第二段管理员规则。");
    expect(combined).not.toContain("残缺合同");
    expect(combined).not.toContain(LEGACY_DREAM_FLEX_RESPONSE);
    expect(combined.split(DREAM_OUTPUT_CONTRACT_MARKER)).toHaveLength(2);
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
    expect(migrateDreamCanonicalOutputContractTemplate(migrated)).toBeUndefined();
  });

  it("removes legacy flexible instructions from every system message and appends one contract to the first", () => {
    const original = dreamPromptTemplate();
    const migrated = migrateDreamCanonicalOutputContractTemplate({
      ...original,
      messages: [
        { role: "system", content: `第一段管理员规则。\n\n${LEGACY_DREAM_FLEX_RESPONSE}` },
        { role: "system", content: `第二段管理员规则。\n\n${LEGACY_DREAM_FLEX_RESPONSE}` },
        ...original.messages.filter((message) => message.role !== "system")
      ]
    })!;
    const systems = migrated.messages.filter((message) => message.role === "system");
    const combined = systems.map((message) => message.content).join("\n");

    expect(systems[0]?.content).toContain(DREAM_OUTPUT_CONTRACT);
    expect(systems[1]?.content).toBe("第二段管理员规则。");
    expect(combined).not.toContain(LEGACY_DREAM_FLEX_RESPONSE);
    expect(combined.split(DREAM_OUTPUT_CONTRACT_MARKER)).toHaveLength(2);
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
  });

  it("does not accept contract keywords scattered across system messages", () => {
    const original = dreamPromptTemplate();
    const scattered = {
      ...original,
      messages: [
        { role: "system", content: `${DREAM_OUTPUT_CONTRACT_MARKER}\nschemaVersion dream` },
        {
          role: "system",
          content: "longTermReviews workingReviews personaAdjustment fieldKnowledge sourceIds canonical fact"
        },
        ...original.messages.filter((message) => message.role !== "system")
      ]
    };

    expect(() => assertDreamCanonicalOutputContractTemplate(scattered))
      .toThrow("Dream prompt output contract is incomplete.");
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

  it("upgrades the previous layered-memory contract to the impression-level contract", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? { ...message, content: message.content.replace(DREAM_CONTRACT, LEGACY_DREAM_CONTRACT_V4) }
        : message
    ));
    const migrated = migrateDreamMemoryContractTemplate({ ...original, messages });
    const system = migrated?.messages.find((message) => message.role === "system");

    expect(system?.content).toContain(DREAM_CONTRACT);
    expect(system?.content).not.toContain(LEGACY_DREAM_CONTRACT_V4);
  });

  it("replaces the exact legacy identity-alias guidance while preserving administrator content", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: `管理员前缀。\n\n${message.content.replace(
              DREAM_RAW_IDENTITY_GUIDANCE,
              LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE
            )}\n\n管理员后缀。`
          }
        : message
    ));
    const migrated = migrateDreamRawIdentityTemplate({ ...original, messages });
    const system = migrated?.messages.find((message) => message.role === "system");

    expect(system?.content).toContain("管理员前缀。");
    expect(system?.content).toContain(DREAM_RAW_IDENTITY_GUIDANCE);
    expect(system?.content).toContain("管理员后缀。");
    expect(system?.content).not.toContain(LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE);
    expect(migrated?.tools).toEqual(original.tools);
    expect(migrated?.response_format).toEqual(original.response_format);
    expect(migrateDreamRawIdentityTemplate(migrated!)).toBeUndefined();
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
