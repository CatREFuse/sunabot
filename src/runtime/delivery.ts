import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
  type ReplyQuoteSnapshotV1,
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
import { appendRequestLog, appendRequestLogStrict } from "../requestLog.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type OutboxDeliveryContext,
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
import { formatErrorReply, saveConversationRecordsStrict } from "./infrastructure.js";

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
    trace: AssistantMessageTrace = { messageOrigin: "text" },
    deliveryTiming: "buffered" | "immediate" = "buffered"
  ) {
    if (
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
      const draft = this.replyDeliveryDraft(
        incoming,
        replyText,
        isAdmin,
        generatedImageAssets,
        logRunId,
        undefined,
        quoteReply,
        trace,
        delivery.replyQuote
      );
      if (deliveryTiming === "immediate" && delivery.emitOutbox) {
        draft.dedupeFingerprint = immediateReplyFingerprint(
          incoming,
          replyText,
          generatedImageAssets,
          quoteReply,
          draft.payload.payload.replyToMessageId,
          trace
        );
        await delivery.emitOutbox(draft);
      } else {
        delivery.outbox.push(draft);
      }
      return undefined;
    }

    const replyToMessageId = quoteReply ? this.groupReplyOptions(incoming).replyToMessageId : undefined;
    const receipt = await gateway.send(outboundForIncoming(
      incoming,
      replyText,
      generatedImageAssets,
      replyToMessageId
    ));

    const record = this.recordAssistantMessage(
      incoming,
      replyText || "[图片]",
      generatedImageUrls,
      logRunId,
      undefined,
      trace,
      {
        ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
        ...(replyToMessageId == null ? {} : { replyMessageIds: [replyToMessageId] })
      }
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
    trace: AssistantMessageTrace = { messageOrigin: "text" },
    replyQuote?: ReplyQuoteSnapshotV1
  ): ReplyDeliveryDraft {
    const replyToMessageId = resolveReplyToMessageId(this, incoming, quoteReply, replyQuote);
    return {
      kind: "onebot.reply",
      payload: assistantReplyEnvelope({
        type: "assistant_reply",
        incoming: queueIncomingSnapshot(incoming),
        text,
        generatedImages,
        isAdmin,
        quoteReply,
        replyToMessageId: replyToMessageId ?? null,
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
export async function runtime_deliverReplyOutbox(
  this: RuntimeHost,
  payload: AssistantReplyOutboxPayload,
  gateway: MessagingPort | undefined,
  delivery?: OutboxDeliveryContext
) {
  const incoming = payload.incoming;
  const replyToMessageId = durableReplyToMessageId(this, payload, incoming);
  const generatedImageAssets = payload.generatedImages.filter((image) => image.url || image.filePath);
  const generatedImageUrls = payload.generatedImages.flatMap((image) => image.url ? [image.url] : []);
  let remoteReceipt = delivery?.remoteReceipt;
  if (delivery?.phase === "send" || !delivery) {
      if (!gateway) throw new OutboxDisconnectedError("OneBot is not connected.");
      const sendReply = () => gateway.send(outboundForIncoming(
        incoming,
        payload.text,
        generatedImageAssets,
        replyToMessageId
      ));
    if (delivery) remoteReceipt = await delivery.sendRemote(sendReply);
    else remoteReceipt = await sendReply();
  }

    const settleConversation = (idempotencyKey?: string) => {
      const outboundMessageId = messagingReceiptMessageId(delivery?.remoteReceipt ?? remoteReceipt);
      const record = this.recordAssistantMessage(
        incoming,
        payload.text || "[图片]",
        generatedImageUrls,
        payload.logRunId,
        undefined,
        {
          messageOrigin: payload.messageOrigin,
          toolNames: payload.toolNames
        },
        {
          ...(idempotencyKey
            ? { persist: false, messageId: outboundMessageId ?? idempotencyKey }
            : outboundMessageId ? { messageId: outboundMessageId } : {}),
          ...(replyToMessageId == null ? {} : { replyMessageIds: [replyToMessageId] })
        }
      );
      if (idempotencyKey) {
        saveConversationRecordsStrict(
          [...this.conversationRecords.values()],
          idempotencyKey,
          this.config,
          this.protectedConversationIds()
        );
      } else {
        this.scheduleMemoryCompression(record);
      }
      return record;
    };
    if (delivery) {
      await delivery.settleStep("conversation_projection", settleConversation);
      await delivery.settleStep("memory_enqueue", async () => {
        const record = this.conversationRecords.get(conversationRecordId(incoming));
        if (!record) throw new Error(`Conversation projection is missing: ${conversationRecordId(incoming)}`);
        await this.enqueueConversationMemory(record);
        this.scheduleMemoryDrain();
      });
    } else settleConversation();

    const settleRequestLog = () => payload.logRunId ? appendRequestLog({
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
      }) : undefined;
    if (delivery) await delivery.settleStep("request_log", (idempotencyKey) => payload.logRunId
      ? appendRequestLogStrict({
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
        }, idempotencyKey)
      : undefined);
    else await settleRequestLog();

    const afterReplyPayload = {
      channel: conversationRecordId(incoming),
      text: payload.text,
      context: {
        scope: incoming.scope,
        userId: incoming.userId,
        groupId: incoming.groupId,
        isAdmin: payload.isAdmin
      }
    };
    if (delivery) {
      await this.hooks.runEach("after_reply", afterReplyPayload, async (handlerId, invoke) => {
        await delivery.settleEffectStep(`after_reply:${handlerId}`, (idempotencyKey) => invoke({
          ...afterReplyPayload,
          context: { ...afterReplyPayload.context, idempotencyKey }
        }));
      });
    } else await this.hooks.run("after_reply", afterReplyPayload);
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
          trace,
          delivery.replyQuote
        ));
        return;
      }
      const replyToMessageId = this.groupReplyOptions(incoming).replyToMessageId;
      const receipt = await gateway.send(outboundForIncoming(
        incoming,
        message,
        [],
        replyToMessageId
      ));
      this.recordAssistantMessage(
        incoming,
        message,
        [],
        logRunId,
        logRunId ? "failed" : undefined,
        trace,
        {
          ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          ...(replyToMessageId == null ? {} : { replyMessageIds: [replyToMessageId] })
        }
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

function messagingReceiptMessageId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
}

function durableReplyToMessageId(
  runtime: RuntimeHost,
  payload: AssistantReplyOutboxPayload,
  incoming: ParsedIncomingMessage
) {
  if (Object.hasOwn(payload, "replyToMessageId")) {
    return Number.isSafeInteger(payload.replyToMessageId) && Number(payload.replyToMessageId) > 0
      ? Number(payload.replyToMessageId)
      : undefined;
  }
  return payload.quoteReply === false ? undefined : runtime.groupReplyOptions(incoming).replyToMessageId;
}

function resolveReplyToMessageId(
  runtime: RuntimeHost,
  incoming: ParsedIncomingMessage,
  quoteReply: boolean,
  replyQuote?: ReplyQuoteSnapshotV1
) {
  if (!quoteReply) return undefined;
  if (replyQuote) {
    return replyQuote.enabled ? replyQuote.replyToMessageId ?? undefined : undefined;
  }
  return runtime.groupReplyOptions(incoming).replyToMessageId;
}

function immediateReplyFingerprint(
  incoming: ParsedIncomingMessage,
  text: string,
  generatedImages: ImageResult[],
  quoteReply: boolean,
  replyToMessageId: number | null | undefined,
  trace: AssistantMessageTrace
) {
  return createHash("sha256").update(JSON.stringify({
    target: {
      scope: incoming.scope,
      messageId: incoming.messageId,
      userId: incoming.userId,
      groupId: incoming.groupId,
      selfId: incoming.selfId,
      accountId: incoming.accountId,
      agentId: incoming.agentId
    },
    text,
    generatedImages: generatedImages.map(({ url, filePath }) => ({ url, filePath })),
    quoteReply,
    replyToMessageId,
    messageOrigin: trace.messageOrigin
  })).digest("hex");
}
