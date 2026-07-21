import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../src/types.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "dream-schema-v2";

export async function migrateDreamSchemaPrompt(config: AppConfig, fileName: string) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(path.dirname(fileName), `.${path.basename(fileName)}.${MIGRATION_VERSION}`)
  );
  if (await readOptional(markerPath) === `${MIGRATION_VERSION}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateDreamSchemaTemplate(parseFinalPromptTemplate(content));
  if (migrated) await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  await atomicWriteText(markerPath, `${MIGRATION_VERSION}\n`);
  return Boolean(migrated);
}

export function migrateDreamSchemaTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  if (!containsUniqueItems(template.response_format)) return undefined;
  const migrated = structuredClone(template);
  removeUniqueItems(migrated.response_format);
  return migrated;
}

function containsUniqueItems(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUniqueItems);
  if (!isRecord(value)) return false;
  return Object.hasOwn(value, "uniqueItems") || Object.values(value).some(containsUniqueItems);
}

function removeUniqueItems(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(removeUniqueItems);
    return;
  }
  if (!isRecord(value)) return;
  delete value.uniqueItems;
  Object.values(value).forEach(removeUniqueItems);
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
