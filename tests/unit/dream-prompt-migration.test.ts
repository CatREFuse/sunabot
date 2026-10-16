// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assertDreamCanonicalOutputContractTemplate,
  migrateDreamCanonicalOutputContractTemplate,
  migrateDreamMemoryContractTemplate,
  migrateDreamMinimalContractTemplate,
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
  LEGACY_DREAM_STRICT_OUTPUT_CONTRACT,
  LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE,
  LEGACY_DREAM_CONTRACT_V3,
  LEGACY_DREAM_CONTRACT_V4,
  LEGACY_DREAM_CONTRACT_V6,
  LEGACY_DREAM_OUTPUT_CONTRACT_V7,
  LEGACY_DREAM_OUTPUT_CONTRACT_V8,
  dreamPromptTemplate
} from "../../services/memory/dream/public.js";
import { defaultConfig } from "../../src/config.js";
import { planRuntimePromptMigrations } from "../../src/runtime/promptMigrations.js";

const DREAM_TIME_PRESERVATION_GUIDANCE = "保留事件的时间语义";

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
  it("registers a repair after v9 so completed journals still correct stale itemized guidance", async () => {
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = "/tmp/sunabot-dream-v9-repair-system";
    config.persona.agentWorkspace = "/tmp/sunabot-dream-v9-repair-persona";

    const ids = (await planRuntimePromptMigrations(config)).map((entry) => entry.id);
    const v9 = ids.findIndex((id) => id.startsWith("dream-minimal-contract-v9:system:"));
    const repair = ids.findIndex((id) => id.startsWith("dream-minimal-contract-v9-repair-v1:system:"));

    expect(v9).toBeGreaterThanOrEqual(0);
    expect(repair).toBeGreaterThan(v9);
  });

  it("registers time-preserving compression after the completed v9 repair", async () => {
    const config = defaultConfig();
    config.persona.systemPromptWorkspace = "/tmp/sunabot-dream-time-preservation-system";
    config.persona.agentWorkspace = "/tmp/sunabot-dream-time-preservation-persona";

    const ids = (await planRuntimePromptMigrations(config)).map((entry) => entry.id);
    const repair = ids.findIndex((id) => id.startsWith("dream-minimal-contract-v9-repair-v1:system:"));
    const timePreservation = ids.findIndex((id) => id.startsWith(
      "dream-working-memory-time-preservation-v1:system:"
    ));

    expect(timePreservation).toBeGreaterThan(repair);
  });

  it("uses text output for new prompt workspaces", () => {
    expect(dreamPromptTemplate().response_format).toEqual({ type: "text" });
    expect(JSON.stringify(dreamPromptTemplate())).toContain(DREAM_OUTPUT_CONTRACT_MARKER);
    expect(JSON.stringify(dreamPromptTemplate())).toContain("字段顺序自由");
    expect(JSON.stringify(dreamPromptTemplate())).toContain(DREAM_TIME_PRESERVATION_GUIDANCE);
    expect(() => assertDreamCanonicalOutputContractTemplate(dreamPromptTemplate())).not.toThrow();
  });

  it("adds time-preserving compression to an existing v9 prompt without replacing administrator content", () => {
    const original = dreamPromptTemplate();
    const outdatedOutputContract = LEGACY_DREAM_STRICT_OUTPUT_CONTRACT;
    const outdated = {
      ...original,
      messages: original.messages.map((message) => message.role === "system"
        ? {
            ...message,
            content: `管理员自定义时间规则。\n\n${message.content.replace(
              DREAM_OUTPUT_CONTRACT,
              outdatedOutputContract
            )}`
          }
        : message)
    };
    const migrated = migrateDreamMinimalContractTemplate(outdated);
    const system = migrated?.messages.find((message) => message.role === "system")?.content ?? "";

    expect(system).toContain("管理员自定义时间规则。");
    expect(system).toContain(DREAM_TIME_PRESERVATION_GUIDANCE);
    expect(system).toContain("<persona_soul>@{persona.soul}</persona_soul>");
    expect(migrated?.tools).toEqual(outdated.tools);
    expect(migrated?.response_format).toEqual(outdated.response_format);
    expect(migrateDreamMinimalContractTemplate(migrated!)).toBeUndefined();
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated!)).not.toThrow();
  });

  it("preserves an administrator-only custom system prompt", () => {
    const original=dreamPromptTemplate();
    const custom={...original,messages:[{role:"system" as const,content:"管理员自定义的 Dream 规则。"}]};
    expect(migrateDreamCanonicalOutputContractTemplate(custom)).toBeUndefined();
    expect(()=>assertDreamCanonicalOutputContractTemplate(custom)).not.toThrow();
  });

  it("keeps custom partial-format instructions unchanged", () => {
    const partial={...dreamPromptTemplate(),messages:[{role:"system" as const,content:DREAM_OUTPUT_CONTRACT_MARKER+" custom format"}]};
    expect(()=>assertDreamCanonicalOutputContractTemplate(partial)).not.toThrow();
    expect(migrateDreamCanonicalOutputContractTemplate(partial)).toBeUndefined();
  });

  it("does not rewrite unrecognized format fragments", () => {
    const partial={...dreamPromptTemplate(),messages:[{role:"system" as const,content:DREAM_OUTPUT_CONTRACT_MARKER+" first "+DREAM_OUTPUT_CONTRACT_MARKER+" second"}]};
    expect(migrateDreamCanonicalOutputContractTemplate(partial)).toBeUndefined();
  });

  it("retains already flexible administrator guidance", () => {
    const custom={...dreamPromptTemplate(),messages:[{role:"system" as const,content:LEGACY_DREAM_FLEX_RESPONSE}]};
    expect(migrateDreamCanonicalOutputContractTemplate(custom)).toBeUndefined();
  });

  it("accepts contract keywords scattered across system messages", () => {
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
      .not.toThrow();
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
            content: `管理员前缀。\n\n${LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE}\n\n管理员后缀。`
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

  it("replaces the complete v6 Dream contract with the minimal three-part contract", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: `管理员前缀。\n\n${message.content.replace(
              DREAM_CONTRACT,
              LEGACY_DREAM_CONTRACT_V6
            )}\n\n管理员后缀。`
          }
        : message
    ));
    const migrated = migrateDreamMinimalContractTemplate({ ...original, messages })!;
    const system = migrated.messages.find((message) => message.role === "system");

    expect(system?.content).toContain("管理员前缀。");
    expect(system?.content).toContain(DREAM_CONTRACT);
    expect(system?.content).toContain("管理员后缀。");
    expect(system?.content).not.toContain(LEGACY_DREAM_CONTRACT_V6);
    expect(system?.content).not.toContain("longTermReviews");
    expect(system?.content).not.toContain("personaAdjustment");
    expect(system?.content).not.toContain("fieldKnowledge");
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
    expect(migrateDreamMinimalContractTemplate(migrated)).toBeUndefined();
  });

  it("replaces the itemized v8 contract with the document-level v9 contract", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: message.content.replace(
              DREAM_OUTPUT_CONTRACT,
              LEGACY_DREAM_OUTPUT_CONTRACT_V8
            )
          }
        : message
    ));
    const migrated = migrateDreamMinimalContractTemplate({ ...original, messages })!;
    const system = migrated.messages.find((message) => message.role === "system")?.content ?? "";

    expect(system).toContain(DREAM_OUTPUT_CONTRACT);
    expect(system).not.toContain(LEGACY_DREAM_OUTPUT_CONTRACT_V8);
    expect(system).toContain("字段顺序自由");
    expect(system).toContain("workingMemoryCompression 表达整理后的完整工作记忆");
    expect(system).not.toContain("sourceWorkingMemoryIds");
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
  });

  it("replaces itemized minimal guidance left beside an already migrated v9 output contract", () => {
    const original = dreamPromptTemplate();
    const staleMinimalGuidance = [
      "你负责在每日睡眠窗口结束时完成一次最小 Dream 记忆循环。",
      "先把 payload.workingMemories 按同一事件、因果链和仍有效状态压缩。不得丢弃任何来源；无法安全合并时保持单条并用原意改写。",
      "再从事实工作记忆中提取会持续影响未来回复的新长期事实。payload.longTermMemories 只用于判断是否已经记录，不能提出改写、合并、归档、删除或遗忘。",
      "最后结合事实输入、实际对话、活动任务、已提交日程和人格材料写一段连贯的第一人称梦境。"
    ].join("\n\n");
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: message.content.replace(DREAM_CONTRACT, [
              staleMinimalGuidance,
              DREAM_OUTPUT_CONTRACT
            ].join("\n\n"))
          }
        : message
    ));

    const migrated = migrateDreamMinimalContractTemplate({ ...original, messages })!;
    const system = migrated.messages.find((message) => message.role === "system")?.content ?? "";

    expect(system).toContain("先把 payload.workingMemory 作为一份完整文档压缩");
    expect(system).toContain(DREAM_OUTPUT_CONTRACT);
    expect(system).not.toContain("payload.workingMemories");
    expect(system.split(DREAM_OUTPUT_CONTRACT_MARKER)).toHaveLength(2);
    expect(migrateDreamMinimalContractTemplate(migrated)).toBeUndefined();
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
  });

  it("removes contradictory visible-reason guidance from a persisted v8 prompt", () => {
    const original = dreamPromptTemplate();
    const messages = original.messages.map((message) => (
      message.role === "system" && typeof message.content === "string"
        ? {
            ...message,
            content: [
              "管理员前缀。",
              message.content.replace(DREAM_OUTPUT_CONTRACT, LEGACY_DREAM_OUTPUT_CONTRACT_V8),
              "再从事实工作记忆中提取会持续影响未来回复的新长期事实。payload.longTermMemories 只用于判断是否已经记录，不能提出改写、合并、归档、删除或遗忘。每次都要明确说明新增或零新增的原因。",
              "管理员后缀。"
            ].join("\n\n")
          }
        : message
    ));
    const migrated = migrateDreamMinimalContractTemplate({ ...original, messages })!;
    const system = migrated.messages.find((message) => message.role === "system")?.content ?? "";

    expect(system).toContain("管理员前缀。");
    expect(system).toContain("管理员后缀。");
    expect(system).toContain("你负责在每日睡眠窗口结束时完成一次最小 Dream 记忆循环。");
    expect(system).toContain(DREAM_OUTPUT_CONTRACT);
    expect(system).not.toContain("每次都要明确说明新增或零新增的原因");
    expect(migrateDreamMinimalContractTemplate(migrated)).toBeUndefined();
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
  });

  it("replaces an older customized official contract slot while preserving content outside the slot", () => {
    const original = dreamPromptTemplate();
    const legacySlot = [
      "你负责在每日睡眠窗口结束时整理当前角色的记忆，并生成一段连贯的梦境。",
      "longTermMemories 与 workingMemories 中的每个 id 必须在对应 reviews 中恰好出现一次。",
      "archive 只是一项低价值归档建议。",
      "personaAdjustment 每晚最多一项，证据不足时返回 null。",
      "只输出符合 schema 的 JSON 对象。"
    ].join("\n\n");
    const messages = original.messages.map((message) => (
      message.role === "system"
        ? {
            ...message,
            content: [
              "管理员前缀。",
              legacySlot,
              "<persona_soul>@{persona.soul}</persona_soul>",
              "管理员后缀。",
              DREAM_OUTPUT_CONTRACT
            ].join("\n\n")
          }
        : message
    ));
    const migrated = migrateDreamMinimalContractTemplate({ ...original, messages })!;
    const system = migrated.messages.find((message) => message.role === "system")?.content ?? "";

    expect(system).toContain("管理员前缀。");
    expect(system).toContain("管理员后缀。");
    expect(system).toContain("<persona_soul>@{persona.soul}</persona_soul>");
    expect(system).toContain("你负责在每日睡眠窗口结束时完成一次最小 Dream 记忆循环。");
    expect(system).toContain(DREAM_OUTPUT_CONTRACT);
    expect(system).not.toContain("longTermMemories 与 workingMemories 中的每个 id 必须在对应 reviews");
    expect(system).not.toContain("archive 只是一项低价值归档建议");
    expect(system).not.toContain("personaAdjustment");
    expect(system.split(DREAM_OUTPUT_CONTRACT_MARKER)).toHaveLength(2);
    expect(() => assertDreamCanonicalOutputContractTemplate(migrated)).not.toThrow();
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
