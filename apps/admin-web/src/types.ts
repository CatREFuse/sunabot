import type {
  AppConfigShape,
  BotDirectorSettings,
  BotMemorySettings,
  BotOrchestratorSettings,
  BotConfigShape,
  BotToneSettings,
  BotToolSettingsBase,
  BroadcastStormConfig,
  ConversationMessageStats,
  ConversationOrchestratorStatus,
  NormalReplyConfig,
  OrchestratorDecisionResult,
  ReasoningEffort,
  ToolOverride
} from "../../../packages/contracts/admin/public.js";

export type {
  BotMemorySettings,
  BotImageReaderSettings,
  BotDirectorSettings,
  BotOrchestratorSettings,
  BotToneSettings,
  BroadcastStormConfig,
  ConversationMessageStats,
  ConversationOrchestratorStatus,
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
  ReasoningEffort,
  ToolOverride,
  WebsearchToolProvider
} from "../../../packages/contracts/admin/public.js";

export type ToolName = string;
export type ToolExecutionMode = "inline" | "deferred";
export type ToolUnavailabilityKind = "runtime" | "session";
export interface BotToolSettings extends BotToolSettingsBase {
  maxCalls: number;
  overrides: Record<ToolName, ToolOverride>;
}
export type BotConfig = BotConfigShape<BotToolSettings>;

export interface BotToolSettingsDraft extends BotToolSettings {
  websearch: BotToolSettings["websearch"] & {
    removeTavilyApiKeyIndexes: number[];
  };
}

export type AppConfig = AppConfigShape<BotConfig>;

export interface AgentAccount {
  id: string;
  agentId: string;
  label: string;
  qqId?: string;
  enabled: boolean;
  webuiPort: number;
  connected?: boolean;
  selfId?: string;
  runtimeReady?: boolean;
  desiredState?: "running" | "stopped";
  observedState?: "running" | "stopped" | "missing" | "unknown";
  reconcileRequired?: boolean;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  enabled: boolean;
  workspace: string;
  avatarPath?: string;
  createdAt: string;
  updatedAt: string;
  accounts: readonly AgentAccount[];
  runtime?: {
    loaded: boolean;
    persona?: { id: string; name: string; memoryItems: number };
  };
}

export interface AgentAvatarInput {
  fileName: string;
  dataBase64: string;
}

export type ConfigSectionKey = "server" | "persona" | "providers" | "broadcastStorm" | "normalReply" | "bot" | "tone" | "memory" | "director" | "orchestrator" | "tools" | "bash" | "onebot";
export type SettingsSectionKey = ConfigSectionKey | "security";
export type ApplyMode = "hot" | "reconnect" | "restart";

export interface ConfigEnvelope {
  config: AppConfig;
  revision: string;
  fieldStates: Record<string, {
    applyMode: ApplyMode;
    secretConfigured?: boolean;
    secretCount?: number;
    storedSecretCount?: number;
  }>;
}

export interface ConfigSectionValueMap {
  server: AppConfig["server"];
  persona: Pick<AppConfig["persona"], "agentWorkspace">;
  providers: AppConfig["providers"];
  broadcastStorm: BroadcastStormConfig;
  normalReply: NormalReplyConfig;
  bot: Pick<BotConfig, "adminQq" | "adminName" | "replyModel" | "replyReasoningEffort" | "imageReader" | "replyDebounceMs" | "pokeOnNoReply" | "quoteGroupReplies" | "quoteGroupReplyExcludedUserIds" | "contextMessageLimit" | "emojiSendSize" | "emojiSendSeparately">;
  tone: BotToneSettings;
  memory: BotMemorySettings;
  director: BotDirectorSettings;
  orchestrator: BotOrchestratorSettings;
  tools: BotToolSettingsDraft;
  bash: BotConfig["bash"];
  onebot: Omit<AppConfig["onebot"], "quoteGroupReplies">;
}

export interface ConfigPatchResponse extends ConfigEnvelope {
  ok?: boolean;
  applyMode?: ApplyMode;
  restartRequiredFields?: string[];
}

export type ConfigDoctorStatus = "healthy" | "repairable" | "manual";
export type ConfigDoctorSeverity = "warning" | "error";
export type ConfigDoctorIssueSource = "rules" | "syntax" | "ai";
export type ConfigDoctorRisk = "low" | "medium";

export interface ConfigDoctorIssue {
  id: string;
  path: string;
  message: string;
  severity: ConfigDoctorSeverity;
  repairable: boolean;
  source: ConfigDoctorIssueSource;
}

export interface ConfigDoctorChange {
  path: string;
  action: "add" | "replace" | "remove";
  summary: string;
  risk: ConfigDoctorRisk;
}

export interface ConfigDoctorProposal {
  id: string;
  sourceRevision: string;
  expiresAt: string;
  risk: ConfigDoctorRisk;
  source: "rules" | "ai";
  changes: readonly ConfigDoctorChange[];
}

export interface ConfigDoctorProvider {
  label: string;
  model: string;
  destination: string;
}

export interface ConfigDoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  sourceRevision: string;
  status: ConfigDoctorStatus;
  issues: readonly ConfigDoctorIssue[];
  proposal?: ConfigDoctorProposal;
  ai: {
    available: boolean;
    provider?: ConfigDoctorProvider;
  };
}

export interface ConfigDoctorApplyResult {
  ok: boolean;
  repairId: string;
  repairedAt: string;
  sourceRevision: string;
  backupPath: string;
  restartRequired: boolean;
  appliedChanges: number;
}

export interface ModelCatalogItem {
  id: string;
  label: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
  reasoningEfforts?: ReasoningEffort[];
}

export type RuntimeProbeCheckKind = "liveness" | "readiness" | "capability";
export type RuntimeProbeCheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface RuntimeProbeCheck {
  id: string;
  kind: RuntimeProbeCheckKind;
  status: RuntimeProbeCheckStatus;
  code: string | null;
  path: string | null;
  action: string | null;
  detail: string;
}

export interface RuntimeProbe {
  schemaVersion: 1;
  generatedAt: string;
  summary: {
    liveness: "live" | "dead";
    readiness: "ready" | "degraded" | "not_ready";
    capability: "ready" | "degraded";
  };
  checks: RuntimeProbeCheck[];
  accounts: Array<{
    id: string;
    agentId: string;
    desiredState: "running" | "stopped";
    observedState: "running" | "stopped" | "missing" | "unknown";
    connected: boolean | null;
    reconcileRequired: boolean;
    lastError: string | null;
    path: string | null;
  }>;
}

export interface RuntimeStatus {
  startedAt: string;
  configPath: string;
  onebot: {
    connected: boolean;
    connections: number;
    selfIds: string[];
    connectedAt?: string;
    lastEventAt?: string;
    lastMessageEventAt?: string;
  };
  persona: { id: string; name: string; memoryItems: number };
  provider: {
    defaultProviderId: string;
    model: string;
    imageModel: string;
    apiKeyConfigured: boolean;
    configured?: boolean;
    verifiedAvailable?: boolean;
  };
  probe?: RuntimeProbe;
  recovery?: { required: boolean; message?: string; backupPath?: string };
}

export interface ToolParameterSummary {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface SunaTool {
  name: ToolName;
  title: string;
  summary?: string;
  execution?: ToolExecutionMode;
  configuredEnabled?: boolean | null;
  inheritedEnabled?: boolean;
  promptEnabled?: boolean;
  available?: boolean;
  enabled: boolean;
  effectiveEnabled?: boolean;
  configurable?: boolean;
  availabilityReason?: string;
  unavailableReason?: string;
  unavailabilityKind?: ToolUnavailabilityKind;
  accessLabel?: string;
  accessDescription?: string;
  executionBackend?: "native" | "docker";
  bashEnvironments?: {
    native?: { available: boolean; reasonCode?: string };
    docker?: { started: boolean; reasonCode?: string };
  };
  runtimeReasonCode?: string;
  defaultDescription?: string;
  promptDescription?: string;
  description: string;
  descriptionSource?: string;
  parameters?: Readonly<Record<string, unknown>> | readonly ToolParameterSummary[];
  strict?: boolean;
}

export interface ConversationMessageQuote {
  messageId: number;
  text?: string;
  imageUrls?: string[];
  senderName?: string;
}

export type ConversationMessageOrigin = "text" | "assistant_text" | "async_tool_dispatch" | "async_tool_callback";

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
  replyMessageIds?: number[];
  quoteReferences?: ConversationMessageQuote[];
  logRunId?: string;
  messageOrigin?: ConversationMessageOrigin;
  toolNames?: string[];
  actionSummary?: string;
  requestStatus?: "running" | "failed";
  eventKind?: "orchestrator_decision";
  visibility?: "internal";
  orchestratorDecision?: OrchestratorDecisionResult;
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
  orchestratorResponseTimeOverrideEnabled?: boolean;
  orchestratorResponseTimeMs?: number;
  directorEventsEnabled?: boolean;
  disabledTools?: ToolName[];
  messageCount: number;
  lastAt: string;
  lastText: string;
  memoryCompressedThroughMessageCount?: number;
  memoryCompressedAt?: string;
  orchestratorCheckedMessageCount?: number;
  orchestratorCheckedAt?: string;
  orchestratorStatus?: ConversationOrchestratorStatus;
  messages: ConversationMessageRecord[];
}

export interface ConversationMessagePage {
  conversationId: string;
  messages: ConversationMessageRecord[];
  hasMore: boolean;
  nextBeforeSequence?: number;
  memberNames: Record<string, string>;
}

export interface ConversationLogEntry {
  id: string;
  at: string;
  category: string;
  action: string;
  providerId?: string;
  providerKind?: string;
  model?: string;
  request?: unknown;
  response?: unknown;
  metadata?: Record<string, unknown>;
  tokenUsage?: TokenUsageBreakdown;
}

export interface TokenUsageBreakdown {
  input: number;
  output: number;
  cachedInput: number;
  total: number;
  cacheRate: number | null;
}

export interface TokenUsageBucket extends TokenUsageBreakdown {
  requests: number;
}

export type TokenUsageBehavior = "" | "reply" | "orchestrator" | "memory" | "other";

export interface TokenUsageFilters {
  model: string;
  behavior: TokenUsageBehavior;
}

export interface TokenUsagePayload {
  today: TokenUsageBucket & { date: string };
  days: Array<TokenUsageBucket & { date: string }>;
  hours: Array<TokenUsageBucket & { hour: number }>;
  filters?: TokenUsageFilters & { models: string[] };
}

export interface ModelCallStatsBreakdown {
  total: TokenUsageBucket;
  behavior: Record<"reply" | "orchestrator" | "memory" | "other", TokenUsageBucket>;
  memory: {
    total: TokenUsageBucket;
    kinds: Record<"working_long_term" | "user_profile", TokenUsageBucket>;
  };
}

export interface ModelCallStatsPayload extends ModelCallStatsBreakdown {
  conversationId: string | null;
  models?: ReadonlyArray<ModelCallStatsBreakdown & { model: string }>;
}

export interface ConversationStatsPayload {
  conversationId: string;
  messages: ConversationMessageStats;
  modelCalls: ModelCallStatsPayload;
}

export interface SelfieReferenceImage {
  id: string;
  fileName: string;
  note: string;
  sizeBytes: number;
  width: number;
  height: number;
  updatedAt: string;
  originalUrl: string;
  displayUrl: string;
  placeholderUrl: string;
  workbench?: "native" | "docker";
}

export interface SelfieReferencePayload {
  images: SelfieReferenceImage[];
  maxImages: number;
}

export interface ImageResult { url: string; model?: string; providerId?: string }

export const memorySourceIds = ["working", "long_term", "user_profile"] as const;
export type MemorySourceId = typeof memorySourceIds[number];
export interface MemorySource { id: MemorySourceId; title: string; fileName: string; editable: boolean }
export interface MemoryEntry {
  id: string;
  source: MemorySourceId;
  sourceTitle: string;
  fileName: string;
  editable: boolean;
  key: string;
  value: string;
  text: string;
  field: string;
  time?: string;
  occurredAt?: string;
  occurredEndAt?: string;
  observedAt?: string;
  legacyTime?: string;
  legacyCreatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
  userIds?: string[];
  userName?: string;
  addressNames?: string[];
  addressName?: string;
  userNickname?: string;
  groupCards?: Array<{ groupId: number; card: string; lastSeenAt: string }>;
  score?: number;
  recallCount?: number;
  distinctRecallDays?: number;
  lastRecalledAt?: string;
  recallTrackingStartedAt?: string;
  lastReviewedAt?: string;
  importance?: number;
  futureRelevance?: number;
  emotionalSalience?: number;
}
export interface MemoryWritePayload {
  source: MemorySourceId;
  id?: string;
  text: string;
  userId?: string;
  addressNames?: string[];
  addressName?: string;
}
export interface MemoryDocument {
  fileName: string;
  content: string;
  revision: string;
}
export interface MemoryProcessingHealth {
  windowHours: 24;
  windowStartedAt: string;
  measuredAt: string;
  successful: number;
  attempted: number;
  pending: number;
}
export interface MemoryPayload {
  sources: MemorySource[];
  entries: MemoryEntry[];
  health: MemoryProcessingHealth;
  document?: MemoryDocument;
}
export interface MemoryRecallPayload { ok: boolean; query: string; matches: MemoryEntry[]; error?: string }
export interface MemoryOperationLogEntry {
  id: string;
  at: string;
  category: string;
  action: string;
  request?: {
    source?: string;
    operation?: string;
    actor?: string;
    recordIds?: string[];
    batchId?: string;
    conversationId?: string;
    conversationScope?: string;
  };
  response?: {
    outcome?: string;
    beforeCount?: number;
    afterCount?: number;
    changedCount?: number;
    beforeRevision?: string;
    afterRevision?: string;
    reasonCode?: string;
  };
  metadata?: {
    agentId?: string;
    stage?: string;
    memorySource?: string;
    batchId?: string;
    conversationId?: string;
  };
}
export interface MemoryOperationLogPayload {
  logs: MemoryOperationLogEntry[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface OneBotChatList {
  connected: boolean;
  private: Array<{ userId: number; nickname: string; remark: string }>;
  groups: Array<{ groupId: number; groupName: string; memberCount: number; maxMemberCount: number }>;
}

export interface OneBotEventTrace {
  receivedAt: string;
  postType?: string;
  messageType?: string;
  detailType?: string;
  selfId?: number;
  userId?: number;
  groupId?: number;
  messageId?: number;
  text?: string;
}

export type AgentFileCategory = "persona" | "memory" | "orchestrator" | "conversation" | "image" | string;
export interface PromptVariableDefinition {
  name: string;
  description: string;
  type: "string" | "message[]" | "json" | "number" | "boolean";
  source: string;
  required: boolean;
}
export interface AgentFileSummary {
  id: string;
  title: string;
  category: AgentFileCategory;
  kind: "fragment" | "final";
  variables: readonly PromptVariableDefinition[];
  fileName: string;
  updatedAt?: string;
  revision: string;
  empty?: boolean;
}
export interface AgentFileDetail extends AgentFileSummary { content: string }

export interface ApiErrorBody {
  error: { code: string; message: string; field?: string; latestRevision?: string };
}
