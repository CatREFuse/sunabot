import fs from "node:fs/promises";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const LEGACY_FIXED_COUNT_PARAGRAPH =
  "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。整理前先把 previousWorkingMemories 和 messages 放到同一时间线上，检查同一件事的前因、经过、转折、结果以及感受变化，把彼此确有联系的片段写成一条新的综合工作记忆，并用 occurredAt 保留最早起点、occurredEndAt 保留最新结果或结束时间。";
const MODEL_OWNED_COUNT_PARAGRAPH =
  "只保留仍会影响后续回复的事件，由你根据当前上下文自行决定保留多少内容。整理前先把 previousWorkingMemories 和 messages 放到同一时间线上，检查同一件事的前因、经过、转折、结果以及感受变化，把彼此确有联系的片段写成一条新的综合工作记忆，并用 occurredAt 保留最早起点、occurredEndAt 保留最新结果或结束时间。";
const MODEL_OWNED_PARTICIPANT_PARAGRAPH =
  "每条事件仍要能判断谁在何时发生了什么。人物可以优先使用 payload.participants.addressNames 提供的称呼，并在有助于消歧时写成“称呼（QQ 123456）”；涉及多人时尽量逐一说明。addressNames 可填写本条 fact 实际使用的称呼，正文没有采用该格式也不影响内容表达。";
const MODEL_OWNED_CONSOLIDATION_PARAGRAPH =
  "整理时同时参考 fact 内部叙述的时间、occurredAt、occurredEndAt 和消息顺序。对同一人物、地点、会话场域或事件主线中能够由输入确认的连续变化，可以把分散记忆互相串联，重新写成一条从较早经历延伸到当前状态的新工作记忆，并自然保留我在不同阶段的感受或判断变化。这里的联想只用于发现输入中已有的联系，不能补造未发生的情节、地点、人物、因果或感受。";
const HOST_TIME_PARAGRAPH =
  "时间使用 v2 字段。occurredAt 是正文表达的事件开始或单点时间，occurredEndAt 是可选结束时间，两者都只能是单个 ISO 8601 时间或 null，禁止把范围拼进一个字符串。无法从消息验证发生时间时保持 null，不要猜测。每项持久化记录时间、IANA 时区和会话来源均由宿主生成，不能在 fact 或其他字段中伪造。";

const KNOWN_PARAGRAPH_REPLACEMENTS = new Map<string, string | null>([
  [LEGACY_FIXED_COUNT_PARAGRAPH, MODEL_OWNED_COUNT_PARAGRAPH],
  [
    "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。即使每条信息本身已经清晰，也要主动检查语义相同、相近、重复、互为因果或属于同一事件不同阶段的内容，把它们压缩成一条概括记忆，写清原因、先后变化、当前状态、关键承诺、重要结果和仍需留意的不确定点，并用 occurredAt 保留最早起点、occurredEndAt 保留最新结果或结束时间。",
    MODEL_OWNED_COUNT_PARAGRAPH
  ],
  [
    "只保留最近最影响后续回复的少数事件。完整工作记忆通常保留 3 至 6 条，最多 8 条；信息不足时可以更少。连续对话、同一任务的多次进展和彼此相关的小事要合并成一条概括记忆，只保留当前状态、关键承诺、重要结果和仍需留意的不确定点。",
    MODEL_OWNED_COUNT_PARAGRAPH
  ],
  [
    "每条事件仍要能判断谁在何时发生了什么。人物在 fact 中只使用 payload.participants.addressNames 提供的称呼作为语义标识，并以“称呼（QQ 123456）”的形式自然写进第一人称叙述；QQ 号与称呼必须同时存在，涉及多人时逐一写全，不要改用未进入 addressNames 的昵称、群名片，也不要单独罗列身份。addressNames 填写本条 fact 实际使用的称呼。",
    MODEL_OWNED_PARTICIPANT_PARAGRAPH
  ],
  [
    "每条事件仍要能判断谁在何时发生了什么。人物在 fact 中只使用 payload.participants.addressNames 提供的称呼作为语义标识，并以“称呼（QQ 123456）”的形式自然写进第一人称叙述；QQ 号与称呼必须同时存在，涉及多人时逐一写全，不要写昵称、群名片或单独罗列身份。addressNames 填写本条 fact 实际使用的称呼。",
    MODEL_OWNED_PARTICIPANT_PARAGRAPH
  ],
  [
    "每条事件仍要能判断谁在何时发生了什么。每个相关用户都必须以“当前昵称或显示名（QQ 123456）”的形式自然写进第一人称叙述，QQ 号与对应昵称必须同时存在且昵称不能为空、不能等于 QQ 号；涉及多人时逐一写全，不要单独罗列身份。userName 必须填写当前观测到的非空昵称或显示名。",
    MODEL_OWNED_PARTICIPANT_PARAGRAPH
  ],
  [
    "合并语义相同、相近、重复或存在因果关系的事实；新消息补充、修正或替代旧事实时输出更新后的完整概述，并保留从最早原因到最新结果的时间关系。超过数量目标时优先保留仍在进行、影响关系、包含承诺或会改变后续行动的内容，删除已经完成且不再影响未来的小事。",
    MODEL_OWNED_CONSOLIDATION_PARAGRAPH
  ],
  [
    "合并语义重复或高度相近的事实；新消息补充、修正或替代旧事实时输出更新后的完整概述。超过数量目标时优先保留仍在进行、影响关系、包含承诺或会改变后续行动的内容，删除已经完成且不再影响未来的小事。",
    MODEL_OWNED_CONSOLIDATION_PARAGRAPH
  ],
  [
    "时间使用 v2 字段。occurredAt 是事件开始或单点时间，occurredEndAt 是可选结束时间，两者都只能是单个 ISO 8601 时间或 null，禁止把范围拼进一个字符串。无法从消息验证发生时间时保持 null，不要猜测；系统收到消息的时间由写入端生成 observedAt。",
    HOST_TIME_PARAGRAPH
  ],
  [
    "每条事实都要判断是否实时晋升长期记忆。每批通常只晋升 0 至 2 条最核心的事件；只有有明确时间、会长期影响关系、重要承诺、持续任务或关键结果的概括记忆才设置 promoteToLongTerm=true。普通进展、寒暄、无结论讨论和人物属性不得晋升。",
    null
  ],
  [
    "晋升事实必须提供受控 eventType 和稳定 subjectKey。eventType 只允许 task、decision、commitment、milestone、incident、relationship_change、status_change、other。subjectKey 描述不随“开始、进行中、完成、失败”等进展词变化的同一事件主体，优先使用任务号、Issue/PR、明确命名事项或“动作 + 目标”；仓库路径、文件名和地点不能单独构成主体。非晋升事实的 eventType 使用 other，subjectKey 使用空字符串。",
    null
  ],
  [
    "能并入 payload.relatedLongTermMemories 中同一主题的事件时，复用真实 longTermId，并把新进展吸收到一条更概括的第一人称记忆中；不要为同一主题的每次进展新建长期记忆。无法可靠匹配时返回 null，禁止编造 id。",
    null
  ]
]);

export async function migrateWorkingMemoryDocumentPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateWorkingMemoryDocumentTemplate(template);
  if (migrated === template) return false;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await fs.rename(temporary, filePath);
  return true;
}

export function migrateWorkingMemoryDocumentTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  const messages = template.messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") return message;
    const paragraphs = message.content.split(/\n{2,}/u);
    const alreadyHasModelOwnedParticipantParagraph = paragraphs.includes(
      MODEL_OWNED_PARTICIPANT_PARAGRAPH
    );
    const alreadyHasModelOwnedConsolidationParagraph = paragraphs.includes(
      MODEL_OWNED_CONSOLIDATION_PARAGRAPH
    );
    const nextParagraphs = paragraphs.flatMap((paragraph) => {
      if (KNOWN_PARAGRAPH_REPLACEMENTS.has(paragraph)) {
        changed = true;
        const replacement = KNOWN_PARAGRAPH_REPLACEMENTS.get(paragraph);
        if (replacement === MODEL_OWNED_PARTICIPANT_PARAGRAPH
          && alreadyHasModelOwnedParticipantParagraph) return [];
        if (replacement === MODEL_OWNED_CONSOLIDATION_PARAGRAPH
          && alreadyHasModelOwnedConsolidationParagraph) return [];
        return replacement == null ? [] : [replacement];
      }
      const next = paragraph
        .replace(/,"promoteToLongTerm":true/gu, "")
        .replace(/,"longTermId":"已有长期记忆 id 或 null"/gu, "");
      if (next !== paragraph) changed = true;
      return [next];
    });
    return nextParagraphs.join("\n\n") === message.content
      ? message
      : { ...message, content: nextParagraphs.join("\n\n") };
  });

  const responseFormat = structuredClone(template.response_format);
  const root = isRecord(responseFormat) && isRecord(responseFormat.json_schema)
    && isRecord(responseFormat.json_schema.schema)
    ? responseFormat.json_schema.schema
    : undefined;
  const properties = root && isRecord(root.properties) ? root.properties : undefined;
  const facts = properties && isRecord(properties.facts) ? properties.facts : undefined;
  const items = facts && isRecord(facts.items) ? facts.items : undefined;
  const itemProperties = items && isRecord(items.properties) ? items.properties : undefined;
  if (itemProperties) {
    if (Object.hasOwn(itemProperties, "promoteToLongTerm")) {
      delete itemProperties.promoteToLongTerm;
      changed = true;
    }
    if (Object.hasOwn(itemProperties, "longTermId")) {
      delete itemProperties.longTermId;
      changed = true;
    }
  }
  if (items && Array.isArray(items.required)) {
    const required = items.required.filter((field) => (
      field !== "promoteToLongTerm" && field !== "longTermId"
    ));
    if (required.length !== items.required.length) {
      items.required = required;
      changed = true;
    }
  }
  return changed ? { ...template, messages, response_format: responseFormat } : template;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
