import type { ImageResult, ParsedAttachment } from "../packages/contracts/media/media.js";
import type { InboundMessageV1, MessageQuoteV1 } from "../packages/contracts/messaging/messages.js";
import type { AssistantMessageOrigin } from "../packages/contracts/session/runtimeMessages.js";

export type { ImageResult, ParsedAttachment } from "../packages/contracts/media/media.js";
export type {
  InboundMessageV1,
  MessageQuoteV1
} from "../packages/contracts/messaging/messages.js";
export type { AssistantMessageOrigin } from "../packages/contracts/session/runtimeMessages.js";

export type ProviderKind =
  | "codex-responses"
  | "openai-official"
  | "anthropic-official"
  | "openai-compatible"
  | "anthropic-compatible"
  | "gemini-official"
  | "gemini-compatible";

export type ProviderModelSource = "remote" | "custom";
export type ProviderMultimodalMode = "auto" | "enabled" | "disabled";

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
  modelSource?: ProviderModelSource;
  multimodal?: ProviderMultimodalMode;
  detectedMultimodal?: boolean;
  visionProviderId?: string;
  visionModel?: string;
}

export type WebsearchToolProvider = "tavily";
export type GenerateImgToolProvider = "codex-image-gen" | "custom";
export const AGENT_TOOL_NAMES = [
  "assistant_text",
  "no_reply",
  "memory_recall",
  "websearch",
  "generate_img",
  "selfie",
  "workspace_bash",
  "codex"
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export interface AssistantMessageTrace {
  messageOrigin?: AssistantMessageOrigin;
  toolNames?: readonly string[];
}
export interface BotToolOverride {
  enabled?: boolean;
  description?: string;
}
export type BotToolOverrides = Partial<Record<AgentToolName, BotToolOverride>>;
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
  maxCalls: number;
  overrides?: BotToolOverrides;
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
  groupThreadModel: string;
  reasoningEffort?: ReasoningEffort;
  promptFile: string;
  messageThreshold: number;
  recentMessageWindowMs: number;
}

export interface BroadcastStormConfig {
  enabled: boolean;
  windowMinutes: number;
  replyThreshold: number;
  cooldownMinutes: number;
  additionalQqIds: string[];
}

export interface NormalReplyConfig {
  maxRetries: number;
}

export interface BotConfig {
  adminQq: string;
  adminName: string;
  pokeOnNoReply: boolean;
  quoteGroupReplies: boolean;
  quoteGroupReplyExcludedUserIds: string[];
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
  schemaVersion: 1;
  server: {
    host: string;
    port: number;
  };
  persona: {
    defaultAgentId: string;
    name: string;
    agentWorkspace: string;
    systemPromptWorkspace: string;
    systemPromptOverride: boolean;
    avatarPath?: string;
  };
  providers: {
    defaultProviderId: string;
    items: ProviderConfig[];
  };
  broadcastStorm: BroadcastStormConfig;
  normalReply: NormalReplyConfig;
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
  phase?: "online" | "connecting" | "restarting" | "starting" | "waiting_scan" | "expired";
  loginError?: string;
  action?: string;
  imageDataUrl?: string;
  imageUrl?: string;
  imageUpdatedAt?: string;
  qrcode?: string;
  webuiUrl?: string;
}

export type ParsedIncomingMessage = InboundMessageV1;
export type ConversationMessageQuote = MessageQuoteV1;

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
  messageOrigin?: AssistantMessageOrigin;
  toolNames?: string[];
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

export interface ConversationMessageStats {
  total: number;
  retained: number;
  visible: number;
  user: number;
  assistant: number;
  internal: number;
}

export interface ConversationRecord {
  id: string;
  agentId?: string;
  accountId?: string;
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
