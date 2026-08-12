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

export const DEFAULT_REPLY_DEBOUNCE_MS = 5_000;
export const MIN_REPLY_DEBOUNCE_MS = 1_000;
export const MAX_REPLY_DEBOUNCE_MS = 60_000;

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

export interface ToolOverride {
  enabled?: boolean;
  description?: string;
}

export const AGENT_TOOL_NAMES = [
  "assistant_text",
  "no_reply",
  "memory_recall",
  "add_workmemory",
  "add_user_profile",
  "read_air",
  "knowledge_search",
  "websearch",
  "webfetch",
  "generate_img",
  "selfie",
  "read_file",
  "write_file",
  "export_chat_media",
  "import_chat_emoji",
  "import_chat_selfie",
  "send_file",
  "send_voice_message",
  "native_bash",
  "codex",
  "activate_skill",
  "read_skill_resource",
  "run_skill_script",
  "system_config",
  "cron",
  "call_director"
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export type BotToolOverride = ToolOverride;
export type BotToolOverrides = Partial<Record<AgentToolName, BotToolOverride>>;

export interface BotToolSettingsBase {
  maxCalls: number;
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

export interface BotToolSettings extends BotToolSettingsBase {
  overrides?: BotToolOverrides;
}

export interface BotMemorySettings {
  memoryModel: string;
  reasoningEffort?: ReasoningEffort;
  dreamRecentWindowHours: number;
  dreamRecentMemoryLimit: number;
  dreamOlderMemoryLimit: number;
  workMemoryCompressOutPrompt: string;
}

export interface BotOrchestratorSettings {
  enabled: boolean;
  userGroupchatOrchestratorModel: string;
  reasoningEffort?: ReasoningEffort;
  promptFile: string;
  messageThreshold: number;
  recentMessageWindowMs: number;
}

export interface BotDirectorSettings {
  enabled: boolean;
}

export interface BotImageReaderSettings {
  enabled: boolean;
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
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

export interface BotToneSettings {
  enabled: boolean;
  segmentedReply: boolean;
  followMainModel: boolean;
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  temperature: number;
  maxOutputTokens: number;
  maxRetries: number;
}

export const EMOJI_SEND_SIZES = [64, 128, 256, 512, 1024] as const;
export type EmojiSendSize = (typeof EMOJI_SEND_SIZES)[number];

export interface BotBashSettings {
  enabled: boolean;
  auditModel: string;
  strictMode: boolean;
  allowGroup: boolean;
  adminOnly: boolean;
  workspaceOnly: boolean;
  blockedKeywords: string[];
}

export interface BotConfigShape<TTools extends BotToolSettingsBase> {
  adminQq: string;
  adminName: string;
  replyModel: string;
  replyReasoningEffort?: ReasoningEffort;
  imageReader: BotImageReaderSettings;
  replyDebounceMs: number;
  pokeOnNoReply: boolean;
  quoteGroupReplies: boolean;
  quoteGroupReplyExcludedUserIds: string[];
  contextMessageLimit: number;
  emojiSendSize: EmojiSendSize;
  emojiSendSeparately: boolean;
  tone: BotToneSettings;
  director: BotDirectorSettings;
  memory: BotMemorySettings;
  orchestrator: BotOrchestratorSettings;
  tools: TTools;
  bash: BotBashSettings;
}

export interface AppConfigShape<TBot> {
  schemaVersion: 1;
  server: { host: string; port: number };
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
  bot: TBot;
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

export type BotConfig = BotConfigShape<BotToolSettings>;
export type AppConfig = AppConfigShape<BotConfig>;

export interface OneBotLoginCheck {
  connected: boolean;
  online: boolean;
  data?: { user_id?: number; nickname?: string };
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

export interface OrchestratorDecisionResult {
  status?: "completed" | "failed";
  shouldReply: boolean;
  reason: string;
  replyToMessageId?: string;
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

export {
  AGENT_SOUL_FILE_EXTENSION,
  AGENT_SOUL_SCHEMA,
  AGENT_SOUL_VERSION
} from "./agentSoul.js";
export type {
  AgentSoulDocument,
  AgentSoulFile,
  AgentSoulImportRequest,
  AgentSoulPreview,
  AgentSoulPreviewFile,
  AgentSoulSource,
  AgentSoulUpload
} from "./agentSoul.js";
