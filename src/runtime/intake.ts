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
import { attachmentSourcePort, conversationMessageAttachments, conversationRecordId, conversationReplyEnabled, incomingAttachmentReferenceScope, isNumericMessageId, isRecentMessageForHydration, mergeAttachments, mergeConversationMessageDetails, persistentIncomingKey, queueIncomingSnapshot, replaceQuoteAttachments, uniqueAttachments, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { conversationLastText } from "./selfieHelpers.js";
import { errorMessage, isAbortError, isRuntimeIncomingMessage, withAbortTimeout } from "./infrastructure.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export async function runtime_hydrateConversationRecords(this: RuntimeHost, gateway: MessagingPort) {
    if (!this.hydrationPromise) {
      this.hydrationPromise = this.performHydrateConversationRecords(gateway)
        .finally(() => {
          this.hydrationPromise = undefined;
        });
    }
    await this.hydrationPromise;
  }
export async function runtime_performHydrateConversationRecords(this: RuntimeHost, gateway: MessagingPort) {
    const generation = String(gateway.getStatus().connectedAt ?? "unknown");
    if (generation !== this.hydrationGeneration) {
      this.hydrationGeneration = generation;
      this.hydrationFailures.clear();
    }
    const targets: Array<{ record: ConversationRecord; message: ConversationRecord["messages"][number] }> = [];
    for (const record of [...this.conversationRecords.values()].sort((left, right) => Date.parse(right.lastAt) - Date.parse(left.lastAt))) {
      for (const message of record.messages.slice(-this.contextMessageLimit())) {
        if (message.role !== "user") continue;
        if (!isNumericMessageId(message.id)) continue;
        if (!isRecentMessageForHydration(message.at)) continue;
        if (this.hydratedMessageIds.has(message.id)) continue;
        const failure = this.hydrationFailures.get(`${record.id}/${message.id}`);
        if (failure?.generation === generation && Date.now() < failure.nextAt) continue;
        targets.push({ record, message });
      }
    }
    targets.sort((left, right) =>
      Number(right.message.text === "[文件]") - Number(left.message.text === "[文件]") ||
      Date.parse(right.message.at) - Date.parse(left.message.at)
    );

    let changed = false;
    const selectedTargets = targets.slice(0, 16);
    for (let offset = 0; offset < selectedTargets.length; offset += 2) {
      await Promise.all(selectedTargets.slice(offset, offset + 2).map(async (target) => {
      const failureKey = `${target.record.id}/${target.message.id}`;
      try {
        const messageId = Number(target.message.id);
        const details = await this.loadMessageDetails(gateway, messageId, {
          source: "message",
          groupId: target.record.groupId,
          userId: target.message.userId ?? target.record.userId
        });
        let quoteReferences = await this.loadQuoteReferences(
          gateway,
          details.replyMessageIds,
          {
            source: "quote",
            groupId: target.record.groupId,
            userId: target.message.userId ?? target.record.userId
          }
        );
        const knownAttachments = conversationMessageAttachments(target.message);
        const discoveredAttachments = uniqueAttachments([
          ...details.attachments,
          ...quoteReferences.flatMap((quote) => quote.attachments ?? [])
        ]);
        const unresolvedAttachments = discoveredAttachments.filter((attachment) => {
          const existing = knownAttachments.find((value) => value.id === attachment.id);
          return !existing || existing.status === "pending";
        });
        const processedAttachments = unresolvedAttachments.length
          ? await this.attachmentService.processIncoming(
            unresolvedAttachments,
            attachmentSourcePort(gateway),
            details.text,
            `${target.record.id}/${target.message.id}`
          )
          : [];
        const resolvedAttachments = mergeAttachments(knownAttachments, processedAttachments);
        const resolvedById = new Map(resolvedAttachments.map((attachment) => [attachment.id, attachment]));
        details.attachments = details.attachments.map(
          (attachment) => resolvedById.get(attachment.id) ?? attachment
        );
        quoteReferences = replaceQuoteAttachments(quoteReferences, resolvedAttachments);
        const imageUrls = uniqueStrings([
          ...details.media.flatMap((asset) => asset.url ? [asset.url] : []),
          ...quoteReferences.flatMap((quote) => quote.imageUrls ?? [])
        ]);
        if (mergeConversationMessageDetails(target.message, details, imageUrls, quoteReferences)) {
          target.record.lastText = conversationLastText(target.record.messages[target.record.messages.length - 1]);
          changed = true;
        }
        this.hydratedMessageIds.add(target.message.id);
        this.hydrationFailures.delete(failureKey);
      } catch (error) {
        const previous = this.hydrationFailures.get(failureKey);
        const attempts = (previous?.attempts ?? 0) + 1;
        const retryDelays = [60_000, 5 * 60_000, 30 * 60_000];
        const missingMessage = /消息不存在|message[^\n]*not[^\n]*found/i.test(errorMessage(error));
        this.hydrationFailures.set(failureKey, {
          attempts,
          nextAt: missingMessage ? Number.POSITIVE_INFINITY : Date.now() + retryDelays[Math.min(attempts - 1, retryDelays.length - 1)]!,
          generation
        });
        console.error("[runtime] hydrate conversation message failed", {
          messageId: target.message.id,
          error
        });
      }
      }));
    }

    if (changed) {
      this.persistConversationRecords();
      await this.refreshAttachmentCacheReferences().catch((error) => {
        console.error("[runtime] refresh hydrated attachment references failed", error);
      });
    }
  }
export async function runtime_handleInboundMessage(this: RuntimeHost, incoming: ParsedIncomingMessage, gateway: MessagingPort) {
    this.activeGateway = gateway;
    if (this.isDuplicateIncoming(incoming)) return;
    if (!this.isReplySenderAllowed(incoming.userId)) {
      this.markIncomingSeen(incoming);
      return;
    }

    const channelKey = conversationRecordId(incoming);
    const gate = this.replyGates.capture(incoming.scope, channelKey);
    const command = this.commandRouter.match(incoming.text, uniqueStrings([
      ...this.config.onebot.mentionNames,
      this.persona?.name ?? "",
      incoming.selfId == null ? "" : String(incoming.selfId)
    ]));
    const route = this.resolveIncomingReplyRoute(incoming, Boolean(command));
    const existingRecord = this.conversationRecords.get(channelKey);

    if (existingRecord && !conversationReplyEnabled(existingRecord)) {
      const record = this.recordIncomingMessage(incoming);
      this.markIncomingSeen(incoming);
      this.markConversationMessagesAsRecordedOnly(record);
      return;
    }

    if (route === "command" || route === "direct") {
      const proposedCaptureSequence = this.incomingCaptureSequence(incoming);
      const preparationKey = persistentIncomingKey(incoming);
      const committed = this.sessionCoordinator.enqueueEvent({
        sessionId: channelKey,
        kind: "incoming_reply",
        dedupeKey: `reply:${preparationKey}`,
        payload: incomingReplyEnvelope({
          type: "incoming_reply",
          route,
          incoming: queueIncomingSnapshot(incoming),
          captureSequence: proposedCaptureSequence,
          preparationKey
        }, {
          conversationId: channelKey,
          correlationId: `onebot:${incoming.messageId ?? preparationKey}`,
          idempotencyKey: `reply:${preparationKey}`
        })
      }, { schedule: false });

      try {
        const committedPayload = decodeIncomingReply(committed.event.payload);
        const captureSequence = committedPayload.captureSequence;
        const record = this.recordIncomingMessage(incoming, {
          expectedSequence: captureSequence,
          persist: false
        });
        this.consumeOrchestratorBatch(record, captureSequence);
        this.persistConversationRecords();
        this.cancelAmbientReply(channelKey);
        if (committed.event.status === "pending" || committed.event.status === "running") {
          const preparation = this.prepareIncomingMessage(incoming, gateway)
            .then(() => this.patchIncomingMessage(record, incoming))
            .catch((error) => {
              console.error("[runtime] prepare incoming message failed; continuing with degraded context", {
                channel: channelKey,
                messageId: incoming.messageId,
                error
              });
            })
            .finally(() => this.scheduleAttachmentCacheRefresh());
          this.incomingPreparations.set(preparationKey, { promise: preparation, incoming });
        }
        this.scheduleMemoryCompression(record);
      } finally {
        // The in-memory dedupe cursor is committed only after the durable event.
        // If post-commit bookkeeping fails, the queued event remains recoverable.
        this.markIncomingSeen(incoming);
        this.sessionCoordinator.resume();
      }
      return;
    }

    const captureSequence = this.incomingCaptureSequence(incoming);
    const record = this.recordIncomingMessage(incoming);
    this.markIncomingSeen(incoming);
    const preparation = this.prepareIncomingMessage(incoming, gateway)
      .then(() => this.patchIncomingMessage(record, incoming))
      .catch((error) => {
        console.error("[runtime] prepare incoming message failed; continuing with degraded context", {
          channel: channelKey,
          messageId: incoming.messageId,
          error
        });
      })
      .finally(() => this.scheduleAttachmentCacheRefresh());
    this.scheduleMemoryCompression(record);

    if (route === "ambient") {
      const thresholdReached = this.shouldRunUserGroupchatOrchestrator(incoming);
      void preparation.then(() => {
        if (!this.isReplyTaskCurrent(incoming, gate)) return;
        const job = { channelKey, incoming, gateway, captureSequence, gate };
        if (thresholdReached) this.queueAmbientReply(job);
        else this.scheduleAmbientIdleReply(job);
      }).finally(() => this.scheduleMemoryCompression(record));
      return;
    }

    void preparation.finally(() => this.scheduleMemoryCompression(record));
  }
export async function runtime_processSessionEvent(this: RuntimeHost,
    event: SessionEventRecord,
    coordinatorSignal: AbortSignal
  ): Promise<SessionHandleResult> {
    let timeoutIncoming: ParsedIncomingMessage | undefined;
    let controller: AbortController | undefined;
    try {
      return await withAbortTimeout(async (signal) => {
        if (event.kind === "incoming_reply") {
          const payload = decodeIncomingReply(event.payload);
          if (!isRuntimeIncomingMessage(payload.incoming)) {
            throw new Error(`Session 事件格式无效：${event.id}`);
          }
          timeoutIncoming = payload.incoming;
          return this.processIncomingReplyEvent(event, payload, signal);
        }
        if (event.kind === "tool_completion") {
          const payload = decodeToolCompletion(event.payload);
          timeoutIncoming = payload.originalRequest?.incoming;
          await appendRequestLog({
            category: "tool.call",
            action: payload.toolName,
            request: {
              jobId: payload.toolJobId,
              callId: payload.providerCallId,
              arguments: payload.arguments
            },
            response: payload.outcome,
            metadata: {
              conversationId: event.sessionId,
              stage: "async_tool_completion"
            }
          });
          const gateway = this.requireActiveGateway();
          const delivery: ReplyDelivery = { outbox: [] };
          await this.replyToToolCompletion(payload, gateway, signal, delivery);
          return delivery.outbox.length
            ? { status: "completed", outbox: delivery.outbox }
            : { status: "no_reply" };
        }
        throw new Error(`不支持的 Session 事件：${event.kind}`);
      }, DIRECT_REPLY_TIMEOUT_MS, (value) => {
        controller = value;
        this.activeDirectControllers.set(event.sessionId, value);
      }, coordinatorSignal);
    } catch (error) {
      if (!isAbortError(error) || !timeoutIncoming) throw error;
      if (!this.isReplySenderAllowed(timeoutIncoming.userId)) return { status: "no_reply" };
      const message = /timed out|timeout/i.test(errorMessage(error))
        ? "请求处理超时了，请稍后再试。"
        : "请求处理已取消。";
      return {
        status: "failed",
        error: { message: errorMessage(error) },
        outbox: [this.replyDeliveryDraft(
          timeoutIncoming,
          message,
          this.isAdminUser(timeoutIncoming.userId)
        )]
      };
    } finally {
      if (controller && this.activeDirectControllers.get(event.sessionId) === controller) {
        this.activeDirectControllers.delete(event.sessionId);
      }
    }
  }
export async function runtime_processIncomingReplyEvent(this: RuntimeHost,
    event: SessionEventRecord,
    payload: RuntimeIncomingReplyEventPayload,
    signal: AbortSignal
  ): Promise<SessionHandleResult> {
    const gateway = this.requireActiveGateway();
    const captureSequence = payload.captureSequence;
    const prepared = payload.preparationKey
      ? this.incomingPreparations.get(payload.preparationKey)
      : undefined;
    const incoming = prepared?.incoming ?? payload.incoming;
    if (!this.isReplySenderAllowed(incoming.userId)) {
      if (payload.preparationKey) this.incomingPreparations.delete(payload.preparationKey);
      return { status: "no_reply" };
    }
    // A crash can happen after the Session event commit and before the JSON
    // conversation snapshot. Rebuild that user message before creating context.
    const recoveredRecord = this.recordIncomingMessage(incoming, {
      expectedSequence: captureSequence,
      persist: false
    });
    this.consumeOrchestratorBatch(recoveredRecord, captureSequence);
    this.persistConversationRecords();
    this.markIncomingSeen(incoming);
    const channelKey = event.sessionId;
    const gate = this.replyGates.capture(incoming.scope, channelKey);
    const isCurrent = () => this.isReplyTaskCurrent(incoming, gate, signal);
    if (!isCurrent()) return { status: "no_reply" };

    try {
      if (prepared) {
        await prepared.promise;
      } else {
        await this.prepareIncomingMessage(incoming, gateway).catch((error) => {
          console.error("[runtime] recovered incoming preparation failed; continuing with degraded context", {
            channel: channelKey,
            eventId: event.id,
            error
          });
        });
      }
    } finally {
      if (payload.preparationKey) this.incomingPreparations.delete(payload.preparationKey);
    }
    if (!isCurrent()) return { status: "no_reply" };

    const command = payload.route === "command"
      ? this.commandRouter.match(incoming.text, uniqueStrings([
        ...this.config.onebot.mentionNames,
        this.persona?.name ?? "",
        incoming.selfId == null ? "" : String(incoming.selfId)
      ]))
      : undefined;
    const delivery: ReplyDelivery = { outbox: [] };
    let deferred: DeferredCodexTurn | undefined;
    await this.handleIncomingMessage(
      channelKey,
      incoming,
      gateway,
      captureSequence,
      signal,
      command,
      isCurrent,
      delivery,
      (value) => { deferred = value; }
    );
    if (deferred) {
      await appendRequestLog({
        category: "tool.call",
        action: "codex",
        request: {
          callId: deferred.deferred.toolCall.callId,
          arguments: deferred.deferred.toolCall.arguments
        },
        response: { status: "queued" },
        metadata: {
          conversationId: channelKey,
          incomingMessageId: incoming.messageId == null
            ? undefined
            : String(incoming.messageId),
          stage: "async_tool_submit"
        }
      });
      return {
        status: "deferred",
        providerCallId: deferred.deferred.toolCall.callId,
        arguments: deferred.deferred.toolCall.arguments,
        originalRequest: deferred.originalRequest,
        acknowledgement: deferred.acknowledgement,
        result: { acknowledgement: decodeAssistantReply(deferred.acknowledgement.payload).text }
      };
    }
    return delivery.outbox.length
      ? { status: "completed", outbox: delivery.outbox }
      : { status: "no_reply" };
  }
export async function runtime_deliverSessionOutbox(this: RuntimeHost, outbox: OutboxRecord, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new Error("Outbox delivery aborted.");
    if (outbox.kind !== "onebot.reply") throw new Error(`不支持的 outbox 类型：${outbox.kind}`);
    const payload = decodeAssistantReply(outbox.payload);
    if (!isRuntimeIncomingMessage(payload.incoming)) {
      throw new Error(`Outbox 消息格式无效：${outbox.id}`);
    }
    if (!this.isReplySenderAllowed(payload.incoming.userId)) {
      return { delivered: false, skipped: "sender_not_allowed" };
    }
    const gateway = this.activeGateway;
    if (!gateway?.getStatus().connected) throw new OutboxDisconnectedError("OneBot is not connected.");
    await this.deliverReplyOutbox(payload, gateway);
    return { delivered: true };
  }
export function runtime_requireActiveGateway(this: RuntimeHost) {
    if (!this.activeGateway) throw new OutboxDisconnectedError("OneBot is not connected.");
    return this.activeGateway;
  }
export async function runtime_handleIncomingMessage(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    captureSequence: number,
    signal: AbortSignal,
    command: CommandMatch<RuntimeCommandContext> | undefined = undefined,
    isCurrent: () => boolean = () => true,
    delivery?: ReplyDelivery,
    onDeferred?: (value: DeferredCodexTurn) => void
  ) {
    if (command) {
      try {
        await this.commandRouter.dispatch(command, { channelKey, incoming, gateway, signal, isCurrent, delivery });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.error("[runtime] command failed", {
          commandId: command.id,
          channel: channelKey,
          messageId: incoming.messageId,
          error
        });
        await this.sendErrorReply(incoming, gateway, error, isCurrent, undefined, delivery);
      }
      return;
    }

    await this.replyToIncoming(channelKey, incoming, gateway, {
      captureSequence,
      signal,
      isCurrent,
      delivery,
      onDeferred
    });
  }
export async function runtime_prepareIncomingMessage(this: RuntimeHost, incoming: ParsedIncomingMessage, gateway: MessagingPort) {
    await withAbortTimeout(async (signal) => {
      await this.senderNameResolver.hydrate(incoming, gateway);
      await this.attachReplyReferences(incoming, gateway, signal);
      if (!incoming.attachments.length) return;
      incoming.attachments = await this.attachmentService.processIncoming(
        incoming.attachments,
        attachmentSourcePort(gateway),
        incoming.text,
        incomingAttachmentReferenceScope(incoming)
      );
      incoming.quoteReferences = replaceQuoteAttachments(incoming.quoteReferences, incoming.attachments);
    }, PREPARE_TIMEOUT_MS);
  }

export class RuntimeIntake {
  constructor(private readonly host: RuntimeHost) {}
  hydrateConversationRecords(...args: Parameters<typeof runtime_hydrateConversationRecords>) { return runtime_hydrateConversationRecords.call(this.host, ...args); }
  performHydrateConversationRecords(...args: Parameters<typeof runtime_performHydrateConversationRecords>) { return runtime_performHydrateConversationRecords.call(this.host, ...args); }
  handleInboundMessage(...args: Parameters<typeof runtime_handleInboundMessage>) { return runtime_handleInboundMessage.call(this.host, ...args); }
  processSessionEvent(...args: Parameters<typeof runtime_processSessionEvent>) { return runtime_processSessionEvent.call(this.host, ...args); }
  processIncomingReplyEvent(...args: Parameters<typeof runtime_processIncomingReplyEvent>) { return runtime_processIncomingReplyEvent.call(this.host, ...args); }
  deliverSessionOutbox(...args: Parameters<typeof runtime_deliverSessionOutbox>) { return runtime_deliverSessionOutbox.call(this.host, ...args); }
  requireActiveGateway(...args: Parameters<typeof runtime_requireActiveGateway>) { return runtime_requireActiveGateway.call(this.host, ...args); }
  handleIncomingMessage(...args: Parameters<typeof runtime_handleIncomingMessage>) { return runtime_handleIncomingMessage.call(this.host, ...args); }
  prepareIncomingMessage(...args: Parameters<typeof runtime_prepareIncomingMessage>) { return runtime_prepareIncomingMessage.call(this.host, ...args); }
}
