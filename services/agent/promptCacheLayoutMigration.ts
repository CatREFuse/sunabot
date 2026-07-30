import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "cache-layout-v1";

interface DynamicBlock {
  variables: readonly string[];
  role: "developer" | "user";
}

const DYNAMIC_BLOCKS: readonly DynamicBlock[] = [
  {
    variables: ["conversation.emoji.keys", "conversation.emoji.syntax"],
    role: "developer"
  },
  {
    variables: ["conversation.voice.settings", "conversation.voice.trigger_policy"],
    role: "developer"
  },
  {
    variables: ["conversation.director.schedule"],
    role: "developer"
  },
  {
    variables: ["conversation.group.orchestrator_result"],
    role: "developer"
  },
  {
    variables: ["persona.air"],
    role: "user"
  },
  {
    variables: ["memory.working"],
    role: "user"
  },
  {
    variables: ["memory.long_term"],
    role: "user"
  },
  {
    variables: ["memory.user_profile"],
    role: "user"
  }
] as const;

const DYNAMIC_VARIABLES = new Set(DYNAMIC_BLOCKS.flatMap((block) => block.variables));

export async function migrateConversationPromptCacheLayout(
  config: AppConfig,
  fileName: string
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
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateConversationPromptCacheLayoutTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${MIGRATION_VERSION}\n`);
  return migrated !== template;
}

export function migrateConversationPromptCacheLayoutTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  const extracted = DYNAMIC_BLOCKS.map(() => [] as string[]);
  const messages: FinalPromptTemplate["messages"] = [];

  for (const message of template.messages) {
    if (!isPromptMessage(message)) {
      messages.push(message);
      continue;
    }
    const retained: string[] = [];
    for (const paragraph of splitParagraphs(message.content)) {
      const variables = extractPromptVariables(paragraph);
      const dynamicIndexes = variables
        .map((variable) => dynamicBlockIndex(variable))
        .filter((index): index is number => index >= 0);
      const containsOnlyMovableVariables = dynamicIndexes.length > 0
        && variables.every((variable) => DYNAMIC_VARIABLES.has(variable));
      if (!containsOnlyMovableVariables) {
        retained.push(paragraph);
        continue;
      }
      extracted[Math.min(...dynamicIndexes)]?.push(paragraph);
    }
    if (retained.length > 0) {
      messages.push({ ...message, content: retained.join("\n\n") });
    }
  }

  if (!extracted.some((paragraphs) => paragraphs.length > 0)) return template;

  const currentInputIndex = messages.findIndex((message) => (
    isPromptMessage(message)
    && message.role === "user"
    && extractPromptVariables(message.content).includes("user.input")
  ));
  const finalUserIndex = findLastIndex(messages, (message) => (
    isPromptMessage(message) && message.role === "user"
  ));
  const anchorIndex = currentInputIndex >= 0 ? currentInputIndex : finalUserIndex;
  if (anchorIndex < 0) return template;

  const anchor = messages[anchorIndex];
  if (!anchor || !isPromptMessage(anchor)) return template;
  const developerMessages = DYNAMIC_BLOCKS.flatMap((block, index) => (
    block.role === "developer" && extracted[index]?.length
      ? [{ role: "developer", content: extracted[index].join("\n\n") }]
      : []
  ));
  const userParagraphs = DYNAMIC_BLOCKS.flatMap((block, index) => (
    block.role === "user" ? extracted[index] ?? [] : []
  ));
  const migratedMessages = [
    ...messages.slice(0, anchorIndex),
    ...developerMessages,
    {
      ...anchor,
      content: [...userParagraphs, anchor.content].filter(Boolean).join("\n\n")
    },
    ...messages.slice(anchorIndex + 1)
  ];
  if (JSON.stringify(migratedMessages) === JSON.stringify(template.messages)) return template;
  return { ...template, messages: migratedMessages };
}

function dynamicBlockIndex(variable: string) {
  return DYNAMIC_BLOCKS.findIndex((block) => block.variables.includes(variable));
}

function splitParagraphs(content: string) {
  return content
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function isPromptMessage(
  value: FinalPromptTemplate["messages"][number]
): value is Record<string, unknown> & { role: string; content: string } {
  return typeof value === "object"
    && value != null
    && !Array.isArray(value)
    && typeof value.role === "string"
    && typeof value.content === "string";
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
