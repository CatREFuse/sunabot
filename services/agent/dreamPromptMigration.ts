import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  DREAM_CONTRACT,
  DREAM_RAW_IDENTITY_GUIDANCE,
  DREAM_OUTPUT_CONTRACT,
  DREAM_OUTPUT_CONTRACT_MARKER,
  LEGACY_DREAM_MINIMAL_OUTPUT_CONTRACT_MARKER,
  LEGACY_DREAM_REASONLESS_OUTPUT_CONTRACT_MARKER,
  LEGACY_DREAM_OUTPUT_CONTRACT_MARKER,
  LEGACY_DREAM_OUTPUT_CONTRACT_V6,
  LEGACY_DREAM_OUTPUT_CONTRACT_V7,
  LEGACY_DREAM_OUTPUT_CONTRACT_V8,
  LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE,
  LEGACY_DREAM_FLEX_RESPONSE,
  LEGACY_DREAM_CONTRACT_V3,
  LEGACY_DREAM_CONTRACT_V4,
  LEGACY_DREAM_CONTRACT_V6
} from "../memory/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "dream-flex-contract-v3";
const LEGACY_DREAM_VISIBLE_REASON_GUIDANCE =
  "再从事实工作记忆中提取会持续影响未来回复的新长期事实。payload.longTermMemories 只用于判断是否已经记录，不能提出改写、合并、归档、删除或遗忘。每次都要明确说明新增或零新增的原因。";
const DREAM_REASONLESS_LONG_TERM_GUIDANCE =
  "再从事实工作记忆中提取会持续影响未来回复的新长期事实。payload.longTermMemories 只用于判断是否已经记录，不能提出改写、合并、归档、删除或遗忘。";

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

export async function migrateDreamMinimalContractPrompt(config: AppConfig, fileName: string) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateDreamMinimalContractTemplate(template);
  const verified = migrated ?? template;
  assertDreamCanonicalOutputContractTemplate(verified);
  if (!migrated) return false;
  await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  return true;
}

export async function migrateDreamRawIdentityPrompt(config: AppConfig, fileName: string) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const migrated = migrateDreamRawIdentityTemplate(parseFinalPromptTemplate(content));
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

export function migrateDreamRawIdentityTemplate(
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
      || !message.content.includes(LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE)
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: message.content.replaceAll(
        LEGACY_DREAM_IDENTITY_ALIAS_GUIDANCE,
        DREAM_RAW_IDENTITY_GUIDANCE
      )
    };
  });
  return changed ? { ...template, messages } : undefined;
}

export function migrateDreamMinimalContractTemplate(
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
    let content = message.content;
    if (content.includes(LEGACY_DREAM_VISIBLE_REASON_GUIDANCE)) {
      content = content.replaceAll(
        LEGACY_DREAM_VISIBLE_REASON_GUIDANCE,
        DREAM_REASONLESS_LONG_TERM_GUIDANCE
      );
      changed = true;
    }
    for (const legacy of [
      LEGACY_DREAM_CONTRACT_V6,
      LEGACY_DREAM_CONTRACT_V4,
      LEGACY_DREAM_CONTRACT_V3
    ]) {
      if (!content.includes(legacy)) continue;
      content = content.replaceAll(legacy, DREAM_CONTRACT);
      changed = true;
    }
    const slotted = replaceLegacyDreamContractSlot(content);
    if (slotted !== content) {
      content = slotted;
      changed = true;
    }
    return content === message.content ? message : { ...message, content };
  });
  const staged = changed ? { ...template, messages } : template;
  const canonical = migrateDreamCanonicalOutputContractTemplate(staged);
  return canonical ?? (changed ? staged : undefined);
}

function replaceLegacyDreamContractSlot(content: string) {
  const starts = [
    "你负责在每日睡眠窗口结束时完成一次最小 Dream 记忆循环。",
    "你负责在每日睡眠窗口结束时整理当前角色的记忆",
    "你负责在每日睡眠窗口结束时整理当前角色的近期工作环境"
  ].map((opening) => content.indexOf(opening)).filter((offset) => offset >= 0);
  if (!starts.length) return content;
  const start = Math.min(...starts);
  const boundaries = [
    "<persona_soul>",
    "<persona_preference>",
    "<persona_user>",
    "<persona_relation>",
    DREAM_OUTPUT_CONTRACT_MARKER,
    LEGACY_DREAM_REASONLESS_OUTPUT_CONTRACT_MARKER,
    LEGACY_DREAM_MINIMAL_OUTPUT_CONTRACT_MARKER,
    LEGACY_DREAM_OUTPUT_CONTRACT_MARKER
  ].map((marker) => content.indexOf(marker, start)).filter((offset) => offset > start);
  if (!boundaries.length) return content;
  const end = Math.min(...boundaries);
  const slot = content.slice(start, end);
  if (
    slot.startsWith("你负责在每日睡眠窗口结束时完成一次最小 Dream 记忆循环。")
    && !slot.includes("payload.workingMemories")
    && !slot.includes("workingMemoryCompression.items")
    && !slot.includes("sourceWorkingMemoryIds")
  ) return content;
  return `${content.slice(0, start)}${DREAM_CONTRACT}\n\n${content.slice(end)}`;
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
    .reduce((count, content) => count
      + occurrenceCount(content, LEGACY_DREAM_FLEX_RESPONSE)
      + occurrenceCount(content, LEGACY_DREAM_OUTPUT_CONTRACT_V6)
      + occurrenceCount(content, LEGACY_DREAM_OUTPUT_CONTRACT_V7)
      + occurrenceCount(content, LEGACY_DREAM_OUTPUT_CONTRACT_V8), 0);
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
    .replaceAll(LEGACY_DREAM_OUTPUT_CONTRACT_V8, "")
    .replaceAll(LEGACY_DREAM_OUTPUT_CONTRACT_V7, "")
    .replaceAll(LEGACY_DREAM_OUTPUT_CONTRACT_V6, "")
    .replaceAll(LEGACY_DREAM_FLEX_RESPONSE, "");
  const markerOffsets = [
    DREAM_OUTPUT_CONTRACT_MARKER,
    LEGACY_DREAM_REASONLESS_OUTPUT_CONTRACT_MARKER,
    LEGACY_DREAM_MINIMAL_OUTPUT_CONTRACT_MARKER,
    LEGACY_DREAM_OUTPUT_CONTRACT_MARKER
  ].map((marker) => withoutKnownContracts.indexOf(marker)).filter((offset) => offset >= 0);
  const partialMarkerAt = markerOffsets.length ? Math.min(...markerOffsets) : -1;
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
  const hasLegacyContract = systemContents.some((content) =>
    content.includes(LEGACY_DREAM_FLEX_RESPONSE)
    || content.includes(LEGACY_DREAM_OUTPUT_CONTRACT_V6)
    || content.includes(LEGACY_DREAM_OUTPUT_CONTRACT_V7)
    || content.includes(LEGACY_DREAM_OUTPUT_CONTRACT_V8)
    || content.includes(LEGACY_DREAM_REASONLESS_OUTPUT_CONTRACT_MARKER)
    || content.includes(LEGACY_DREAM_MINIMAL_OUTPUT_CONTRACT_MARKER)
    || content.includes(LEGACY_DREAM_OUTPUT_CONTRACT_MARKER)
  );
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
