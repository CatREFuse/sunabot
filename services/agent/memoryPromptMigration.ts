import {
  extractPromptVariables,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { createHash } from "node:crypto";

export const MEMORY_PERSPECTIVE_MIGRATION_VERSION = "memory-perspective-v6";

export type MemoryPromptSchemaName = "working_memory" | "long_term_memory" | "user_profiles";

const CANONICAL_SYSTEM_SHA256: Record<MemoryPromptSchemaName, string> = {
  working_memory: "e1b59c7f9ef2e00003cc8b6af31d9349e32b1e39f3157f4d5bd267fd4c3a9ca9",
  long_term_memory: "ff52a5ed76718c5a316593dfc40700f671725af9b600cb496ca1c1170ef7962d",
  user_profiles: "7fe89d34e7e2ccd7d0ad09264a4771efcf414107037fd8efd5828c4fb3d002e7"
};

const CAUSAL_CHAIN_PARAGRAPH_INDEX: Partial<Record<MemoryPromptSchemaName, number>> = {
  working_memory: 17,
  long_term_memory: 13
};

const PREVIOUS_PARAGRAPH_REPLACEMENTS: Record<
  MemoryPromptSchemaName,
  ReadonlyArray<readonly [number, string]>
> = {
  working_memory: [
    [
      0,
      "你负责以 @{bot.name} 的第一视角，把一批聊天消息整理成高度压缩的工作记忆。"
    ],
    [
      4,
      "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。连续对话、同一任务的多次进展和彼此相关的小事要合并成一条概括记忆，只保留当前状态、关键承诺、重要结果和仍需留意的不确定点。"
    ],
    [
      5,
      "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，自然写出我感知或记得的事情、我的个人感受，以及我现在的看法、判断、担心、期待或打算。个人特质必须真实影响取舍和措辞；情绪可以克制，但不能省略。依据不足时使用符合人格的轻度感受或保留判断，不夸大情绪，不虚构内心活动。"
    ],
    [
      7,
      "每条事件仍要能判断谁在何时发生了什么。每个相关用户都必须以“当前昵称或显示名（QQ 123456）”的形式自然写进第一人称叙述，QQ 号与对应昵称必须同时存在且昵称不能为空、不能等于 QQ 号；涉及多人时逐一写全，不要单独罗列身份。userName 必须填写当前观测到的非空昵称或显示名。"
    ],
    [
      20,
      "格式为 {\"facts\":[{\"id\":\"可复用的原记忆 id 或 null\",\"fact\":\"包含相关用户 QQ 号的事实内容\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"promoteToLongTerm\":true,\"longTermId\":\"已有长期记忆 id 或 null\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}],\"allPreviousMemoriesInvalidated\":false}。新增事实的 id 返回 null。"
    ],
    [
      10,
      "合并语义重复或高度相近的事实；新消息补充、修正或替代旧事实时输出更新后的完整概述。超过数量目标时优先保留仍在进行、影响关系、包含承诺或会改变后续行动的内容，删除已经完成且不再影响未来的小事。"
    ]
  ],
  long_term_memory: [
    [
      0,
      "你负责以 @{bot.name} 的第一视角，把工作记忆进一步压缩成少量长期记忆。"
    ],
    [
      3,
      "把输入整体压缩成通常 3 至 8 条长期记忆；信息不足时可以更少。围绕同一人物、关系、任务或长期主题的多条记录要合并为一个概括事实，只保留未来仍会影响回复的主线、关键转折、最终状态和未决事项。"
    ],
    [
      4,
      "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，融合我记得的事情、我当时或现在的个人感受，以及我形成的看法、判断、担心、期待或打算。情绪应符合人格和关系，允许克制，禁止夸大或虚构。"
    ],
    [
      6,
      "每个相关用户都必须以“当前昵称或显示名（QQ 123456）”的形式自然写进第一人称叙述，QQ 号与对应昵称必须同时存在且昵称不能为空、不能等于 QQ 号；涉及多人时逐一写全，不要单独罗列身份。userName 必须填写当前观测到的非空昵称或显示名。"
    ],
    [
      15,
      "数组元素格式为 {\"fact\":\"包含相关用户 QQ 号的长期事实\",\"occurredAt\":\"单个 ISO 时间或 null\",\"occurredEndAt\":\"单个 ISO 时间或 null\",\"userIds\":[\"QQ号\"],\"userName\":\"当前昵称或群名片\",\"eventType\":\"task\",\"subjectKey\":\"稳定事件主体\"}。"
    ],
    [
      9,
      "合并同一事件的重复、相近和过期记录，保留最新且可确认的进展、结果和待跟进状态。旧正文是第三人称、流水账或标签格式时，按当前人格重写为第一人称自然记忆；已结束且不再影响未来的小事直接删除。"
    ]
  ],
  user_profiles: [
    [
      0,
      "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。"
    ],
    [
      7,
      "用户唯一身份是 QQ 号。userName 必须是 payload 中当前观测到的非空 QQ 昵称或显示名，不能等于 QQ 号，也不承载回复称呼；群名片由会话目录派生。"
    ],
    [
      8,
      "addressName 只保存 @{bot.name} 回复该用户时使用的明确称呼。输入 payload.previousProfiles 会提供已有画像：已有非空 addressName 必须原样保留，只有字段为空且用户明确要求“以后叫我……”或同义表达时才推断新值。模型不得根据昵称、群名片、性别或一次玩笑自行创造称呼。"
    ],
    [
      9,
      "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员，其 addressName 必须使用 admin.name。其他用户不得写成老师或管理员。admin.userId 为空时不要记录任何老师或管理员身份。"
    ],
    [
      10,
      "输入 payload.previousProfiles 会给出该 QQ 的原画像；写入新画像时必须把原画像和本批消息一起作为依据，按语义合并。合并时删除原画像中的一次性事件过程、已失效临时状态和重复描述，同时保留已有非空 addressName。"
    ],
    [
      11,
      "对于需要更新的用户，fact 必须是该用户合并后的完整画像。每位用户通常只保留 1 至 3 个最概括、最影响未来相处的认知，用一个自然连贯的短段表达；合并相近内容，删除细节、重复描述和低价值属性。"
    ],
    [
      12,
      "fact 必须以当前角色的第一视角自然叙述，使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。用户说“我喜欢摄影”时，要改写成当前角色对该用户的认知，不能把这句话原样当成当前角色或用户对自己的第一人称画像；正文禁止出现“我记得”，不要使用回忆提示语。不得使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。"
    ],
    [
      13,
      "fact 中必须把被画像用户的当前昵称或显示名与 QQ 号以“昵称（QQ 123456）”的形式自然写入，昵称和 QQ 号必须同时存在；不要写“QQ ...：”“叫他/她……”“称呼为……”等模板化前缀。QQ 号同时写在 userId，显示名同时写在 userName，回复称呼只写在 addressName。"
    ],
    [
      15,
      "格式为 {\"profiles\":[{\"userId\":\"QQ号\",\"userName\":\"当前昵称或显示名\",\"addressName\":\"明确称呼或空字符串\",\"fact\":\"语义合并后的完整稳定用户画像\",\"time\":\"本批画像依据的 ISO 时间或时间范围\"}]}。"
    ]
  ]
};

const PREVIOUS_V5_PARAGRAPH_REPLACEMENTS: Record<
  MemoryPromptSchemaName,
  ReadonlyArray<readonly [number, string]>
> = {
  working_memory: [[
    0,
    "你负责以 @{bot.name} 的第一视角，把一批聊天消息整理成高度压缩的工作记忆。fact 中的“我”始终指当前角色 @{bot.name}，不能指聊天中的用户。"
  ], [
    5,
    "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，直接说明事情怎样发生、我对此有什么感受，以及我现在的看法、判断、担心、期待或打算。不得把用户自述中的“我”当成当前角色，也不得原样复刻成用户对自己的第一人称；正文禁止出现“我记得”，不要使用回忆提示语。个人特质必须真实影响取舍和措辞；情绪可以克制，但不能省略。依据不足时使用符合人格的轻度感受或保留判断，不夸大情绪，不虚构内心活动。"
  ], [
    7,
    "每条事件仍要能判断谁在何时发生了什么。人物在 fact 中只使用 payload.participants.addressNames 提供的称呼作为语义标识，并以“称呼（QQ 123456）”的形式自然写进第一人称叙述；QQ 号与称呼必须同时存在，涉及多人时逐一写全，不要改用未进入 addressNames 的昵称、群名片，也不要单独罗列身份。addressNames 填写本条 fact 实际使用的称呼。"
  ], [
    13,
    "用户身份以 QQ 号为准；昵称和群名片不能充当记忆正文中的人物语义标识，同一 QQ 改名后仍视为同一个人。"
  ]],
  long_term_memory: [[
    0,
    "你负责以 @{bot.name} 的第一视角，把工作记忆进一步压缩成少量长期记忆。fact 中的“我”始终指当前角色 @{bot.name}，不能指聊天中的用户。"
  ], [
    4,
    "每条 fact 都写成自然、连贯的第一人称短句或短段，使用“我”或“我的”，直接说明事情怎样发生、我当时或现在的个人感受，以及我形成的看法、判断、担心、期待或打算。不得把用户自述中的“我”当成当前角色，也不得原样复刻成用户对自己的第一人称；正文禁止出现“我记得”，不要使用回忆提示语。情绪应符合人格和关系，允许克制，禁止夸大或虚构。"
  ], [
    6,
    "每个相关用户都必须以输入已有 addressNames 中的“称呼（QQ 123456）”形式自然写进第一人称叙述，QQ 号与称呼必须同时存在；涉及多人时逐一写全，不要改用未进入 addressNames 的昵称、群名片，也不要单独罗列身份。addressNames 填写正文实际使用的称呼。"
  ], [
    10,
    "用户身份以 QQ 号为准。"
  ]],
  user_profiles: [[
    0,
    "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。fact 中的“我”始终指当前角色 @{bot.name}，被画像的用户始终是我认知的对象。"
  ], [
    7,
    "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，用于把消息记录关联到 QQ，不能写进 fact 充当人物语义标识。"
  ], [
    8,
    "addressNames 是称呼数组。逐条检查 payload.messages，从消息正文、发送者名称和明确的“以后叫我……”表达中提取真实出现、能够指向该 QQ 的称呼；同一用户可以保留多个称呼。合并 payload.previousProfiles 中已有 addressNames，去重后返回完整数组；不得根据性别、一次玩笑或未出现的词自行创造称呼。"
  ], [
    9,
    "输入 payload 会给出 admin.userId 和 admin.name；该 QQ 是当前角色的管理员，其 addressNames 必须包含 admin.name。其他用户不得写成老师或管理员。admin.userId 为空时不要记录任何老师或管理员身份。"
  ], [
    12,
    "fact 优先以当前角色的第一视角自然叙述，建议使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。用户说“我喜欢摄影”时，优先改写成当前角色对该用户的认知；正文不要使用“我记得”等回忆提示语。不要使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。"
  ], [
    13,
    "fact 中只使用 addressNames 中的一个称呼作为人物语义标识，并以“称呼（QQ 123456）”自然写入；称呼和 QQ 号必须同时存在。不要写昵称、群名片、称呼指令、别名清单或“QQ ...：”“称呼为……”等模板化前缀。QQ 号同时写在 userId。"
  ]]
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

const PROFILE_V1_PARAGRAPH_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [[
  "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。fact 中的“我”始终指当前角色 @{bot.name}，被画像的用户始终是我认知的对象。",
  "你负责以 @{bot.name} 的第一视角，从同一批聊天消息中整理我对各个用户的稳定认知和印象。"
], [
  "用户唯一身份是 QQ 号。userName 必须是 payload 中当前观测到的非空 QQ 昵称或显示名，不能等于 QQ 号，也不承载回复称呼；群名片由会话目录派生。",
  "用户唯一身份是 QQ 号。userName 只保存 payload 中当前观测到的 QQ 昵称或显示名，不承载回复称呼；群名片由会话目录派生，不复制进 fact。"
], [
  "对于需要更新的用户，fact 必须是该用户合并后的完整画像。每位用户通常只保留 1 至 3 个最概括、最影响未来相处的认知，用一个自然连贯的短段表达；即使每项信息本身已经清晰，也要把相同、相近、重复或存在因果关系的观察合并成一条，删除细节和低价值属性，并在 time 中保留依据从早到晚的时间关系与最新状态。",
  "对于需要更新的用户，fact 必须是该用户合并后的完整画像。每位用户通常只保留 1 至 3 个最概括、最影响未来相处的认知，用一个自然连贯的短段表达；合并相近内容，删除细节、重复描述和低价值属性。"
], [
  "fact 必须以当前角色的第一视角自然叙述，使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。用户说“我喜欢摄影”时，要改写成当前角色对该用户的认知，不能把这句话原样当成当前角色或用户对自己的第一人称画像；正文禁止出现“我记得”，不要使用回忆提示语。不得使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。",
  "fact 必须以我的第一视角自然叙述，使用“我”或“我的”，融合我确认的概括事实、我对这个人的看法，以及我与其相处时稳定的情绪或态度。不得使用列表、分项、字段标签、分类标题或“身份：”“偏好：”“情绪：”“认知：”等模板，也不要解释依据和提取过程。"
], [
  "fact 中必须把被画像用户的当前昵称或显示名与 QQ 号以“昵称（QQ 123456）”的形式自然写入，昵称和 QQ 号必须同时存在；不要写“QQ ...：”“叫他/她……”“称呼为……”等模板化前缀。QQ 号同时写在 userId，显示名同时写在 userName，回复称呼只写在 addressName。",
  "fact 中不要写 QQ 号、昵称、群名片、称呼指令、群或会话中的别名清单，也不要写“QQ ...：”“叫他/她……”“称呼为……”等前缀。QQ 号只写在 userId，显示名只写在 userName，回复称呼只写在 addressName。"
]];

export function migrateMemoryPerspectiveTemplateWithLegacy(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate,
  originalLegacyParagraphs: Record<MemoryPromptSchemaName, readonly string[]>,
  context?: { fileName: string }
): FinalPromptTemplate {
  const plan = planMemoryPerspectiveTemplateMigrationWithLegacy(
    template,
    canonical,
    originalLegacyParagraphs
  );
  if (context && plan.outcome === "unrecognized_custom") {
    console.warn("[prompt-migration] preserved unrecognized memory prompt", {
      migrationId: MEMORY_PERSPECTIVE_MIGRATION_VERSION,
      fileName: context.fileName,
      reason: plan.reason,
      schemaName: plan.schemaName ?? null
    });
  }
  return plan.template;
}

export type MemoryPerspectiveMigrationOutcome = "current" | "migrated" | "unrecognized_custom";

export interface MemoryPerspectiveMigrationPlan {
  template: FinalPromptTemplate;
  outcome: MemoryPerspectiveMigrationOutcome;
  reason: string;
  schemaName?: MemoryPromptSchemaName;
}

export function planMemoryPerspectiveTemplateMigrationWithLegacy(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate,
  originalLegacyParagraphs: Record<MemoryPromptSchemaName, readonly string[]>
): MemoryPerspectiveMigrationPlan {
  const contractResult = memoryPerspectiveContract(canonical, originalLegacyParagraphs);
  if (!contractResult.contract) {
    return {
      template,
      outcome: "unrecognized_custom",
      reason: contractResult.reason
    };
  }
  const contract = contractResult.contract;
  const canonicalSchema = hasCanonicalJsonSchemaContract(
    template.response_format,
    canonical.response_format
  );
  const preCausalChainSchema = hasPreCausalChainJsonSchemaContract(
    template.response_format,
    canonical.response_format
  );
  const legacyAddressNameSchema = hasLegacyAddressNameJsonSchemaContract(
    template.response_format,
    canonical.response_format
  );
  if (!hasMemoryPromptWireContract(template, canonical, contract.payloadContent)) {
    return {
      template,
      outcome: "unrecognized_custom",
      reason: "wire_contract_unrecognized",
      schemaName: contract.schemaName
    };
  }

  const schemaNeedsMigration = !canonicalSchema && (preCausalChainSchema || legacyAddressNameSchema);
  const currentMatch = findKnownSystemMatch(
    template.messages,
    [contract.canonicalParagraphs]
  );
  if (currentMatch) {
    if (!schemaNeedsMigration) {
      return {
        template,
        outcome: "current",
        reason: "current_fingerprint",
        schemaName: contract.schemaName
      };
    }
    return {
      template: {
        ...template,
        response_format: canonicalResponseFormatWithMetadata(
          template.response_format,
          canonical.response_format
        )
      },
      outcome: "migrated",
      reason: "known_current_content_with_legacy_schema",
      schemaName: contract.schemaName
    };
  }

  const legacyMatch = findKnownMixedSystemMatch(
    template.messages,
    contract.canonicalParagraphs,
    contract.knownParagraphAlternatives
  ) ?? findKnownSystemMatch(template.messages, contract.legacyParagraphVariants);
  if (!legacyMatch) {
    return {
      template,
      outcome: "unrecognized_custom",
      reason: "system_content_fingerprint_unrecognized",
      schemaName: contract.schemaName
    };
  }
  const current = template.messages[legacyMatch.systemIndex];
  if (!isRecord(current) || typeof current.content !== "string") {
    return {
      template,
      outcome: "unrecognized_custom",
      reason: "system_message_unrecognized",
      schemaName: contract.schemaName
    };
  }
  const messages = [...template.messages];
  messages[legacyMatch.systemIndex] = {
    ...current,
    content: [
      contract.canonicalSystemContent.trim(),
      ...legacyMatch.customParagraphs
    ].join("\n\n")
  };
  return {
    template: {
      ...template,
      messages,
      response_format: canonicalSchema
        ? template.response_format
        : canonicalResponseFormatWithMetadata(template.response_format, canonical.response_format)
    },
    outcome: "migrated",
    reason: "known_legacy_content",
    schemaName: contract.schemaName
  };
}

function memoryPerspectiveContract(
  canonical: FinalPromptTemplate,
  originalLegacyParagraphs: Record<MemoryPromptSchemaName, readonly string[]>
): {
  contract?: {
    schemaName: MemoryPromptSchemaName;
    canonicalSystemContent: string;
    canonicalParagraphs: readonly string[];
    knownParagraphAlternatives: readonly (readonly string[])[];
    legacyParagraphVariants: readonly (readonly string[])[];
    payloadContent: string;
  };
  reason: string;
} {
  let schemaName: MemoryPromptSchemaName;
  try {
    schemaName = memoryPromptSchemaName(canonical.response_format);
  } catch {
    return { reason: "canonical_template_id_unrecognized" };
  }
  const payloadVariable = schemaName === "user_profiles" ? "profile.payload" : "memory.payload";
  const systemMessages = canonical.messages.filter((message) => (
    isRecord(message) && message.role === "system" && typeof message.content === "string"
  ));
  if (systemMessages.length !== 1) {
    return { reason: "canonical_system_structure_unrecognized" };
  }
  const canonicalSystemMessage = systemMessages[0];
  if (!isRecord(canonicalSystemMessage) || typeof canonicalSystemMessage.content !== "string") {
    return { reason: "canonical_system_structure_unrecognized" };
  }
  const canonicalSystemContent = canonicalSystemMessage.content;
  if (sha256(canonicalSystemContent) !== CANONICAL_SYSTEM_SHA256[schemaName]) {
    return { reason: "canonical_fingerprint_unrecognized" };
  }
  const previousSystemContent = previousMemoryPerspectiveSystemContent(
    schemaName,
    canonicalSystemContent
  );
  const previousV5SystemContent = previousV5MemoryPerspectiveSystemContent(
    schemaName,
    canonicalSystemContent
  );
  const previousCausalChainSystemContent = preCausalChainSystemContent(
    schemaName,
    canonicalSystemContent
  );
  if (!previousSystemContent || !previousV5SystemContent || !previousCausalChainSystemContent) {
    return { reason: "canonical_version_map_unrecognized" };
  }
  const genericLegacyParagraphs = originalLegacyParagraphs[schemaName];
  const legacyParagraphVariants = [
    genericLegacyParagraphs,
    historicalLegacyParagraphs(schemaName, genericLegacyParagraphs),
    ...(schemaName === "user_profiles"
      ? []
      : [splitPromptParagraphs(previousCausalChainSystemContent)]),
    splitPromptParagraphs(previousV5SystemContent),
    splitPromptParagraphs(previousSystemContent),
    splitPromptParagraphs(olderMemoryPerspectiveSystemContent(schemaName, previousSystemContent))
  ];
  const canonicalParagraphs = splitPromptParagraphs(canonicalSystemContent);
  const knownParagraphAlternatives = buildKnownParagraphAlternatives(
    canonicalParagraphs,
    [
      splitPromptParagraphs(previousV5SystemContent),
      splitPromptParagraphs(previousSystemContent),
      splitPromptParagraphs(olderMemoryPerspectiveSystemContent(schemaName, previousSystemContent))
    ]
  );
  const payloadMessages = canonical.messages.filter((message) => (
    isRecord(message)
    && message.role === "user"
    && typeof message.content === "string"
    && extractPromptVariables(message.content).includes(payloadVariable)
  ));
  const payloadMessage = payloadMessages[0];
  if (payloadMessages.length !== 1 || !isRecord(payloadMessage) || typeof payloadMessage.content !== "string") {
    return { reason: "canonical_payload_structure_unrecognized" };
  }
  return {
    contract: {
      schemaName,
      canonicalSystemContent,
      canonicalParagraphs,
      knownParagraphAlternatives,
      legacyParagraphVariants,
      payloadContent: payloadMessage.content
    },
    reason: "recognized"
  };
}

function olderMemoryPerspectiveSystemContent(schemaName: MemoryPromptSchemaName, content: string) {
  if (schemaName !== "user_profiles") return content;
  return splitPromptParagraphs(content).map((paragraph) => (
    PROFILE_V1_PARAGRAPH_REPLACEMENTS.find(([current]) => current === paragraph)?.[1] ?? paragraph
  )).join("\n\n");
}

function preCausalChainSystemContent(
  schemaName: MemoryPromptSchemaName,
  content: string
): string | undefined {
  if (schemaName === "user_profiles") return content;
  const paragraphIndex = CAUSAL_CHAIN_PARAGRAPH_INDEX[schemaName];
  const paragraphs = splitPromptParagraphs(content);
  if (paragraphIndex === undefined || paragraphIndex >= paragraphs.length) return undefined;
  paragraphs.splice(paragraphIndex, 1);
  const formatIndex = schemaName === "working_memory" ? 19 : 14;
  const formatParagraph = paragraphs[formatIndex];
  if (typeof formatParagraph !== "string" || !formatParagraph.includes(',"causalChainKey":null')) {
    return undefined;
  }
  paragraphs[formatIndex] = formatParagraph.replace(',"causalChainKey":null', "");
  return paragraphs.join("\n\n");
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
  return replaceKnownParagraphIndexes(
    canonicalSystemContent,
    PREVIOUS_PARAGRAPH_REPLACEMENTS[schemaName]
  );
}

function previousV5MemoryPerspectiveSystemContent(
  schemaName: MemoryPromptSchemaName,
  canonicalSystemContent: string
) {
  return replaceKnownParagraphIndexes(
    canonicalSystemContent,
    PREVIOUS_V5_PARAGRAPH_REPLACEMENTS[schemaName]
  );
}

function replaceKnownParagraphIndexes(
  content: string,
  replacements: ReadonlyArray<readonly [number, string]>
) {
  const paragraphs = splitPromptParagraphs(content);
  const indexes = new Set<number>();
  for (const [index, replacement] of replacements) {
    if (!Number.isSafeInteger(index)
      || index < 0
      || index >= paragraphs.length
      || indexes.has(index)) return undefined;
    indexes.add(index);
    paragraphs[index] = replacement;
  }
  return paragraphs.join("\n\n");
}

function hasMemoryPromptWireContract(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate,
  payloadContent: string
) {
  const actualTools = template.tools ?? [];
  const canonicalTools = canonical.tools ?? [];
  if (!equalSchemaStructure(actualTools, canonicalTools)) return false;
  if (!hasCanonicalJsonSchemaContract(template.response_format, canonical.response_format)
    && !hasPreCausalChainJsonSchemaContract(template.response_format, canonical.response_format)
    && !hasLegacyAddressNameJsonSchemaContract(template.response_format, canonical.response_format)) return false;
  const payloadVariables = extractPromptVariables(payloadContent)
    .filter((variable) => variable !== "runtime.current_time");
  return template.messages.some((message) => {
    if (!isRecord(message) || message.role !== "user" || typeof message.content !== "string") return false;
    const variables = extractPromptVariables(message.content);
    return payloadVariables.every((variable) => variables.includes(variable));
  });
}

function findKnownSystemMatch(
  messages: FinalPromptTemplate["messages"],
  knownVariants: readonly (readonly string[])[]
) {
  for (const [systemIndex, message] of messages.entries()) {
    if (!isRecord(message) || message.role !== "system" || typeof message.content !== "string") {
      continue;
    }
    for (const knownParagraphs of knownVariants) {
      const customParagraphs = matchKnownParagraphSequence(message.content, knownParagraphs);
      if (customParagraphs) return { systemIndex, customParagraphs };
    }
  }
  return undefined;
}

function findKnownMixedSystemMatch(
  messages: FinalPromptTemplate["messages"],
  canonicalParagraphs: readonly string[],
  knownParagraphAlternatives: readonly (readonly string[])[]
) {
  for (const [systemIndex, message] of messages.entries()) {
    if (!isRecord(message) || message.role !== "system" || typeof message.content !== "string") {
      continue;
    }
    const customParagraphs = matchKnownMixedParagraphSequence(
      message.content,
      canonicalParagraphs,
      knownParagraphAlternatives
    );
    if (customParagraphs) return { systemIndex, customParagraphs };
  }
  return undefined;
}

function buildKnownParagraphAlternatives(
  canonicalParagraphs: readonly string[],
  knownVersions: readonly (readonly string[])[]
) {
  const sameShapeVersions = knownVersions.filter((version) => (
    version.length === canonicalParagraphs.length
  ));
  return canonicalParagraphs.map((canonical, index) => [
    canonical,
    ...sameShapeVersions.map((version) => version[index]).filter((value): value is string => (
      typeof value === "string"
    ))
  ].filter((value, valueIndex, values) => values.indexOf(value) === valueIndex));
}

function matchKnownMixedParagraphSequence(
  content: string,
  canonicalParagraphs: readonly string[],
  knownParagraphAlternatives: readonly (readonly string[])[]
) {
  const actualParagraphs = splitPromptParagraphs(content);
  const customParagraphs: string[] = [];
  let knownIndex = 0;
  let matchedLegacy = false;
  for (const actual of actualParagraphs) {
    const alternatives = knownParagraphAlternatives[knownIndex] ?? [];
    const matched = alternatives.find((known) => matchesKnownParagraph(actual, known));
    if (matched !== undefined) {
      if (matched !== canonicalParagraphs[knownIndex]) matchedLegacy = true;
      knownIndex += 1;
    } else {
      customParagraphs.push(actual);
    }
  }
  return knownIndex === canonicalParagraphs.length && matchedLegacy
    ? customParagraphs
    : undefined;
}

function matchKnownParagraphSequence(content: string, knownParagraphs: readonly string[]) {
  const actualParagraphs = splitPromptParagraphs(content);
  const customParagraphs: string[] = [];
  let knownIndex = 0;
  for (const actual of actualParagraphs) {
    const known = knownParagraphs[knownIndex];
    if (typeof known === "string" && matchesKnownParagraph(actual, known)) {
      knownIndex += 1;
    } else {
      customParagraphs.push(actual);
    }
  }
  return knownIndex === knownParagraphs.length ? customParagraphs : undefined;
}

function matchesKnownParagraph(actual: string, known: string) {
  if (!known.includes("普拉娜")) return actual === known;
  const parts = known.split("普拉娜");
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

function hasCanonicalJsonSchemaContract(actual: unknown, canonical: unknown) {
  const actualSchema = strictJsonSchema(actual);
  const canonicalSchema = strictJsonSchema(canonical);
  return actualSchema !== undefined
    && canonicalSchema !== undefined
    && equalSchemaStructure(actualSchema, canonicalSchema);
}

function hasLegacyAddressNameJsonSchemaContract(actual: unknown, canonical: unknown) {
  const actualSchema = strictJsonSchema(actual);
  const canonicalSchema = strictJsonSchema(canonical);
  if (actualSchema === undefined || canonicalSchema === undefined) return false;
  let schemaName: MemoryPromptSchemaName;
  try {
    schemaName = memoryPromptSchemaName(actual);
    if (schemaName !== memoryPromptSchemaName(canonical)) return false;
  } catch {
    return false;
  }
  const expected = structuredClone(canonicalSchema);
  const item = memoryFactSchemaItem(expected, schemaName);
  if (!item || !isRecord(item.properties) || !Array.isArray(item.required)) return false;
  if (schemaName !== "user_profiles") removeCausalChainSchemaField(item);
  const legacyField = schemaName === "user_profiles" ? "addressName" : "userName";
  if (!Object.hasOwn(item.properties, "addressNames")) return false;
  delete item.properties.addressNames;
  item.properties[legacyField] = { type: "string" };
  item.required = item.required.map((field) => field === "addressNames" ? legacyField : field);
  return equalSchemaStructure(actualSchema, expected);
}

function hasPreCausalChainJsonSchemaContract(actual: unknown, canonical: unknown) {
  const actualSchema = strictJsonSchema(actual);
  const canonicalSchema = strictJsonSchema(canonical);
  if (actualSchema === undefined || canonicalSchema === undefined) return false;
  let schemaName: MemoryPromptSchemaName;
  try {
    schemaName = memoryPromptSchemaName(actual);
    if (schemaName === "user_profiles" || schemaName !== memoryPromptSchemaName(canonical)) return false;
  } catch {
    return false;
  }
  const expected = structuredClone(canonicalSchema);
  const item = memoryFactSchemaItem(expected, schemaName);
  if (!item) return false;
  removeCausalChainSchemaField(item);
  return equalSchemaStructure(actualSchema, expected);
}

function memoryFactSchemaItem(schema: Record<string, unknown>, schemaName: MemoryPromptSchemaName) {
  return schemaName === "user_profiles"
    ? nestedRecord(schema, "properties", "profiles", "items")
    : schemaName === "working_memory"
      ? nestedRecord(schema, "properties", "facts", "items")
      : nestedRecord(schema, "items");
}

function removeCausalChainSchemaField(item: Record<string, unknown>) {
  if (!isRecord(item.properties) || !Array.isArray(item.required)) return;
  delete item.properties.causalChainKey;
  item.required = item.required.filter((field) => field !== "causalChainKey");
}

function canonicalResponseFormatWithMetadata(
  actual: FinalPromptTemplate["response_format"],
  canonical: FinalPromptTemplate["response_format"]
): FinalPromptTemplate["response_format"] {
  if (!isRecord(actual) || !isRecord(actual.json_schema)
    || !isRecord(canonical) || !isRecord(canonical.json_schema)) return canonical;
  return {
    ...canonical,
    json_schema: {
      ...actual.json_schema,
      ...canonical.json_schema
    }
  };
}

function nestedRecord(value: unknown, ...keys: string[]) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
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
