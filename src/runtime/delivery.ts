import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
  AssistantMessageTrace,
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
import { conversationRecordId, normalizeOutgoingReplyText, outboundForIncoming, persistentIncomingKey, queueIncomingSnapshot } from "./messagingAttachmentHelpers.js";
import { formatErrorReply } from "./infrastructure.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export async function runtime_sendAssistantReply(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    text: string,
    isAdmin: boolean,
    generatedImages: ImageResult[] = [],
    logRunId?: string,
    isCurrent: () => boolean = () => true,
    delivery?: ReplyDelivery,
    quoteReply = true,
    trace: AssistantMessageTrace = { messageOrigin: "text" }
  ) {
    if (
      !this.replySuppression.canReplyTo(incoming.time) ||
      !this.isReplySenderAllowed(incoming.userId) ||
      !isCurrent()
    ) return undefined;
    const beforeReply = await this.hooks.run("before_reply", {
      channel: channelKey,
      text,
      context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
    });
    const generatedImageAssets = generatedImages.filter((image) => image.url || image.filePath);
    const generatedImageUrls = generatedImages.flatMap((image) => image.url ? [image.url] : []);
    const replyText = normalizeOutgoingReplyText(beforeReply.text).trim();
    if (!replyText && !generatedImageAssets.length) {
      throw new Error("模型回复为空。");
    }
    if (!isCurrent()) return undefined;

    if (delivery) {
      delivery.outbox.push(this.replyDeliveryDraft(
        incoming,
        replyText,
        isAdmin,
        generatedImageAssets,
        logRunId,
        undefined,
        quoteReply,
        trace
      ));
      return undefined;
    }

    await gateway.send(outboundForIncoming(
      incoming,
      replyText,
      generatedImageAssets,
      quoteReply ? this.groupReplyOptions(incoming).replyToMessageId : undefined
    ));

    const record = this.recordAssistantMessage(
      incoming,
      replyText || "[图片]",
      generatedImageUrls,
      logRunId,
      undefined,
      trace
    );
    if (logRunId) {
      await appendRequestLog({
        category: "runtime.action",
        action: "reply.sent",
        request: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId
        },
        response: {
          textChars: replyText.length,
          generatedImageCount: generatedImageUrls.length
        },
        metadata: {
          conversationId: conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          runId: logRunId,
          stage: "reply"
        }
      });
    }

    await this.hooks.run("after_reply", {
      channel: channelKey,
      text: replyText,
      context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
    });

    return record;
  }
export function runtime_replyDeliveryDraft(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    text: string,
    isAdmin: boolean,
    generatedImages: ImageResult[] = [],
    logRunId?: string,
    dedupeKey?: string,
    quoteReply = true,
    trace: AssistantMessageTrace = { messageOrigin: "text" }
  ): ReplyDeliveryDraft {
    return {
      kind: "onebot.reply",
      payload: assistantReplyEnvelope({
        type: "assistant_reply",
        incoming: queueIncomingSnapshot(incoming),
        text,
        generatedImages,
        isAdmin,
        quoteReply,
        logRunId,
        messageOrigin: trace.messageOrigin ?? "text",
        toolNames: trace.toolNames?.length ? [...new Set(trace.toolNames)] : undefined,
        replyGate: this.replyGates.capture(incoming.scope, conversationRecordId(incoming))
      }, {
        conversationId: conversationRecordId(incoming),
        correlationId: logRunId ?? `onebot:${incoming.messageId ?? persistentIncomingKey(incoming)}`,
        idempotencyKey: dedupeKey
      }),
      dedupeKey
    };
  }
export async function runtime_deliverReplyOutbox(this: RuntimeHost, payload: AssistantReplyOutboxPayload, gateway: MessagingPort) {
    const incoming = payload.incoming;
    const generatedImageAssets = payload.generatedImages.filter((image) => image.url || image.filePath);
    const generatedImageUrls = payload.generatedImages.flatMap((image) => image.url ? [image.url] : []);
    await gateway.send(outboundForIncoming(
      incoming,
      payload.text,
      generatedImageAssets,
      payload.quoteReply === false ? undefined : this.groupReplyOptions(incoming).replyToMessageId
    ));

    const record = this.recordAssistantMessage(
      incoming,
      payload.text || "[图片]",
      generatedImageUrls,
      payload.logRunId,
      undefined,
      {
        messageOrigin: payload.messageOrigin,
        toolNames: payload.toolNames
      }
    );
    if (payload.logRunId) {
      await appendRequestLog({
        category: "runtime.action",
        action: "reply.sent",
        request: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId
        },
        response: {
          textChars: payload.text.length,
          generatedImageCount: generatedImageUrls.length
        },
        metadata: {
          conversationId: conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          runId: payload.logRunId,
          stage: "reply"
        }
      });
    }
    await this.hooks.run("after_reply", {
      channel: conversationRecordId(incoming),
      text: payload.text,
      context: {
        scope: incoming.scope,
        userId: incoming.userId,
        groupId: incoming.groupId,
        isAdmin: payload.isAdmin
      }
    });
    this.scheduleMemoryCompression(record);
  }
export async function runtime_sendErrorReply(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    error: unknown,
    isCurrent: () => boolean = () => true,
    logRunId?: string,
    delivery?: ReplyDelivery,
    trace: AssistantMessageTrace = { messageOrigin: "text" }
  ) {
    if (
      !this.replySuppression.canReplyTo(incoming.time) ||
      !this.isReplySenderAllowed(incoming.userId) ||
      !isCurrent()
    ) return;
    const message = formatErrorReply(error);
    try {
      if (!isCurrent()) return;
      if (delivery) {
        delivery.outbox.push(this.replyDeliveryDraft(
          incoming,
          message,
          this.isAdminUser(incoming.userId),
          [],
          logRunId,
          undefined,
          true,
          trace
        ));
        return;
      }
      await gateway.send(outboundForIncoming(
        incoming,
        message,
        [],
        this.groupReplyOptions(incoming).replyToMessageId
      ));
      this.recordAssistantMessage(
        incoming,
        message,
        [],
        logRunId,
        logRunId ? "failed" : undefined,
        trace
      );
    } catch (error) {
      console.error("[runtime] error reply failed", {
        messageId: incoming.messageId,
        userId: incoming.userId,
        groupId: incoming.groupId,
        error
      });
    }
  }

export class RuntimeDelivery {
  constructor(private readonly host: RuntimeHost) {}
  sendAssistantReply(...args: Parameters<typeof runtime_sendAssistantReply>) { return runtime_sendAssistantReply.call(this.host, ...args); }
  replyDeliveryDraft(...args: Parameters<typeof runtime_replyDeliveryDraft>) { return runtime_replyDeliveryDraft.call(this.host, ...args); }
  deliverReplyOutbox(...args: Parameters<typeof runtime_deliverReplyOutbox>) { return runtime_deliverReplyOutbox.call(this.host, ...args); }
  sendErrorReply(...args: Parameters<typeof runtime_sendErrorReply>) { return runtime_sendErrorReply.call(this.host, ...args); }
}
