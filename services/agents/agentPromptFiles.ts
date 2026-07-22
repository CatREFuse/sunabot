import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_LAYOUT, workspaceRelativeReference } from "../../packages/platform/workspaceLayout.js";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  defaultPromptContent,
  PROMPT_FILE_DEFINITIONS,
  resolveSafePromptFilePath
} from "../agent/public.js";
import type { AgentManifest } from "./agentRegistry.js";

type ConfigProjector = (shared: AppConfig, manifest: AgentManifest) => AppConfig;

export function sharedSystemPromptConfig(config: AppConfig): AppConfig {
  return {
    ...structuredClone(config),
    persona: {
      ...structuredClone(config.persona),
      systemPromptWorkspace: workspaceRelativeReference(WORKSPACE_LAYOUT.systemPrompts),
      systemPromptOverride: false
    }
  };
}

export async function ensureSharedSystemPrompts(config: AppConfig, workspace: string) {
  const sharedConfig = sharedSystemPromptConfig(config);
  sharedConfig.persona.systemPromptWorkspace = path.join(workspace, WORKSPACE_LAYOUT.systemPrompts);
  const defaultWorkspace = path.join(workspace, WORKSPACE_LAYOUT.defaultAgent);
  await Promise.all(PROMPT_FILE_DEFINITIONS.filter((definition) => definition.scope === "system").map(async (definition) => {
    const fileName = definition.fileName(sharedConfig);
    const destination = await resolveSafePromptFilePath(sharedConfig, "system", fileName);
    const legacy = defaultWorkspace ? path.resolve(defaultWorkspace, fileName) : "";
    const content = await readOptionalText(legacy) || defaultPromptContent(definition.id, config.persona.name);
    await writeIfMissing(destination, content);
  }));
}

export async function ensureAgentSystemPromptOverrides(
  shared: AppConfig,
  manifest: AgentManifest,
  agentDirectory: string,
  projectConfig: ConfigProjector,
  directory?: string
) {
  if (directory) {
    const overrideConfig = projectConfig(shared, { ...manifest, prompts: { overrideSystem: true } });
    await Promise.all(PROMPT_FILE_DEFINITIONS.filter((definition) => definition.scope === "system").map((definition) => (
      writeIfMissing(
        path.join(directory, "system-prompts", definition.fileName(overrideConfig)),
        defaultPromptContent(definition.id, manifest.name)
      )
    )));
    return;
  }
  const inheritedConfig = projectConfig(shared, { ...manifest, prompts: { overrideSystem: false } });
  const overrideConfig = projectConfig(shared, { ...manifest, prompts: { overrideSystem: true } });
  inheritedConfig.persona.systemPromptWorkspace = path.join(
    path.resolve(agentDirectory, "../.."),
    WORKSPACE_LAYOUT.systemPrompts
  );
  overrideConfig.persona.systemPromptWorkspace = path.join(agentDirectory, "system-prompts");
  await Promise.all(PROMPT_FILE_DEFINITIONS.filter((definition) => definition.scope === "system").map(async (definition) => {
    const fileName = definition.fileName(overrideConfig);
    const destination = await resolveSafePromptFilePath(overrideConfig, "system", fileName);
    const legacy = path.resolve(agentDirectory, fileName);
    const inherited = await resolveSafePromptFilePath(
      inheritedConfig,
      "system",
      definition.fileName(inheritedConfig)
    );
    const content = await readOptionalText(legacy)
      || await readOptionalText(inherited)
      || defaultPromptContent(definition.id, manifest.name);
    await writeIfMissing(destination, content);
  }));
}

export async function writeIfMissing(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(filePath, `${content.trim()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function readOptionalText(filePath: string) {
  if (!filePath) return "";
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
