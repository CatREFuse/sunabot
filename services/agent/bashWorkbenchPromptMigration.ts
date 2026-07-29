import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const LEGACY_CONTRACT_MARKERS = [
  '<bash_workbench_contract version="6">',
  '<bash_workbench_contract version="5">',
  '<bash_workbench_contract version="4">',
  '<bash_workbench_contract version="3">',
  '<bash_workbench_contract version="2">',
  '<bash_workbench_contract version="1">'
];
const CONTRACT_MARKER = '<bash_workbench_contract version="7">';
const LEGACY_CONFIGURATION_INDEX_MARKERS = [
  '<configuration_directory_index_contract version="4">',
  '<configuration_directory_index_contract version="3">',
  '<configuration_directory_index_contract version="2">',
  '<configuration_directory_index_contract version="1">'
];
const CONFIGURATION_INDEX_MARKER = '<configuration_directory_index_contract version="5">';

export const BASH_WORKBENCH_CONTRACT = [
  CONTRACT_MARKER,
  "你可以使用本轮实际提供的 `native_bash` 或 `docker_bash` 在当前 Agent 的 Workbench 中读取、创建、修改、移动和删除文件；具体可写范围以工具本轮授予的后端和文件系统权限为准。",
  "`native_bash` 和 `docker_bash` 都从各自当前工作目录（cwd）开始执行。Native Bash 的默认 cwd 固定为当前 Agent 的 `workbench/`，并以宿主机真实绝对路径呈现；环境变量 `SUNABOT_DOCKER_WORKBENCH` 指向同一 Agent 的独立 `docker-workbench/`，两处都属于可寻址工作区。Docker Bash 的 cwd 是 `docker-workbench/`，在容器内固定映射为 `/workbench`；Native workbench 以整体只读投影映射到 `/workbench/native-workbench`，也可由 `SUNABOT_NATIVE_WORKBENCH` 寻址。",
  "`native_bash` 仅管理员私聊和已认证管理员 Web Chat 可用。`docker_bash` 使用隔离工作区，真实 QQ 会话均可按本轮工具权限使用；它可以在 `/workbench` 内读取、创建、修改、移动和删除文件，也可以从网络下载业务所需文件，但 Native workbench 投影、Skill 和 MCP 始终只读，且不能访问 Docker socket 或其他宿主路径。不得借此扩大工具实际授予的会话权限或路径权限。",
  "`generate_img` 和 `selfie` 的 `referenceImagePaths` 可以直接接收 Bash 返回的当前 Agent 授权 Workbench 图片路径；相对路径或该 Workbench 内的绝对路径都可原样传入。Native Bash 使用宿主真实绝对路径，Docker Bash 使用 `/workbench/...`，Native 只读投影使用 `/workbench/native-workbench/...`。不得改写为 URL、Base64、媒体句柄，也不得猜测或传入其他宿主路径。",
  "任务涉及制定或维护计划文件、聊天文件、网络下载、文件转换、压缩打包或其他需要文件系统落盘的工作时，优先使用本轮可用的 Bash 工具在该 cwd 内完成。聊天文件先用 `export_chat_media` 导出，Docker Bash 如需修改则从 `native-workbench/` 复制到 `/workbench`；完成后使用 `send_file` 把当前会话 workbench 内的成品返回当前单聊或群聊，不要把应交付的文件只留在临时目录、聊天正文或其他路径。",
  "开始文件工作前，先检查 cwd 根目录是否存在 `index.md`；存在时优先读取，并把它作为当前文件工作区的入口说明。",
  "</bash_workbench_contract>"
].join("\n");

export const CONFIGURATION_DIRECTORY_INDEX_CONTRACT = [
  CONFIGURATION_INDEX_MARKER,
  "本轮 Bash 可直接访问的每个配置或资源目录都必须有一个固定管理入口。进入目录后先读取入口，再按其中的文件名、状态和说明取用内容；入口缺失或损坏时停止猜测目录内容，并报告具体目录。",
  "固定入口为：两个工作目录各自的 `index.md`，以及两套独立的 Skills `skills/index.json`、自拍参考图 `selfie/references.jsonl`、表情 `emoji/emojis.jsonl`、知识库 `knowledge/index.json`；MCP 入口仍是 `servers.json`。Native Bash 从 `workbench/` 直接寻址 Native 资源，并通过 `SUNABOT_DOCKER_WORKBENCH` 寻址 Docker 资源；Docker Bash 从 `/workbench` 寻址 Docker 资源，并从只读 `native-workbench/` 寻址 Native 资源。运行时同时取用两套表情、自拍和知识入口，管理 API 可选择目标 Workbench；Skill 激活仍要求 Native `workbench/skills/` 内经过审查的仓库记录。只有本轮实际暴露的目录才可读取，入口文件不能扩大 Bash 的会话、路径或写入权限。",
  "</configuration_directory_index_contract>"
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
  const legacyIndex = messages.findIndex((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && LEGACY_CONTRACT_MARKERS.some((marker) => (
      (message as { content: string }).content.includes(marker)
    ))
  ));
  if (legacyIndex >= 0) {
    const message = messages[legacyIndex] as Record<string, unknown> & { content: string };
    const marker = LEGACY_CONTRACT_MARKERS.find((candidate) => message.content.includes(candidate))!;
    messages[legacyIndex] = {
      ...message,
      content: replaceContractBlock(
        message.content,
        marker,
        "</bash_workbench_contract>",
        BASH_WORKBENCH_CONTRACT
      )
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

export async function migrateConversationConfigurationIndexPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationConfigurationIndexTemplate(template);
  if (migrated === template) return false;
  await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

export function migrateConversationConfigurationIndexTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (template.messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CONFIGURATION_INDEX_MARKER)
  ))) return template;

  const messages = [...template.messages];
  const legacyIndex = messages.findIndex((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && LEGACY_CONFIGURATION_INDEX_MARKERS.some((marker) => (
      (message as { content: string }).content.includes(marker)
    ))
  ));
  if (legacyIndex >= 0) {
    const message = messages[legacyIndex] as Record<string, unknown> & { content: string };
    const marker = LEGACY_CONFIGURATION_INDEX_MARKERS.find((candidate) => message.content.includes(candidate))!;
    messages[legacyIndex] = {
      ...message,
      content: replaceContractBlock(
        message.content,
        marker,
        "</configuration_directory_index_contract>",
        CONFIGURATION_DIRECTORY_INDEX_CONTRACT
      )
    } as FinalPromptTemplate["messages"][number];
    return { ...template, messages };
  }
  const contractIndex = messages.findIndex((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CONTRACT_MARKER)
  ));
  if (contractIndex >= 0) {
    const message = messages[contractIndex] as Record<string, unknown> & { content: string };
    messages[contractIndex] = {
      ...message,
      content: `${message.content.trimEnd()}\n\n${CONFIGURATION_DIRECTORY_INDEX_CONTRACT}`
    } as FinalPromptTemplate["messages"][number];
  } else {
    const systemIndex = messages.findIndex((message) => (
      isRecord(message) && message.role === "system" && typeof message.content === "string"
    ));
    if (systemIndex >= 0) {
      const system = messages[systemIndex] as { role: string; content: string };
      messages[systemIndex] = {
        ...system,
        content: `${system.content.trimEnd()}\n\n${CONFIGURATION_DIRECTORY_INDEX_CONTRACT}`
      };
    } else {
      const finalUserIndex = findLastIndex(messages, (message) => (
        isRecord(message) && message.role === "user"
      ));
      messages.splice(finalUserIndex < 0 ? 0 : finalUserIndex, 0, {
        role: "developer",
        content: CONFIGURATION_DIRECTORY_INDEX_CONTRACT
      });
    }
  }
  return { ...template, messages };
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
