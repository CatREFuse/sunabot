import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";
import { CONFIGURATION_DIRECTORY_INDEX_CONTRACT } from "./bashWorkbenchPromptMigration.js";

const LEGACY_CHAT_MEDIA_CONTRACT_MARKER = '<chat_media_export_contract version="1">';
const LEGACY_CHAT_MEDIA_CONTRACT_V2_MARKER = '<chat_media_export_contract version="2">';
const LEGACY_CHAT_MEDIA_CONTRACT_V3_MARKER = '<chat_media_export_contract version="3">';
const LEGACY_CHAT_MEDIA_CONTRACT_V4_MARKER = '<chat_media_export_contract version="4">';
const CHAT_MEDIA_CONTRACT_MARKER = '<chat_media_export_contract version="5">';

export const CHAT_MEDIA_EXPORT_CONTRACT = [
  CHAT_MEDIA_CONTRACT_MARKER,
  "当前消息和明确引用消息中的图片、文件会以 `message:<message-id>:image:<index>` 或 `message:<message-id>:file:<index>` 媒体句柄显示。需要保存原始媒体时，只能把提示词中原样出现的句柄传给 `export_chat_media`；不得猜测、改写或把句柄当作路径、URL、Base64、下载地址。",
  "`export_chat_media` 只解析本轮当前 Agent、当前消息及其明确引用消息实际提供的媒体；工具不可用或返回句柄不可用时，停止尝试通过 Bash、联网工具或任意 URL 获取原件。导出结果返回当前 Agent 唯一 Workbench 下的相对路径、SHA-256、MIME、扩展名、宽高和字节数。",
  "`import_chat_emoji` 和 `import_chat_selfie` 仅在本轮实际提供对应工具的当前 Agent 管理员 QQ 私聊或群聊中可用。导入时传入原样媒体句柄，以及表情 key 或自拍备注，由工具完成格式校验、内容寻址、去重及对应 JSONL 的原子更新；所有会话都写入当前 Agent 的唯一 Workbench。",
  "当前 Agent 的 `workbench/` 是唯一资源根，其中 `emoji/emojis.jsonl`、`selfie/references.jsonl`、`skills/index.json` 和 `knowledge/index.json` 分别是固定管理入口。运行时和管理 API 只读取这一套资源；Skill 只有经过仓库审查并发布到 `workbench/skills/` 后才可激活。",
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
  const legacyMarker = [
    LEGACY_CHAT_MEDIA_CONTRACT_V4_MARKER,
    LEGACY_CHAT_MEDIA_CONTRACT_V3_MARKER,
    LEGACY_CHAT_MEDIA_CONTRACT_V2_MARKER,
    LEGACY_CHAT_MEDIA_CONTRACT_MARKER
  ].find((marker) => messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(marker)
  ))) ?? LEGACY_CHAT_MEDIA_CONTRACT_MARKER;
  const legacyIndex = messages.findIndex((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(legacyMarker)
  ));
  if (legacyIndex >= 0) {
    const message = messages[legacyIndex] as Record<string, unknown> & { content: string };
    messages[legacyIndex] = {
      ...message,
      content: replaceContractBlock(
        message.content,
        legacyMarker,
        "</chat_media_export_contract>",
        CHAT_MEDIA_EXPORT_CONTRACT
      )
    } as FinalPromptTemplate["messages"][number];
    return { ...template, messages };
  }

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

function replaceContractBlock(
  content: string,
  startMarker: string,
  endMarker: string,
  replacement: string
) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start < 0) return content;
  if (end < 0) return `${content.trimEnd()}\n\n${replacement}`;
  return `${content.slice(0, start)}${replacement}${content.slice(end + endMarker.length)}`;
}

async function atomicWriteText(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
