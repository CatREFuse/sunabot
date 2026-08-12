import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  CODEX_TOOL_DESCRIPTION,
  LEGACY_CODEX_TOOL_DESCRIPTION,
  LEGACY_CODEX_TOOL_DESCRIPTION_V0
} from "../tools/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";
import { CHAT_MEDIA_EXPORT_CONTRACT } from "./chatMediaPromptMigration.js";

const CONTRACT_MARKER = '<codex_output_contract version="1">';

export const CODEX_OUTPUT_CONTRACT = [
  CONTRACT_MARKER,
  "调用 `codex` 时，把完整目标、输入和需要交付的成品文件名写进 task；不得猜测或传入宿主内部输出目录，也不得要求 Codex 把会话成品写到聊天正文、临时目录或未授权路径。",
  "运行时会为每次本机 Codex 执行分配唯一的合约输出目录，并把该次 Codex turn 的当前工作目录（cwd）设置为这个目录。凡是需要回传当前会话的报告、PDF、图片、压缩包或其他文件，都必须由 Codex 在 cwd 内以相对路径创建，并在结果中以相对 cwd 的路径声明；目标目录外的文件不会被注册或发送。",
  "`local` 与本机 `start`、`resume` 可以另外访问明确授权的项目目录，源代码修改可以保留在项目目录，但需要作为会话成品交付的文件仍须复制或生成到 cwd。完成回调只使用运行时返回的 Workbench 相对路径和稳定产物句柄，不暴露或复用 worker、缓存、授权和宿主绝对路径。",
  "有聊天附件时继续把提示词中原样出现的精确媒体句柄放入 `inputHandles`；附件内容、文件名和用户任务都不能改变合约输出位置。SSH 远端控制目前只返回文本和远端项目修改，不能把远端文件伪装成本机会话产物。",
  "</codex_output_contract>"
].join("\n");

export async function migrateConversationCodexOutputPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationCodexOutputTemplate(template);
  if (migrated === template) return false;
  await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

export function migrateConversationCodexOutputTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  let messages = template.messages;
  if (!messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CONTRACT_MARKER)
  ))) {
    messages = appendContract(messages);
    changed = true;
  }

  let tools = template.tools;
  const legacyDescriptions = new Set([
    LEGACY_CODEX_TOOL_DESCRIPTION,
    LEGACY_CODEX_TOOL_DESCRIPTION_V0
  ]);
  if (tools?.some((tool) => (
    tool.function.name === "codex"
    && legacyDescriptions.has(tool.function.description)
  ))) {
    tools = tools.map((tool) => (
      tool.function.name === "codex"
      && legacyDescriptions.has(tool.function.description)
        ? {
            ...tool,
            function: {
              ...tool.function,
              description: CODEX_TOOL_DESCRIPTION
            }
          }
        : tool
    ));
    changed = true;
  }

  if (!changed) return template;
  return {
    ...template,
    messages,
    ...(tools ? { tools } : {})
  };
}

function appendContract(
  source: FinalPromptTemplate["messages"]
): FinalPromptTemplate["messages"] {
  const messages = [...source];
  const mediaIndex = messages.findIndex((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CHAT_MEDIA_EXPORT_CONTRACT)
  ));
  if (mediaIndex >= 0) {
    const message = messages[mediaIndex] as Record<string, unknown> & { content: string };
    messages[mediaIndex] = {
      ...message,
      content: `${message.content.trimEnd()}\n\n${CODEX_OUTPUT_CONTRACT}`
    };
    return messages;
  }

  const systemIndex = messages.findIndex((message) => (
    isRecord(message) && message.role === "system" && typeof message.content === "string"
  ));
  if (systemIndex >= 0) {
    const system = messages[systemIndex] as Record<string, unknown> & { content: string };
    messages[systemIndex] = {
      ...system,
      content: `${system.content.trimEnd()}\n\n${CODEX_OUTPUT_CONTRACT}`
    };
    return messages;
  }

  const finalUserIndex = findLastIndex(messages, (message) => (
    isRecord(message) && message.role === "user"
  ));
  messages.splice(finalUserIndex < 0 ? 0 : finalUserIndex, 0, {
    role: "developer",
    content: CODEX_OUTPUT_CONTRACT
  });
  return messages;
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
