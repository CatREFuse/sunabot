// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import { attachUsersToMemoryFacts } from "../../src/runtime/conversationMemoryHelpers.js";

const memoryPrompts = [
  ["memory.compress-in", "memory.payload"],
  ["memory.compress-out", "memory.payload"],
  ["memory.user-profile", "profile.payload"]
] as const;

describe("memory perspective prompt contract", () => {
  it.each(memoryPrompts)("keeps %s persona-aware, first-person and highly compressed", (id) => {
    const template = parseFinalPromptTemplate(defaultPromptContent(id, "阿罗娜"));
    const systemPrompt = template.messages
      .filter((message) => typeof message === "object" && message.role === "system")
      .map((message) => typeof message === "object" ? message.content : "")
      .join("\n");

    expect(systemPrompt).toContain("@{bot.name}");
    expect(systemPrompt).toContain("@{persona.soul}");
    expect(systemPrompt).toContain("@{persona.preference}");
    expect(systemPrompt).toContain("@{persona.user}");
    expect(systemPrompt).toContain("@{persona.relation}");
    expect(systemPrompt).toMatch(/第一人称|第一视角/);
    expect(systemPrompt).toMatch(/感受|情绪/);
    expect(systemPrompt).toMatch(/看法|判断|认知/);
    expect(systemPrompt).toMatch(/少数|3 至 6|3 至 8|1 至 3/);
    expect(systemPrompt).toMatch(/模板化前缀|字段标签/);
    expect(systemPrompt).not.toContain("普拉娜唯一");
  });

  it.each(memoryPrompts)("renders %s with the current persona and no unresolved variables", (id, payloadVariable) => {
    const template = parseFinalPromptTemplate(defaultPromptContent(id, "阿罗娜"));
    const rendered = renderFinalPromptTemplate(template, {
      "bot.name": "阿罗娜",
      "persona.soul": "ARONA_SOUL_SENTINEL",
      "persona.preference": "ARONA_PREFERENCE_SENTINEL",
      "persona.user": "ARONA_USER_SENTINEL",
      "persona.relation": "ARONA_RELATION_SENTINEL",
      [payloadVariable]: { messages: [] }
    }, {
      opaqueVariables: [payloadVariable]
    });
    const content = rendered.messages.map((message) => message.content).join("\n");

    expect(content).toContain("阿罗娜");
    expect(content).toContain("ARONA_SOUL_SENTINEL");
    expect(content).toContain("ARONA_PREFERENCE_SENTINEL");
    expect(content).toContain("ARONA_USER_SENTINEL");
    expect(content).toContain("ARONA_RELATION_SENTINEL");
    expect(content).not.toMatch(/@\{(?:bot|persona)\./);
  });

  it("keeps the strict JSON envelopes and memory metadata fields unchanged", () => {
    const working = parseFinalPromptTemplate(defaultPromptContent("memory.compress-in"));
    const longTerm = parseFinalPromptTemplate(defaultPromptContent("memory.compress-out"));
    const profile = parseFinalPromptTemplate(defaultPromptContent("memory.user-profile"));

    expect(working.tools).toEqual([]);
    expect(longTerm.tools).toEqual([]);
    expect(profile.tools).toEqual([]);
    expect(working.messages.map((message) => typeof message === "object" ? message.role : "messages"))
      .toEqual(["system", "user"]);
    expect(longTerm.messages.map((message) => typeof message === "object" ? message.role : "messages"))
      .toEqual(["system", "user"]);
    expect(profile.messages.map((message) => typeof message === "object" ? message.role : "messages"))
      .toEqual(["system", "user"]);

    const workingSchema = structuredSchema(working);
    const longTermSchema = structuredSchema(longTerm);
    const profileSchema = structuredSchema(profile);
    expect(workingSchema.name).toBe("working_memory");
    expect(workingSchema.strict).toBe(true);
    expect(workingSchema.schema.required).toEqual(["facts", "allPreviousMemoriesInvalidated"]);
    expect(workingSchema.schema.properties.facts.items.required).toEqual([
      "id",
      "fact",
      "occurredAt",
      "occurredEndAt",
      "userIds",
      "userName",
      "promoteToLongTerm",
      "longTermId",
      "eventType",
      "subjectKey"
    ]);
    expect(longTermSchema.name).toBe("long_term_memory");
    expect(longTermSchema.strict).toBe(true);
    expect(longTermSchema.schema.items.required).toEqual([
      "fact",
      "occurredAt",
      "occurredEndAt",
      "userIds",
      "userName",
      "eventType",
      "subjectKey"
    ]);
    expect(profileSchema.name).toBe("user_profiles");
    expect(profileSchema.strict).toBe(true);
    expect(profileSchema.schema.properties.profiles.items.required).toEqual([
      "userId",
      "userName",
      "addressName",
      "fact",
      "time"
    ]);
  });

  it("does not add a formatted user prefix when the first-person memory naturally includes the QQ number", () => {
    const [fact] = attachUsersToMemoryFacts([{
      fact: "我记得老师（QQ 10001）在推进这项工作，这让我很在意，我会继续关注结果。",
      userIds: ["10001"]
    }], [{
      userId: "10001",
      currentName: "老师",
      addressName: "老师",
      isAdmin: true
    }]);

    expect(fact?.fact).toBe("我记得老师（QQ 10001）在推进这项工作，这让我很在意，我会继续关注结果。");
    expect(fact?.fact).not.toContain("相关用户：");
  });
});

function structuredSchema(template: ReturnType<typeof parseFinalPromptTemplate>) {
  const format = template.response_format as {
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, any>;
    };
  };
  return format.json_schema;
}
