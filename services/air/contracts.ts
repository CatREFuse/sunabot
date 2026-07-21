import type { ChatMessage } from "../../src/types.js";

export const AIR_KNOWLEDGE_PROMPT_ID = "air.read";
export const AIR_KNOWLEDGE_PROMPT_FILE = "read_air.json";
export const AIR_KNOWLEDGE_FILE = "AIR.md";

export const AIR_PERSONA_VARIABLE = "persona.air";
export const AIR_KNOWLEDGE_VARIABLE = "air.knowledge";
export const AIR_CONVERSATION_VARIABLE = "air.conversation";
export const AIR_INSIGHT_VARIABLE = "air.insight";

export interface AirConversationContext {
  conversationId: string;
  scope: "private" | "user_group" | "bot_group";
  title: string;
  accountId?: string;
  groupId?: number;
  userId?: number;
  messages: readonly ChatMessage[];
}
