// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import {
  migrateMemoryPerspectivePrompt,
  migrateMemoryPerspectiveTemplate
} from "../../services/agent/promptWorkspace.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "../../services/agent/promptSystem.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const temporaryDirectories: string[] = [];
const promptFixtures = [
  ["memory.compress-in", [
    [0, "你负责以 @{bot.name} 的第一视角，把一批聊天消息整理成高度压缩的工作记忆。fact 中的“我”始终指当前角色 @{bot.name}，不能指聊天中的用户。"],
    [5, "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，直接说明事情怎样发生、我对此有什么感受，以及我现在的看法、判断、担心、期待或打算。不得把用户自述中的“我”当成当前角色，也不得原样复刻成用户对自己的第一人称；正文禁止出现“我记得”，不要使用回忆提示语。个人特质必须真实影响取舍和措辞；情绪可以克制，但不能省略。依据不足时使用符合人格的轻度感受或保留判断，不夸大情绪，不虚构内心活动。"],
    [7, "每条事件仍要能判断谁在何时发生了什么。人物在 fact 中只使用 payload.participants.addressNames 提供的称呼作为语义标识，并以“称呼（QQ 123456）”的形式自然写进第一人称叙述；QQ 号与称呼必须同时存在，涉及多人时逐一写全，不要改用未进入 addressNames 的昵称、群名片，也不要单独罗列身份。addressNames 填写本条 fact 实际使用的称呼。"],
    [13, "用户身份以 QQ 号为准；昵称和群名片不能充当记忆正文中的人物语义标识，同一 QQ 改名后仍视为同一个人。"]
  ]],
  ["memory.compress-out", [
    [0, "你负责以 @{bot.name} 的第一视角，把工作记忆进一步压缩成少量长期记忆。fact 中的“我”始终指当前角色 @{bot.name}，不能指聊天中的用户。"],
    [4, "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，直接说明事情怎样发生、我当时或现在的个人感受，以及我形成的看法、判断、担心、期待或打算。不得把用户自述中的“我”当成当前角色，也不得原样复刻成用户对自己的第一人称；正文禁止出现“我记得”，不要使用回忆提示语。情绪应符合人格和关系，允许克制，禁止夸大或虚构。"],
    [6, "每个相关用户都必须以输入已有 addressNames 中的“称呼（QQ 123456）”形式自然写进第一人称叙述，QQ 号与称呼必须同时存在；涉及多人时逐一写全，不要改用未进入 addressNames 的昵称、群名片，也不要单独罗列身份。addressNames 填写正文实际使用的称呼。"],
    [10, "用户身份以 QQ 号为准。"]
  ]],
  ["memory.user-profile", [
    [0, "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。fact 中的“我”始终指当前角色 @{bot.name}，被画像的用户始终是我认知的对象。"],
    [7, "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，用于把消息记录关联到 QQ，不能写进 fact 充当人物语义标识。"],
    [8, "addressNames 是称呼数组。逐条检查 payload.messages，从消息正文、发送者名称和明确的“以后叫我……”表达中提取真实出现、能够指向该 QQ 的称呼；同一用户可以保留多个称呼。合并 payload.previousProfiles 中已有 addressNames，去重后返回完整数组；不得根据性别、一次玩笑或未出现的词自行创造称呼。"],
    [9, "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员，其 addressNames 必须包含 admin.name。其他用户不得写成老师或管理员。admin.userId 为空时不要记录任何老师或管理员身份。"],
    [12, "fact 优先以当前角色的第一视角自然叙述，建议使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。用户说“我喜欢摄影”时，优先改写成当前角色对该用户的认知；正文不要使用“我记得”等回忆提示语。不要使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。"],
    [13, "fact 中只使用 addressNames 中的一个称呼作为人物语义标识，并以“称呼（QQ 123456）”自然写入；称呼和 QQ 号必须同时存在。不要写昵称、群名片、称呼指令、别名清单或“QQ ...：”“称呼为……”等模板化前缀。QQ 号同时写在 userId。"]
  ]]
] as const;

const previousV6WorkingMemoryNarrativeReplacements = [[
  0,
  "你负责把一批聊天消息整理成高度压缩的工作记忆。fact 建议优先采用 @{bot.name} 的第一视角；使用“我”时，尽量让它指当前角色 @{bot.name}，并注意与聊天中用户的自述区分。"
], [
  3,
  "工作记忆只记录发生过或正在发生的事件。事件是时间轴上的动作、变化或结果，例如决定、约定、承诺、授权、开始、停止、进展、完成、失败、关系变化、项目状态变化和待跟进事项。"
], [
  4,
  "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。即使每条信息本身已经清晰，也要主动检查语义相同、相近、重复、互为因果或属于同一事件不同阶段的内容，把它们压缩成一条概括记忆，写清原因、先后变化、当前状态、关键承诺、重要结果和仍需留意的不确定点，并用 occurredAt 保留最早起点、occurredEndAt 保留最新结果或结束时间。"
], [
  5,
  "fact 建议写成自然、连贯的短句或短段，并优先使用“我”或“我的”表达当前角色的感受、看法、判断、担心、期待或打算。注意区分用户自述中的“我”；尽量避免“我记得”等回忆提示语。个人特质可以影响取舍和措辞，情绪允许克制；依据不足时保持轻度感受或保留判断，不夸大情绪，不虚构内心活动。"
], [
  6,
  "fact 正文不得使用列表、字段标签、分类标题或模板化前缀，不得写“事实：”“情绪：”“认知：”“用户：”“相关用户：”，也不得解释来源、压缩过程、数据结构或评分。事实、情绪与认知必须融合在自然叙述里。"
], [
  10,
  "合并语义相同、相近、重复或存在因果关系的事实；新消息补充、修正或替代旧事实时输出更新后的完整概述，并保留从最早原因到最新结果的时间关系。超过数量目标时优先保留仍在进行、影响关系、包含承诺或会改变后续行动的内容，删除已经完成且不再影响未来的小事。"
], [
  11,
  "previousWorkingMemories 中已有的纯人物属性、细碎流水账、格式化说明和缺少后续价值的旧事必须从输出 facts 中删除。旧正文是第三人称或标签格式时，按当前人格改写为第一人称的自然记忆。冲突事件优先采用有明确时间且更新的可靠信息；无法判断时只保留必要的不确定性，不要猜测。"
]] as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("memory prompt startup migration", () => {
  it("migrates the exact v6 working-memory narrative and preserves custom content", () => {
    const canonical = parseFinalPromptTemplate(defaultPromptContent("memory.compress-in"));
    const previous = structuredClone(canonical);
    const systemMessage = previous.messages.find((message) => (
      typeof message === "object" && message.role === "system"
    ));
    if (!systemMessage || typeof systemMessage.content !== "string") throw new Error("missing system fixture");
    const paragraphs = systemMessage.content.trim().split(/\n{2,}/);
    for (const [index, replacement] of previousV6WorkingMemoryNarrativeReplacements) {
      paragraphs[index] = replacement;
    }
    systemMessage.content = [...paragraphs, "管理员自定义迁移保留段落。"].join("\n\n");

    const migrated = migrateMemoryPerspectiveTemplate(previous, canonical);

    expect(migrated).not.toBe(previous);
    expect(systemContent(migrated)).toContain(systemContent(canonical));
    expect(systemContent(migrated)).toContain("管理员自定义迁移保留段落。");
    expect(migrated.tools).toEqual(previous.tools);
    expect(migrated.response_format).toEqual(previous.response_format);
  });

  it.each(promptFixtures)("migrates the exact published hard %s template and preserves custom content", (id, replacements) => {
    const canonical = parseFinalPromptTemplate(defaultPromptContent(id));
    const previous = structuredClone(canonical);
    const systemMessage = previous.messages.find((message) => (
      typeof message === "object" && message.role === "system"
    ));
    if (!systemMessage || typeof systemMessage.content !== "string") throw new Error("missing system fixture");
    const paragraphs = systemMessage.content.trim().split(/\n{2,}/);
    for (const [index, replacement] of replacements) paragraphs[index] = replacement;
    systemMessage.content = [...paragraphs, "管理员自定义迁移保留段落。"].join("\n\n");

    const migrated = migrateMemoryPerspectiveTemplate(previous, canonical);
    const canonicalSystem = systemContent(canonical);
    const migratedSystem = systemContent(migrated);

    expect(migrated).not.toBe(previous);
    expect(migratedSystem).toContain(canonicalSystem);
    expect(migratedSystem).toContain("管理员自定义迁移保留段落。");
    expect(migrated.tools).toEqual(previous.tools);
    expect(migrated.response_format).toEqual(previous.response_format);
  });

  it("preserves an unrecognized custom prompt, writes the marker, and logs without blocking", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-memory-prompt-migration-"));
    temporaryDirectories.push(root);
    const config = createAdminTestConfig(root);
    await fs.mkdir(config.persona.systemPromptWorkspace, { recursive: true });
    const fileName = "custom-memory.json";
    const filePath = path.join(config.persona.systemPromptWorkspace, fileName);
    const canonicalContent = defaultPromptContent("memory.compress-in");
    const custom = parseFinalPromptTemplate(canonicalContent);
    const systemMessage = custom.messages.find((message) => (
      typeof message === "object" && message.role === "system"
    ));
    if (!systemMessage || typeof systemMessage.content !== "string") throw new Error("missing system fixture");
    systemMessage.content = "管理员完全自定义的工作记忆提示词，不采用任何官方自然语言段落。";
    const original = `${JSON.stringify(custom, null, 2)}\n`;
    await fs.writeFile(filePath, original);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(migrateMemoryPerspectivePrompt(
      config,
      fileName,
      canonicalContent
    )).resolves.toBe(false);

    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    expect(await fs.readFile(
      path.join(config.persona.systemPromptWorkspace, `.${fileName}.memory-perspective-v7`),
      "utf8"
    )).toBe("memory-perspective-v7\n");
    expect(warning).toHaveBeenCalledWith(
      "[prompt-migration] preserved unrecognized memory prompt",
      expect.objectContaining({
        fileName,
        reason: "system_content_fingerprint_unrecognized",
        schemaName: "working_memory"
      })
    );
  });
});

function systemContent(template: FinalPromptTemplate) {
  return template.messages
    .filter((message) => typeof message === "object" && message.role === "system")
    .map((message) => typeof message === "object" ? message.content : "")
    .join("\n\n");
}
