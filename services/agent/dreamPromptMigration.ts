import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  DREAM_CONTRACT,
  LEGACY_DREAM_CONTRACT_V3
} from "../memory/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "dream-flex-contract-v3";

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

export async function migrateDreamMemoryContractPrompt(config: AppConfig, fileName: string) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateDreamMemoryContractTemplate(parseFinalPromptTemplate(content));
  if (!migrated) return false;
  await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

export function migrateDreamSchemaTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  if (template.response_format.type === "text") return undefined;
  const migrated = structuredClone(template);
  migrated.response_format = { type: "text" };
  return migrated;
}

export function migrateDreamMemoryContractTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  let changed = false;
  const messages = template.messages.map((message) => {
    if (
      typeof message !== "object"
      || message == null
      || Array.isArray(message)
      || message.role !== "system"
      || typeof message.content !== "string"
      || !message.content.includes(LEGACY_DREAM_CONTRACT_V3)
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: message.content.replace(LEGACY_DREAM_CONTRACT_V3, DREAM_CONTRACT)
    };
  });
  return changed ? { ...template, messages } : undefined;
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
