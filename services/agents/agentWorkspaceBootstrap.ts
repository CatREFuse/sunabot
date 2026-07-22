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
  return [...fragments, ...finalPrompts];
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
