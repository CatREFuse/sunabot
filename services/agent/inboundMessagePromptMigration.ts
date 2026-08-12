import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { INBOUND_MESSAGE_INTERPRETATION_CONTRACT } from "./inboundMessagePrompt.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const MIGRATION_VERSION = "inbound-message-v1";
const CONTRACT_MARKER = '<inbound_message_contract version="1">';

export async function migrateConversationInboundMessagePrompt(
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
  const migrated = migrateConversationInboundMessageTemplate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${MIGRATION_VERSION}\n`);
  return migrated !== template;
}

export function migrateConversationInboundMessageTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  if (template.messages.some((message) => (
    isRecord(message)
    && typeof message.content === "string"
    && message.content.includes(CONTRACT_MARKER)
  ))) return template;

  const messages = [...template.messages];
  const systemIndex = messages.findIndex((message) => (
    isRecord(message) && message.role === "system" && typeof message.content === "string"
  ));
  if (systemIndex >= 0) {
    const system = messages[systemIndex] as { role: string; content: string };
    messages[systemIndex] = {
      ...system,
      content: `${system.content.trimEnd()}\n\n${INBOUND_MESSAGE_INTERPRETATION_CONTRACT}`
    };
  } else {
    const currentInputIndex = messages.findIndex((message) => (
      isRecord(message)
      && message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("@{user.input}")
    ));
    messages.splice(currentInputIndex < 0 ? 0 : currentInputIndex, 0, {
      role: "developer",
      content: INBOUND_MESSAGE_INTERPRETATION_CONTRACT
    });
  }
  return { ...template, messages };
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
