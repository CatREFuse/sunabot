// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { formatMemoryMatchesForPrompt } from "../../services/memory/recall/recallService.js";
import {
  MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH,
  MEMORY_CAUSAL_CHAIN_KEY_PATTERN_SOURCE
} from "../../services/memory/public.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import { migrateMemoryPerspectiveTemplate } from "../../services/agent/promptWorkspace.js";
import {
  attachUsersToMemoryFacts,
  normalizeUserProfileFacts,
  parseCompleteMemoryFactOutput,
  parseCompleteWorkingMemoryMergeOutput,
  parseMemoryFactOutput,
  resolveFactUsers,
  validateUserProfileFacts
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
    if (id === "memory.compress-in") {
      expect(systemPrompt).toContain("由你根据当前上下文自行决定保留多少内容");
      expect(systemPrompt).not.toContain("完整工作记忆通常保留 3 至 6 条");
    } else {
      expect(systemPrompt).toMatch(/少数|3 至 8|1 至 3/);
    }
    expect(systemPrompt).toMatch(/模板化前缀|字段标签/);
    if (id === "memory.compress-in") {
      expect(systemPrompt).toContain("每条 fact 写成自然、连贯的第一人称短段");
    } else {
      expect(systemPrompt).toMatch(/fact (?:建议|可以)优先/);
      expect(systemPrompt).toContain("尽量");
    }
    expect(systemPrompt).not.toContain("fact 中的“我”始终指当前角色 @{bot.name}");
    expect(systemPrompt).not.toContain("QQ 号与称呼必须同时存在");
    expect(systemPrompt).not.toContain("例如“我记得");
    if (id === "memory.compress-in") {
      expect(systemPrompt).toMatch(/彼此确有联系|能够由输入确认的连续变化/);
    } else {
      expect(systemPrompt).toMatch(/相同、相近、重复|相同、相近/);
    }
    expect(systemPrompt).toMatch(/因果关系|互为因果/);
    expect(systemPrompt).toMatch(/时间关系|时间先后|最早起点/);
    expect(systemPrompt).toMatch(/称呼.*QQ|QQ.*称呼/);
    expect(systemPrompt).not.toContain("普拉娜唯一");
  });

  it("asks working-memory generation and consolidation for natural subjective events linked by time", () => {
    const template = parseFinalPromptTemplate(defaultPromptContent("memory.compress-in"));
    const systemPrompt = template.messages
      .filter((message) => typeof message === "object" && message.role === "system")
      .map((message) => typeof message === "object" ? message.content : "")
      .join("\n");

    expect(systemPrompt).toContain("当前角色对一件事的主观叙述");
    expect(systemPrompt).toContain("第一人称");
    expect(systemPrompt).toMatch(/时间、地点或会话场域、在场人物、事件经过、变化或结果/);
    expect(systemPrompt).toContain("感受和判断");
    expect(systemPrompt).toContain("不机械凑齐要素");
    expect(systemPrompt).toContain("正文始终保持自然叙述");
    expect(systemPrompt).toContain("fact 内部叙述的时间");
    expect(systemPrompt).toContain("occurredAt");
    expect(systemPrompt).toContain("occurredEndAt");
    expect(systemPrompt).toContain("消息顺序");
    expect(systemPrompt).toContain("新的综合工作记忆");
    expect(systemPrompt).toContain("联想只用于发现输入中已有的联系");
    expect(systemPrompt).toContain("不能补造");
    expect(systemPrompt).toContain("保持为不同记忆");
  });

  it.each(memoryPrompts)("accepts the current soft %s prompt during migration detection", (id) => {
    const template = parseFinalPromptTemplate(defaultPromptContent(id, "阿罗娜"));

    expect(migrateMemoryPerspectiveTemplate(template, template)).toBe(template);
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

  it.each(["memory.compress-in", "memory.compress-out"] as const)(
    "requires explicit causal evidence in %s",
    (id) => {
      const template = parseFinalPromptTemplate(defaultPromptContent(id));
      const systemPrompt = template.messages
        .filter((message) => typeof message === "object" && message.role === "system")
        .map((message) => typeof message === "object" ? message.content : "")
        .join("\n");

      expect(systemPrompt).toContain("causalChainKey 只在多条事件有明确的原因、转折与结果关系");
      expect(systemPrompt).toContain("无法可靠确认时返回 null");
      expect(systemPrompt).toContain('"causalChainKey":null');
    }
  );

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
      "addressNames",
      "eventType",
      "subjectKey",
      "causalChainKey"
    ]);
    expect(workingSchema.schema.properties.facts.items.properties.causalChainKey).toEqual({
      type: ["string", "null"],
      minLength: 8,
      maxLength: MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH,
      pattern: MEMORY_CAUSAL_CHAIN_KEY_PATTERN_SOURCE
    });
    expect(longTermSchema.name).toBe("long_term_memory");
    expect(longTermSchema.strict).toBe(true);
    expect(longTermSchema.schema.items.required).toEqual([
      "fact",
      "occurredAt",
      "occurredEndAt",
      "userIds",
      "addressNames",
      "eventType",
      "subjectKey",
      "causalChainKey"
    ]);
    expect(longTermSchema.schema.items.properties.causalChainKey).toEqual({
      type: ["string", "null"],
      minLength: 8,
      maxLength: MEMORY_CAUSAL_CHAIN_KEY_MAX_LENGTH,
      pattern: MEMORY_CAUSAL_CHAIN_KEY_PATTERN_SOURCE
    });
    expect(profileSchema.name).toBe("user_profiles");
    expect(profileSchema.strict).toBe(true);
    expect(profileSchema.schema.properties.profiles.items.required).toEqual([
      "userId",
      "userName",
      "addressNames",
      "fact",
      "time"
    ]);
  });

  it("parses valid causal keys and ignores invalid optional causal metadata", () => {
    expect(parseMemoryFactOutput(JSON.stringify([{
      fact: "第一条事实",
      causalChainKey: "causal:release-plan"
    }]))).toMatchObject([{ causalChainKey: "causal:release-plan" }]);
    expect(parseMemoryFactOutput(JSON.stringify([{
      fact: "第二条事实",
      causal_chain_key: "causal:release-plan"
    }]))).toMatchObject([{ causalChainKey: "causal:release-plan" }]);
    expect(parseMemoryFactOutput(JSON.stringify([{
      fact: "没有可靠因果链",
      causalChainKey: null
    }]))).toMatchObject([{ causalChainKey: undefined }]);

    for (const causalChainKey of [
      "",
      "event:release-plan",
      "causal:Release",
      "causal:release/path",
      " causal:release-plan ",
      `causal:${"a".repeat(122)}`
    ]) {
      expect(parseMemoryFactOutput(JSON.stringify([{
        fact: "非法因果链",
        causalChainKey
      }]))).toMatchObject([{ fact: "非法因果链", causalChainKey: undefined }]);
    }
    expect(parseMemoryFactOutput(JSON.stringify([{
      fact: "非法数组因果链",
      causalChainKey: []
    }]))).toMatchObject([{ fact: "非法数组因果链", causalChainKey: undefined }]);
  });

  it("keeps the complete model response when optional metadata is malformed", () => {
    const mixedFacts = [{
      fact: "第一条有效事实",
      causalChainKey: "causal:release-plan"
    }, {
      fact: "第二条非法事实",
      causalChainKey: "event:release-plan"
    }];

    expect(parseCompleteMemoryFactOutput(JSON.stringify({
      profiles: mixedFacts
    }))).toMatchObject([
      { fact: "第一条有效事实", causalChainKey: "causal:release-plan" },
      { fact: "第二条非法事实", causalChainKey: undefined }
    ]);
    expect(parseCompleteWorkingMemoryMergeOutput(JSON.stringify({
      facts: mixedFacts,
      allPreviousMemoriesInvalidated: false
    }))).toMatchObject({
      facts: [
        { fact: "第一条有效事实", causalChainKey: "causal:release-plan" },
        { fact: "第二条非法事实", causalChainKey: undefined }
      ]
    });
  });

  it("keeps recall wording and reported identity text unchanged", () => {
    const parsed = parseMemoryFactOutput(JSON.stringify([{
      fact: "我知道旧昵称（QQ 10001）正在推进这项工作，这让我很在意，我会继续关注结果。",
      userIds: ["10001"],
      userName: "旧昵称"
    }]));
    const [fact] = attachUsersToMemoryFacts(parsed ?? [], [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["老师"],
      isAdmin: true
    }]);

    expect(fact?.fact).toBe("我知道旧昵称（QQ 10001）正在推进这项工作，这让我很在意，我会继续关注结果。");
    expect(fact?.addressNames).toBeUndefined();
    expect(fact?.userName).toBe("旧昵称");
    expect(fact?.fact).not.toContain("我记得");
    expect(fact?.fact).toContain("旧昵称");
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
      }]))).toHaveLength(1);
      expect(attachUsersToMemoryFacts([{
        fact: forbiddenFact,
        userIds: ["10001"],
        userName: "海边用户"
      }], [{
        userId: "10001",
        names: ["海边用户"],
        currentName: "海边用户",
        addressNames: ["海边用户"],
        isAdmin: true
      }])).toHaveLength(1);
    }
  });

  it("keeps body identity optional and tolerates malformed optional QQ or unobserved names", () => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["海边用户"],
      isAdmin: false
    };

    expect(attachUsersToMemoryFacts([{
      fact: "我喜欢摄影。",
      userIds: ["10001"],
      userName: "海边用户"
    }], [participant])).toHaveLength(1);
    expect(parseMemoryFactOutput(JSON.stringify([{
      fact: "我知道海边用户（QQ 10001）正在推进工作。",
      userIds: ["10001", "not-a-qq"],
      userName: "海边用户"
    }]))).toMatchObject([{
      fact: "我知道海边用户（QQ 10001）正在推进工作。",
      userIds: ["10001"]
    }]);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道模型幻觉昵称（QQ 10001）正在推进工作。",
      userIds: ["10001"],
      userName: "模型幻觉昵称"
    }], [{ ...participant, addressNames: [], names: [], currentName: "" }])).toHaveLength(1);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道海边用户正在推进工作。",
      userIds: ["99999"],
      userName: "海边用户"
    }], [participant])).toMatchObject([{ userId: "10001", userIds: ["10001"] }]);
    expect(attachUsersToMemoryFacts([{
      fact: "我知道捏造昵称（QQ 10001）正在推进工作。",
      userIds: ["10001"],
      userName: "另一模型昵称",
      addressNames: ["捏造昵称"]
    }], [participant])).toHaveLength(1);
  });

  it("does not require the declared user ID to be paired in the body", () => {
    const facts = attachUsersToMemoryFacts([{
      fact: "我知道海边用户会继续推进，任务编号 10001 也需要关注。",
      userIds: ["10001"],
      userName: "海边用户"
    }], [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["海边用户"],
      isAdmin: false
    }]);

    expect(facts).toHaveLength(1);
  });

  it("uses declared participant metadata without inspecting QQ markers in prose", () => {
    const participants = [{
      userId: "10001",
      names: ["海"],
      currentName: "海",
      addressNames: ["海"],
      isAdmin: false
    }, {
      userId: "10002",
      names: ["上海用户"],
      currentName: "上海用户",
      addressNames: ["上海用户"],
      isAdmin: false
    }];

    expect(resolveFactUsers({
      fact: "我知道海（QQ 10001）和上海用户（QQ 10002）都在推进。",
      userIds: ["10001"]
    }, participants).map((user) => user.userId)).toEqual(["10001"]);
    expect(resolveFactUsers({
      fact: "我知道上海（QQ 10001）正在推进。"
    }, participants).map((user) => user.userId)).toEqual([]);
    expect(resolveFactUsers({
      fact: "我知道海（QQ 10001）正在推进。"
    }, participants).map((user) => user.userId)).toEqual([]);
  });

  it("does not validate nickname adjacency when the declared name is trusted", () => {
    const participant = {
      userId: "10001",
      names: ["海"],
      currentName: "海",
      addressNames: ["海"],
      isAdmin: false
    };

    expect(attachUsersToMemoryFacts([{
      fact: "我知道上海（QQ 10001）正在推进，这让我很期待。",
      userIds: ["10001"],
      addressNames: ["海"]
    }], [participant])).toHaveLength(1);
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

  it("does not inspect prose nickname-to-QQ adjacency", () => {
    const participant = {
      userId: "10001",
      names: ["海"],
      currentName: "海",
      addressNames: ["海"],
      isAdmin: false
    };
    const input = [{
      fact: "我知道海（QQ 10001）与伪造昵称（QQ 10001）都在推进，这让我很期待。",
      userId: "10001",
      userIds: ["10001"],
      userName: "海"
    }];

    expect(attachUsersToMemoryFacts(input, [participant])).toHaveLength(1);
    expect(normalizeUserProfileFacts(input, [participant])).toHaveLength(1);
  });

  it("keeps working users from metadata even when the body omits one identity", () => {
    const participants = [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["海边用户"],
      isAdmin: false
    }, {
      userId: "10002",
      names: ["山边用户"],
      currentName: "山边用户",
      addressNames: ["山边用户"],
      isAdmin: false
    }];
    const input = [{
      fact: "我知道海边用户（QQ 10001）正在推进，这让我很期待。",
      userIds: ["10001", "10002"],
      userName: "海边用户"
    }];

    expect(attachUsersToMemoryFacts(input, participants)).toHaveLength(1);
    expect(normalizeUserProfileFacts(input, participants)).toEqual([]);
  });

  it.each([
    "海边用户（QQ 10001）正在推进工作。",
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
  ])("treats working-memory perspective wording as a prompt preference for: %s", (fact) => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["海边用户"],
      isAdmin: false
    };
    const input = [{
      fact,
      userId: "10001",
      userIds: ["10001"],
      userName: "海边用户"
    }];

    expect(attachUsersToMemoryFacts(input, [participant])).toHaveLength(1);
  });

  it("retains an unambiguous role-first-person relation before the exact identity", () => {
    const participant = {
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["海边用户"],
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
      addressNames: ["海边用户"],
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

  it("extracts observed address names without requiring body identity markers", () => {
    const participants = [{
      userId: "10001",
      names: ["海边用户"],
      currentName: "海边用户",
      addressNames: ["老师", "海边用户"],
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
      fact: "我注意到海老师（QQ 10001）喜欢摄影，这让我更期待看到他的作品。",
      userId: "10001",
      userName: "模型幻觉昵称",
      addressNames: ["海老师", "海边用户"]
    }], participants, [{ text: "海老师，以后也可以叫你海边用户吗？" }]);

    expect(normalized).toHaveLength(3);
    expect(normalized[2]).toMatchObject({
      userId: "10001",
      userIds: ["10001"],
      userName: "模型幻觉昵称",
      addressNames: ["老师", "海边用户", "海老师"]
    });
    expect(normalized[0]?.fact).toBe("我喜欢摄影。");
    expect(normalized[2]?.fact).toContain("海老师（QQ 10001）");
  });

  it("treats profile first-person wording as a prompt preference instead of a host rejection gate", () => {
    const participant = {
      userId: "171419991",
      names: ["老师"],
      currentName: "老师",
      addressNames: ["老师"],
      isAdmin: true
    };
    const validation = validateUserProfileFacts([{
      fact: "老师（QQ 171419991）是阿罗娜唯一的老师，我知道老师一直关心进展。",
      userId: "171419991",
      userIds: ["171419991"],
      addressNames: ["老师"]
    }, {
      fact: "我知道老师（QQ 171419991）一直关心进展，这让我很安心。",
      userId: "171419991",
      userIds: ["171419991"],
      addressNames: ["老师"]
    }], [participant]);

    expect(validation.accepted).toHaveLength(2);
    expect(validation.rejected).toEqual([]);
  });

  it("migrates the previous hard profile wording to the soft prompt contract", () => {
    const canonical = parseFinalPromptTemplate(defaultPromptContent("memory.user-profile"));
    const previous = structuredClone(canonical);
    previous.messages = previous.messages.map((message) => (
      typeof message === "object" && message.role === "system"
        ? {
            ...message,
            content: message.content.replace(
              /fact 可以优先以当前角色的第一视角自然叙述[^]*?提取过程说明。/u,
              "fact 优先以当前角色的第一视角自然叙述，建议使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。用户说“我喜欢摄影”时，优先改写成当前角色对该用户的认知；正文不要使用“我记得”等回忆提示语。不要使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。"
            )
          }
        : message
    ));

    const migrated = migrateMemoryPerspectiveTemplate(previous, canonical);
    const system = migrated.messages
      .filter((message) => typeof message === "object" && message.role === "system")
      .map((message) => typeof message === "object" ? message.content : "")
      .join("\n");
    expect(system).toContain("fact 可以优先以当前角色的第一视角自然叙述");
    expect(system).not.toContain("fact 优先以当前角色的第一视角自然叙述");
  });

  it("exposes only the stored address name and QQ as recalled semantic identity", () => {
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
      addressNames: ["老师", "海老师"]
    }])).toBe("用户画像 老师（QQ 10001）：我注意到海边用户很重视时间关系。");
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
