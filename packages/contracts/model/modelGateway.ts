export interface ProviderLogContext {
  conversationId?: string;
  incomingMessageId?: string;
  runId?: string;
  stage?: string;
  attempt?: number;
  retry?: number;
  maxRetries?: number;
}
