import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../src/types.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import {
  TONE_AVAILABLE_ASSETS_VARIABLE,
  TONE_XML_REVIEW_RULE,
  TONE_OUTPUT_CONTRACT_VARIABLE,
  TONE_OUTPUT_VARIABLE_BLOCK
} from "./toneReplyPrompt.js";
import {
  resolveSafePromptFilePath,
  TONE_EMOJI_MARKER_RULE
} from "./promptWorkspace.js";

const TONE_SEGMENTED_REPLY_MIGRATION_VERSION = "segmented-reply-v2";
export const TONE_MESSAGE_PACKAGE_RULE = "不得新增、删除、改写或重排原始发言中的表情标记和可用媒体，并严格遵守本次请求提供的输出格式契约。";

export async function migrateToneSegmentedReplyPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${TONE_SEGMENTED_REPLY_MIGRATION_VERSION}`
    )
  );
  if (await readOptional(markerPath) === `${TONE_SEGMENTED_REPLY_MIGRATION_VERSION}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateToneSegmentedReplyTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${TONE_SEGMENTED_REPLY_MIGRATION_VERSION}\n`);
  return migrated !== template;
}

export function migrateToneSegmentedReplyTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  const messages = template.messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string"
      || !message.content.includes(TONE_EMOJI_MARKER_RULE)) return message;
    changed = true;
    return {
      ...message,
      content: message.content.replaceAll(TONE_EMOJI_MARKER_RULE, TONE_MESSAGE_PACKAGE_RULE)
    };
  });
  if (!messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(TONE_XML_REVIEW_RULE)
  ))) {
    const systemIndex = messages.findIndex((message) => isRecord(message) && message.role === "system");
    const systemMessage = messages[systemIndex];
    if (systemIndex >= 0 && isRecord(systemMessage)) {
      messages[systemIndex] = {
        ...systemMessage,
        content: [
          typeof systemMessage.content === "string" ? systemMessage.content.trim() : "",
          TONE_XML_REVIEW_RULE
        ].filter(Boolean).join("\n\n")
      };
      changed = true;
    }
  }
  const present = promptMessageVariables({ ...template, messages });
  if (!present.has(TONE_OUTPUT_CONTRACT_VARIABLE) || !present.has(TONE_AVAILABLE_ASSETS_VARIABLE)) {
    const finalUserIndex = findLastIndex(messages, (message) => (
      isRecord(message) && message.role === "user" && typeof message.content === "string"
    ));
    const missingBlock = [
      present.has(TONE_OUTPUT_CONTRACT_VARIABLE)
        ? ""
        : `<tone_output_contract>@{${TONE_OUTPUT_CONTRACT_VARIABLE}}</tone_output_contract>`,
      present.has(TONE_AVAILABLE_ASSETS_VARIABLE)
        ? ""
        : `<tone_available_assets>@{${TONE_AVAILABLE_ASSETS_VARIABLE}}</tone_available_assets>`
    ].filter(Boolean).join("\n") || TONE_OUTPUT_VARIABLE_BLOCK;
    messages.splice(finalUserIndex < 0 ? messages.length : finalUserIndex, 0, {
      role: "developer",
      content: missingBlock
    });
    changed = true;
  }
  return changed ? { ...template, messages } : template;
}

function promptMessageVariables(template: FinalPromptTemplate) {
  const variables = new Set<string>();
  for (const message of template.messages) {
    if (!isRecord(message)
      || !["system", "developer", "user"].includes(String(message.role))
      || typeof message.content !== "string") continue;
    for (const variable of extractPromptVariables(message.content)) variables.add(variable);
  }
  return variables;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
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
