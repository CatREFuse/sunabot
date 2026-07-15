import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
  ChatMessage,
  ConversationMessageQuote,
  ConversationRecord,
  ImageResult,
  ParsedIncomingMessage,
  ReasoningEffort
} from "../types.js";
import { resolveModelReasoningEffort } from "../admin/models.js";
import { AttachmentService } from "../../services/media/attachments/service.js";
import type {
  AttachmentExtractionContext,
  ParsedAttachment
} from "../../services/media/attachments/types.js";
import { CommandRouter, type CommandMatch } from "../../services/messaging/commandRouter.js";
import { isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import { getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "../config.js";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeToolCompletion,
  incomingReplyEnvelope,
  type AssistantReplyOutboxEnvelope,
  type AssistantReplyOutboxPayload,
  type AsyncToolCompletionPayload,
  type NoReplyPokeOutboxEnvelope,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import { applicationDataStore, sqliteMemoryPersistence } from "../../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import {
  ReplyGateEpochs,
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute,
  type ReplyGateSnapshot
} from "../../services/orchestration/groupReplyPolicy.js";
import { HookBus } from "../../services/messaging/hookBus.js";
import {
  applyMemoryBatchTransaction,
  ensureAgentTextFile,
  formatMemoryMatchesForPrompt,
  isMemoryBatchCommitted,
  mergeUserProfileMemory,
  normalizeEventMemorySchema,
  readAgentTextFile,
  readMemorySourceEntries,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  recallMemory,
  recoverMemoryTransactions,
  replaceWorkingMemoryFacts,
  resolveUserAddressName,
  type MemoryEntry,
  type MemoryFactInput
} from "../../services/memory/memoryService.js";
import {
  MemorySchedulerStore,
  type MemoryClaim,
  type MemoryQueuedMessage
} from "../../services/memory/memoryScheduler.js";
import {
  OpenAIProvider,
  type ProviderBashOptions,
  type ProviderCompleteOptions,
  type ProviderDeferredTurn
} from "../../adapters/model/openaiProvider.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import {
  inboundImageUrls,
  replaceInboundImageUrls,
  type MessageDetailsV1,
  type MessagingPort,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import { loadPersona, AgentPersona } from "../../services/agent/persona.js";
import { appendRequestLog } from "../requestLog.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import type { RuntimeToolCapabilityResolver } from "../../services/tools/bashCapability.js";
import type { ReplyTaskGate } from "../../services/orchestration/broadcastStormDetector.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../../services/agent/persona.js";

export const DEFAULT_CONTEXT_MESSAGE_LIMIT = 48;
export const MAX_STORED_CONVERSATION_MESSAGES = 2000;
export const GROUP_CHAT_SUMMARY_WINDOW_MS = 6 * 60 * 60 * 1000;
export const MAX_SELFIE_REFERENCE_IMAGES = 4;
export const MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES = 3;
export const MAX_CURRENT_CONTEXT_IMAGES = 4;
export const MAX_HISTORY_CONTEXT_IMAGES = 2;
export const HYDRATE_MESSAGE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const ACTIVE_CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DIRECT_REPLY_TIMEOUT_MS = TOOL_CALL_TIMEOUT_MS;
export const AMBIENT_ORCHESTRATOR_TIMEOUT_MS = 8 * 1000;
export const ORCHESTRATOR_MAX_RETRIES = 3;
export const PREPARE_TIMEOUT_MS = 90 * 1000;
export const RECENT_CONTEXT_TOKEN_BUDGET = 2_048;
export const DEDUPE_TTL_MS = 10 * 60 * 1000;
export const MAX_DEDUPE_KEYS = 20_000;
export const DEFAULT_ADMIN_NAME = "猫老师";
export const GROUP_CHAT_SUMMARY_COMMAND = "/总结群聊";
export const CONVERSATION_REPLY_PROMPT_FILE = "conversation_reply.json";
export const PRIVATE_CONVERSATION_REPLY_PROMPT_FILE = "conversation_private_reply.json";
export const GROUP_CONVERSATION_REPLY_PROMPT_FILE = "conversation_group_reply.json";
export const SELFIE_PROMPT_FILE = "selfie_prompt_rewrite.json";
export const GROUP_CHAT_SUMMARY_PROMPT_FILE = "group_chat_summary.json";
export const ADMIN_PERSONA_FILES: Readonly<Record<string, string>> = {
  "persona.agents": "AGENTS.md",
  "persona.soul": "SOUL.md",
  "persona.preference": "PREFERENCE.md",
  "persona.dialogue_style_examples": "DIALOGUE_STYLE_EXAMPLES.md",
  "persona.user": "USER.md",
  "persona.relation": "RELATION.md"
};
export const ADMIN_RUNTIME_PROMPT_DEFAULTS: Readonly<Record<string, string>> = {
  "conversation.private-reply": defaultFinalPromptContent("conversation.private-reply"),
  "conversation.group-reply": defaultFinalPromptContent("conversation.group-reply"),
  "memory.compress-in": defaultFinalPromptContent("memory.compress-in"),
  "memory.compress-out": defaultFinalPromptContent("memory.compress-out"),
  "memory.user-profile": defaultFinalPromptContent("memory.user-profile"),
  "orchestrator.user-group": defaultFinalPromptContent("orchestrator.user-group"),
  "conversation.group-summary": defaultFinalPromptContent("conversation.group-summary"),
  "image.selfie-rewrite": defaultFinalPromptContent("image.selfie-rewrite")
};
export interface BatchUserInfo {
  userId: string;
  names: string[];
  currentName: string;
  addressName: string;
  isAdmin: boolean;
}
export interface WorkingMemoryMergeOutput {
  facts: MemoryFactInput[];
  allPreviousMemoriesInvalidated: boolean;
}
export interface WorkingMemoryMergeContext {
  conversation: {
    id: string;
    scope: string;
    title: string;
    userId?: number;
    groupId?: number;
  };
  participants: BatchUserInfo[];
  messages: Array<{
    sequence: number;
    role: ConversationRecord["messages"][number]["role"];
    text: string;
    at: string;
    userId?: number;
    senderName?: string;
    imageCount: number;
    quoteCount: number;
  }>;
  metadata: Record<string, unknown>;
}
export function personaFileNameForAdminId(id: string) {
  return ADMIN_PERSONA_FILES[id];
}
export interface AdminIdentity {
  userId: string;
  name: string;
}
export interface ConversationReplyUpdateInput {
  id?: unknown;
  scope?: unknown;
  title?: unknown;
  userId?: unknown;
  groupId?: unknown;
  replyEnabled?: unknown;
  orchestratorEnabled?: unknown;
}
export interface RuntimeCommandContext {
  channelKey: string;
  incoming: ParsedIncomingMessage;
  gateway: MessagingPort;
  signal: AbortSignal;
  isCurrent: () => boolean;
  delivery?: ReplyDelivery;
}
export interface ReplyDeliveryDraft {
  kind: "onebot.reply";
  payload: AssistantReplyOutboxEnvelope;
  dedupeKey?: string;
}
export interface NoReplyPokeDeliveryDraft {
  kind: "onebot.poke";
  payload: NoReplyPokeOutboxEnvelope;
  dedupeKey?: string;
}
export interface ReplyDelivery {
  outbox: Array<ReplyDeliveryDraft | NoReplyPokeDeliveryDraft>;
  terminalStatus?: "no_reply";
}
export interface DeferredCodexTurn {
  deferred: ProviderDeferredTurn;
  originalRequest: {
    incoming: ParsedIncomingMessage;
    captureSequence?: number;
    replyGate?: ReplyGateSnapshot;
  };
  acknowledgement: ReplyDeliveryDraft;
}
export interface AmbientReplyJob {
  channelKey: string;
  incoming: ParsedIncomingMessage;
  gateway: MessagingPort;
  captureSequence: number;
  gate: ReplyGateSnapshot;
}
export interface AmbientReplyState {
  epoch: number;
  running: boolean;
  deciding?: boolean;
  controller?: AbortController;
  next?: AmbientReplyJob;
}
export interface AmbientIdleTimer {
  timer: NodeJS.Timeout;
  job: AmbientReplyJob;
}
export interface RuntimeConfigSnapshot {
  config: AppConfig;
  persona: AgentPersona;
}
export type RuntimePromptSnapshot = RuntimeConfigSnapshot;
export interface SunaRuntimeOptions {
  attachmentService?: AttachmentService;
  sessionStore?: SessionStore;
  codexRunner?: CodexRunner;
  resolveToolCapabilities?: RuntimeToolCapabilityResolver;
  replyTaskGate?: ReplyTaskGate;
}
