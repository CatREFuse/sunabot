// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { formatMemoryMatchesForPrompt } from "../../services/memory/recall/recallService.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import {
  attachUsersToMemoryFacts,
  normalizeUserProfileFacts,
  parseMemoryFactOutput,
  resolveFactUsers
} from "../../src/runtime/conversationMemoryHelpers.js";

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
    expect(systemPrompt).toContain("fact 中的“我”始终指当前角色 @{bot.name}");
    expect(systemPrompt).toContain("正文禁止出现“我记得”");
    expect(systemPrompt).not.toContain("例如“我记得");
    expect(systemPrompt).toMatch(/相同、相近、重复|相同、相近/);
    expect(systemPrompt).toMatch(/因果关系|互为因果/);
    expect(systemPrompt).toMatch(/时间关系|时间先后|最早起点/);
    expect(systemPrompt).toMatch(/昵称.*QQ|QQ.*昵称/);
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
      "runtime.current_time": "2026-07-19T23:00:00.000+08:00 [system_timezone=Asia/Shanghai]",
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

  it("rejects recall phrases and persists the current nickname instead of the address name", () => {
    const parsed = parseMemoryFactOutput(JSON.stringify([{
      fact: "我知道旧昵称（QQ 10001）正在推进这项工作，这让我很在意，我会继续关注结果。",
      userIds: ["10001"],
      userName: "旧昵称"
    }]));
    const [fact] = attachUsersToMemoryFacts(parsed ?? [], [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "老师",
      isAdmin: true
    }]);

    expect(fact?.fact).toBe("我知道海边用户（QQ 10001）正在推进这项工作，这让我很在意，我会继续关注结果。");
    expect(fact?.userName).toBe("海边用户");
    expect(fact?.userName).not.toBe("老师");
    expect(fact?.fact).not.toContain("我记得");
    expect(fact?.fact).not.toContain("旧昵称");
    expect(fact?.fact).not.toContain("相关用户：");
    for (const forbiddenFact of [
      "我还记得海边用户（QQ 10001）正在推进。",
      "我回想起来海边用户（QQ 10001）正在推进。",
      "I still remember 海边用户（QQ 10001）正在推进。",
      "I recall 海边用户（QQ 10001）正在推进。"
    ]) {
      expect(parseMemoryFactOutput(JSON.stringify([{
        fact: forbiddenFact,
        userIds: ["10001"],
        userName: "海边用户"
      }]))).toEqual([]);
    }
  });

  it("fails closed for ambiguous user self-narration, invalid QQ values and unobserved nicknames", () => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "海边用户",
      isAdmin: false
    };

    expect(attachUsersToMemoryFacts([{
      fact: "我喜欢摄影。",
      userIds: ["10001"],
      userName: "海边用户"
    }], [participant])).toEqual([]);
    expect(parseMemoryFactOutput(JSON.stringify([{
      fact: "我知道海边用户（QQ 10001）正在推进工作。",
      userIds: ["10001", "not-a-qq"],
      userName: "海边用户"
    }]))).toEqual([]);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道模型幻觉昵称（QQ 10001）正在推进工作。",
      userIds: ["10001"],
      userName: "模型幻觉昵称"
    }], [{ ...participant, names: [], currentName: "" }])).toEqual([]);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道海边用户正在推进工作。",
      userIds: ["99999"],
      userName: "海边用户"
    }], [participant])).toEqual([]);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道捏造昵称（QQ 10001）正在推进工作。",
      userIds: ["10001"],
      userName: "另一模型昵称"
    }], [participant])).toEqual([]);
  });

  it("does not infer a nickname and QQ pair from separate substrings", () => {
    const facts = attachUsersToMemoryFacts([{
      fact: "我知道海边用户会继续推进，任务编号 10001 也需要关注。",
      userIds: ["10001"],
      userName: "海边用户"
    }], [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "海边用户",
      isAdmin: false
    }]);

    expect(facts).toEqual([]);
  });

  it("keeps explicit user IDs authoritative and infers users only from exact nickname and QQ pairs", () => {
    const participants = [{
      userId: "10001",
      names: ["海"],
      currentName: "海",
      addressName: "海",
      isAdmin: false
    }, {
      userId: "10002",
      names: ["上海用户"],
      currentName: "上海用户",
      addressName: "上海用户",
      isAdmin: false
    }];

    expect(resolveFactUsers({
      fact: "我知道海（QQ 10001）和上海用户（QQ 10002）都在推进。",
      userIds: ["10001"]
    }, participants).map((user) => user.userId)).toEqual(["10001"]);
    expect(resolveFactUsers({
      fact: "我知道上海（QQ 10001）正在推进。"
    }, participants)).toEqual([]);
    expect(resolveFactUsers({
      fact: "我知道海（QQ 10001）正在推进。"
    }, participants).map((user) => user.userId)).toEqual(["10001"]);
  });

  it("rejects nickname suffix matches while retaining natural exact identity sentences", () => {
    const participant = {
      userId: "10001",
      names: ["海"],
      currentName: "海",
      addressName: "海",
      isAdmin: false
    };

    expect(attachUsersToMemoryFacts([{
      fact: "我知道上海（QQ 10001）正在推进，这让我很期待。",
      userIds: ["10001"],
      userName: "海"
    }], [participant])).toEqual([]);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道海（QQ 10001）正在推进，这让我很期待。",
      userIds: ["10001"],
      userName: "海"
    }], [participant])).toMatchObject([{
      fact: "我知道海（QQ 10001）正在推进，这让我很期待。",
      userIds: ["10001"],
      userName: "海"
    }]);
  });

  it("rejects every forged nickname marker even when the same QQ also has a trusted pair", () => {
    const participant = {
      userId: "10001",
      names: ["海"],
      currentName: "海",
      addressName: "海",
      isAdmin: false
    };
    const input = [{
      fact: "我知道海（QQ 10001）与伪造昵称（QQ 10001）都在推进，这让我很期待。",
      userId: "10001",
      userIds: ["10001"],
      userName: "海"
    }];

    expect(attachUsersToMemoryFacts(input, [participant])).toEqual([]);
    expect(normalizeUserProfileFacts(input, [participant])).toEqual([]);
  });

  it("rejects the whole profile fact when declared users are missing from the body", () => {
    const participants = [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "海边用户",
      isAdmin: false
    }, {
      userId: "10002",
      names: ["山边用户"],
      currentName: "山边用户",
      addressName: "山边用户",
      isAdmin: false
    }];
    const input = [{
      fact: "我知道海边用户（QQ 10001）正在推进，这让我很期待。",
      userIds: ["10001", "10002"],
      userName: "海边用户"
    }];

    expect(attachUsersToMemoryFacts(input, participants)).toEqual([]);
    expect(normalizeUserProfileFacts(input, participants)).toEqual([]);
  });

  it.each([
    "我认为摄影是我的爱好，海边用户（QQ 10001）是我的昵称，我很开心。",
    "我认为自己喜欢摄影，海边用户（QQ 10001）让我感到开心。",
    "我正在学习摄影，海边用户（QQ 10001）是我的昵称。",
    "我的判断是摄影是我的爱好，海边用户（QQ 10001）让我很开心。",
    "我会关注海边用户（QQ 10001）说：我喜欢摄影。",
    "我注意到海边用户（QQ 10001）说：我觉得摄影很重要，我很开心。",
    "我注意到海边用户（QQ 10001）说：“我觉得摄影很重要”，我很开心。",
    "我注意到海边用户（QQ 10001）在聊天中说：我觉得摄影很重要，我很开心。",
    "我注意到海边用户（QQ 10001）告诉我：‘我觉得摄影很重要’，我很开心。",
    "我注意到‘我觉得摄影很重要’，海边用户（QQ 10001）这样说让我很开心。",
    "我知道在我的印象里，海边用户（QQ 10001）喜欢摄影，我觉得很有趣。",
    "我知道在我印象里，海边用户（QQ 10001）喜欢摄影，我觉得很有趣。",
    "我知道在我印象中，海边用户（QQ 10001）喜欢摄影，我觉得很有趣。",
    "我知道我的印象中，海边用户（QQ 10001）喜欢摄影，我觉得很有趣。"
  ])("fails closed for user-first-person or recalled prose: %s", (fact) => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "海边用户",
      isAdmin: false
    };
    const input = [{
      fact,
      userId: "10001",
      userIds: ["10001"],
      userName: "海边用户"
    }];

    expect(attachUsersToMemoryFacts(input, [participant])).toEqual([]);
    expect(normalizeUserProfileFacts(input, [participant])).toEqual([]);
  });

  it("retains an unambiguous role-first-person relation before the exact identity", () => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "海边用户",
      isAdmin: false
    };
    const input = [{
      fact: "我认为我对海边用户（QQ 10001）的选择很在意，也期待看到后续结果。",
      userId: "10001",
      userIds: ["10001"],
      userName: "海边用户"
    }];

    expect(attachUsersToMemoryFacts(input, [participant])).toHaveLength(1);
    expect(normalizeUserProfileFacts(input, [participant])).toHaveLength(1);
  });

  it("retains role actions and third-person reported speech with an exact trusted identity", () => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "海边用户",
      isAdmin: false
    };
    const reportedSpeech = [{
      fact: "我注意到海边用户（QQ 10001）在聊天中说他喜欢摄影，这让我替他开心。",
      userId: "10001",
      userIds: ["10001"],
      userName: "海边用户"
    }];
    const roleAction = [{
      fact: "我会继续支持海边用户（QQ 10001）的计划，也期待后续结果。",
      userId: "10001",
      userIds: ["10001"],
      userName: "海边用户"
    }];

    expect(attachUsersToMemoryFacts(reportedSpeech, [participant])).toHaveLength(1);
    expect(normalizeUserProfileFacts(reportedSpeech, [participant])).toHaveLength(1);
    expect(attachUsersToMemoryFacts(roleAction, [participant])).toHaveLength(1);
  });

  it("rejects user self-narration and keeps only role-first-person profiles with nickname and QQ", () => {
    const participants = [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressName: "老师",
      isAdmin: true
    }];
    const normalized = normalizeUserProfileFacts([{
      fact: "我喜欢摄影。",
      userId: "10001",
      userName: "海边用户"
    }, {
      fact: "我觉得我（海边用户，QQ 10001）很喜欢摄影。",
      userId: "10001",
      userName: "海边用户"
    }, {
      fact: "我注意到海边用户（QQ 10001）喜欢摄影，这让我更期待看到他的作品。",
      userId: "10001",
      userName: "模型幻觉昵称"
    }], participants);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      userId: "10001",
      userIds: ["10001"],
      userName: "海边用户",
      addressName: "老师"
    });
    expect(normalized[0]?.fact).toContain("海边用户（QQ 10001）");
    expect(normalized[0]?.fact).not.toContain("我记得");
  });

  it("exposes the stored nickname and QQ together when memory is recalled", () => {
    expect(formatMemoryMatchesForPrompt([{
      id: "profile-1",
      source: "user_profile",
      sourceTitle: "用户画像",
      fileName: "sunabot.sqlite#memory/user-profile",
      editable: true,
      key: "QQ 10001",
      value: "我注意到海边用户很重视时间关系。",
      text: "我注意到海边用户很重视时间关系。",
      field: "fact",
      userId: "10001",
      userName: "海边用户",
      addressName: "老师"
    }])).toBe("用户画像 海边用户（QQ 10001） 称呼：老师：我注意到海边用户很重视时间关系。");
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
