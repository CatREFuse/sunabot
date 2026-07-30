import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

export const CONVERSATION_MESSAGE_32_MIGRATION_VERSION = "conversation-message-32-v1";

const LEGACY_HISTORY_SLOT = "@{messages_64}";
const CURRENT_HISTORY_SLOT = "@{message_32}";
const HISTORY_VARIABLES = new Set([
  "messages_64",
  "message_32",
  "conversation.messages"
]);
const LEGACY_GROUP_HISTORY_DESCRIPTION =
  "messages_64 是本轮注入窗口内当前消息之前最近最多 64 条完整原始群聊消息，数组顺序就是原始时间顺序。不得删除、替换或重排原始消息。";
const CURRENT_GROUP_HISTORY_DESCRIPTION =
  "message_32 是本轮注入窗口内当前消息之前最近最多 32 条完整原始群聊消息，数组顺序就是原始时间顺序。不得删除、替换或重排原始消息。";
const LEGACY_GROUP_TOPIC_REASONING =
  "生成回复前，在内部按 messages_64 的原始顺序梳理并行话题，结合紧邻消息、发送者、时间与 reply_to_message_id 判断当前输入延续、切换或连接的话题，再据此组织本轮回复。";
const CURRENT_GROUP_TOPIC_REASONING =
  "生成回复前，在内部按 message_32 的原始顺序梳理并行话题，结合紧邻消息、发送者、时间与 reply_to_message_id 判断当前输入延续、切换或连接的话题，再据此组织本轮回复。";

export async function migrateConversationMessage32Prompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${CONVERSATION_MESSAGE_32_MIGRATION_VERSION}`
    )
  );
  if (
    await readOptional(markerPath)
      === `${CONVERSATION_MESSAGE_32_MIGRATION_VERSION}\n`
  ) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationMessage32Template(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(
    markerPath,
    `${CONVERSATION_MESSAGE_32_MIGRATION_VERSION}\n`
  );
  return migrated !== template;
}

export function migrateConversationMessage32Template(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  const historySlots = template.messages.flatMap((message, index) => {
    const variable = standaloneVariableName(message);
    return variable && HISTORY_VARIABLES.has(variable) ? [{ index, variable }] : [];
  });
  if (
    historySlots.length !== 1
    || historySlots[0]?.variable !== "messages_64"
    || template.messages[historySlots[0].index] !== LEGACY_HISTORY_SLOT
  ) return template;

  const legacyIndex = historySlots[0].index;
  const messages = template.messages.map((message, index) => {
    if (index === legacyIndex) return CURRENT_HISTORY_SLOT;
    if (
      typeof message !== "object"
      || message == null
      || typeof message.content !== "string"
      || !message.content.includes("<group_context_contract>")
    ) return message;
    const content = migrateKnownGroupContract(message.content);
    return content === message.content ? message : { ...message, content };
  });
  return { ...template, messages };
}

function standaloneVariableName(message: FinalPromptTemplate["messages"][number]) {
  if (typeof message !== "string") return undefined;
  const match = message.trim().match(
    /^(?:@\{\s*([A-Za-z_][\w.-]*)\s*\}|\{\{\s*([A-Za-z_][\w.-]*)\s*\}\})$/u
  );
  return match?.[1] ?? match?.[2];
}

function migrateKnownGroupContract(content: string) {
  return content.replace(
    /<group_context_contract>([\s\S]*?)<\/group_context_contract>/gu,
    (contract) => contract
      .replace(LEGACY_GROUP_HISTORY_DESCRIPTION, CURRENT_GROUP_HISTORY_DESCRIPTION)
      .replace(LEGACY_GROUP_TOPIC_REASONING, CURRENT_GROUP_TOPIC_REASONING)
  );
}

async function readOptional(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

async function atomicWriteText(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
