export const AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS = 10 * 60_000;

export type ChatRole = "system" | "developer" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  imageUrls?: string[];
  imageAltTexts?: string[];
  localImagePaths?: string[];
}

export interface ProviderLogContext {
  conversationId?: string;
  incomingMessageId?: string;
  runId?: string;
  stage?: string;
  promptFamily?: string;
  memoryKind?: "working_long_term" | "user_profile";
  attempt?: number;
  retry?: number;
  maxRetries?: number;
}
