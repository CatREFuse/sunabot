import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  defaultGenericSelfiePromptContent,
  defaultPromptContent,
  PROMPT_FILE_DEFINITIONS
} from "../agent/public.js";
import type { AgentManifest } from "./agentRegistry.js";
import { DEFAULT_DIRECTOR_SEED } from "../director/public.js";
import { DEFAULT_AIR_KNOWLEDGE } from "../air/public.js";
import { WORKING_MEMORY_FILE, renderWorkingMemoryMarkdown } from "../memory/public.js";
import { AGENT_RESOURCE_LAYOUT } from "../../packages/platform/agentResourceLayout.js";

const WORKBENCH_INDEX = [
  "# 文件工作区",
  "",
  "本目录用于保存当前 Agent 的计划、下载、转存文件和任务产物。",
  "",
  "当前工作区的配置与资料目录：",
  "",
  "- `selfie/`：自拍参考图，入口 `references.jsonl`。",
  "- `emoji/`：表情，入口 `emojis.jsonl`。",
  "- `skills/`：Skills，入口 `index.json`。",
  "- `knowledge/`：知识库，入口 `index.json`。",
  "",
  "进入目录后先读取对应管理入口。入口缺失、损坏或引用不存在时停止猜测，并报告具体目录。",
  "",
  "Docker Bash 在 `native-workbench/` 中只读访问本目录；Native Bash 可通过环境变量 `SUNABOT_DOCKER_WORKBENCH` 寻址独立 Docker 工作区。",
  ""
].join("\n");
const DOCKER_WORKBENCH_INDEX = [
  "# Docker 文件工作区",
  "",
  "本目录用于保存 Docker Bash 的计划、下载、转存文件和任务产物。",
  "",
  "本工作区拥有独立的配置与资料目录：",
  "",
  "- `selfie/`：自拍参考图，入口 `references.jsonl`。",
  "- `emoji/`：表情，入口 `emojis.jsonl`。",
  "- `skills/`：Skills，入口 `index.json`。",
  "- `knowledge/`：知识库，入口 `index.json`。",
  "",
  "Native workbench 只读投影位于 `native-workbench/`，其中包含另一套同名目录和入口。",
  "",
  "进入目录后先读取当前目录的管理入口；需要同时取用两套资源时，再读取 `native-workbench/` 下的对应入口。只读投影不可修改。",
  ""
].join("\n");
const EMPTY_EXTENSION_REVISION = createHash("sha256").update("[]").digest("hex");

export function initialAgentWorkspaceFiles(
  config: AppConfig,
  manifest: AgentManifest
): Array<readonly [string, string]> {
  const fragments = Object.entries(initialPersonaFiles(manifest.name));
  const finalPrompts = PROMPT_FILE_DEFINITIONS.filter((definition) => (
    definition.scope === "persona" && definition.kind === "final"
  )).map((definition) => [
    definition.fileName(config),
    definition.id === "image.selfie-rewrite" && manifest.id !== config.persona.defaultAgentId
      ? defaultGenericSelfiePromptContent()
      : defaultPromptContent(definition.id, manifest.name)
  ] as const);
  return [
    ...fragments,
    [WORKING_MEMORY_FILE, renderWorkingMemoryMarkdown([])] as const,
    [`${AGENT_RESOURCE_LAYOUT.workbench}/index.md`, WORKBENCH_INDEX] as const,
    [`${AGENT_RESOURCE_LAYOUT.dockerWorkbench}/index.md`, DOCKER_WORKBENCH_INDEX] as const,
    [`${AGENT_RESOURCE_LAYOUT.selfie}/references.jsonl`, ""] as const,
    [`${AGENT_RESOURCE_LAYOUT.emoji}/emojis.jsonl`, ""] as const,
    [`${AGENT_RESOURCE_LAYOUT.skills}/index.json`, `${JSON.stringify({
      schemaVersion: 1,
      revision: EMPTY_EXTENSION_REVISION,
      skills: []
    }, null, 2)}\n`] as const,
    [`${AGENT_RESOURCE_LAYOUT.knowledge}/index.json`, `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      root: "knowledge",
      documents: [],
      fileCount: 0,
      chunkCount: 0,
      errorCount: 0,
      indexedAt: manifest.createdAt
    }, null, 2)}\n`] as const,
    [`${AGENT_RESOURCE_LAYOUT.dockerSelfie}/references.jsonl`, ""] as const,
    [`${AGENT_RESOURCE_LAYOUT.dockerEmoji}/emojis.jsonl`, ""] as const,
    [`${AGENT_RESOURCE_LAYOUT.dockerSkills}/index.json`, `${JSON.stringify({
      schemaVersion: 1,
      revision: EMPTY_EXTENSION_REVISION,
      skills: []
    }, null, 2)}\n`] as const,
    [`${AGENT_RESOURCE_LAYOUT.dockerKnowledge}/index.json`, `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      root: "knowledge",
      documents: [],
      fileCount: 0,
      chunkCount: 0,
      errorCount: 0,
      indexedAt: manifest.createdAt
    }, null, 2)}\n`] as const,
    [`${AGENT_RESOURCE_LAYOUT.mcp}/servers.json`, `${JSON.stringify({
      schemaVersion: 1,
      revision: EMPTY_EXTENSION_REVISION,
      servers: []
    }, null, 2)}\n`] as const,
    ...finalPrompts
  ];
}

export async function ensureAccountRuntimeDirectories(workspace: string, accountId: string) {
  const root = path.join(workspace, WORKSPACE_LAYOUT.napcatAccounts, accountId);
  await Promise.all(["config-full", "qq", "plugins"].map((segment) => (
    fs.mkdir(path.join(root, segment), { recursive: true, mode: 0o700 })
  )));
}

export async function migrateLegacyPrimaryAccountRuntime(workspace: string) {
  const target = path.join(workspace, WORKSPACE_LAYOUT.napcatAccounts, "primary");
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const mappings: Array<readonly [string, string]> = [
    [path.join(workspace, WORKSPACE_LAYOUT.legacyNapcatConfig), path.join(target, "config-full")],
    [path.join(workspace, WORKSPACE_LAYOUT.legacyNapcatQqState), path.join(target, "qq")],
    [path.join(workspace, WORKSPACE_LAYOUT.legacyNapcatPlugins), path.join(target, "plugins")],
    [path.join(workspace, WORKSPACE_LAYOUT.legacyNapcatQrCode), path.join(target, "qrcode.png")],
    [path.join(workspace, WORKSPACE_LAYOUT.legacyNapcatManualLogin), path.join(target, "manual-login-required")]
  ];
  for (const [source, destination] of mappings) {
    try {
      await fs.cp(source, destination, { recursive: true, errorOnExist: false, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function inferPrimaryAccountQqId(workspace: string) {
  const configDirectory = path.join(workspace, WORKSPACE_LAYOUT.napcatAccounts, "primary", "config-full");
  try {
    const candidates = new Set((await fs.readdir(configDirectory)).flatMap((fileName) => {
      const match = /^(?:onebot11|napcat)_(\d{5,20})\.json$/.exec(fileName);
      return match?.[1] ? [match[1]] : [];
    }));
    return candidates.size === 1 ? [...candidates][0] : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function initialPersonaFiles(name: string) {
  return {
    "AGENTS.md": `你是${name}。回复必须是可以直接发送给用户的成品内容。\n`,
    "SOUL.md": `${name}会保持稳定的人格、语气和身份。\n`,
    "PREFERENCE.md": `${name}遵守当前 Agent 的偏好和边界。\n`,
    "DIALOGUE_STYLE_EXAMPLES.md": [
      "# 对话风格示例",
      "",
      "生成回复时必须严格遵从以下示例的语气、句式、节奏、用词和情绪强度。",
      "",
      "用户：你好。",
      `${name}：你好，请告诉我需要处理什么。`,
      ""
    ].join("\n"),
    "USER.md": `${name}根据当前对话和用户画像称呼用户。\n`,
    "RELATION.md": `${name}只使用工作区中明确记录的关系。\n`,
    "AIR.md": DEFAULT_AIR_KNOWLEDGE,
    "DIRECTOR_SEED.md": DEFAULT_DIRECTOR_SEED
  };
}
