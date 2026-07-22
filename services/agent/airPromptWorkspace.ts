import type { AppConfig } from "../../packages/contracts/admin/public.js";
import {
  AIR_KNOWLEDGE_FILE,
  AIR_KNOWLEDGE_PROMPT_FILE,
  AIR_KNOWLEDGE_PROMPT_ID,
  DEFAULT_AIR_KNOWLEDGE
} from "../air/public.js";
import { migrateConversationAirPrompt } from "./airPromptMigration.js";
import { defaultPromptContent } from "./promptDefaults.js";
import { ensurePromptTextFile, migratePromptTimeContext } from "./promptWorkspace.js";

export async function ensureAirPromptWorkspace(config: AppConfig) {
  const prompt = defaultPromptContent(
    AIR_KNOWLEDGE_PROMPT_ID,
    config.persona.name,
    config.persona.defaultAgentId
  );
  await Promise.all([
    ensurePromptTextFile(config, "persona", AIR_KNOWLEDGE_FILE, DEFAULT_AIR_KNOWLEDGE),
    ensurePromptTextFile(config, "system", AIR_KNOWLEDGE_PROMPT_FILE, prompt)
  ]);
  await migratePromptTimeContext(config, "system", AIR_KNOWLEDGE_PROMPT_FILE);
  await Promise.all([
    ["conversation_private_reply.json", "conversation.private-reply"],
    ["conversation_group_reply.json", "conversation.group-reply"]
  ].map(([fileName, promptId]) => migrateConversationAirPrompt(
    config,
    fileName ?? "",
    defaultPromptContent(promptId ?? "", config.persona.name, config.persona.defaultAgentId)
  )));
}
