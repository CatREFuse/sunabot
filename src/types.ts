import type {
  AppConfig as AdminAppConfig,
  BotConfig as AdminBotConfig,
  BotToolSettings as AdminBotToolSettings,
  AgentToolName,
  ConversationOrchestratorStatus,
  OrchestratorDecisionResult,
  ToolOverride
} from "../packages/contracts/admin/public.js";
import type { ParsedAttachment } from "../packages/contracts/media/media.js";
import type {
  ConversationRecord as ConversationContract,
  InboundMessageV1,
  MessageQuoteV1
} from "../packages/contracts/messaging/messages.js";
import type { AssistantMessageOrigin } from "../packages/contracts/session/runtimeMessages.js";

export {
  AGENT_TOOL_NAMES,
  DEFAULT_REPLY_DEBOUNCE_MS,
  EMOJI_SEND_SIZES,
  MAX_REPLY_DEBOUNCE_MS,
  MIN_REPLY_DEBOUNCE_MS
} from "../packages/contracts/admin/public.js";
export type {
  AgentToolName,
  BotBashSettings,
  BotDirectorSettings,
  BotImageReaderSettings,
  BotMemorySettings,
  BotOrchestratorSettings,
  BotToneSettings,
  BroadcastStormConfig,
  ConversationMessageStats,
  ConversationOrchestratorStatus,
  EmojiSendSize,
  GenerateImgToolProvider,
  ImageHistoryRecord,
  ImageQuality,
  ImageResolution,
  ImageSize,
  NormalReplyConfig,
  OneBotLoginCheck,
  OneBotQrLogin,
  OrchestratorDecisionResult,
  ProviderConfig,
  ProviderKind,
  ProviderModelSource,
  ProviderMultimodalMode,
  ReasoningEffort,
  WebsearchToolProvider
} from "../packages/contracts/admin/public.js";
export type { ImageResult, ParsedAttachment } from "../packages/contracts/media/media.js";
export type {
  InboundMessageV1,
  MessageQuoteV1
} from "../packages/contracts/messaging/messages.js";
export type { ChatMessage, ChatRole } from "../packages/contracts/model/modelGateway.js";
export type { AssistantMessageOrigin } from "../packages/contracts/session/runtimeMessages.js";

export interface AssistantMessageTrace {
  messageOrigin?: AssistantMessageOrigin;
  toolNames?: readonly string[];
}
export type BotToolOverride = ToolOverride;
export type BotToolOverrides = Partial<Record<AgentToolName, BotToolOverride>>;
export type BotToolSettings = AdminBotToolSettings;
export type BotConfig = AdminBotConfig;
export type AppConfig = AdminAppConfig;

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
  imageAltTexts?: string[];
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

export interface ConversationRecord extends ConversationContract {
  id: string;
  agentId?: string;
  scope: "private" | "user_group" | "bot_group";
  nickname?: string;
  remark?: string;
  groupName?: string;
  selfId?: number;
  replyEnabled?: boolean;
  orchestratorEnabled?: boolean;
  orchestratorResponseTimeOverrideEnabled?: boolean;
  orchestratorResponseTimeMs?: number;
  directorEventsEnabled?: boolean;
  disabledTools?: AgentToolName[];
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
