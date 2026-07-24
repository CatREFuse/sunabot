// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  migrateWorkingMemoryDocumentTemplate
} from "../../services/agent/workingMemoryDocumentPromptMigration.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";

describe("working-memory document prompt migration", () => {
  it("removes real-time long-term promotion while preserving custom prompt content", () => {
    const template: FinalPromptTemplate = {
      messages: [{
        role: "system",
        content: [
          "管理员保留段落。",
          "时间使用 v2 字段。旧时间合同。",
          "每条事实都要判断是否实时晋升长期记忆。",
          "晋升事实必须提供受控 eventType 和稳定 subjectKey。",
          "能并入 payload.relatedLongTermMemories 中同一主题的事件时，复用真实 longTermId。"
        ].join("\n\n")
      }, {
        role: "user",
        content: "格式包含 ,\"promoteToLongTerm\":true,\"longTermId\":\"已有长期记忆 id 或 null\"。"
      }],
      tools: [{
        type: "function",
        function: {
          name: "custom_tool",
          description: "保留工具",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: []
          },
          strict: true
        }
      }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "working_memory",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              facts: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    fact: { type: "string" },
                    promoteToLongTerm: { type: "boolean" },
                    longTermId: { type: ["string", "null"] }
                  },
                  required: ["fact", "promoteToLongTerm", "longTermId"]
                }
              }
            },
            required: ["facts"]
          },
          strict: true
        }
      }
    };

    const migrated = migrateWorkingMemoryDocumentTemplate(template);
    const serialized = JSON.stringify(migrated);

    expect(serialized).toContain("管理员保留段落");
    expect(serialized).toContain("每项持久化记录时间、IANA 时区和会话来源均由宿主生成");
    expect(serialized).not.toContain("实时晋升长期记忆");
    expect(serialized).not.toContain("relatedLongTermMemories");
    expect(serialized).not.toContain("promoteToLongTerm");
    expect(serialized).not.toContain("longTermId");
    expect(migrated.tools).toEqual(template.tools);
    expect(migrateWorkingMemoryDocumentTemplate(migrated)).toBe(migrated);
  });
});
