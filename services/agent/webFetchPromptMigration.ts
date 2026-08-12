import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const WEBFETCH_TOOL_NAME = "webfetch";
const CONVERSATION_WEBFETCH_MIGRATION_VERSION = "webfetch-v2";

export async function migrateConversationWebFetchPrompt(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${CONVERSATION_WEBFETCH_MIGRATION_VERSION}`
    )
  );
  if (await readOptional(markerPath) === `${CONVERSATION_WEBFETCH_MIGRATION_VERSION}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateConversationWebFetchTemplate(
    parseFinalPromptTemplate(content),
    parseFinalPromptTemplate(canonicalContent)
  );
  if (migrated !== undefined) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${CONVERSATION_WEBFETCH_MIGRATION_VERSION}\n`);
  return migrated !== undefined;
}

export function migrateConversationWebFetchTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const canonicalTool = canonical.tools?.find((tool) => tool.function.name === WEBFETCH_TOOL_NAME);
  if (!canonicalTool) throw new Error("Canonical conversation prompt is missing webfetch.");
  const tools = [...(template.tools ?? [])];
  const index = tools.findIndex((tool) => tool.function.name === WEBFETCH_TOOL_NAME);
  if (index >= 0) {
    const current = tools[index]!;
    if (
      JSON.stringify(current.function.parameters) === JSON.stringify(canonicalTool.function.parameters)
      && current.function.strict === canonicalTool.function.strict
    ) return undefined;
    tools[index] = {
      ...current,
      function: {
        ...current.function,
        parameters: structuredClone(canonicalTool.function.parameters),
        ...(canonicalTool.function.strict == null ? {} : { strict: canonicalTool.function.strict })
      }
    };
    return { ...template, tools };
  }
  return {
    ...template,
    tools: [...tools, structuredClone(canonicalTool)]
  };
}

async function readOptional(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

async function atomicWriteText(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}
