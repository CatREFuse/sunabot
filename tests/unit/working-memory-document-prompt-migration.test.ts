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
          "管理员自定义提醒：不要讨论实时晋升长期记忆的历史设计。",
          "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者都只能是单个 ISO 8601 时间或 null，禁止把范围拼进一个字符串。无法从消息验证发生时间时保持 null，不要猜测；系统收到消息的时间由写入端生成 observedAt。",
          "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。整理前先把 previousWorkingMemories 和 messages 放到同一时间线上，检查同一件事的前因、经过、转折、结果以及感受变化，把彼此确有联系的片段写成一条新的综合工作记忆，并用 occurredAt 保留最早起点、occurredEndAt 保留最新结果或结束时间。",
          "每条事件仍要能判断谁在何时发生了什么。人物可以优先使用 payload.participants.addressNames 提供的称呼，并在有助于消歧时写成“称呼（QQ 123456）”；涉及多人时尽量逐一说明。addressNames 可填写本条 fact 实际使用的称呼，正文没有采用该格式也不影响内容表达。",
          "每条事件仍要能判断谁在何时发生了什么。人物在 fact 中只使用 payload.participants.addressNames 提供的称呼作为语义标识，并以“称呼（QQ 123456）”的形式自然写进第一人称叙述；QQ 号与称呼必须同时存在，涉及多人时逐一写全，不要写昵称、群名片或单独罗列身份。addressNames 填写本条 fact 实际使用的称呼。",
          "每条事实都要判断是否实时晋升长期记忆。每批通常只晋升 0 至 2 条最核心的事件；只有有明确时间、会长期影响关系、重要承诺、持续任务或关键结果的概括记忆才设置 promoteToLongTerm=true。普通进展、寒暄、无结论讨论和人物属性不得晋升。",
          "晋升事实必须提供受控 eventType 和稳定 subjectKey。eventType 只允许 task、decision、commitment、milestone、incident、relationship_change、status_change、other。subjectKey 描述不随“开始、进行中、完成、失败”等进展词变化的同一事件主体，优先使用任务号、Issue/PR、明确命名事项或“动作 + 目标”；仓库路径、文件名和地点不能单独构成主体。非晋升事实的 eventType 使用 other，subjectKey 使用空字符串。",
          "能并入 payload.relatedLongTermMemories 中同一主题的事件时，复用真实 longTermId，并把新进展吸收到一条更概括的第一人称记忆中；不要为同一主题的每次进展新建长期记忆。无法可靠匹配时返回 null，禁止编造 id。"
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
    expect(serialized).toContain("管理员自定义提醒：不要讨论实时晋升长期记忆的历史设计。");
    expect(serialized).toContain("每项持久化记录时间、IANA 时区和会话来源均由宿主生成");
    expect(serialized).toContain("由你根据当前上下文自行决定保留多少内容");
    expect(serialized).not.toContain("完整工作记忆通常保留 3 至 6 条");
    expect(serialized).not.toContain("QQ 号与称呼必须同时存在");
    expect(serialized).not.toContain("relatedLongTermMemories");
    expect(serialized).not.toContain("promoteToLongTerm");
    expect(serialized).not.toContain("longTermId");
    expect(migrated.tools).toEqual(template.tools);
    expect(migrateWorkingMemoryDocumentTemplate(migrated)).toBe(migrated);
  });
});
