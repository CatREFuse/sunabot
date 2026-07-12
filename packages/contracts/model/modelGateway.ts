export interface ProviderLogContext {
  conversationId?: string;
  incomingMessageId?: string;
  runId?: string;
  stage?: string;
  memoryKind?: "working" | "long_term" | "user_profile";
  attempt?: number;
  retry?: number;
  maxRetries?: number;
}
