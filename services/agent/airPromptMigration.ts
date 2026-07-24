import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { AIR_PERSONA_VARIABLE } from "../air/public.js";
import { READ_AIR_TOOL_NAME } from "../tools/public.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate,
  type OpenAIToolDefinition
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "read-air-v1";

export async function migrateConversationAirPrompt(
  config: AppConfig,
  fileName: string,
  canonicalContent: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(path.dirname(fileName), `.${path.basename(fileName)}.${MIGRATION_VERSION}`)
  );
  if (await readOptional(markerPath) === `${MIGRATION_VERSION}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateConversationAirTemplate(
    parseFinalPromptTemplate(content),
    parseFinalPromptTemplate(canonicalContent)
  );
  if (migrated) await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  await atomicWriteText(markerPath, `${MIGRATION_VERSION}\n`);
  return Boolean(migrated);
}

export function migrateConversationAirTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const hasKnowledge = extractPromptVariables(JSON.stringify(template)).includes(AIR_PERSONA_VARIABLE);
  const hasTool = template.tools?.some((tool) => tool.function.name === READ_AIR_TOOL_NAME) === true;
  if (hasKnowledge && hasTool) return undefined;

  const messages = [...template.messages];
  if (!hasKnowledge) {
    const currentInputIndex = messages.findIndex((message) => (
      typeof message === "object"
      && message != null
      && !Array.isArray(message)
      && message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("@{user.input}")
    ));
    const finalUserIndex = findLastIndex(messages, (message) => (
      typeof message === "object"
      && message != null
      && !Array.isArray(message)
      && message.role === "user"
      && typeof message.content === "string"
    ));
    const userIndex = currentInputIndex >= 0 ? currentInputIndex : finalUserIndex;
    if (userIndex < 0) throw new Error("Conversation prompt is missing its user message.");
    const user = messages[userIndex] as Record<string, unknown>;
    const field = `<air_knowledge>@{${AIR_PERSONA_VARIABLE}}</air_knowledge>`;
    messages[userIndex] = {
      ...user,
      content: `${field}\n\n${String(user.content).trimStart()}`
    };
  }
  const canonicalTool = canonical.tools?.find((tool) => tool.function.name === READ_AIR_TOOL_NAME);
  if (!canonicalTool) throw new Error("Canonical conversation prompt is missing read_air.");
  const tools: OpenAIToolDefinition[] = hasTool
    ? [...(template.tools ?? [])]
    : [...(template.tools ?? []), structuredClone(canonicalTool)];
  return { ...template, messages, tools };
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] as T)) return index;
  }
  return -1;
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
