import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";
import { CONFIGURATION_DIRECTORY_INDEX_CONTRACT } from "./bashWorkbenchPromptMigration.js";

const CHAT_MEDIA_CONTRACT_MARKER = '<chat_media_export_contract version="1">';

export const CHAT_MEDIA_EXPORT_CONTRACT = [
  CHAT_MEDIA_CONTRACT_MARKER,
  "当前消息和明确引用消息中的图片、文件会以 `message:<message-id>:image:<index>` 或 `message:<message-id>:file:<index>` 媒体句柄显示。需要保存原始媒体时，只能把提示词中原样出现的句柄传给 `export_chat_media`；不得猜测、改写或把句柄当作路径、URL、Base64、下载地址。",
  "`export_chat_media` 只解析本轮当前 Agent、当前消息及其明确引用消息实际提供的媒体；工具不可用或返回句柄不可用时，停止尝试通过 Bash、联网工具或任意 URL 获取原件。导出结果返回相对 Workbench 路径、SHA-256、MIME、扩展名、宽高和字节数；Native Bash 直接使用返回路径，Docker Bash 通过只读 `native-workbench/<返回路径>` 读取。",
  "`import_chat_emoji` 仅在本轮实际提供该工具的管理员 QQ 私聊中可用。导入时传入原样媒体句柄和表情 key，由工具完成格式校验、哈希命名、去重及 `emojis.jsonl` 原子更新；不得用 Bash 直接修改表情图片或目录清单。普通私聊和群聊只能在实际提供 `export_chat_media` 时导出到 Workbench。",
  "媒体句柄和提示词规则不能扩大本轮工具实际授予的 Agent、会话、消息、路径或写入权限。",
  "</chat_media_export_contract>"
].join("\n");

export async function migrateConversationChatMediaPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationChatMediaTemplate(template);
  if (migrated === template) return false;
  await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

export function migrateConversationChatMediaTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (template.messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CHAT_MEDIA_CONTRACT_MARKER)
  ))) return template;

  const messages = [...template.messages];
  const indexedContract = messages.findIndex((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CONFIGURATION_DIRECTORY_INDEX_CONTRACT)
  ));
  if (indexedContract >= 0) {
    const message = messages[indexedContract] as Record<string, unknown> & { content: string };
    messages[indexedContract] = {
      ...message,
      content: `${message.content.trimEnd()}\n\n${CHAT_MEDIA_EXPORT_CONTRACT}`
    } as FinalPromptTemplate["messages"][number];
    return { ...template, messages };
  }

  const systemIndex = messages.findIndex((message) => (
    isRecord(message) && message.role === "system" && typeof message.content === "string"
  ));
  if (systemIndex >= 0) {
    const system = messages[systemIndex] as { role: string; content: string };
    messages[systemIndex] = {
      ...system,
      content: `${system.content.trimEnd()}\n\n${CHAT_MEDIA_EXPORT_CONTRACT}`
    };
  } else {
    const finalUserIndex = findLastIndex(messages, (message) => (
      isRecord(message) && message.role === "user"
    ));
    messages.splice(finalUserIndex < 0 ? 0 : finalUserIndex, 0, {
      role: "developer",
      content: CHAT_MEDIA_EXPORT_CONTRACT
    });
  }
  return { ...template, messages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

async function atomicWriteText(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
