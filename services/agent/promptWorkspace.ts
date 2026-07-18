import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../../src/config.js";
import type { AppConfig } from "../../src/types.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import {
  MEMORY_PERSPECTIVE_MIGRATION_VERSION,
  migrateMemoryPerspectiveTemplateWithLegacy,
  type MemoryPromptSchemaName
} from "./memoryPromptMigration.js";

export type PromptWorkspaceScope = "persona" | "system";

export function resolvePromptWorkspace(config: AppConfig, scope: PromptWorkspaceScope) {
  const configured = scope === "system"
    ? config.persona.systemPromptWorkspace
    : config.persona.agentWorkspace;
  const workspace = resolveProjectPath(configured);
  if (!workspace) throw new Error(`${scope === "system" ? "System prompt" : "Agent"} workspace is not configured.`);
  return path.resolve(workspace);
}

export function resolvePromptFilePath(config: AppConfig, scope: PromptWorkspaceScope, fileName: string) {
  const workspace = resolvePromptWorkspace(config, scope);
  const resolved = path.resolve(workspace, fileName.trim());
  if (resolved === workspace || !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Prompt file must be inside its workspace.");
  }
  return resolved;
}

export async function resolveSafePromptFilePath(
  config: AppConfig,
  scope: PromptWorkspaceScope,
  fileName: string
) {
  const workspace = resolvePromptWorkspace(config, scope);
  const filePath = resolvePromptFilePath(config, scope, fileName);
  await assertNoSymbolicLink(workspace, filePath);
  return filePath;
}

export async function readPromptTextFile(
  config: AppConfig,
  scope: PromptWorkspaceScope,
  fileName: string,
  fallback = ""
) {
  const content = await readOptional(await resolveSafePromptFilePath(config, scope, fileName));
  return content.trim() || fallback;
}

export async function ensurePromptTextFile(
  config: AppConfig,
  scope: PromptWorkspaceScope,
  fileName: string,
  content: string
) {
  const filePath = await resolveSafePromptFilePath(config, scope, fileName);
  const current = await readOptional(filePath);
  if (current.trim()) return filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

const GROUP_THREAD_CONTEXT_VARIABLE = "conversation.group.thread_context";
const GROUP_ORCHESTRATOR_RESULT_VARIABLE = "conversation.group.orchestrator_result";
const EMOJI_KEYS_VARIABLE = "conversation.emoji.keys";
const EMOJI_SYNTAX_VARIABLE = "conversation.emoji.syntax";
const VOICE_SETTINGS_VARIABLE = "conversation.voice.settings";
const VOICE_TRIGGER_POLICY_VARIABLE = "conversation.voice.trigger_policy";
const VOICE_TOOL_NAME = "send_voice_message";
const CONVERSATION_EMOJI_MIGRATION_VERSION = "emoji-v2";
const CONVERSATION_VOICE_MIGRATION_VERSION = "voice-v1";
const TONE_EMOJI_MIGRATION_VERSION = "emoji-marker-v2";
export const TONE_EMOJI_MARKER_RULE = "保留正文中形如 [/表情key] 的表情标记，必须逐字保留每个标记及其原始位置，不得新增、删除、改写或重排。";
const SELFIE_REFERENCE_SELECTION_CONTRACT_MARKER = '<selfie_reference_selection_contract version="1">';

const LEGACY_MEMORY_PROMPT_PARAGRAPHS: Record<MemoryPromptSchemaName, readonly string[]> = {
  working_memory: [
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
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员。这些字段只用于校验管理员身份和管理员提供的称呼，不构成需要写入工作记忆的事件。如果 admin.userId 为空，不要记录任何管理员身份；其他用户不得写成管理员。",
    "提取颗粒度应该粗一些。连续十几条聊天围绕同一件事时，合并为一条完整概述。",
    "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
    "格式为 {\"facts\":[{\"id\":\"可复用的原记忆 id 或 null\",\"fact\":\"包含相关用户 QQ 号的事实内容\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"promoteToLongTerm\":true,\"longTermId\":\"已有长期记忆 id 或 null\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}],\"allPreviousMemoriesInvalidated\":false}。新增事实的 id 返回 null。",
    "通常 allPreviousMemoriesInvalidated 为 false。只有 messages 明确证明全部原记忆都已失效或错误，或者全部原记忆都是应转入用户画像的纯人物属性，并且 facts 为空时，才设为 true。",
    "原记忆非空时，不得仅因本批没有新事实而返回空 facts；没有原记忆且没有值得记录的事实时返回 {\"facts\":[],\"allPreviousMemoriesInvalidated\":false}。"
  ],
  long_term_memory: [
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
  ],
  user_profiles: [
    "你负责从同一批聊天消息中提取 BOT 对各个用户的稳定认知和印象。",
    "所有与人本身有关的属性都归入用户画像，包括身份、职业、背景、所在地、拥有的设备或资源、能力、偏好、习惯、表达风格、长期关注点、边界和长期目标。客观属性与主观认知都在这里处理。",
    "明确自述的客观属性可以直接记录；偏好、习惯、性格和长期关注点需要用户明确表达，或由多次一致表现支持。不要根据一次普通行为推断稳定属性。",
    "不要保留一次性事件的过程和结果，例如某次购买、决定、约定、项目进展、故障、完成或临时安排、决定、要求你做的事；这些内容属于工作记忆和长期记忆。只有事件明确形成了对未来有价值的持久属性时，才提取形成后的当前属性，不复述事件过程。",
    "严禁写入一次性事件，只能写可能会被多次观察到的事件。",
    "忽略群聊事件本身、临时情绪、临时状态、不指向具体用户的内容，以及无法确认的推测。",
    "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，不承载回复称呼；群名片由会话目录派生，不复制进 fact。",
    "addressName 只保存当前角色回复该用户时使用的明确称呼。输入 payload.previousProfiles 会提供已有画像：已有非空 addressName 必须原样保留，只有字段为空且用户明确要求“以后叫我……”或同义表达时才推断新值。模型不得根据昵称、群名片、性别或一次玩笑自行创造称呼。",
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员，其 addressName 必须使用 admin.name。其他用户不得写成管理员。admin.userId 为空时不要记录任何管理员身份。",
    "输入 payload.previousProfiles 会给出该 QQ 的原画像；写入新画像时必须把原画像和本批消息一起作为依据，按语义合并。合并时删除原画像中的一次性事件过程、已失效临时状态和重复描述，同时保留已有非空 addressName。",
    "对于需要更新的用户，fact 必须是该用户合并后的完整画像，不是增量；合并相近表达，删除重复描述，保留最新且稳定的信息。",
    "fact 中不要写 QQ 号、昵称、群名片、称呼指令、群或会话中的别名清单，也不要写“QQ ...：”“叫他/她……”“称呼为……”等前缀。QQ 号只写在 userId，显示名只写在 userName，回复称呼只写在 addressName。",
    "输出严格 JSON 对象，不要输出 Markdown、解释或额外文字。",
    "格式为 {\"profiles\":[{\"userId\":\"QQ号\",\"userName\":\"当前昵称或显示名\",\"addressName\":\"明确称呼或空字符串\",\"fact\":\"语义合并后的完整稳定用户画像\",\"time\":\"本批画像依据的 ISO 时间或时间范围\"}]}。",
    "如果没有值得记录的用户认知，输出 {\"profiles\":[]}。"
  ]
};

export async function migrateGroupReplyThreadContextVariable(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    `.${path.basename(fileName)}.thread-context-v1`
  );
  if (await readOptional(markerPath)) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateGroupReplyThreadContextTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, "thread-context-v1\n");
  return migrated !== template;
}

export function migrateGroupReplyThreadContextTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (extractPromptVariables(JSON.stringify(template)).includes(GROUP_THREAD_CONTEXT_VARIABLE)) {
    return template;
  }
  const messages = [...template.messages];
  const currentInputIndex = messages.findIndex((message) => (
    typeof message === "object"
    && message.role === "user"
    && typeof message.content === "string"
    && extractPromptVariables(message.content).includes("user.input")
  ));
  const finalUserIndex = findLastIndex(messages, (message) => (
    typeof message === "object" && message.role === "user"
  ));
  const insertionIndex = currentInputIndex >= 0
    ? currentInputIndex
    : finalUserIndex >= 0 ? finalUserIndex : messages.length;
  messages.splice(insertionIndex, 0, {
    role: "developer",
    content: `<thread_context>@{${GROUP_THREAD_CONTEXT_VARIABLE}}</thread_context>`
  });
  return { ...template, messages };
}

export async function migrateGroupReplyOrchestratorResultVariable(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    `.${path.basename(fileName)}.orchestrator-result-v1`
  );
  if (await readOptional(markerPath)) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateGroupReplyOrchestratorResultTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, "orchestrator-result-v1\n");
  return migrated !== template;
}

export function migrateGroupReplyOrchestratorResultTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (extractPromptVariables(JSON.stringify(template)).includes(GROUP_ORCHESTRATOR_RESULT_VARIABLE)) {
    return template;
  }
  const messages = [...template.messages];
  const currentInputIndex = messages.findIndex((message) => (
    typeof message === "object"
    && message.role === "user"
    && typeof message.content === "string"
    && extractPromptVariables(message.content).includes("user.input")
  ));
  const finalUserIndex = findLastIndex(messages, (message) => (
    typeof message === "object" && message.role === "user"
  ));
  const insertionIndex = currentInputIndex >= 0
    ? currentInputIndex
    : finalUserIndex >= 0 ? finalUserIndex : messages.length;
  messages.splice(insertionIndex, 0, {
    role: "developer",
    content: `<orchestrator_result>@{${GROUP_ORCHESTRATOR_RESULT_VARIABLE}}</orchestrator_result>`
  });
  return { ...template, messages };
}

export async function migrateUserGroupOrchestratorResultSchema(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.reply-target-v2`
    )
  );
  if (await readOptional(markerPath) === "reply-target-v2\n") return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const canonical = parseFinalPromptTemplate(canonicalContent);
  const migrated = migrateUserGroupOrchestratorResultSchemaTemplate(template, canonical);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, "reply-target-v2\n");
  return migrated !== template;
}

export function migrateUserGroupOrchestratorResultSchemaTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate {
  if (hasCanonicalJsonSchemaContract(template.response_format, canonical.response_format)) {
    return template;
  }
  return {
    ...template,
    response_format: structuredClone(canonical.response_format)
  };
}

export async function migrateSelfieReferenceSelectionPrompt(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "persona", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "persona",
    `.${path.basename(fileName)}.reference-selection-v1`
  );
  if (await readOptional(markerPath)) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const canonical = parseFinalPromptTemplate(canonicalContent);
  const migrated = migrateSelfieReferenceSelectionTemplate(template, canonical);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, "reference-selection-v1\n");
  return migrated !== template;
}

export function migrateSelfieReferenceSelectionTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate {
  const canonicalContract = canonical.messages.find((message) => (
    typeof message === "object"
    && message.role === "system"
    && typeof message.content === "string"
    && message.content.includes(SELFIE_REFERENCE_SELECTION_CONTRACT_MARKER)
  ));
  if (!isRecord(canonicalContract)
    || typeof canonicalContract.role !== "string"
    || typeof canonicalContract.content !== "string") {
    throw new Error("Canonical selfie prompt is missing its selection contract.");
  }

  let messages = template.messages;
  const hasSelectionContract = messages.some((message) => (
    typeof message === "object"
    && message.role === canonicalContract.role
    && message.content === canonicalContract.content
  ));
  if (!hasSelectionContract) {
    messages = [...messages];
    const payloadIndex = findLastIndex(messages, (message) => (
      typeof message === "object"
      && message.role === "user"
      && typeof message.content === "string"
      && extractPromptVariables(message.content).includes("selfie.payload")
    ));
    const finalUserIndex = findLastIndex(messages, (message) => (
      typeof message === "object" && message.role === "user"
    ));
    const insertionIndex = payloadIndex >= 0
      ? payloadIndex
      : finalUserIndex >= 0 ? finalUserIndex : messages.length;
    messages.splice(insertionIndex, 0, structuredClone(canonicalContract));
  }

  const responseFormat = hasCanonicalJsonSchemaContract(template.response_format, canonical.response_format)
    ? template.response_format
    : structuredClone(canonical.response_format);
  if (messages === template.messages && responseFormat === template.response_format) return template;
  return { ...template, messages, response_format: responseFormat };
}

export async function migrateConversationEmojiVariables(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${CONVERSATION_EMOJI_MIGRATION_VERSION}`
    )
  );
  if (await readOptional(markerPath) === `${CONVERSATION_EMOJI_MIGRATION_VERSION}\n`) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationEmojiTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${CONVERSATION_EMOJI_MIGRATION_VERSION}\n`);
  return migrated !== template;
}

export function migrateConversationEmojiTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  const variables = promptMessageVariables(template);
  const missing = [EMOJI_KEYS_VARIABLE, EMOJI_SYNTAX_VARIABLE]
    .filter((variable) => !variables.has(variable));
  if (!missing.length) return template;

  const messages = [...template.messages];
  const currentInputIndex = messages.findIndex((message) => (
    isRecord(message)
    && message.role === "user"
    && typeof message.content === "string"
    && extractPromptVariables(message.content).includes("user.input")
  ));
  const finalUserIndex = findLastIndex(messages, (message) => (
    isRecord(message) && message.role === "user"
  ));
  const insertionIndex = currentInputIndex >= 0
    ? currentInputIndex
    : finalUserIndex >= 0 ? finalUserIndex : messages.length;
  messages.splice(insertionIndex, 0, {
    role: "developer",
    content: missing.map((variable) => variable === EMOJI_KEYS_VARIABLE
      ? `<emoji_keys>@{${variable}}</emoji_keys>`
      : `<emoji_syntax>@{${variable}}</emoji_syntax>`).join("\n")
  });
  return { ...template, messages };
}

export async function migrateConversationVoicePrompt(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${CONVERSATION_VOICE_MIGRATION_VERSION}`
    )
  );
  if (await readOptional(markerPath) === `${CONVERSATION_VOICE_MIGRATION_VERSION}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateConversationVoiceTemplate(
    parseFinalPromptTemplate(content),
    parseFinalPromptTemplate(canonicalContent)
  );
  if (migrated !== undefined) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${CONVERSATION_VOICE_MIGRATION_VERSION}\n`);
  return migrated !== undefined;
}

export function migrateConversationVoiceTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const canonicalTool = canonical.tools?.find((tool) => tool.function.name === VOICE_TOOL_NAME);
  if (!canonicalTool) throw new Error("Canonical conversation prompt is missing send_voice_message.");
  let changed = false;
  let messages = template.messages;
  const variables = promptMessageVariables(template);
  const missingVariables = [VOICE_SETTINGS_VARIABLE, VOICE_TRIGGER_POLICY_VARIABLE]
    .filter((variable) => !variables.has(variable));
  if (missingVariables.length) {
    messages = [...messages];
    const currentInputIndex = messages.findIndex((message) => (
      isRecord(message)
      && message.role === "user"
      && typeof message.content === "string"
      && extractPromptVariables(message.content).includes("user.input")
    ));
    const finalUserIndex = findLastIndex(messages, (message) => isRecord(message) && message.role === "user");
    const insertionIndex = currentInputIndex >= 0
      ? currentInputIndex
      : finalUserIndex >= 0 ? finalUserIndex : messages.length;
    messages.splice(insertionIndex, 0, {
      role: "developer",
      content: missingVariables.map((variable) => variable === VOICE_SETTINGS_VARIABLE
        ? `<voice_settings>@{${variable}}</voice_settings>`
        : `<voice_trigger_policy>@{${variable}}</voice_trigger_policy>`).join("\n")
    });
    changed = true;
  }

  const tools = [...(template.tools ?? [])];
  const voiceIndex = tools.findIndex((tool) => tool.function.name === VOICE_TOOL_NAME);
  if (voiceIndex < 0) {
    tools.push(structuredClone(canonicalTool));
    changed = true;
  } else {
    const current = tools[voiceIndex]!;
    const currentVariables = new Set(extractPromptVariables(current.function.description));
    const missingDescriptionVariables = [VOICE_SETTINGS_VARIABLE, VOICE_TRIGGER_POLICY_VARIABLE]
      .filter((variable) => !currentVariables.has(variable));
    const description = missingDescriptionVariables.length
      ? [current.function.description.trim(), ...missingDescriptionVariables.map((variable) => variable === VOICE_SETTINGS_VARIABLE
          ? `Current settings: @{${variable}}`
          : `Trigger policy: @{${variable}}`)]
        .filter(Boolean)
        .join("\n\n")
      : current.function.description;
    if (
      description !== current.function.description
      || JSON.stringify(current.function.parameters) !== JSON.stringify(canonicalTool.function.parameters)
      || current.function.strict !== canonicalTool.function.strict
    ) {
      tools[voiceIndex] = {
        ...current,
        function: {
          ...current.function,
          description,
          parameters: structuredClone(canonicalTool.function.parameters),
          ...(canonicalTool.function.strict == null ? {} : { strict: canonicalTool.function.strict })
        }
      };
      changed = true;
    }
  }
  return changed ? { ...template, messages, tools } : undefined;
}

export async function migrateToneEmojiMarkerRule(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${TONE_EMOJI_MIGRATION_VERSION}`
    )
  );
  if (await readOptional(markerPath) === `${TONE_EMOJI_MIGRATION_VERSION}\n`) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateToneEmojiMarkerTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${TONE_EMOJI_MIGRATION_VERSION}\n`);
  return migrated !== template;
}

export function migrateToneEmojiMarkerTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (template.messages.some((message) => (
    isRecord(message)
    && message.role === "system"
    && typeof message.content === "string"
    && message.content.includes(TONE_EMOJI_MARKER_RULE)
  ))) return template;
  const messages = [...template.messages];
  const systemIndex = messages.findIndex((message) => isRecord(message) && message.role === "system");
  if (systemIndex < 0) {
    messages.unshift({ role: "system", content: TONE_EMOJI_MARKER_RULE });
  } else {
    const systemMessage = messages[systemIndex];
    if (!isRecord(systemMessage)) return template;
    const current = typeof systemMessage.content === "string" ? systemMessage.content.trim() : "";
    messages[systemIndex] = {
      ...systemMessage,
      content: [current, TONE_EMOJI_MARKER_RULE].filter(Boolean).join("\n\n")
    };
  }
  return { ...template, messages };
}

function promptMessageVariables(template: FinalPromptTemplate) {
  const variables = new Set<string>();
  for (const message of template.messages) {
    if (!isRecord(message)
      || !["system", "developer", "user"].includes(String(message.role))
      || typeof message.content !== "string") continue;
    for (const variable of extractPromptVariables(message.content)) variables.add(variable);
  }
  return variables;
}

export async function migrateMemoryPerspectivePrompt(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${MEMORY_PERSPECTIVE_MIGRATION_VERSION}`
    )
  );
  if (await readOptional(markerPath) === `${MEMORY_PERSPECTIVE_MIGRATION_VERSION}\n`) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const canonical = parseFinalPromptTemplate(canonicalContent);
  const migrated = migrateMemoryPerspectiveTemplate(template, canonical);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${MEMORY_PERSPECTIVE_MIGRATION_VERSION}\n`);
  return migrated !== template;
}

export function migrateMemoryPerspectiveTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate {
  return migrateMemoryPerspectiveTemplateWithLegacy(
    template,
    canonical,
    LEGACY_MEMORY_PROMPT_PARAGRAPHS
  );
}

function hasCanonicalJsonSchemaContract(actual: unknown, canonical: unknown) {
  const actualSchema = strictJsonSchema(actual);
  const canonicalSchema = strictJsonSchema(canonical);
  return actualSchema !== undefined
    && canonicalSchema !== undefined
    && equalSchemaStructure(actualSchema, canonicalSchema);
}

function strictJsonSchema(value: unknown) {
  if (!isRecord(value) || value.type !== "json_schema" || !isRecord(value.json_schema)) {
    return undefined;
  }
  const descriptor = value.json_schema;
  return descriptor.strict === true && isRecord(descriptor.schema)
    ? descriptor.schema
    : undefined;
}

function equalSchemaStructure(actual: unknown, canonical: unknown): boolean {
  if (Array.isArray(canonical)) {
    return Array.isArray(actual)
      && actual.length === canonical.length
      && canonical.every((item, index) => equalSchemaStructure(actual[index], item));
  }
  if (isRecord(canonical)) {
    if (!isRecord(actual)) return false;
    const canonicalKeys = Object.keys(canonical).filter((key) => key !== "description");
    const actualKeys = Object.keys(actual).filter((key) => key !== "description");
    return actualKeys.length === canonicalKeys.length
      && canonicalKeys.every((key) => (
        Object.hasOwn(actual, key)
        && equalSchemaStructure(actual[key], canonical[key])
      ));
  }
  return actual === canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

async function assertNoSymbolicLink(workspace: string, filePath: string) {
  const relative = path.relative(workspace, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw promptPathError();
  }
  const paths = [workspace];
  let current = workspace;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  for (const [index, candidate] of paths.entries()) {
    try {
      const stat = await fs.lstat(candidate);
      const leaf = index === paths.length - 1;
      if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory())) throw promptPathError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

function promptPathError() {
  return Object.assign(new Error("Prompt path contains an invalid or symbolic-link component."), {
    code: "PROMPT_PATH_INVALID"
  });
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWriteText(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
