export interface ProviderLogContext {
  conversationId?: string;
  incomingMessageId?: string;
  runId?: string;
  stage?: string;
  memoryKind?: "working_long_term" | "user_profile";
  attempt?: number;
  retry?: number;
  maxRetries?: number;
}
