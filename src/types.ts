import type { ParsedAttachment } from "./attachments/types.js";

export type ProviderKind = "openai-responses" | "codex-responses" | "gemini-openai" | "anthropic-openai";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type ChatRole = "system" | "developer" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  imageUrls?: string[];
  localImagePaths?: string[];
}

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  enabled: boolean;
  model: string;
  imageModel: string;
  baseUrl?: string;
  apiKeyEnv: string;
  envFile?: string;
  temperature: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
}

export type WebsearchToolProvider = "tavily";
export type GenerateImgToolProvider = "codex-image-gen" | "custom";
export type ImageResolution = "1K" | "2K" | "4K";
export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageSize =
  | "1024x1024"
  | "1536x1024"
  | "1024x1536"
  | "2048x2048"
  | "2048x1152"
  | "1152x2048"
  | "3840x2160"
  | "2160x3840";

export interface BotToolSettings {
  websearch: {
    provider: WebsearchToolProvider;
    tavilyApiKey: string;
    tavilyApiKeys: string[];
    tavilyApiKeyEnv: string;
    maxResults: number;
  };
  codex: {
    enabled: boolean;
    model: string;
    codexExecutable: string;
    timeoutMs: number;
    maxConcurrency: number;
  };
  generateImg: {
    provider: GenerateImgToolProvider;
    size: ImageSize;
    resolution: ImageResolution;
    quality: ImageQuality;
  };
}

export interface BotMemorySettings {
  memoryModel: string;
  reasoningEffort?: ReasoningEffort;
  messageThreshold: number;
  workingMemoryMaxEntries: number;
  workMemoryCompressInPrompt: string;
  workMemoryCompressOutPrompt: string;
  userProfilePrompt: string;
}

export interface BotOrchestratorSettings {
  enabled: boolean;
  userGroupchatOrchestratorModel: string;
  reasoningEffort?: ReasoningEffort;
  promptFile: string;
  messageThreshold: number;
  recentMessageWindowMs: number;
}

export interface BotConfig {
  adminQq: string;
  adminName: string;
  quoteGroupReplies: boolean;
  contextMessageLimit: number;
  memory: BotMemorySettings;
  orchestrator: BotOrchestratorSettings;
  tools: BotToolSettings;
  bash: {
    enabled: boolean;
    allowGroup: boolean;
    adminOnly: boolean;
    workspaceOnly: boolean;
    blockedKeywords: string[];
  };
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
  };
  persona: {
    defaultAgentId: "plana";
    agentWorkspace: string;
    memoryLimit: number;
  };
  providers: {
    defaultProviderId: string;
    items: ProviderConfig[];
  };
  bot: BotConfig;
  onebot: {
    reverseWsPath: string;
    accessTokenEnv: string;
    autoReplyPrivate: boolean;
    autoReplyUserGroup: boolean;
    autoReplyBotGroup: boolean;
    quoteGroupReplies: boolean;
    mentionNames: string[];
    commandPrefixes: string[];
  };
}

export interface RuntimeStatus {
  startedAt: string;
  onebot: {
    connected: boolean;
    connections: number;
    selfIds: string[];
    connectedAt?: string;
    lastEventAt?: string;
    lastMessageEventAt?: string;
  };
  persona: {
    id: string;
    name: string;
    memoryItems: number;
  };
  provider: {
    defaultProviderId: string;
    model: string;
    imageModel: string;
    apiKeyConfigured: boolean;
  };
}

export interface OneBotLoginCheck {
  connected: boolean;
  online: boolean;
  data?: {
    user_id?: number;
    nickname?: string;
  };
  error?: string;
}

export interface OneBotQrLogin extends OneBotLoginCheck {
  available: boolean;
  action?: string;
  imageDataUrl?: string;
  imageUrl?: string;
  imageUpdatedAt?: string;
  qrcode?: string;
  webuiUrl?: string;
}

export interface OneBotMessageSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotEvent {
  post_type?: string;
  notice_type?: string;
  message_type?: "private" | "group";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  self_id?: number;
  raw_message?: string;
  message?: string | OneBotMessageSegment[];
  sender?: Record<string, unknown>;
  file?: Record<string, unknown>;
  time?: number;
  echo?: string;
  status?: string;
  retcode?: number;
  msg?: string;
  wording?: string;
  data?: unknown;
}

export interface ParsedIncomingMessage {
  scope: "private" | "user_group" | "bot_group";
  userId: number;
  groupId?: number;
  selfId?: number;
  text: string;
  imageUrls: string[];
  attachments: ParsedAttachment[];
  replyMessageIds: number[];
  quoteReferences: ConversationMessageQuote[];
  mentionedSelf: boolean;
  event: OneBotEvent;
}

export interface ImageResult {
  url: string;
  filePath?: string;
  revisedPrompt?: string;
}

export interface ConversationMessageQuote {
  messageId: number;
  text?: string;
  imageUrls?: string[];
  attachments?: ParsedAttachment[];
  senderName?: string;
}

export interface ConversationMessageRecord {
  id: string;
  role: "user" | "assistant" | "event";
  text: string;
  at: string;
  sequence?: number;
  userId?: number;
  groupId?: number;
  senderName?: string;
  senderNickname?: string;
  senderCard?: string;
  isAdmin?: boolean;
  selfId?: number;
  imageUrls?: string[];
  attachments?: ParsedAttachment[];
  replyMessageIds?: number[];
  quoteReferences?: ConversationMessageQuote[];
  logRunId?: string;
  actionSummary?: string;
  requestStatus?: "running" | "failed";
  eventKind?: "orchestrator_decision";
  visibility?: "internal";
  orchestratorDecision?: OrchestratorDecisionResult;
}

export interface OrchestratorDecisionResult {
  status?: "completed" | "failed";
  shouldReply: boolean;
  reason: string;
  raw: string;
}

export interface ConversationOrchestratorStatus {
  active: boolean;
  messageCount: number;
  messageTarget: number;
  activeWindowMs: number;
  lastMessageAt: string;
  lastCheckedAt?: string;
}

export interface ConversationRecord {
  id: string;
  scope: "private" | "user_group" | "bot_group";
  title: string;
  nickname?: string;
  remark?: string;
  groupName?: string;
  userId: number;
  groupId?: number;
  selfId?: number;
  replyEnabled?: boolean;
  orchestratorEnabled?: boolean;
  messageCount: number;
  lastAt: string;
  lastText: string;
  memoryCompressedThroughMessageCount?: number;
  memoryCompressedAt?: string;
  orchestratorCheckedMessageCount?: number;
  orchestratorCheckedAt?: string;
  orchestratorLastReplyAt?: string;
  orchestratorStatus?: ConversationOrchestratorStatus;
  messages: ConversationMessageRecord[];
}

export interface ImageHistoryRecord {
  id: string;
  url: string;
  filePath?: string;
  prompt?: string;
  size?: string;
  resolution?: ImageResolution;
  providerId?: string;
  model?: string;
  createdAt: string;
}
