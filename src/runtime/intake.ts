import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import {
  decodeAssistantReply,
  decodeIncomingReply,
  decodeNoReplyPoke,
  decodeToolCompletion,
  type ReplyQuoteSnapshotV1,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import { commandInvocationSnapshot, type CommandMatch } from "../../services/messaging/commandRouter.js";
import { readReplyGateSnapshot } from "../../services/orchestration/groupReplyPolicy.js";
import {
  OutboxDisconnectedError,
  type OutboxDeliveryContext,
  type SessionHandleResult,
  type SessionTurnContext
} from "../../services/sessions/sessionCoordinator.js";
import type { OutboxRecord, SessionEventRecord } from "../../services/sessions/sessionStore.js";
import { appendRequestLog, appendRequestLogStrict } from "../../adapters/observability/requestLog.js";
import {
  type ConversationRecord,
  type ParsedIncomingMessage
} from "../types.js";
import {
  conversationRecordSnapshot,
  handleInboundConversationGate,
  restoreConversationRecord
} from "./inboundConversationGate.js";
import { errorMessage, isAbortError, isRuntimeIncomingMessage, withAbortTimeout } from "./infrastructure.js";
import { appendReplySoftError } from "./replyModuleIsolation.js";
import {
  attachmentSourcePort,
  conversationMessageAttachments,
  conversationRecordId,
  conversationReplyEnabled,
  incomingAttachmentReferenceScope,
  incomingConversationMessageId,
  isNumericMessageId,
  isRecentMessageForHydration,
  mergeAttachments,
  mergeConversationMessageDetails,
  persistentIncomingKey,
  replaceQuoteAttachments,
  uniqueAttachments,
  uniqueStrings
} from "./messagingAttachmentHelpers.js";
import {
  DIRECT_REPLY_TIMEOUT_MS,
  PREPARE_TIMEOUT_MS,
  type DeferredCodexTurn,
  type ReplyDelivery,
  type RuntimeCommandContext
} from "./runtimeContracts.js";
import {
  SCHEDULED_CALLBACK_EVENT_KIND,
  SCHEDULED_CALLBACK_OUTBOX_KIND
} from "./scheduledTasks.js";
import { conversationLastText } from "./selfieHelpers.js";
import { populateInboundImageAltTexts } from "./imageAltText.js";
import {
  createSystemConfigHeldConfirmationPort,
  sameCanonicalOutbox,
  validateHeldSystemConfigConfirmation
} from "./systemConfigReply.js";

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
          ...(target.record.accountId ? { accountId: target.record.accountId } : {}),
          source: "message",
          groupId: target.record.groupId,
          userId: target.message.userId ?? target.record.userId
        });
        let quoteReferences = await this.loadQuoteReferences(
          gateway,
          details.replyMessageIds,
          {
            ...(target.record.accountId ? { accountId: target.record.accountId } : {}),
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
            attachmentSourcePort(gateway, target.record.accountId),
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
    const existingConversation = this.conversationRecords.get(channelKey);
    if (existingConversation && !conversationReplyEnabled(existingConversation)) {
      this.markIncomingSeen(incoming);
      return;
    }

    const activeDebounceConversation = this.recoverActiveReplyDebounceConversation(incoming);
    const durableMessageId = incomingConversationMessageId(incoming);
    const gate = this.replyGates.capture(incoming.scope, channelKey);
    const command = this.commandRouter.match(incoming.text, uniqueStrings([
      ...this.config.onebot.mentionNames,
      this.persona?.name ?? "",
      incoming.selfId == null ? "" : String(incoming.selfId)
    ]));
    const route = this.resolveIncomingReplyRoute(incoming, Boolean(command));
    if (await handleInboundConversationGate(
      this, incoming, gateway, activeDebounceConversation, durableMessageId
    )) return;

    if (this.handleActiveReplyDebounceIncoming(incoming, gateway)) return;

    if (route === "command" || route === "direct") {
      const proposedCaptureSequence = this.incomingCaptureSequence(incoming);
      const preparationKey = persistentIncomingKey(incoming);
      this.scheduleReplyDebounce({
        route,
        incoming,
        captureSequence: proposedCaptureSequence,
        preparationKey,
        gate,
        ...(command ? { commandInvocation: commandInvocationSnapshot(command) } : {})
      });

      const rollback = activeDebounceConversation
        ? conversationRecordSnapshot(activeDebounceConversation)
        : undefined;
      let incomingPersisted = !activeDebounceConversation;
      try {
        const record = this.recordIncomingMessage(incoming, {
          expectedSequence: proposedCaptureSequence,
          persist: false
        });
        if (incoming.scope === "user_group" && this.config.bot.orchestrator.enabled) {
          record.orchestratorEnabled = true;
        }
        this.consumeOrchestratorBatch(record, proposedCaptureSequence);
        if (activeDebounceConversation) this.persistConversationRecordStrict(record);
        else this.persistConversationRecords();
        incomingPersisted = true;
        this.cancelAmbientReply(channelKey);
        const preparation = this.prepareIncomingMessage(incoming, gateway)
          .then(() => this.patchIncomingMessage(record, incoming, durableMessageId))
          .catch((error) => {
            console.error("[runtime] prepare incoming message failed; continuing with degraded context", {
              channel: channelKey,
              messageId: incoming.messageId,
              error
            });
          })
          .finally(() => this.scheduleAttachmentCacheRefresh());
        this.incomingPreparations.set(preparationKey, { promise: preparation, incoming });
        this.trackReplyDebouncePreparation(incoming, preparation);
        this.scheduleMemoryCompression(record);
      } catch (error) {
        if (rollback && activeDebounceConversation && !incomingPersisted) {
          restoreConversationRecord(activeDebounceConversation, rollback);
        }
        throw error;
      } finally {
        // The in-memory dedupe cursor is committed only after the durable event.
        // If post-commit bookkeeping fails, the queued event remains recoverable.
        if (incomingPersisted) this.markIncomingSeen(incoming);
        this.sessionCoordinator.resume(incoming.accountId ?? "primary");
      }
      return;
    }

    const captureSequence = this.incomingCaptureSequence(incoming);
    const rollback = activeDebounceConversation
      ? conversationRecordSnapshot(activeDebounceConversation)
      : undefined;
    let record: ConversationRecord;
    try {
      record = this.recordIncomingMessage(incoming, {
        expectedSequence: captureSequence,
        persist: !activeDebounceConversation
      });
      if (activeDebounceConversation) this.persistConversationRecordStrict(record);
    } catch (error) {
      if (rollback && activeDebounceConversation) {
        restoreConversationRecord(activeDebounceConversation, rollback);
      }
      throw error;
    }
    this.markIncomingSeen(incoming);
    const preparation = this.prepareIncomingMessage(incoming, gateway)
      .then(() => this.patchIncomingMessage(record, incoming, durableMessageId))
      .catch((error) => {
        console.error("[runtime] prepare incoming message failed; continuing with degraded context", {
          channel: channelKey,
          messageId: incoming.messageId,
          error
        });
      })
      .finally(() => this.scheduleAttachmentCacheRefresh());
    this.trackReplyDebouncePreparation(incoming, preparation);
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
    turnContext: SessionTurnContext
  ): Promise<SessionHandleResult> {
    const coordinatorSignal = turnContext.signal;
    let timeoutIncoming: ParsedIncomingMessage | undefined;
    let timeoutReplyQuote: ReplyQuoteSnapshotV1 | undefined;
    let controller: AbortController | undefined;
    try {
      return await withAbortTimeout(async (signal) => {
        if (event.kind === SCHEDULED_CALLBACK_EVENT_KIND) {
          return this.scheduledTasks.processEvent(event, turnContext);
        }
        if (event.kind === "reply_debounce") {
          return this.processReplyDebounceEvent(event, event.payload, signal);
        }
        if (event.kind === "incoming_reply") {
          const payload = decodeIncomingReply(event.payload);
          if (!isRuntimeIncomingMessage(payload.incoming)) {
            throw new Error(`Session 事件格式无效：${event.id}`);
          }
          timeoutIncoming = payload.incoming;
          timeoutReplyQuote = payload.replyQuote;
          return this.processIncomingReplyEvent(
            event,
            payload,
            signal,
            turnContext.emitOutbox,
            turnContext.emitDeferredOutbox,
            turnContext.appendHeldOutbox
          );
        }
        if (event.kind === "tool_completion") {
          const payload = decodeToolCompletion(event.payload);
          timeoutIncoming = payload.originalRequest?.incoming;
          timeoutReplyQuote = payload.originalRequest?.replyQuote;
          const expectedAgentId = this.config.persona.defaultAgentId.trim();
          if (
            !timeoutIncoming ||
            conversationRecordId(timeoutIncoming) !== event.sessionId ||
            (timeoutIncoming.agentId != null && timeoutIncoming.agentId !== expectedAgentId) ||
            !this.isReplySenderAllowed(timeoutIncoming.userId)
          ) return { status: "no_reply" };
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
          const delivery: ReplyDelivery = {
            outbox: [],
            emitOutbox: turnContext.emitOutbox,
            ...(payload.originalRequest.replyQuote ? { replyQuote: payload.originalRequest.replyQuote } : {})
          };
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
      if (
        !this.isReplySenderAllowed(timeoutIncoming.userId)
      ) return { status: "no_reply" };
      const message = /timed out|timeout/i.test(errorMessage(error))
        ? "请求处理超时了，请稍后再试。"
        : "请求处理已取消。";
      let tonedMessage = message;
      try {
        tonedMessage = await this.rewriteToneText(message, {
          incoming: timeoutIncoming,
          logContext: {
            conversationId: event.sessionId,
            incomingMessageId: timeoutIncoming.messageId == null
              ? undefined
              : String(timeoutIncoming.messageId)
          }
        });
      } catch (toneError) {
        console.error("[runtime] timeout reply tone unavailable", { error: toneError });
        tonedMessage = appendReplySoftError(message, "表达优化暂不可用");
      }
      return {
        status: "failed",
        error: { message: errorMessage(error) },
        outbox: [this.replyDeliveryDraft(
          timeoutIncoming,
          tonedMessage,
          this.isAdminUser(timeoutIncoming.userId),
          [],
          undefined,
          undefined,
          true,
          undefined,
          timeoutReplyQuote
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
    signal: AbortSignal,
    emitOutbox?: ReplyDelivery["emitOutbox"],
    emitDeferredOutbox?: ReplyDelivery["emitDeferredOutbox"],
    appendHeldOutbox?: SessionTurnContext["appendHeldOutbox"]
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
    const recoveredRecord = this.recoverReplyDebounceMessages(payload);
    const contextThroughSequence = payload.contextThroughSequence ?? captureSequence;
    this.consumeOrchestratorBatch(recoveredRecord, contextThroughSequence);
    this.persistConversationRecords();
    this.markIncomingSeen(incoming);
    const channelKey = event.sessionId;
    const gate = readReplyGateSnapshot(payload.replyGate, incoming.scope, channelKey);
    if (!gate) {
      throw new Error(`Session 回复门禁快照无效：${event.id}`);
    }
    const isCurrent = () => this.isReplyTaskCurrent(incoming, gate, signal);
    if (!isCurrent()) {
      this.clearReplyDebouncePreparation(payload);
      return { status: "no_reply" };
    }

    try {
      this.prepareReplyDebounceMessages(payload, gateway);
      if (prepared) await prepared.promise;
      await this.waitForReplyDebouncePreparations(incoming, contextThroughSequence);
    } finally {
      this.clearReplyDebouncePreparation(payload);
    }
    if (!isCurrent()) return { status: "no_reply" };

    const command = payload.commandInvocation
      ? this.commandRouter.restore(payload.commandInvocation)
      : undefined;
    const delivery: ReplyDelivery = {
      outbox: [],
      emitOutbox,
      emitDeferredOutbox,
      replyQuote: payload.replyQuote,
      systemConfigHeld: createSystemConfigHeldConfirmationPort(this, appendHeldOutbox)
    };
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
      (value) => { deferred = value; },
      payload.contextThroughSequence,
      payload.orchestratorResult
    );
    if (deferred) {
      await appendRequestLog({
        category: "tool.call",
        action: deferred.deferred.toolCall.name,
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
        ...(deferred.jobId ? { jobId: deferred.jobId } : {}),
        providerCallId: deferred.deferred.toolCall.callId,
        toolName: deferred.deferred.toolCall.name,
        arguments: deferred.deferred.toolCall.arguments,
        originalRequest: deferred.originalRequest,
        acknowledgement: deferred.acknowledgement,
        result: { acknowledgement: decodeAssistantReply(deferred.acknowledgement.payload).text }
      };
    }
    if (delivery.terminalStatus === "no_reply") {
      return { status: "no_reply", ...(delivery.outbox.length ? { outbox: delivery.outbox } : {}) };
    }
    if (delivery.terminalStatus === "replied") return { status: "completed" };
    return delivery.outbox.length
      ? { status: "completed", outbox: delivery.outbox }
      : { status: "no_reply" };
  }
export async function runtime_deliverSessionOutbox(
  this: RuntimeHost,
  outbox: OutboxRecord,
  delivery: OutboxDeliveryContext | AbortSignal
) {
  const context = isOutboxDeliveryContext(delivery) ? delivery : undefined;
  const signal = context?.signal ?? delivery as AbortSignal;
  if (signal.aborted) throw signal.reason ?? new Error("Outbox delivery aborted.");
  if (context) {
    const canonical = this.sessionStore.getOutbox(outbox.id);
    if (!canonical || !sameCanonicalOutbox(canonical, outbox)) {
      throw new Error(`Outbox ${outbox.id} canonical record changed before delivery.`);
    }
    outbox = canonical;
  }
  if (outbox.kind === SCHEDULED_CALLBACK_OUTBOX_KIND) {
    if (!context) throw new Error("Scheduled callback delivery requires a durable outbox context.");
    return this.scheduledTasks.deliverOutbox(outbox, context);
  }
  if (outbox.kind === "onebot.conversation_asset") {
    return this.deliverConversationAssetOutbox(outbox, delivery);
  }
    if (outbox.kind === "onebot.poke") {
      const payload = decodeNoReplyPoke(outbox.payload);
      if (!isRuntimeIncomingMessage(payload.incoming)) {
        throw new Error(`Outbox 消息格式无效：${outbox.id}`);
      }
      if (context?.phase !== "settle" && !this.isReplySenderAllowed(payload.incoming.userId)) {
        return { delivered: false, skipped: "sender_not_allowed" };
      }
      const conversationId = conversationRecordId(payload.incoming);
      const gate = readReplyGateSnapshot(payload.replyGate, payload.incoming.scope, conversationId) ??
        this.replyGates.capture(payload.incoming.scope, conversationId);
      if (context?.phase !== "settle" && !this.isReplyTaskCurrent(payload.incoming, gate, signal)) {
        return { delivered: false, skipped: "reply_gate_closed" };
      }
      const gateway = this.activeGateway;
      if (context?.phase === "send" || !context) {
        if (!gateway || !isOutboxAccountConnected(gateway, payload.incoming.accountId)) {
          throw new OutboxDisconnectedError("OneBot is not connected.");
        }
        if (!gateway.poke) throw new Error("当前消息适配器不支持戳一戳。");
        const sendPoke = () => gateway.poke!({
          ...(payload.incoming.accountId ? { accountId: payload.incoming.accountId } : {}),
          userId: payload.incoming.userId,
          ...(payload.incoming.groupId ? { groupId: payload.incoming.groupId } : {})
        });
        if (context) await context.sendRemote(sendPoke);
        else await sendPoke();
      }
      const settleLog = () => appendRequestLog({
        category: "runtime.action",
        action: "reply.no_reply.poke.sent",
        request: {
          scope: payload.incoming.scope,
          userId: payload.incoming.userId,
          groupId: payload.incoming.groupId
        },
        response: { status: "sent" },
        metadata: {
          conversationId: conversationRecordId(payload.incoming),
          incomingMessageId: payload.incoming.messageId == null ? undefined : String(payload.incoming.messageId),
          runId: payload.logRunId,
          stage: "reply"
        }
      });
      if (context) await context.settleStep("request_log", (idempotencyKey) => appendRequestLogStrict({
        category: "runtime.action",
        action: "reply.no_reply.poke.sent",
        request: {
          scope: payload.incoming.scope,
          userId: payload.incoming.userId,
          groupId: payload.incoming.groupId
        },
        response: { status: "sent" },
        metadata: {
          conversationId: conversationRecordId(payload.incoming),
          incomingMessageId: payload.incoming.messageId == null ? undefined : String(payload.incoming.messageId),
          runId: payload.logRunId,
          stage: "reply"
        }
      }, idempotencyKey));
      else await settleLog();
      return { delivered: true, ...(context ? { remoteReceipt: context.remoteReceipt } : {}) };
    }
    if (outbox.kind !== "onebot.reply") throw new Error(`不支持的 outbox 类型：${outbox.kind}`);
    const payload = decodeAssistantReply(outbox.payload);
    if (!isRuntimeIncomingMessage(payload.incoming)) {
      throw new Error(`Outbox 消息格式无效：${outbox.id}`);
    }
    if (this.scheduledTasks.isDisabledDirectorReply(payload.incoming.text)) {
      return { delivered: true };
    }
    if (context?.phase !== "settle" && !this.isReplySenderAllowed(payload.incoming.userId)) {
      return { delivered: false, skipped: "sender_not_allowed" };
    }
    const conversationId = conversationRecordId(payload.incoming);
    const gate = readReplyGateSnapshot(payload.replyGate, payload.incoming.scope, conversationId) ??
      this.replyGates.capture(payload.incoming.scope, conversationId);
    const heldSystemConfig = validateHeldSystemConfigConfirmation(
      this,
      outbox,
      payload,
      context?.phase !== "settle",
      signal
    );
    if (
      context?.phase !== "settle" &&
      (heldSystemConfig
        ? !heldSystemConfig.current
        : !this.isReplyTaskCurrent(payload.incoming, gate, signal))
    ) {
      return { delivered: false, skipped: "reply_gate_closed" };
    }
    const gateway = this.activeGateway;
    if (context?.phase !== "settle" && (
      !gateway || !isOutboxAccountConnected(gateway, payload.incoming.accountId)
    )) {
      throw new OutboxDisconnectedError("OneBot is not connected.");
    }
    await this.deliverReplyOutbox(payload, gateway, context);
    return { delivered: true, ...(context ? { remoteReceipt: context.remoteReceipt } : {}) };
  }

function isOutboxDeliveryContext(value: OutboxDeliveryContext | AbortSignal): value is OutboxDeliveryContext {
  return typeof (value as OutboxDeliveryContext).sendRemote === "function";
}

function isOutboxAccountConnected(gateway: MessagingPort, accountId?: string) {
  const status = gateway.getStatus();
  if (!status.connected) return false;
  if (!accountId || !status.accounts) return true;
  return status.accounts.some((account) => account.accountId === accountId);
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
    onDeferred?: (value: DeferredCodexTurn) => void,
    contextThroughSequence?: number,
    orchestratorResult?: RuntimeIncomingReplyEventPayload["orchestratorResult"]
  ) {
    if (command) {
      try {
        await this.commandRouter.dispatch(command, {
          channelKey,
          incoming,
          gateway,
          signal,
          isCurrent,
          delivery,
          contextThroughSequence
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        console.error("[runtime] command failed", {
          commandId: command.id,
          channel: channelKey,
          messageId: incoming.messageId,
          error
        });
        await this.sendErrorReply(incoming, gateway, error, isCurrent, undefined, delivery, { messageOrigin: "text" }, signal);
      }
      return;
    }

    await this.replyToIncoming(channelKey, incoming, gateway, {
      captureSequence,
      contextThroughSequence,
      signal,
      isCurrent,
      delivery,
      onDeferred,
      orchestratorResult
    });
  }
export async function runtime_prepareIncomingMessage(this: RuntimeHost, incoming: ParsedIncomingMessage, gateway: MessagingPort) {
    await withAbortTimeout(async (signal) => {
      await this.senderNameResolver.hydrate(incoming, gateway);
      await this.attachReplyReferences(incoming, gateway, signal);
      if (incoming.attachments.length) {
        incoming.attachments = await this.attachmentService.processIncoming(
          incoming.attachments,
          attachmentSourcePort(gateway, incoming.accountId),
          incoming.text,
          incomingAttachmentReferenceScope(incoming)
        );
        incoming.quoteReferences = replaceQuoteAttachments(incoming.quoteReferences, incoming.attachments);
      }
      await populateInboundImageAltTexts(this, incoming, {
        signal,
        logContext: {
          conversationId: conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          stage: "image_alt_text",
          promptFamily: "image.alt-text"
        }
      });
    }, PREPARE_TIMEOUT_MS);
  }
