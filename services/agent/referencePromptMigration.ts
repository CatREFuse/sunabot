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

export async function migrateOrchestratorReferenceResolutionPrompt(
  config: AppConfig,
  fileName: string
) {
  const filePath = await resolveSafePromptFilePath(config, "system", fileName);
  const template = parseFinalPromptTemplate(await fs.readFile(filePath, "utf8"));
  const messages = template.messages.map((message) => {
    if (typeof message === "string" || typeof message.content !== "string") return message;
    const content = message.content.includes(ORCHESTRATOR_RULE)
      ? message.content
      : message.content.replace(LEGACY_ORCHESTRATOR_RULE, ORCHESTRATOR_RULE);
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

async function atomicWrite(filePath: string, content: string) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
