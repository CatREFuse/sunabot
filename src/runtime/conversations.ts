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
import { conversationDescriptorFromInput, conversationRecordId, conversationReplyEnabled, isWebConversationId, normalizeConversationId, persistedAttachments, persistedQuoteReferences } from "./messagingAttachmentHelpers.js";
import { appendConversationMessage } from "./conversationMemoryHelpers.js";
import { conversationLastText, conversationTitle } from "./selfieHelpers.js";
import { saveConversationRecords } from "./infrastructure.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export function runtime_incomingCaptureSequence(this: RuntimeHost, incoming: ParsedIncomingMessage) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    const messageId = incoming.messageId == null ? "" : String(incoming.messageId);
    const existing = messageId
      ? record?.messages.find((message) => message.role === "user" && message.id === messageId)
      : undefined;
    return typeof existing?.sequence === "number"
      ? existing.sequence
      : (record?.messageCount ?? 0) + 1;
  }
export function runtime_recordIncomingMessage(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    options: { expectedSequence?: number; persist?: boolean } = {}
  ) {
    const at = incoming.time;
    const record = this.ensureConversationRecord(incoming, at);
    const messageId = incoming.messageId == null ? "" : String(incoming.messageId);
    const existing = messageId
      ? record.messages.find((message) => message.role === "user" && message.id === messageId)
      : undefined;
    if (existing || (
      options.expectedSequence != null &&
      record.messageCount >= options.expectedSequence
    )) return record;

    const senderName = senderDisplayName(incoming.sender);
    const identity = senderIdentity(incoming.sender);
    appendConversationMessage(record, {
      id: messageId || nanoid(),
      role: "user",
      text: incoming.text || (inboundImageUrls(incoming).length ? "[图片]" : incoming.attachments.length ? "[文件]" : "[消息]"),
      at,
      userId: incoming.userId,
      groupId: incoming.groupId,
      senderName,
      senderNickname: identity.nickname || undefined,
      senderCard: identity.card || undefined,
      isAdmin: this.isAdminUser(incoming.userId),
      selfId: incoming.selfId,
      imageUrls: inboundImageUrls(incoming),
      attachments: persistedAttachments(incoming.attachments),
      replyMessageIds: incoming.replyMessageIds,
      quoteReferences: persistedQuoteReferences(incoming.quoteReferences)
    }, this.retainedConversationMessageLimit());
    if (options.persist !== false) this.persistConversationRecords();
    return record;
  }
export function runtime_recordAssistantRequestStarted(this: RuntimeHost, incoming: ParsedIncomingMessage, logRunId: string) {
    const at = new Date().toISOString();
    const record = this.ensureConversationRecord(incoming, at);
    appendConversationMessage(record, {
      id: nanoid(),
      role: "assistant",
      text: "正在输入…",
      at,
      userId: incoming.userId,
      groupId: incoming.groupId,
      senderName: this.persona?.name ?? "普拉娜",
      selfId: incoming.selfId,
      logRunId,
      actionSummary: "日志",
      requestStatus: "running"
    }, this.retainedConversationMessageLimit());
    this.persistConversationRecords();
    return record;
  }
export function runtime_recordAssistantMessage(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    text: string,
    imageUrls: string[] = [],
    logRunId?: string,
    requestStatus?: "failed"
  ) {
    const at = new Date().toISOString();
    const record = this.ensureConversationRecord(incoming, at);
    const message = {
      id: nanoid(),
      role: "assistant",
      text,
      at,
      userId: incoming.userId,
      groupId: incoming.groupId,
      senderName: this.persona?.name ?? "普拉娜",
      selfId: incoming.selfId,
      imageUrls,
      logRunId,
      actionSummary: logRunId ? "日志" : undefined,
      requestStatus
    } satisfies ConversationRecord["messages"][number];
    const pending = logRunId
      ? [...record.messages].reverse().find((item) => item.logRunId === logRunId && item.requestStatus === "running")
      : undefined;
    if (pending) {
      const sequence = pending.sequence;
      Object.assign(pending, message, { id: pending.id, sequence });
      record.lastAt = at;
      record.lastText = conversationLastText(pending);
      record.selfId = incoming.selfId ?? record.selfId;
    } else {
      appendConversationMessage(record, message, this.retainedConversationMessageLimit());
    }
    this.persistConversationRecords();
    return record;
  }
export function runtime_ensureConversationRecord(this: RuntimeHost, incoming: ParsedIncomingMessage, at: string) {
    const id = conversationRecordId(incoming);
    const existing = this.conversationRecords.get(id);
    if (existing) return existing;

    const record: ConversationRecord = {
      id,
      scope: incoming.scope,
      title: conversationTitle(incoming),
      userId: incoming.userId,
      groupId: incoming.groupId,
      selfId: incoming.selfId,
      messageCount: 0,
      lastAt: at,
      lastText: "",
      messages: []
    };
    this.conversationRecords.set(id, record);
    return record;
  }
export function runtime_upsertConversationRecordForReplySetting(this: RuntimeHost, input: ConversationReplyUpdateInput) {
    const id = normalizeConversationId(input.id);
    const existing = id ? this.conversationRecords.get(id) : undefined;
    if (existing) return existing;

    const descriptor = conversationDescriptorFromInput(input);
    const existingByDescriptor = this.conversationRecords.get(descriptor.id);
    if (existingByDescriptor) return existingByDescriptor;

    const now = new Date().toISOString();
    const record: ConversationRecord = {
      id: descriptor.id,
      scope: descriptor.scope,
      title: descriptor.title,
      userId: descriptor.userId,
      groupId: descriptor.groupId,
      messageCount: 0,
      lastAt: now,
      lastText: "",
      messages: []
    };
    this.conversationRecords.set(record.id, record);
    return record;
  }
export function runtime_persistConversationRecords(this: RuntimeHost) {
    saveConversationRecords([...this.conversationRecords.values()]);
  }
export function runtime_markConversationMessagesAsRecordedOnly(this: RuntimeHost, record: ConversationRecord) {
    record.memoryCompressedThroughMessageCount = record.messageCount;
    this.persistConversationRecords();
  }
export function runtime_getActiveConversationRecords(this: RuntimeHost) {
    const now = Date.now();
    return [...this.conversationRecords.values()]
      .filter((record) => !isWebConversationId(record.id))
      .filter((record) => record.scope === "private" && !record.groupId)
      .filter((record) => this.isAdminUser(record.userId))
      .filter((record) => conversationReplyEnabled(record))
      .filter((record) => record.messages.length > 0)
      .filter((record) => {
        const lastAt = Date.parse(record.lastAt);
        return Number.isFinite(lastAt) && now - lastAt <= ACTIVE_CONVERSATION_WINDOW_MS;
      })
      .sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt))
      .slice(0, 30);
  }
export function runtime_recordServiceMessage(this: RuntimeHost, record: ConversationRecord, text: string) {
    appendConversationMessage(record, {
      id: nanoid(),
      role: "assistant",
      text,
      at: new Date().toISOString(),
      userId: record.userId,
      groupId: record.groupId,
      senderName: this.persona?.name ?? "普拉娜",
      selfId: record.selfId
    }, this.retainedConversationMessageLimit());
    this.persistConversationRecords();
  }

export class RuntimeConversations {
  constructor(private readonly host: RuntimeHost) {}
  incomingCaptureSequence(...args: Parameters<typeof runtime_incomingCaptureSequence>) { return runtime_incomingCaptureSequence.call(this.host, ...args); }
  recordIncomingMessage(...args: Parameters<typeof runtime_recordIncomingMessage>) { return runtime_recordIncomingMessage.call(this.host, ...args); }
  recordAssistantRequestStarted(...args: Parameters<typeof runtime_recordAssistantRequestStarted>) { return runtime_recordAssistantRequestStarted.call(this.host, ...args); }
  recordAssistantMessage(...args: Parameters<typeof runtime_recordAssistantMessage>) { return runtime_recordAssistantMessage.call(this.host, ...args); }
  ensureConversationRecord(...args: Parameters<typeof runtime_ensureConversationRecord>) { return runtime_ensureConversationRecord.call(this.host, ...args); }
  upsertConversationRecordForReplySetting(...args: Parameters<typeof runtime_upsertConversationRecordForReplySetting>) { return runtime_upsertConversationRecordForReplySetting.call(this.host, ...args); }
  persistConversationRecords(...args: Parameters<typeof runtime_persistConversationRecords>) { return runtime_persistConversationRecords.call(this.host, ...args); }
  markConversationMessagesAsRecordedOnly(...args: Parameters<typeof runtime_markConversationMessagesAsRecordedOnly>) { return runtime_markConversationMessagesAsRecordedOnly.call(this.host, ...args); }
  getActiveConversationRecords(...args: Parameters<typeof runtime_getActiveConversationRecords>) { return runtime_getActiveConversationRecords.call(this.host, ...args); }
  recordServiceMessage(...args: Parameters<typeof runtime_recordServiceMessage>) { return runtime_recordServiceMessage.call(this.host, ...args); }
}
