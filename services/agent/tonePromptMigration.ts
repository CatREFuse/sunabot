import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  extractPromptVariables,
  parseFinalPromptTemplate,
  type FinalPromptTemplate
} from "./promptSystem.js";
import {
  LEGACY_TONE_BUBBLE_COUNT_RULE,
  TONE_BUBBLE_COUNT_GUIDANCE,
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
export const TONE_BUBBLE_COUNT_GUIDANCE_MIGRATION_VERSION = "bubble-count-guidance-v1";
export const TONE_MESSAGE_PACKAGE_RULE = "不得新增、删除、改写或重排原始发言中的表情标记和可用媒体，并严格遵守本次请求提供的输出格式契约。";

const LEGACY_TONE_XML_REVIEW_RULE_WITHOUT_BUBBLE_GUIDANCE = [
  `<xml-check s-if="tone_mode == true">`,
  "原始发言中的 XML 草稿会原样进入 Tone，不要在改写前拒绝或复述格式错误；你必须在本节点完成检查和订正。",
  "检查并订正所有 XML：只保留 tone_output_contract 规定的标签、属性、顺序、表情标记和媒体句柄，正文事实、代码、命令、数字与原始顺序不得丢失或改写。",
  "发现嵌套标签时必须展开为合法的顶层节点；发现 <br/> 或其他未规定的 XML/HTML 标签时，用普通换行、实体转义或新的顶层文字节点表达其原有内容，绝对不可把未规定标签带入最终输出。",
  "最终输出前再次逐项核对 tone_output_contract；订正后的结果必须与宿主校验规则完全一致。",
  "</xml-check>"
].join("\n");

const LEGACY_TONE_BUBBLE_REPLY_RULES = [
  `<bubble_reply_rules s-if="tone_mode == true">`,
  "根据内容长度判断文字气泡的拆分方式：",
  "1. 信息较短时，可以按短句拆分，每个文字气泡只放一个短句，一般不超过 3 个。",
  "2. 信息较长时，每个文字气泡承载一个完整段落；一个段落能讲清楚就只用一个文字气泡，讲不清楚时可以继续拆分，但文字气泡总数不超过 3 个。",
  "3. 用户明确要求只用一个气泡时，使用一个文字气泡输出。",
  "</bubble_reply_rules>"
].join("\n");

const TONE_BUBBLE_REPLY_GUIDANCE = [
  `<bubble_reply_rules s-if="tone_mode == true">`,
  "根据内容长度判断文字气泡的拆分方式：",
  "1. 信息较短时，可以按短句拆分，每个文字气泡只放一个短句，推荐最多 3 个。",
  "2. 信息较长时，每个文字气泡承载一个完整段落；一个段落能讲清楚就只用一个文字气泡。",
  "3. 内容确实需要更多独立短句或段落、或用户明确要求时，可以生成 3 个以上的文字气泡。",
  "4. 用户明确要求只用一个气泡时，使用一个文字气泡输出。",
  "</bubble_reply_rules>"
].join("\n");

export async function migrateToneSegmentedReplyPrompt(
  config: AppConfig,
  fileName: string
) {
  return migrateTonePromptFile(
    config,
    fileName,
    TONE_SEGMENTED_REPLY_MIGRATION_VERSION,
    migrateToneSegmentedReplyTemplate
  );
}

export async function migrateToneBubbleCountGuidancePrompt(
  config: AppConfig,
  fileName: string
) {
  return migrateTonePromptFile(
    config,
    fileName,
    TONE_BUBBLE_COUNT_GUIDANCE_MIGRATION_VERSION,
    migrateToneBubbleCountGuidanceTemplate
  );
}

async function migrateTonePromptFile(
  config: AppConfig,
  fileName: string,
  version: string,
  migrate: (template: FinalPromptTemplate) => FinalPromptTemplate
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const markerPath = await resolveSafePromptFilePath(
    config,
    "system",
    path.join(
      path.dirname(fileName),
      `.${path.basename(fileName)}.${version}`
    )
  );
  if (await readOptional(markerPath) === `${version}\n`) return false;
  const content = await readOptional(filePath);
  if (!content.trim()) return false;
  const template = parseFinalPromptTemplate(content);
  const migrated = migrate(template);
  if (migrated !== template) {
    await atomicWriteText(filePath, `${JSON.stringify(migrated, null, 2)}\n`);
  }
  await atomicWriteText(markerPath, `${version}\n`);
  return migrated !== template;
}

export function migrateToneBubbleCountGuidanceTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  const messages = template.messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") return message;
    let content = message.content;
    if (content.includes(LEGACY_TONE_BUBBLE_COUNT_RULE)) {
      content = content.replaceAll(LEGACY_TONE_BUBBLE_COUNT_RULE, TONE_BUBBLE_COUNT_GUIDANCE);
    }
    if (content.includes(LEGACY_TONE_BUBBLE_REPLY_RULES)) {
      content = content.replaceAll(LEGACY_TONE_BUBBLE_REPLY_RULES, TONE_BUBBLE_REPLY_GUIDANCE);
    }
    if (
      content.includes(TONE_XML_REVIEW_RULE)
      && content.includes(LEGACY_TONE_XML_REVIEW_RULE_WITHOUT_BUBBLE_GUIDANCE)
    ) {
      content = removeKnownDuplicateBlock(
        content,
        LEGACY_TONE_XML_REVIEW_RULE_WITHOUT_BUBBLE_GUIDANCE
      );
    }
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...template, messages } : template;
}

export function migrateToneSegmentedReplyTemplate(
  template: FinalPromptTemplate
): FinalPromptTemplate {
  let changed = false;
  const guided = migrateToneBubbleCountGuidanceTemplate(template);
  if (guided !== template) changed = true;
  const messages = guided.messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") return message;
    let content = message.content;
    if (content.includes(TONE_EMOJI_MARKER_RULE)) {
      content = content.replaceAll(TONE_EMOJI_MARKER_RULE, TONE_MESSAGE_PACKAGE_RULE);
      changed = true;
    }
    if (content === message.content) return message;
    return {
      ...message,
      content
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

function removeKnownDuplicateBlock(content: string, block: string) {
  if (content.includes(`${block}\n\n`)) return content.replace(`${block}\n\n`, "");
  if (content.includes(`\n\n${block}`)) return content.replace(`\n\n${block}`, "");
  return content.replace(block, "");
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
