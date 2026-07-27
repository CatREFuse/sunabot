import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  generateImgTool,
  LEGACY_GENERATE_IMG_TOOL_DESCRIPTION,
  LEGACY_SELFIE_TOOL_DESCRIPTION,
  LEGACY_SEND_FILE_TOOL_DESCRIPTION,
  selfieTool,
  sendFileTool
} from "../tools/public.js";
import { parseFinalPromptTemplate } from "./promptSystem.js";
import { resolveSafePromptFilePath } from "./promptWorkspace.js";

const LEGACY_ORCHESTRATOR_RULE = "你需要在推理中对上下文进行严格的指代消解。";
const ORCHESTRATOR_RULE = "你需要在推理中对上下文进行严格的指代消解：同时解析“他、她、它、这个、那个、这件事”等对人和对事的指代，以及“这个文件、那张图、上一个附件、刚才的文档”等对文件和媒体的指代；综合紧邻消息、发送者 display_name/uid、reply_to_message_id、文件名、媒体句柄和图片替代文本判断。证据不足时保持未解析，禁止猜测。";
const THREAD_ANCHOR = "明确回复已有消息时优先继承被回复消息的 Thread。relation 只允许 new、continue、reply、switch、bridge、unresolved；只有确实跨越多个话题时使用 bridge。无法可靠判断时使用 unresolved 并降低 confidence，禁止为了显得完整而猜测。";
const THREAD_RULE = "为每条目标消息归属 Thread 前，必须同时完成对人、对事和对文件或媒体的指代消解；综合紧邻消息、display_name、uid、reply_to_message_id、文件名、媒体句柄和图片替代文本判断“他、这件事、这个文件、那张图、上一个附件”等具体指向。证据不足时使用 unresolved，禁止猜测。";
const GROUP_ANCHOR = "原始消息是事实依据。当 thread_context 与原始消息冲突、confidence 较低或 relation 为 unresolved 时，应根据完整原始消息完成本轮判断。";
const GROUP_RULE = "回复前必须同时消解对人、对事和对文件或媒体的指代；综合紧邻消息、display_name、uid、reply_to_message_id、文件名、媒体句柄和图片替代文本判断“他、这件事、这个文件、那张图、上一个附件”等具体指向。证据不足时明确保留不确定性，禁止猜测。";

export async function migrateGroupReferenceResolutionPrompt(
  config: AppConfig,
  fileName: string,
  kind: "orchestrator" | "thread" | "reply"
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const template = parseFinalPromptTemplate(await fs.readFile(filePath, "utf8"));
  const messages = template.messages.map((message) => {
    if (typeof message === "string" || typeof message.content !== "string") return message;
    const content = migrateReferenceContent(message.content, kind);
    return content === message.content ? message : { ...message, content };
  });
  if (JSON.stringify(messages) === JSON.stringify(template.messages)) return false;
  await atomicWrite(filePath, `${JSON.stringify({ ...template, messages }, null, 2)}\n`);
  return true;
}

export async function migrateConversationReferenceToolDescriptions(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const template = parseFinalPromptTemplate(await fs.readFile(filePath, "utf8"));
  let changed = false;
  const descriptions = new Map([
    ["generate_img", [LEGACY_GENERATE_IMG_TOOL_DESCRIPTION, generateImgTool.description]],
    ["selfie", [LEGACY_SELFIE_TOOL_DESCRIPTION, selfieTool.description]],
    ["send_file", [LEGACY_SEND_FILE_TOOL_DESCRIPTION, sendFileTool.description]]
  ]);
  const tools = (template.tools ?? []).map((tool) => {
    const next = structuredClone(tool);
    const definition = next.function;
    const pair = descriptions.get(String(definition.name));
    if (pair && definition.description === pair[0]) {
      definition.description = pair[1]!;
      changed = true;
    }
    return next;
  });
  if (!changed) return false;
  await atomicWrite(filePath, `${JSON.stringify({ ...template, tools }, null, 2)}\n`);
  return true;
}

function migrateReferenceContent(content: string, kind: "orchestrator" | "thread" | "reply") {
  if (kind === "orchestrator") {
    return content.includes(ORCHESTRATOR_RULE)
      ? content
      : content.replace(LEGACY_ORCHESTRATOR_RULE, ORCHESTRATOR_RULE);
  }
  if (kind === "thread") {
    return content.includes(THREAD_RULE) ? content : content.replace(THREAD_ANCHOR, `${THREAD_ANCHOR}\n\n${THREAD_RULE}`);
  }
  return content.includes(GROUP_RULE) ? content : content.replace(GROUP_ANCHOR, `${GROUP_ANCHOR}\n${GROUP_RULE}`);
}

async function atomicWrite(filePath: string, content: string) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
