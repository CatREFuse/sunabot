import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../src/types.js";
import {
  CALL_DIRECTOR_TOOL_NAME
} from "../tools/public.js";
import { DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE } from "../director/public.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate,
  type OpenAIToolDefinition
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "director-daily-v1";
const SCHEMA_MIGRATION_VERSION = "director-schema-v2";

export async function migrateDirectorScheduleSchemaPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(path.dirname(fileName), `.${path.basename(fileName)}.${SCHEMA_MIGRATION_VERSION}`)
  );
  if (await readOptional(markerPath) === `${SCHEMA_MIGRATION_VERSION}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateDirectorScheduleSchemaTemplate(parseFinalPromptTemplate(content));
  if (migrated) await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  await atomicWriteText(markerPath, `${SCHEMA_MIGRATION_VERSION}\n`);
  return Boolean(migrated);
}

export function migrateDirectorScheduleSchemaTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const participants = directorParticipantsSchema(template);
  if (!participants || !Object.hasOwn(participants, "uniqueItems")) return undefined;
  const migrated = structuredClone(template);
  delete directorParticipantsSchema(migrated)!.uniqueItems;
  return migrated;
}

export async function migrateConversationDirectorPrompt(
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
  const migrated = migrateConversationDirectorTemplate(
    parseFinalPromptTemplate(content),
    parseFinalPromptTemplate(canonicalContent)
  );
  if (migrated) await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  await atomicWriteText(markerPath, `${MIGRATION_VERSION}\n`);
  return Boolean(migrated);
}

export function migrateConversationDirectorTemplate(
  template: FinalPromptTemplate,
  canonical: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const hasSchedule = extractPromptVariables(JSON.stringify(template))
    .includes(DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE);
  const hasTool = template.tools?.some((tool) => tool.function.name === CALL_DIRECTOR_TOOL_NAME) === true;
  if (hasSchedule && hasTool) return undefined;

  const messages = [...template.messages];
  if (!hasSchedule) {
    const currentInputIndex = messages.findIndex((message) => (
      typeof message === "object"
      && message.role === "user"
      && typeof message.content === "string"
      && extractPromptVariables(message.content).includes("user.input")
    ));
    const insertionIndex = currentInputIndex >= 0 ? currentInputIndex : messages.length;
    messages.splice(insertionIndex, 0, {
      role: "developer",
      content: `<daily_schedule>@{${DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE}}</daily_schedule>`
    });
  }
  const canonicalTool = canonical.tools?.find((tool) => tool.function.name === CALL_DIRECTOR_TOOL_NAME);
  if (!canonicalTool) throw new Error("Canonical conversation prompt is missing call_director.");
  const tools: OpenAIToolDefinition[] = hasTool
    ? [...(template.tools ?? [])]
    : [...(template.tools ?? []), structuredClone(canonicalTool)];
  return { ...template, messages, tools };
}

function directorParticipantsSchema(template: FinalPromptTemplate) {
  let current: unknown = template.response_format;
  for (const key of [
    "json_schema", "schema", "properties", "items", "items", "properties", "participants"
  ]) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
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
