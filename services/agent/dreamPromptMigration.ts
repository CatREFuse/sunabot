import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  DREAM_CONTRACT,
  DREAM_OUTPUT_CONTRACT,
  DREAM_OUTPUT_CONTRACT_MARKER,
  LEGACY_DREAM_FLEX_RESPONSE,
  LEGACY_DREAM_CONTRACT_V3,
  LEGACY_DREAM_CONTRACT_V4
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

export async function migrateDreamCanonicalOutputContractPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateDreamCanonicalOutputContractTemplate(template);
  const verified = migrated ?? template;
  assertDreamCanonicalOutputContractTemplate(verified);
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
    ) {
      return message;
    }
    const content = message.content;
    const legacy = [LEGACY_DREAM_CONTRACT_V4, LEGACY_DREAM_CONTRACT_V3]
      .find((contract) => content.includes(contract));
    if (!legacy) return message;
    changed = true;
    return {
      ...message,
      content: content.replace(legacy, DREAM_CONTRACT)
    };
  });
  return changed ? { ...template, messages } : undefined;
}

export function migrateDreamCanonicalOutputContractTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate | undefined {
  const systemContents = template.messages.flatMap((message) => (
    typeof message === "object"
    && message != null
    && !Array.isArray(message)
    && message.role === "system"
    && typeof message.content === "string"
      ? [message.content] : []
  ));
  if (systemContents.length === 0) {
    throw new Error("Dream prompt requires a system message for the output contract.");
  }
  const fullContractCount = systemContents
    .reduce((count, content) => count + occurrenceCount(content, DREAM_OUTPUT_CONTRACT), 0);
  const markerCount = systemContents
    .reduce((count, content) => count + occurrenceCount(content, DREAM_OUTPUT_CONTRACT_MARKER), 0);
  const legacyCount = systemContents
    .reduce((count, content) => count + occurrenceCount(content, LEGACY_DREAM_FLEX_RESPONSE), 0);
  if (
    systemContents[0]!.includes(DREAM_OUTPUT_CONTRACT)
    && fullContractCount === 1
    && markerCount === 1
    && legacyCount === 0
  ) {
    return undefined;
  }
  let appended = false;
  const messages = template.messages.map((message) => {
    if (
      typeof message !== "object"
      || message == null
      || Array.isArray(message)
      || message.role !== "system"
      || typeof message.content !== "string"
    ) {
      return message;
    }
    const preserved = stripDreamCanonicalOutputContract(message.content);
    if (appended) {
      return preserved === message.content
        ? message
        : { ...message, content: preserved.trimEnd() };
    }
    appended = true;
    const firstContent = preserved.trimEnd();
    return {
      ...message,
      content: firstContent
        ? `${firstContent}\n\n${DREAM_OUTPUT_CONTRACT}`
        : DREAM_OUTPUT_CONTRACT
    };
  });
  return { ...template, messages };
}

function stripDreamCanonicalOutputContract(content: string) {
  const withoutKnownContracts = content
    .replaceAll(DREAM_OUTPUT_CONTRACT, "")
    .replaceAll(LEGACY_DREAM_FLEX_RESPONSE, "");
  const partialMarkerAt = withoutKnownContracts.indexOf(DREAM_OUTPUT_CONTRACT_MARKER);
  return partialMarkerAt < 0
    ? withoutKnownContracts
    : withoutKnownContracts.slice(0, partialMarkerAt);
}

export function assertDreamCanonicalOutputContractTemplate(
  template: FinalPromptTemplate
) {
  const systemContents = template.messages
    .flatMap((message) => (
      typeof message === "object"
      && message != null
      && !Array.isArray(message)
      && message.role === "system"
      && typeof message.content === "string"
        ? [message.content]
        : []
    ));
  const fullContractCount = systemContents
    .reduce((count, content) => count + occurrenceCount(content, DREAM_OUTPUT_CONTRACT), 0);
  const markerCount = systemContents
    .reduce((count, content) => count + occurrenceCount(content, DREAM_OUTPUT_CONTRACT_MARKER), 0);
  const hasLegacyContract = systemContents.some((content) => content.includes(LEGACY_DREAM_FLEX_RESPONSE));
  if (fullContractCount !== 1 || markerCount !== 1 || hasLegacyContract) {
    throw new Error("Dream prompt output contract is incomplete.");
  }
}

function occurrenceCount(content: string, needle: string) {
  return content.split(needle).length - 1;
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
