// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultFinalPromptTemplate, defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { migrateMemoryPerspectiveTemplate } from "../../services/agent/promptWorkspace.js";
import type { FinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const roots: string[] = [];
const runtimes: SunaRuntime[] = [];

const legacyWorkingSystem = [
  "你负责把一批聊天消息压缩成工作记忆。",
  "输入 payload.previousWorkingMemories 会给出全部原工作记忆；必须把原记忆和本批 messages 一起作为依据，输出合并后的完整工作记忆集合。",
  "工作记忆只记录发生过或正在发生的事件。事件是时间轴上的动作、变化或结果，例如决定、约定、承诺、授权、开始、停止、进展、完成、失败、关系变化、项目状态变化和待跟进事项。",
  "只保留后续对角色回复有价值的事件。每条事件必须能回答“谁在何时发生了什么”，写清参与者、动作或变化、对象、时间以及值得记住的结果。",
  "不要记录任何与人本身有关的属性。身份、职业、背景、所在地、昵称、称呼、关系、角色、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标都属于用户画像，即使稳定也不得写入工作记忆。",
  "一段消息同时包含事件和人物属性时，只提取事件中的动作、变化和结果，不把事件概括成人物属性。例如“某人在 7 月 10 日购买了 Mac mini”可以记录购买事件，不要写成“某人拥有 Mac mini”。",
  "合并语义重复或高度相近的事实；新消息补充、修正或替代旧事实时输出更新后的完整事实；与本批消息无关但仍有效的旧事实必须继续保留。",
  "previousWorkingMemories 中已有的纯人物属性不符合工作记忆范围，必须从输出 facts 中删除。冲突事件优先采用有明确时间且更新的可靠信息；无法判断时保留必要差异，不要猜测。已被新事件明确替代或证明错误、失效的旧事件可以删除。",
  "每条事实必须写清相关用户的 QQ 号；如果事实涉及多人，列出所有相关 QQ 号。忽略寒暄、重复表达、临时情绪、无结论争论和无法确认的信息。",
  "用户身份以 QQ 号为准，昵称和群名片只作为显示名；同一 QQ 改名后仍视为同一个人。",
  "未变化或被更新的旧事实沿用原 id；多条旧事实合并时沿用其中最早一条的 id；新增事实的 id 返回 null。合并时汇总 userIds，并使用当前显示名。",
  "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者都只能是单个 ISO 8601 时间或 null，禁止把范围拼进一个字符串。无法从消息验证发生时间时保持 null，不要猜测；系统收到消息的时间由写入端生成 observedAt。",
  "每条事实都要判断是否实时晋升长期记忆。只有有明确时间、对未来仍有价值的事件才设置 promoteToLongTerm=true；寒暄、临时情绪、无结论讨论和人物属性不得晋升。",
  "晋升事实必须提供受控 eventType 和稳定 subjectKey。eventType 只允许 task、decision、commitment、milestone、incident、relationship_change、status_change、other。subjectKey 描述不随“开始、进行中、完成、失败”等进展词变化的同一事件主体，优先使用任务号、Issue/PR、明确命名事项或“动作 + 目标”；仓库路径、文件名和地点不能单独构成主体。非晋升事实的 eventType 使用 other，subjectKey 使用空字符串。",
  "longTermId 只复用输入中真实存在、与本事实参与者一致的长期记忆 id；无法可靠匹配时返回 null，禁止编造 id。已有工作事实中的 promoteToLongTerm、longTermId、eventType 和 subjectKey 在仍有效时必须保留。",
  "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是普拉娜唯一的老师和管理员。这些字段只用于校验用户身份，不构成需要写入工作记忆的事件。如果 admin.userId 为空，不要记录任何老师或管理员身份；其他用户不得写成老师或管理员。",
  "提取颗粒度应该粗一些。连续十几条聊天围绕同一件事时，合并为一条完整概述。",
  "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
  "格式为 {\"facts\":[{\"id\":\"可复用的原记忆 id 或 null\",\"fact\":\"包含相关用户 QQ 号的事实内容\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"promoteToLongTerm\":true,\"longTermId\":\"已有长期记忆 id 或 null\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}],\"allPreviousMemoriesInvalidated\":false}。新增事实的 id 返回 null。",
  "通常 allPreviousMemoriesInvalidated 为 false。只有 messages 明确证明全部原记忆都已失效或错误，或者全部原记忆都是应转入用户画像的纯人物属性，并且 facts 为空时，才设为 true。",
  "原记忆非空时，不得仅因本批没有新事实而返回空 facts；没有原记忆且没有值得记录的事实时返回 {\"facts\":[],\"allPreviousMemoriesInvalidated\":false}。"
].join("\n\n");

const legacyLongTermSystem = [
  "你负责把工作记忆压缩成长期记忆。",
  "长期记忆只记录发生了什么。只保留时间轴上已经发生或正在发生的事件，包括参与者的动作、变化、决定、约定、承诺、进展、结果、关系变化、项目状态变化和待跟进事项。",
  "每条长期记忆必须能回答“谁在何时发生了什么”，并且对未来回复仍有价值。无后续价值的日常琐事、寒暄、临时情绪、无结论争论和无法确认的信息不要保留。",
  "所有与人本身有关的属性都属于用户画像。身份、职业、背景、所在地、昵称、称呼、关系、角色、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标，即使稳定、可复用，也不得进入长期记忆；纯用户属性记录必须丢弃。",
  "一条工作记忆同时包含事件和人物属性时，只保留事件中的动作、变化和结果，不把它改写成人物特征。无法指出具体动作或变化的记录不属于事件。",
  "合并同一事件的重复、相近和过期记录，保留最新且可确认的进展、结果和待跟进状态；不同时间发生的独立事件不得合并成人物概述。",
  "保留事实中的相关用户 QQ 号；用户身份以 QQ 号为准。",
  "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者只能是单个 ISO 8601 时间或 null。",
  "每条事件提供 eventType 和稳定 subjectKey；subjectKey 描述事件实例，不能只使用仓库路径、文件名或地点。",
  "不要保留来源说明、压缩过程、评分标准或实现细节。",
  "输出严格 JSON 数组，不要输出 Markdown、解释或额外文字。",
  "数组元素格式为 {\"fact\":\"包含相关用户 QQ 号的长期事实\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}。",
  "如果没有值得保留的事实，输出 []。"
].join("\n\n");

const legacyProfileSystem = [
  "你负责从同一批聊天消息中提取 BOT 对各个用户的稳定认知和印象。",
  "所有与人本身有关的属性都归入用户画像，包括身份、职业、背景、所在地、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标。客观属性与主观认知都在这里处理。",
  "明确自述的客观属性可以直接记录；偏好、习惯、性格和长期关注点需要用户明确表达，或由多次一致表现支持。不要根据一次普通行为推断稳定属性。",
  "不要保留一次性事件的过程和结果，例如某次购买、决定、约定、项目进展、故障、完成或临时安排、决定、要求你做的事；这些内容属于工作记忆和长期记忆。只有事件明确形成了对未来有价值的持久属性时，才提取形成后的当前属性，不复述事件过程。",
  "严禁写入一次性事件，只能写可能会被多次观察到的事件。",
  "忽略群聊事件本身、临时情绪、临时状态、不指向具体用户的内容，以及无法确认的推测。",
  "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，不承载回复称呼；群名片由会话目录派生，不复制进 fact。",
  "addressName 只保存普拉娜回复该用户时使用的明确称呼。输入 payload.previousProfiles 会提供已有画像：已有非空 addressName 必须原样保留，只有字段为空且用户明确要求“以后叫我……”或同义表达时才推断新值。模型不得根据昵称、群名片、性别或一次玩笑自行创造称呼。",
  "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是普拉娜唯一的老师和管理员，其 addressName 必须使用 admin.name。其他用户不得写成老师或管理员。admin.userId 为空时不要记录任何老师或管理员身份。",
  "输入 payload.previousProfiles 会给出该 QQ 的原画像；写入新画像时必须把原画像和本批消息一起作为依据，按语义合并。合并时删除原画像中的一次性事件过程、已失效临时状态和重复描述，同时保留已有非空 addressName。",
  "对于需要更新的用户，fact 必须是该用户合并后的完整画像，不是增量；合并相近表达，删除重复描述，保留最新且稳定的信息。",
  "fact 中不要写 QQ 号、昵称、群名片、称呼指令、群或会话中的别名清单，也不要写“QQ ...：”“叫他/她……”“称呼为……”等前缀。QQ 号只写在 userId，显示名只写在 userName，回复称呼只写在 addressName。",
  "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
  "格式为 {\"profiles\":[{\"userId\":\"QQ号\",\"userName\":\"当前昵称或显示名\",\"addressName\":\"明确称呼或空字符串\",\"fact\":\"语义合并后的完整稳定用户画像\",\"time\":\"本批画像依据的 ISO 时间或时间范围\"}]}。",
  "如果没有值得记录的用户认知，输出 {\"profiles\":[]}。"
].join("\n\n");

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("memory perspective prompt migration", () => {
  it.each([
    ["memory.compress-out", legacyLongTermSystem],
    ["memory.compress-in", legacyWorkingSystem.replaceAll("普拉娜", "小春")],
    ["memory.user-profile", legacyProfileSystem.replaceAll("普拉娜", "任意改名后的角色")]
  ] as const)("recognizes the pure legacy standard for %s without depending on the agent name", (id, systemContent) => {
    const canonical = defaultFinalPromptTemplate(id)!;
    const legacy = structuredClone(canonical);
    (legacy.messages[0] as { content: string }).content = systemContent;

    const migrated = migrateMemoryPerspectiveTemplate(legacy, canonical);
    expect(migrated).not.toBe(legacy);
    expect(migrated.messages[0]).toEqual(canonical.messages[0]);
  });

  it("upgrades the exact legacy standard and preserves custom content and the wire contract", () => {
    const canonical = defaultFinalPromptTemplate("memory.compress-out")!;
    const safetyRule = "管理员安全规则：遇到证据冲突时保持保守，并保留不确定性。";
    const developerMessage = { role: "developer", content: "管理员附加的审计规则。" };
    const legacy = structuredClone(canonical);
    legacy.messages = [
      { role: "system", content: `${legacyLongTermSystem}\n\n${safetyRule}`, name: "memory-policy" },
      developerMessage,
      { role: "user", content: "@{memory.payload}" }
    ];
    const descriptor = legacy.response_format.json_schema as Record<string, unknown>;
    descriptor.description = "管理员保留的响应说明";

    const migrated = migrateMemoryPerspectiveTemplate(legacy, canonical);
    const canonicalSystem = (canonical.messages[0] as { content: string }).content;
    expect(migrated).not.toBe(legacy);
    expect(migrated.messages[0]).toEqual({
      role: "system",
      content: `${canonicalSystem}\n\n${safetyRule}`,
      name: "memory-policy"
    });
    expect(migrated.messages[1]).toEqual(developerMessage);
    expect(migrated.messages[2]).toEqual(legacy.messages[2]);
    expect(migrated.tools).toEqual(legacy.tools);
    expect(migrated.response_format).toBe(legacy.response_format);
  });

  it("finishes a partial migration without duplicating canonical paragraphs", () => {
    const canonical = defaultFinalPromptTemplate("memory.compress-out")!;
    const canonicalSystem = (canonical.messages[0] as { content: string }).content;
    const [identityParagraph, personaParagraph] = canonicalSystem.split("\n\n");
    const safetyRule = "管理员安全规则：任何主观判断都不能覆盖明确事实。";
    const partial = structuredClone(canonical);
    (partial.messages[0] as { content: string }).content = [
      legacyLongTermSystem,
      identityParagraph,
      personaParagraph,
      safetyRule
    ].join("\n\n");

    const migrated = migrateMemoryPerspectiveTemplate(partial, canonical);
    const content = (migrated.messages[0] as { content: string }).content;
    expect(content).toBe(`${canonicalSystem}\n\n${safetyRule}`);
    expect(content.match(new RegExp(escapeRegExp(identityParagraph), "g"))).toHaveLength(1);
    expect(content).not.toContain("你负责把工作记忆压缩成长期记忆。");
  });

  it("removes legacy leftovers when every current anchor is already present", () => {
    const canonical = defaultFinalPromptTemplate("memory.compress-out")!;
    const canonicalSystem = (canonical.messages[0] as { content: string }).content;
    const canonicalParagraphs = canonicalSystem.split("\n\n");
    const safetyRule = "管理员安全规则：保留我在新标准后追加的谨慎判断。";
    const partial = structuredClone(canonical);
    (partial.messages[0] as { content: string }).content = [
      ...legacyLongTermSystem.split("\n\n").slice(0, 8),
      canonicalParagraphs[0],
      canonicalParagraphs[1],
      canonicalParagraphs[3],
      canonicalParagraphs[4],
      canonicalParagraphs[5],
      safetyRule
    ].join("\n\n");

    const migrated = migrateMemoryPerspectiveTemplate(partial, canonical);
    const content = (migrated.messages[0] as { content: string }).content;
    expect(content).toBe(`${canonicalSystem}\n\n${safetyRule}`);
    const canonicalSet = new Set(canonicalParagraphs);
    for (const paragraph of legacyLongTermSystem.split("\n\n").slice(0, 8)
      .filter((legacy) => !canonicalSet.has(legacy))) {
      expect(content).not.toContain(paragraph);
    }
  });

  it("preserves a structurally current administrator template despite marker-like text", () => {
    const canonical = defaultFinalPromptTemplate("memory.compress-out")!;
    const customized = structuredClone(canonical);
    const system = customized.messages[0] as { content: string };
    system.content += "\n\n管理员注记：.work_memory_compress_out.json.memory-perspective-v1 只是正文样例，保持谨慎。";

    expect(migrateMemoryPerspectiveTemplate(customized, canonical)).toBe(customized);
  });

  it.each([
    "memory.compress-in",
    "memory.compress-out",
    "memory.user-profile"
  ] as const)("preserves a current %s template whose compression anchor was customized", (id) => {
    const canonical = defaultFinalPromptTemplate(id)!;
    const customized = structuredClone(canonical);
    const system = customized.messages[0] as { content: string };
    system.content = customizeCompressionAnchor(id, system.content);

    expect(migrateMemoryPerspectiveTemplate(customized, canonical)).toBe(customized);
  });

  it("marks current administrator compression overrides without rewriting them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-perspective-current-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });
    const expected = new Map<string, unknown>();

    for (const [id, fileName] of memoryFileCases(config)) {
      const current = JSON.parse(defaultPromptContent(id, config.persona.name));
      current.messages[0].content = customizeCompressionAnchor(id, current.messages[0].content);
      expected.set(fileName, current);
      await fs.writeFile(
        path.join(config.persona.systemPromptWorkspace, fileName),
        `${JSON.stringify(current, null, 2)}\n`,
        "utf8"
      );
    }

    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);
    await runtime.ensureAgentPromptFiles(config);

    for (const [, fileName] of memoryFileCases(config)) {
      await expect(readPromptDocument(config, fileName)).resolves.toEqual(expected.get(fileName));
      await expect(fs.readFile(path.join(
        config.persona.systemPromptWorkspace,
        memoryPerspectiveMarkerFile(fileName)
      ), "utf8")).resolves.toBe("memory-perspective-v1\n");
    }
  });

  it("does not rewrite an old-looking template with an incompatible response contract", () => {
    const canonical = defaultFinalPromptTemplate("memory.compress-out")!;
    const incompatible: FinalPromptTemplate = {
      messages: [
        { role: "system", content: legacyLongTermSystem },
        { role: "user", content: "@{memory.payload}" }
      ],
      tools: [],
      response_format: { type: "text" }
    };

    expect(migrateMemoryPerspectiveTemplate(incompatible, canonical)).toBe(incompatible);
  });

  it("migrates shared and override lifecycle paths for renamed agents, validates markers and runs once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-perspective-migration-"));
    roots.push(root);
    const configs = [
      createAdminTestConfig(path.join(root, "shared")),
      overrideConfig(path.join(root, "koharu"), "koharu", "小春"),
      overrideConfig(path.join(root, "renamed"), "renamed-agent", "任意改名后的角色")
    ];

    for (const config of configs) {
      await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });
      const safetyRule = `管理员安全规则：${config.persona.name}只在证据充分时形成判断。`;
      for (const [id, fileName, legacySystem] of memoryFileCases(config)) {
        const legacy = JSON.parse(defaultPromptContent(id, config.persona.name));
        legacy.messages[0].content = legacySystem.replaceAll("普拉娜", config.persona.name);
        if (id === "memory.compress-in") legacy.messages[0].content += `\n\n${safetyRule}`;
        await fs.writeFile(
          path.join(config.persona.systemPromptWorkspace, fileName),
          `${JSON.stringify(legacy, null, 2)}\n`,
          "utf8"
        );
      }
      const invalidMarkerPath = path.join(
        config.persona.systemPromptWorkspace,
        memoryPerspectiveMarkerFile(config.bot.memory.workMemoryCompressOutPrompt)
      );
      await fs.writeFile(
        invalidMarkerPath,
        "memory-perspective-v1 appears here but is not a valid marker\n",
        "utf8"
      );
      const runtime = new SunaRuntime(config, { attachmentService: {} as never });
      runtimes.push(runtime);

      await runtime.ensureAgentPromptFiles(config);
      for (const [id, fileName, legacySystem] of memoryFileCases(config)) {
        const promptPath = path.join(config.persona.systemPromptWorkspace, fileName);
        const migrated = JSON.parse(await fs.readFile(promptPath, "utf8"));
        const content = String(migrated.messages[0].content);
        expect(content).toContain("@{bot.name}");
        expect(content).toContain("@{persona.soul}");
        expect(content).not.toContain(legacySystem.split("\n\n")[0]);
        if (id === "memory.compress-in") expect(content).toContain(safetyRule);
        await expect(fs.readFile(path.join(
          config.persona.systemPromptWorkspace,
          memoryPerspectiveMarkerFile(fileName)
        ), "utf8")).resolves.toBe("memory-perspective-v1\n");
      }

      const profilePath = path.join(
        config.persona.systemPromptWorkspace,
        config.bot.memory.userProfilePrompt
      );
      const administratorOverride = JSON.parse(await fs.readFile(profilePath, "utf8"));
      administratorOverride.messages[0].content = "管理员在迁移完成后接管了这份系统提示词。";
      await fs.writeFile(profilePath, `${JSON.stringify(administratorOverride, null, 2)}\n`, "utf8");
      await runtime.ensureAgentPromptFiles(config);
      expect(JSON.parse(await fs.readFile(profilePath, "utf8"))).toEqual(administratorOverride);
    }
  });

  it("uses distinct markers for equal basenames in different prompt directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-perspective-nested-"));
    roots.push(root);
    const config = createAdminTestConfig(root);
    config.bot.memory.workMemoryCompressInPrompt = "working/prompt.json";
    config.bot.memory.workMemoryCompressOutPrompt = "long/prompt.json";
    config.bot.memory.userProfilePrompt = "profile/prompt.json";
    await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });

    for (const [id, fileName, legacySystem] of memoryFileCases(config)) {
      const promptPath = path.join(config.persona.systemPromptWorkspace, fileName);
      await fs.mkdir(path.dirname(promptPath), { recursive: true });
      const legacy = JSON.parse(defaultPromptContent(id, config.persona.name));
      legacy.messages[0].content = legacySystem.replaceAll("普拉娜", config.persona.name);
      await fs.writeFile(promptPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    }

    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    runtimes.push(runtime);
    await runtime.ensureAgentPromptFiles(config);

    for (const [, fileName, legacySystem] of memoryFileCases(config)) {
      const promptPath = path.join(config.persona.systemPromptWorkspace, fileName);
      const migrated = JSON.parse(await fs.readFile(promptPath, "utf8"));
      expect(String(migrated.messages[0].content)).not.toContain(legacySystem.split("\n\n")[0]);
      await expect(fs.readFile(path.join(
        config.persona.systemPromptWorkspace,
        memoryPerspectiveMarkerFile(fileName)
      ), "utf8")).resolves.toBe("memory-perspective-v1\n");
    }
  });
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function overrideConfig(root: string, id: string, name: string) {
  const config = createAdminTestConfig(root);
  config.persona.defaultAgentId = id;
  config.persona.name = name;
  config.persona.agentWorkspace = path.join(root, "agents", id);
  config.persona.systemPromptWorkspace = path.join(root, "agents", id, "system-prompts");
  config.persona.systemPromptOverride = true;
  return config;
}

function memoryFileCases(config: ReturnType<typeof createAdminTestConfig>) {
  return [
    ["memory.compress-in", config.bot.memory.workMemoryCompressInPrompt, legacyWorkingSystem],
    ["memory.compress-out", config.bot.memory.workMemoryCompressOutPrompt, legacyLongTermSystem],
    ["memory.user-profile", config.bot.memory.userProfilePrompt, legacyProfileSystem]
  ] as const;
}

function memoryPerspectiveMarkerFile(fileName: string) {
  return path.join(path.dirname(fileName), `.${path.basename(fileName)}.memory-perspective-v1`);
}

function customizeCompressionAnchor(id: string, content: string) {
  const replacements: Record<string, readonly [string, string]> = {
    "memory.compress-in": ["3 至 6 条，最多 8 条", "2 至 5 条，最多 6 条"],
    "memory.compress-out": ["3 至 8 条长期记忆", "2 至 5 条长期记忆"],
    "memory.user-profile": ["1 至 3 个最概括", "1 至 2 个最概括"]
  };
  const replacement = replacements[id];
  if (!replacement || !content.includes(replacement[0])) {
    throw new Error(`Missing compression anchor for ${id}`);
  }
  return content.replace(replacement[0], replacement[1]);
}

async function readPromptDocument(
  config: ReturnType<typeof createAdminTestConfig>,
  fileName: string
) {
  return JSON.parse(await fs.readFile(path.join(config.persona.systemPromptWorkspace, fileName), "utf8"));
}
