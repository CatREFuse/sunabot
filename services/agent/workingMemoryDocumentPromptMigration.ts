import fs from "node:fs/promises";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

export async function migrateWorkingMemoryDocumentPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const content = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrateWorkingMemoryDocumentTemplate(template);
  if (migrated === template) return false;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await fs.rename(temporary, filePath);
  return true;
}

export function migrateWorkingMemoryDocumentTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  const messages = template.messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") return message;
    const paragraphs = message.content.split(/\n{2,}/u);
    const nextParagraphs = paragraphs.flatMap((paragraph) => {
      if (
        paragraph.includes("实时晋升长期记忆")
        || paragraph.includes("晋升事实必须提供")
        || paragraph.includes("能并入 payload.relatedLongTermMemories")
      ) {
        changed = true;
        return [];
      }
      if (
        paragraph.startsWith("时间使用 v2 字段。")
        && !paragraph.includes("每项持久化记录时间、IANA 时区和会话来源均由宿主生成")
      ) {
        changed = true;
        return [
          "时间使用 v2 字段。occurredAt 是正文表达的事件开始或单点时间，occurredEndAt 是可选结束时间，两者都只能是单个 ISO 8601 时间或 null，禁止把范围拼进一个字符串。无法从消息验证发生时间时保持 null，不要猜测。每项持久化记录时间、IANA 时区和会话来源均由宿主生成，不能在 fact 或其他字段中伪造。"
        ];
      }
      const next = paragraph
        .replace(/,"promoteToLongTerm":true/gu, "")
        .replace(/,"longTermId":"已有长期记忆 id 或 null"/gu, "");
      if (next !== paragraph) changed = true;
      return [next];
    });
    return nextParagraphs.join("\n\n") === message.content
      ? message
      : { ...message, content: nextParagraphs.join("\n\n") };
  });

  const responseFormat = structuredClone(template.response_format);
  const root = isRecord(responseFormat) && isRecord(responseFormat.json_schema)
    && isRecord(responseFormat.json_schema.schema)
    ? responseFormat.json_schema.schema
    : undefined;
  const properties = root && isRecord(root.properties) ? root.properties : undefined;
  const facts = properties && isRecord(properties.facts) ? properties.facts : undefined;
  const items = facts && isRecord(facts.items) ? facts.items : undefined;
  const itemProperties = items && isRecord(items.properties) ? items.properties : undefined;
  if (itemProperties) {
    if (Object.hasOwn(itemProperties, "promoteToLongTerm")) {
      delete itemProperties.promoteToLongTerm;
      changed = true;
    }
    if (Object.hasOwn(itemProperties, "longTermId")) {
      delete itemProperties.longTermId;
      changed = true;
    }
  }
  if (items && Array.isArray(items.required)) {
    const required = items.required.filter((field) => (
      field !== "promoteToLongTerm" && field !== "longTermId"
    ));
    if (required.length !== items.required.length) {
      items.required = required;
      changed = true;
    }
  }
  return changed ? { ...template, messages, response_format: responseFormat } : template;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
