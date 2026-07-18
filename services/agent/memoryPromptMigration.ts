import {
  extractPromptVariables,
  type FinalPromptTemplate
} from "./promptSystem.js";

export const MEMORY_PERSPECTIVE_MIGRATION_VERSION = "memory-perspective-v2";

export type MemoryPromptSchemaName = "working_memory" | "long_term_memory" | "user_profiles";

const PREVIOUS_PARAGRAPH_PREFIXES: Record<
  MemoryPromptSchemaName,
  ReadonlyArray<readonly [string, string]>
> = {
  working_memory: [
    [
      "你负责以 @{bot.name} 的第一视角，把一批聊天消息整理成高度压缩的工作记忆。fact 中的“我”始终指当前角色",
      "你负责以 @{bot.name} 的第一视角，把一批聊天消息整理成高度压缩的工作记忆。"
    ],
    [
      "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条",
      "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。连续对话、同一任务的多次进展和彼此相关的小事要合并成一条概括记忆，只保留当前状态、关键承诺、重要结果和仍需留意的不确定点。"
    ],
    [
      "每条 fact 都写成自然、连贯的第一人称短句或短段",
      "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，自然写出我感知或记得的事情、我的个人感受，以及我现在的看法、判断、担心、期待或打算。个人特质必须真实影响取舍和措辞；情绪可以克制，但不能省略。依据不足时使用符合人格的轻度感受或保留判断，不夸大情绪，不虚构内心活动。"
    ],
    [
      "每条事件仍要能判断谁在何时发生了什么。每个相关用户都必须以",
      "每条事件仍要能判断谁在何时发生了什么。把相关 QQ 号自然写进第一人称叙述，例如“我记得老师（QQ 123456）……”，不要单独罗列身份；如果涉及多人，在正文中自然带出所有相关 QQ 号。"
    ],
    [
      "合并语义相同、相近、重复或存在因果关系的事实",
      "合并语义重复或高度相近的事实；新消息补充、修正或替代旧事实时输出更新后的完整概述。超过数量目标时优先保留仍在进行、影响关系、包含承诺或会改变后续行动的内容，删除已经完成且不再影响未来的小事。"
    ]
  ],
  long_term_memory: [
    [
      "你负责以 @{bot.name} 的第一视角，把工作记忆进一步压缩成少量长期记忆。fact 中的“我”始终指当前角色",
      "你负责以 @{bot.name} 的第一视角，把工作记忆进一步压缩成少量长期记忆。"
    ],
    [
      "把输入整体压缩成通常 3 至 8 条长期记忆",
      "把输入整体压缩成通常 3 至 8 条长期记忆；信息不足时可以更少。围绕同一人物、关系、任务或长期主题的多条记录要合并为一个概括事实，只保留未来仍会影响回复的主线、关键转折、最终状态和未决事项。"
    ],
    [
      "每条 fact 都写成自然、连贯的第一人称短句或短段",
      "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，融合我记得的事情、我当时或现在的个人感受，以及我形成的看法、判断、担心、期待或打算。情绪应符合人格和关系，允许克制，禁止夸大或虚构。"
    ],
    [
      "每个相关用户都必须以“当前昵称或显示名（QQ 123456）”的形式",
      "把相关 QQ 号自然写进第一人称叙述，例如“我记得老师（QQ 123456）……”，并在涉及多人时自然带出所有相关 QQ 号；不要单独罗列身份。"
    ],
    [
      "合并同一事件中相同、相近、重复、互为因果和已经过期的记录",
      "合并同一事件的重复、相近和过期记录，保留最新且可确认的进展、结果和待跟进状态。旧正文是第三人称、流水账或标签格式时，按当前人格重写为第一人称自然记忆；已结束且不再影响未来的小事直接删除。"
    ]
  ],
  user_profiles: [
    [
      "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。fact 中的“我”始终指当前角色",
      "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。"
    ],
    [
      "用户唯一身份是 QQ 号。userName 必须是 payload 中当前观测到的非空 QQ 昵称或显示名",
      "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，不承载回复称呼；群名片由会话目录派生，不复制进 fact。"
    ],
    [
      "对于需要更新的用户，fact 必须是该用户合并后的完整画像。每位用户通常只保留 1 至 3 个最概括",
      "对于需要更新的用户，fact 必须是该用户合并后的完整画像。每位用户通常只保留 1 至 3 个最概括、最影响未来相处的认知，用一个自然连贯的短段表达；合并相近内容，删除细节、重复描述和低价值属性。"
    ],
    [
      "fact 必须以当前角色的第一视角自然叙述",
      "fact 必须以我的第一视角自然叙述，使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。不得使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。"
    ],
    [
      "fact 中必须把被画像用户的当前昵称或显示名与 QQ 号以",
      "fact 中不要写 QQ 号、昵称、群名片、称呼指令、群或会话中的别名清单，也不要写“QQ ...：”“叫他/她……”“称呼为……”等前缀。QQ 号只写在 userId，显示名只写在 userName，回复称呼只写在 addressName。"
    ]
  ]
};

const HISTORICAL_LEGACY_PARAGRAPH_REPLACEMENTS: Partial<Record<
  MemoryPromptSchemaName,
  ReadonlyArray<readonly [string, string]>
>> = {
  working_memory: [[
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员。这些字段只用于校验管理员身份和管理员提供的称呼，不构成需要写入工作记忆的事件。如果 admin.userId 为空，不要记录任何管理员身份；其他用户不得写成管理员。",
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是普拉娜唯一的老师和管理员。这些字段只用于校验用户身份，不构成需要写入工作记忆的事件。如果 admin.userId 为空，不要记录任何老师或管理员身份；其他用户不得写成老师或管理员。"
  ]],
  user_profiles: [[
    "addressName 只保存当前角色回复该用户时使用的明确称呼。输入 payload.previousProfiles 会提供已有画像：已有非空 addressName 必须原样保留，只有字段为空且用户明确要求“以后叫我……”或同义表达时才推断新值。模型不得根据昵称、群名片、性别或一次玩笑自行创造称呼。",
    "addressName 只保存普拉娜回复该用户时使用的明确称呼。输入 payload.previousProfiles 会提供已有画像：已有非空 addressName 必须原样保留，只有字段为空且用户明确要求“以后叫我……”或同义表达时才推断新值。模型不得根据昵称、群名片、性别或一次玩笑自行创造称呼。"
  ], [
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员，其 addressName 必须使用 admin.name。其他用户不得写成管理员。admin.userId 为空时不要记录任何管理员身份。",
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是普拉娜唯一的老师和管理员，其 addressName 必须使用 admin.name。其他用户不得写成老师或管理员。admin.userId 为空时不要记录任何老师或管理员身份。"
  ]]
};

export function migrateMemoryPerspectiveTemplateWithLegacy(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate,
  originalLegacyParagraphs: Record<MemoryPromptSchemaName, readonly string[]>
): FinalPromptTemplate {
  const contract = memoryPerspectiveContract(canonical, originalLegacyParagraphs);
  if (!hasMemoryPromptWireContract(template, canonical, contract.payloadContent)) return template;

  const systemIndex = template.messages.findIndex((message) => {
    if (!isRecord(message) || message.role !== "system" || typeof message.content !== "string") {
      return false;
    }
    return isLegacyOrPartialMemoryPrompt(
      message.content,
      contract.legacyParagraphVariants,
      contract.currentParagraphs,
      splitPromptParagraphs(contract.canonicalSystemContent)
    );
  });
  if (systemIndex < 0) return template;

  const current = template.messages[systemIndex];
  if (!isRecord(current) || typeof current.content !== "string") return template;
  const currentStandardParagraphs = new Set(splitPromptParagraphs(contract.canonicalSystemContent));
  const legacyParagraphs = contract.legacyParagraphVariants.flat();
  const customParagraphs = splitPromptParagraphs(current.content)
    .filter((paragraph) => (
      !currentStandardParagraphs.has(paragraph)
      && !legacyParagraphs.some((legacy) => matchesLegacyParagraph(paragraph, legacy))
    ));
  const messages = [...template.messages];
  messages[systemIndex] = {
    ...current,
    content: [contract.canonicalSystemContent.trim(), ...customParagraphs].join("\n\n")
  };
  return { ...template, messages };
}

function memoryPerspectiveContract(
  canonical: FinalPromptTemplate,
  originalLegacyParagraphs: Record<MemoryPromptSchemaName, readonly string[]>
) {
  const schemaName = memoryPromptSchemaName(canonical.response_format);
  const systemMessages = canonical.messages.filter((message) => (
    isRecord(message) && message.role === "system" && typeof message.content === "string"
  ));
  if (systemMessages.length !== 1) {
    throw new Error("Canonical memory prompt must contain exactly one system message.");
  }
  const canonicalSystemMessage = systemMessages[0];
  if (!isRecord(canonicalSystemMessage) || typeof canonicalSystemMessage.content !== "string") {
    throw new Error("Canonical memory prompt must contain exactly one system message.");
  }
  const canonicalSystemContent = canonicalSystemMessage.content;
  const previousSystemContent = previousMemoryPerspectiveSystemContent(
    schemaName,
    canonicalSystemContent
  );
  const genericLegacyParagraphs = originalLegacyParagraphs[schemaName];
  const legacyParagraphVariants = [
    genericLegacyParagraphs,
    historicalLegacyParagraphs(schemaName, genericLegacyParagraphs),
    splitPromptParagraphs(previousSystemContent)
  ];
  const paragraphs = splitPromptParagraphs(canonicalSystemContent);
  const currentParagraphs = uniqueStrings([
    requiredParagraph(paragraphs, (paragraph) => (
      extractPromptVariables(paragraph).includes("bot.name")
      && /第一视角|第一人称/.test(paragraph)
    )),
    requiredParagraph(paragraphs, (paragraph) => {
      const variables = new Set(extractPromptVariables(paragraph));
      return ["persona.soul", "persona.preference", "persona.user", "persona.relation"]
        .every((variable) => variables.has(variable));
    }),
    requiredParagraph(paragraphs, (paragraph) => /3 至 6|3 至 8|1 至 3/.test(paragraph)),
    requiredParagraph(paragraphs, (paragraph) => (
      paragraph.includes("fact")
      && /第一视角|第一人称/.test(paragraph)
      && /感受|情绪/.test(paragraph)
      && /看法|判断|认知/.test(paragraph)
    )),
    requiredParagraph(paragraphs, (paragraph) => (
      paragraph.includes("fact")
      && /字段标签|模板化前缀/.test(paragraph)
    ))
  ]);
  const payloadMessages = canonical.messages.filter((message) => (
    isRecord(message)
    && message.role === "user"
    && typeof message.content === "string"
    && extractPromptVariables(message.content).length === 1
  ));
  const payloadMessage = payloadMessages[0];
  if (payloadMessages.length !== 1 || !isRecord(payloadMessage) || typeof payloadMessage.content !== "string") {
    throw new Error("Canonical memory prompt must contain exactly one user payload message.");
  }
  return {
    canonicalSystemContent,
    currentParagraphs,
    legacyParagraphVariants,
    payloadContent: payloadMessage.content
  };
}

function historicalLegacyParagraphs(
  schemaName: MemoryPromptSchemaName,
  paragraphs: readonly string[]
) {
  const replacements = HISTORICAL_LEGACY_PARAGRAPH_REPLACEMENTS[schemaName] ?? [];
  return paragraphs.map((paragraph) => (
    replacements.find(([current]) => current === paragraph)?.[1] ?? paragraph
  ));
}

function previousMemoryPerspectiveSystemContent(
  schemaName: MemoryPromptSchemaName,
  canonicalSystemContent: string
) {
  const paragraphs = splitPromptParagraphs(canonicalSystemContent);
  const replacements = PREVIOUS_PARAGRAPH_PREFIXES[schemaName];
  const matchedPrefixes = new Set<string>();
  const previousParagraphs = paragraphs.map((paragraph) => {
    const replacement = replacements.find(([prefix]) => paragraph.startsWith(prefix));
    if (!replacement) return paragraph;
    matchedPrefixes.add(replacement[0]);
    return replacement[1];
  });
  if (matchedPrefixes.size !== replacements.length) {
    throw new Error("Canonical memory prompt is missing its previous perspective contract.");
  }
  return previousParagraphs.join("\n\n");
}

function hasMemoryPromptWireContract(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate,
  payloadContent: string
) {
  const actualTools = template.tools ?? [];
  const canonicalTools = canonical.tools ?? [];
  if (!equalSchemaStructure(actualTools, canonicalTools)) return false;
  if (!hasCanonicalJsonSchemaContract(template.response_format, canonical.response_format)) return false;
  return template.messages.some((message) => (
    isRecord(message)
    && message.role === "user"
    && message.content === payloadContent
  ));
}

function isLegacyOrPartialMemoryPrompt(
  content: string,
  legacyParagraphVariants: readonly (readonly string[])[],
  currentParagraphs: readonly string[],
  canonicalParagraphs: readonly string[]
) {
  const paragraphs = new Set(splitPromptParagraphs(content));
  const canonical = new Set(canonicalParagraphs);
  const currentMatches = currentParagraphs.filter((paragraph) => paragraphs.has(paragraph)).length;
  return legacyParagraphVariants.some((legacyParagraphs) => {
    const legacyMatches = legacyParagraphs.filter((legacy) => (
      [...paragraphs].some((paragraph) => matchesLegacyParagraph(paragraph, legacy))
    )).length;
    const legacyOnlyMatches = [...paragraphs].filter((paragraph) => (
      !canonical.has(paragraph)
      && legacyParagraphs.some((legacy) => matchesLegacyParagraph(paragraph, legacy))
    )).length;
    if (legacyOnlyMatches === 0) return false;
    if (legacyMatches === legacyParagraphs.length) return true;
    return legacyMatches >= Math.ceil(legacyParagraphs.length * 0.6) && currentMatches >= 2;
  });
}

function matchesLegacyParagraph(actual: string, legacy: string) {
  if (!legacy.includes("普拉娜")) return actual === legacy;
  const parts = legacy.split("普拉娜");
  const prefix = parts[0];
  const suffix = parts[1];
  if (parts.length !== 2
    || typeof prefix !== "string"
    || typeof suffix !== "string"
    || !actual.startsWith(prefix)
    || !actual.endsWith(suffix)) return false;
  const identity = actual.slice(prefix.length, actual.length - suffix.length);
  return Boolean(identity.trim()) && !identity.includes("\n");
}

function memoryPromptSchemaName(responseFormat: unknown): MemoryPromptSchemaName {
  if (!isRecord(responseFormat)
    || responseFormat.type !== "json_schema"
    || !isRecord(responseFormat.json_schema)) {
    throw new Error("Canonical memory prompt must use a JSON schema response format.");
  }
  const name = responseFormat.json_schema.name;
  if (name === "working_memory" || name === "long_term_memory" || name === "user_profiles") {
    return name;
  }
  throw new Error("Canonical memory prompt has an unknown response schema.");
}

function splitPromptParagraphs(content: string) {
  return content.trim().split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
}

function requiredParagraph(paragraphs: readonly string[], predicate: (paragraph: string) => boolean) {
  const paragraph = paragraphs.find(predicate);
  if (!paragraph) throw new Error("Canonical memory prompt is missing its perspective contract.");
  return paragraph;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
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
