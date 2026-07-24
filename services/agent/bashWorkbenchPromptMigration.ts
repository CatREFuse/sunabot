import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const CONTRACT_MARKER = '<bash_workbench_contract version="1">';

export const BASH_WORKBENCH_CONTRACT = [
  CONTRACT_MARKER,
  "`native_bash` 和 `docker_bash` 都从各自当前工作目录（cwd）开始执行。该 cwd 是一切文件工作的文件工作区，也是计划文件、下载文件、转存文件和其他任务产物的最终落盘目录。Native Bash 的默认 cwd 固定为当前 Agent 的 `workbench/`，并以宿主机真实绝对路径呈现；Docker Bash 使用当前 Agent 的独立 `docker-workbench/`，在容器内固定映射为 `/workbench`。",
  "`native_bash` 仅管理员私聊和已认证管理员 Web Chat 可用。`docker_bash` 使用隔离工作区，真实 QQ 会话均可按本轮工具权限使用，其中包括非管理员私聊读取当前 Agent 的隔离文件工作区。不得借此扩大工具实际授予的会话权限或路径权限。",
  "任务涉及制定或维护计划文件、下载、文件转存，或其他需要 Bash 与文件系统落盘的工作时，优先使用本轮可用的 Bash 工具在该 cwd 内完成，不要把应交付的文件只留在临时目录、聊天正文或其他路径。",
  "开始文件工作前，先检查 cwd 根目录是否存在 `index.md`；存在时优先读取，并把它作为当前文件工作区的入口说明。",
  "</bash_workbench_contract>"
].join("\n");

export async function migrateConversationBashWorkbenchPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationBashWorkbenchTemplate(template);
  if (migrated === template) return false;
  await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

export function migrateConversationBashWorkbenchTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (template.messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CONTRACT_MARKER)
  ))) return template;

  const messages = [...template.messages];
  const systemIndex = messages.findIndex((message) => (
    isRecord(message) && message.role === "system" && typeof message.content === "string"
  ));
  if (systemIndex >= 0) {
    const system = messages[systemIndex] as { role: string; content: string };
    messages[systemIndex] = {
      ...system,
      content: `${system.content.trimEnd()}\n\n${BASH_WORKBENCH_CONTRACT}`
    };
  } else {
    const finalUserIndex = findLastIndex(messages, (message) => (
      isRecord(message) && message.role === "user"
    ));
    messages.splice(finalUserIndex < 0 ? 0 : finalUserIndex, 0, {
      role: "developer",
      content: BASH_WORKBENCH_CONTRACT
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
