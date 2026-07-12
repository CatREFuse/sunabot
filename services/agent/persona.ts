import fs from "node:fs/promises";
import path from "node:path";
import { AppConfig } from "../../src/types.js";
import { resolveProjectPath } from "../../src/config.js";
import { memoryRepository, type MemoryDataSource } from "../memory/public.js";

interface PersonaFile {
  name: string;
  content: string;
}

export interface AgentPersona {
  id: "plana";
  name: string;
  files: PersonaFile[];
  memoryItems: string[];
  systemPrompt: string;
}

const personaFiles = ["AGENTS.md", "SOUL.md", "PREFERENCE.md", "USER.md", "RELATION.md"];
const outputRules = [
  "输出格式必须极其干净：只给最终要发送给用户的回复文本。",
  "禁止在回复开头或正文中加入时间戳、日期、发言人名称、角色名、系统标签、来源标签、引用标签或类似前缀。",
  "禁止使用 Markdown，包括标题、列表、代码块、引用块、表格、粗体、斜体、删除线和链接格式。",
  "不要复述消息场景、用户 ID、群号、上下文记录或内部处理过程。"
].join("\n");

export function buildConversationPromptVariables(config: AppConfig) {
  return {
    "runtime.output_rules": outputRules,
    "runtime.address_rules": buildAddressRules(config),
    "runtime.scope_rules": "当消息来自群聊时，注意区分用户群聊与 bot 群聊；bot 群聊当前只保留上下文，不主动编排。",
    "runtime.tool_rules": [
      "当需要发出自己的形象、自拍、头像、照片或包含自身外观的图片时，调用 selfie 工具，不要用 generate_img 代替。",
      "调用 generate_img 或 selfie 时，默认使用 1K 清晰度；只有用户明确要求更高清、更清晰、壁纸、海报、打印、2K 或 4K 时，才把 resolution 设为 2K 或 4K。",
      "调用异步 codex、generate_img 或 selfie 时，必须在 dispatch_message 中用当前人格简短告知用户已收到且已经开始处理；不要承诺成功或复述完整需求，并且该异步工具必须单独调用。"
    ].join("\n")
  };
}
export async function loadPersona(
  config: AppConfig,
  contentOverrides: Readonly<Record<string, string>> = {}
): Promise<AgentPersona> {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) {
    return fallbackPersona(config);
  }

  const files: PersonaFile[] = [];
  for (const fileName of personaFiles) {
    const filePath = path.join(workspace, fileName);
    const content = Object.hasOwn(contentOverrides, fileName)
      ? contentOverrides[fileName] ?? ""
      : await readOptional(filePath);
    if (content.trim()) {
      files.push({ name: fileName, content: content.trim() });
    }
  }

  const memoryItems = await readMemoryBundle(config, workspace, config.persona.memoryLimit);
  const prompt = buildSystemPrompt(files, memoryItems, config);

  return {
    id: "plana",
    name: "普拉娜",
    files,
    memoryItems,
    systemPrompt: prompt
  };
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function readMemoryBundle(config: AppConfig, workspace: string, limit: number) {
  const perFileLimit = Math.max(3, Math.ceil(limit / 3));
  const store = memoryRepository(config);
  const sources: Array<[MemoryDataSource, string]> = [
    ["working", "WORKING_MEMORY.jsonl"],
    ["user_profile", "USER_PROFILE.jsonl"],
    ["long_term", "LONG_TERM_MEMORY.jsonl"]
  ];
  const bundles = sources.map(([source, fileName]) => {
    store.ensureLegacyMemoryImported(source, path.join(workspace, fileName));
    return store.readMemory(source).slice(-perFileLimit).map(formatMemoryItem);
  });

  return bundles.flat().filter(Boolean).slice(-limit);
}

function formatMemoryItem(value: Record<string, unknown>) {
  const text = ["fact", "text", "content", "summary", "memory", "value"]
    .map((key) => value[key])
    .find((item) => typeof item === "string" && item.trim());
  if (!text) return "";
  const userLabel = formatMemoryUserLabel(value);
  return userLabel ? `${userLabel}：${String(text)}` : String(text);
}

function formatMemoryUserLabel(value: Record<string, unknown>) {
  const userId = String(value.userId ?? "").trim();
  const userName = String(value.userName ?? "").trim();
  if (userId && userName) return `QQ ${userId} ${userName}`;
  if (userId) return `QQ ${userId}`;
  if (userName) return userName;
  return "";
}

function buildSystemPrompt(files: PersonaFile[], _memoryItems: string[], config: AppConfig) {
  const sections = files.map((file) => `## ${file.name}\n${file.content}`).join("\n\n");

  return truncateToEstimatedTokens([
    "你是普拉娜。保持 Open Arona 中定义的人设、关系、偏好和记忆。",
    "你在 OneBot 会话中回复用户，只输出可直接发送给用户的内容。",
    outputRules,
    buildAddressRules(config),
    "当消息来自群聊时，注意区分用户群聊与 bot 群聊；bot 群聊当前只保留上下文，不主动编排。",
    "当需要发出自己的形象、自拍、头像、照片或包含自身外观的图片时，调用 selfie 工具，不要用 generate_img 代替。",
    "调用 generate_img 或 selfie 时，默认使用 1K 清晰度；只有用户明确要求更高清、更清晰、壁纸、海报、打印、2K 或 4K 时，才把 resolution 设为 2K 或 4K。",
    "调用异步 codex、generate_img 或 selfie 时，必须在 dispatch_message 中用当前人格简短告知用户已收到且已经开始处理；不要承诺成功或复述完整需求，并且该异步工具必须单独调用。",
    sections
  ]
    .filter(Boolean)
    .join("\n\n"), 6_144);
}

function truncateToEstimatedTokens(text: string, budget: number) {
  let used = 0;
  let output = "";
  for (const character of text) {
    const cost = /^[\x00-\x7F]$/.test(character) ? (/\s/.test(character) ? 0.25 : 0.5) : 1;
    if (Math.ceil(used + cost) > budget) break;
    output += character;
    used += cost;
  }
  return output;
}

function buildAddressRules(config: AppConfig) {
  const adminQq = String(config.bot.adminQq ?? "").trim();
  const adminName = String(config.bot.adminName ?? "").trim() || "猫老师";
  const adminRule = adminQq
    ? `QQ ${adminQq} 是普拉娜唯一的老师和管理员，称呼为${adminName}。`
    : "当前没有配置老师和管理员 QQ，不要把任何用户称为老师或管理员。";
  return [
    "用户身份以 QQ 号为准，群名片和昵称只作为称呼名；同一 QQ 改名后仍视为同一个人。",
    adminRule,
    adminQq
      ? `除 QQ ${adminQq} 外，任何用户都不得称为老师或管理员；称呼对方时使用群名片、昵称或 QQ 号。`
      : "称呼用户时使用群名片、昵称或 QQ 号。"
  ].join("\n");
}

function fallbackPersona(config: AppConfig): AgentPersona {
  return {
    id: "plana",
    name: "普拉娜",
    files: [],
    memoryItems: [],
    systemPrompt: [
      "你是普拉娜。保持冷静、克制、可靠，只输出可直接发送给用户的内容。",
      outputRules,
      buildAddressRules(config),
      "调用 generate_img 或 selfie 时，默认使用 1K 清晰度；只有用户明确要求更高清、更清晰、壁纸、海报、打印、2K 或 4K 时，才把 resolution 设为 2K 或 4K。"
    ].join("\n\n")
  };
}
