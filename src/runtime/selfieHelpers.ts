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
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { isUsableImageUrl, uniqueStrings, validTimestamp } from "./messagingAttachmentHelpers.js";

export function normalizeSelfiePrompt(value: unknown) {
  return String(value ?? "").trim().slice(0, 4_000);
}
export function normalizeSelfieSize(value: unknown, fallback: AppConfig["bot"]["tools"]["generateImg"]["size"], resolution: AppConfig["bot"]["tools"]["generateImg"]["resolution"]) {
  if (isImageSize(value)) return value;
  return sizeForResolution(fallback, resolution);
}
export function normalizeSelfieResolution(value: unknown, fallback: AppConfig["bot"]["tools"]["generateImg"]["resolution"]) {
  return value === "1K" || value === "2K" || value === "4K" ? value : fallback;
}
export function normalizeSelfieQuality(value: unknown, fallback: AppConfig["bot"]["tools"]["generateImg"]["quality"]) {
  return value === "auto" || value === "low" || value === "medium" || value === "high" ? value : fallback;
}
export function sizeForResolution(size: AppConfig["bot"]["tools"]["generateImg"]["size"], resolution: AppConfig["bot"]["tools"]["generateImg"]["resolution"]) {
  const aspect = imageAspect(size);
  if (resolution === "4K") return aspect === "portrait" ? "2160x3840" : "3840x2160";
  if (resolution === "2K") return aspect === "portrait" ? "1152x2048" : aspect === "landscape" ? "2048x1152" : "2048x2048";
  return aspect === "portrait" ? "1024x1536" : aspect === "landscape" ? "1536x1024" : "1024x1024";
}
export function imageAspect(size: string) {
  const [width = 0, height = 0] = size.split("x").map((item) => Number(item));
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}
export function isImageSize(value: unknown): value is AppConfig["bot"]["tools"]["generateImg"]["size"] {
  return value === "1024x1024" ||
    value === "1536x1024" ||
    value === "1024x1536" ||
    value === "2048x2048" ||
    value === "2048x1152" ||
    value === "1152x2048" ||
    value === "3840x2160" ||
    value === "2160x3840";
}
export function normalizeSelfieReferenceImageUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .map((item) => String(item ?? "").trim())
    .filter(isUsableImageUrl))
    .slice(0, MAX_SELFIE_REFERENCE_IMAGES);
}
export function isSelfieImageFile(fileName: string) {
  return /\.(png|jpe?g|webp)$/i.test(fileName);
}
export function selfieMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}
export function shuffle<T>(values: T[]) {
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
export function conversationLastText(message: ConversationRecord["messages"][number] | undefined) {
  if (!message) return "";
  const text = message.text.trim();
  if (text && text !== "[消息]") return text;
  if (message.imageUrls?.length) return "[图片]";
  if (message.attachments?.length) return "[文件]";
  if (message.quoteReferences?.length) return "引用消息";
  return text || "[消息]";
}
export function conversationMemberNames(record: ConversationRecord) {
  const identities = new Map<number, {
    card?: { value: string; at: number };
    nickname?: { value: string; at: number };
    name?: { value: string; at: number };
  }>();
  for (const message of record.messages) {
    if (message.role !== "user" || !message.userId) continue;
    const identity = identities.get(message.userId) ?? {};
    const at = validTimestamp(message.at);
    updateIdentityValue(identity, "card", recognizableIdentity(message.senderCard), at);
    updateIdentityValue(identity, "nickname", recognizableIdentity(message.senderNickname), at);
    updateIdentityValue(identity, "name", recognizableIdentity(message.senderName), at);
    identities.set(message.userId, identity);
  }
  return Object.fromEntries([...identities.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([userId, identity]) => {
      const name = identity.card?.value || identity.nickname?.value || identity.name?.value;
      return name ? [[String(userId), name]] : [];
    }));
}
export function updateIdentityValue(
  identity: { card?: { value: string; at: number }; nickname?: { value: string; at: number }; name?: { value: string; at: number } },
  key: "card" | "nickname" | "name",
  value: string,
  at: number
) {
  if (value && (!identity[key] || at >= identity[key]!.at)) identity[key] = { value, at };
}
export function recognizableIdentity(value: unknown) {
  const text = String(value ?? "").trim();
  return !text || /^\d+$/.test(text) || /^QQ\s+\d+$/i.test(text) ? "" : text;
}
export function conversationTitle(incoming: ParsedIncomingMessage) {
  if (incoming.scope === "private") return senderDisplayName(incoming.sender) || String(incoming.userId);
  return String(incoming.groupId ?? "群聊");
}
