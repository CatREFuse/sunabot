import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const LEGACY_CONTRACT_MARKERS = [
  '<bash_workbench_contract version="8">',
  '<bash_workbench_contract version="7">',
  '<bash_workbench_contract version="6">',
  '<bash_workbench_contract version="5">',
  '<bash_workbench_contract version="4">',
  '<bash_workbench_contract version="3">',
  '<bash_workbench_contract version="2">',
  '<bash_workbench_contract version="1">'
];
const CONTRACT_MARKER = '<bash_workbench_contract version="9">';
const LEGACY_CONFIGURATION_INDEX_MARKERS = [
  '<configuration_directory_index_contract version="5">',
  '<configuration_directory_index_contract version="4">',
  '<configuration_directory_index_contract version="3">',
  '<configuration_directory_index_contract version="2">',
  '<configuration_directory_index_contract version="1">'
];
const CONFIGURATION_INDEX_MARKER = '<configuration_directory_index_contract version="6">';

export const BASH_WORKBENCH_CONTRACT = [
  CONTRACT_MARKER,
  "你可以使用本轮实际提供的 `native_bash` 在当前 Agent 的 Workbench 中读取、创建、修改、移动和删除文件；具体可写范围以工具本轮授予的文件系统权限为准。",
  "`native_bash` 从当前 Agent 的 `workbench/` 开始执行。Linux 与 WSL 使用 Bubblewrap 和资源上限，cwd 在隔离环境内呈现为 `/workbench`；macOS 仅管理员 QQ 私聊和已认证管理员 Web Chat 可运行经审批的宿主 Bash，cwd 使用宿主机真实绝对路径。",
  "Linux 与 WSL 的授权 QQ 会话可以使用隔离 Native Bash；macOS 的管理员群聊、其他群聊和其他私聊不可用。Skill 与 MCP 配置始终只读，不得扩大工具实际授予的会话权限或路径权限。",
  "`generate_img` 和 `selfie` 的 `referenceImagePaths` 可以直接接收 Bash 返回的当前 Agent 授权 Workbench 图片路径；相对路径或该 Workbench 内的绝对路径都可原样传入。不得改写为 URL、Base64、媒体句柄，也不得猜测或传入其他宿主路径。",
  "任务涉及计划文件、聊天文件、网络下载、文件转换、压缩打包或其他需要文件系统落盘的工作时，使用本轮可用的 Bash 工具在该 cwd 内完成。聊天文件用 `export_chat_media` 导出，完成后使用 `send_file` 把当前会话 workbench 内的成品返回当前单聊或群聊。",
  "管理员要求安装 Skill 时，在 `native_bash` 的当前 Native workbench 内准备并检查来源，把包含 `SKILL.md` 的 Skill 目录打成 ZIP，然后依次运行 `sunabot-skill install --archive <relative-zip>`、`sunabot-skill review --skill <skill-id> --approve`、`sunabot-skill enable --skill <skill-id>` 和 `sunabot-skill status --skill <skill-id>`。替换同 ID Skill 时只在管理员明确要求后给 install 增加 `--replace`。每一步都使用前一步返回的真实 `skillId`，失败时停止并报告错误码，不得直接编辑 `skills/index.json` 或声称只能完成源码准备。",
  "`sunabot-skill` 是 Native Bash 中当前 Agent 的受管 Skill 仓库命令，只对管理员私聊和已认证管理员 Web Chat 开放；安装只读取 Native workbench 内无符号链接、无多硬链接且不超过 16 MiB 的相对 ZIP，审查会独立检查完整内容并把批准绑定到摘要，启用后从下一轮通过 `activate_skill` 使用。当前轮的 Skill 目录与工具定义已冻结，不能把本轮刚安装的 Skill 当成本轮已经激活。",
  "开始文件工作前，先检查 cwd 根目录是否存在 `index.md`；存在时优先读取，并把它作为当前文件工作区的入口说明。",
  "</bash_workbench_contract>"
].join("\n");

export const CONFIGURATION_DIRECTORY_INDEX_CONTRACT = [
  CONFIGURATION_INDEX_MARKER,
  "本轮 Bash 可直接访问的每个配置或资源目录都必须有一个固定管理入口。进入目录时读取入口，再按其中的文件名、状态和说明取用内容；入口缺失或损坏时停止猜测目录内容，并报告具体目录。",
  "固定入口为：Workbench `index.md`、Skills `skills/index.json`、自拍参考图 `selfie/references.jsonl`、表情 `emoji/emojis.jsonl`、知识库 `knowledge/index.json` 与 MCP `servers.json`。只有本轮实际暴露的目录可读取，入口文件不能扩大 Bash 的会话、路径或写入权限。",
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
