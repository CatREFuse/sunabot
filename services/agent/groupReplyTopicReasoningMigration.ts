import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import { DEFAULT_GROUP_CONTEXT_CONTRACT } from "./groupReplyPrompt.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

export async function migrateGroupReplyTopicReasoning(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    `.${path.basename(fileName)}.topic-reasoning-v1`
  );
  if (await readOptional(markerPath)) return false;

  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateGroupReplyTopicReasoningTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, "topic-reasoning-v1\n");
  return migrated !== template;
}

export function migrateGroupReplyTopicReasoningTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  let hasContract = false;
  const messages: FinalPromptTemplate["messages"] = [];
  for (const message of template.messages) {
    if (typeof message === "string" || typeof message.content !== "string") {
      messages.push(message);
      continue;
    }
    let content = message.content
      .replace(/<thread_context>[\s\S]*?<\/thread_context>/gu, "")
      .replace(/@\{conversation\.group\.thread_context\}/gu, "")
      .replace(/\{\{\s*conversation\.group\.thread_context\s*\}\}/gu, "");
    if (content !== message.content) changed = true;
    if (content.includes("<group_context_contract>")) {
      const next = content.replace(
        /<group_context_contract>[\s\S]*?<\/group_context_contract>/gu,
        `<group_context_contract>${DEFAULT_GROUP_CONTEXT_CONTRACT}</group_context_contract>`
      );
      if (next !== content) changed = true;
      content = next;
      hasContract = true;
    }
    content = content.replace(/\n{3,}/gu, "\n\n").trim();
    if (!content) {
      changed = true;
      continue;
    }
    messages.push(content === message.content ? message : { ...message, content });
  }
  if (!hasContract) {
    const systemIndex = messages.findIndex((message) => (
      typeof message === "object" && message.role === "system" && typeof message.content === "string"
    ));
    const block = `<group_context_contract>${DEFAULT_GROUP_CONTEXT_CONTRACT}</group_context_contract>`;
    if (systemIndex < 0) {
      messages.unshift({ role: "system", content: block });
    } else {
      const message = messages[systemIndex]!;
      if (typeof message !== "string") {
        messages[systemIndex] = { ...message, content: `${message.content}\n\n${block}` };
      }
    }
    changed = true;
  }
  return changed ? { ...template, messages } : template;
}

async function readOptional(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWriteText(filePath: string, content: string) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}
