import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { parseFinalPromptTemplate, type FinalPromptTemplate } from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const LEGACY_BASH_TOOL_NAME = "workspace_bash";
const NATIVE_BASH_TOOL_NAME = "native_bash";
const DOCKER_BASH_TOOL_NAME = "docker_bash";

export async function migrateConversationBashToolsPrompt(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) return false;
  const migrated = migrateConversationBashToolsTemplate(
    parseFinalPromptTemplate(content),
    parseFinalPromptTemplate(canonicalContent)
  );
  if (!migrated) return false;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
  return true;
}

export function migrateConversationBashToolsTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const canonicalTools = new Map(
    (canonical.tools ?? [])
      .filter((tool) => tool.function.name === NATIVE_BASH_TOOL_NAME || tool.function.name === DOCKER_BASH_TOOL_NAME)
      .map((tool) => [tool.function.name, tool])
  );
  const canonicalDocker = canonicalTools.get(DOCKER_BASH_TOOL_NAME);
  if (!canonicalDocker) throw new Error("Canonical conversation prompt is missing docker_bash.");

  const migratedTools = [] as NonNullable<FinalPromptTemplate["tools"]>;
  let legacyDescription: string | undefined;
  let changed = false;
  for (const tool of template.tools ?? []) {
    if (tool.function.name === LEGACY_BASH_TOOL_NAME) {
      legacyDescription ||= tool.function.description;
      changed = true;
      continue;
    }
    if (tool.function.name === NATIVE_BASH_TOOL_NAME || tool.function.name === DOCKER_BASH_TOOL_NAME) {
      if (migratedTools.some((entry) => entry.function.name === tool.function.name)) {
        changed = true;
        continue;
      }
    }
    migratedTools.push(tool);
  }

  if (!migratedTools.some((tool) => tool.function.name === DOCKER_BASH_TOOL_NAME)) {
    migratedTools.push(withDescription(canonicalDocker, legacyDescription));
    changed = true;
  }
  const canonicalNative = canonicalTools.get(NATIVE_BASH_TOOL_NAME);
  if (canonicalNative && !migratedTools.some((tool) => tool.function.name === NATIVE_BASH_TOOL_NAME)) {
    const dockerIndex = migratedTools.findIndex((tool) => tool.function.name === DOCKER_BASH_TOOL_NAME);
    migratedTools.splice(Math.max(0, dockerIndex), 0, structuredClone(canonicalNative));
    changed = true;
  }
  if (!canonicalNative) {
    const filtered = migratedTools.filter((tool) => tool.function.name !== NATIVE_BASH_TOOL_NAME);
    if (filtered.length !== migratedTools.length) changed = true;
    if (changed) return { ...template, tools: filtered };
  }
  return changed ? { ...template, tools: migratedTools } : undefined;
}

function withDescription(
  tool: NonNullable<FinalPromptTemplate["tools"]>[number],
  description: string | undefined
) {
  const cloned = structuredClone(tool);
  if (description?.trim()) cloned.function.description = description;
  return cloned;
}
