import { nanoid } from "nanoid";
import {
  inboundImageAltTexts,
  inboundImageUrls,
  type MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import { senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import { isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import {
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute,
  type ReplyGateSnapshot
} from "../../services/orchestration/groupReplyPolicy.js";
import {
  parseUserGroupOrchestratorDecision,
  userGroupOrchestratorResult
} from "../../services/orchestration/userGroupOrchestratorResult.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import {
  ConversationRecord,
  ParsedIncomingMessage
} from "../types.js";
import { adminIdentityFromBot, appendConversationMessage, hasIncomingReplyContent, indexedConversationMessages, isAdminUserId, isExplicitWakeMessage, isModelVisibleConversationMessage, resolveRuntimePersonaName, toContextChatMessage } from "./conversationMemoryHelpers.js";
import { errorMessage, isAbortError, sanitizeErrorDetail, withAbortTimeout } from "./infrastructure.js";
import { conversationOrchestratorEnabled, conversationOrchestratorResponseTimeMs, conversationRecordId, conversationReplyEnabled, incomingConversationMessageId, persistedAttachments, persistedQuoteReferences, persistentIncomingKey, restoredGroupIncoming, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { AMBIENT_ORCHESTRATOR_TIMEOUT_MS, AdminIdentity, AmbientReplyJob, AmbientReplyState, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, ORCHESTRATOR_MAX_RETRIES } from "./runtimeContracts.js";
import { conversationLastText } from "./selfieHelpers.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export function runtime_adminIdentity(this: RuntimeHost): AdminIdentity {
    return adminIdentityFromBot(this.config.bot);
  }
export function runtime_isReplySenderAllowed(this: RuntimeHost, userId: number | string) {
    return isReplySenderAllowed(userId, this.config.bot.adminQq);
  }
export function runtime_isDuplicateIncoming(this: RuntimeHost, incoming: ParsedIncomingMessage) {
    const now = Date.now();
    for (const [key, seenAt] of this.seenIncomingEvents) {
      if (now - seenAt > DEDUPE_TTL_MS) this.seenIncomingEvents.delete(key);
    }
    return this.seenIncomingEvents.has(persistentIncomingKey(incoming));
  }
export function runtime_markIncomingSeen(this: RuntimeHost, incoming: ParsedIncomingMessage) {
    const key = persistentIncomingKey(incoming);
    this.seenIncomingEvents.set(key, Date.now());
    while (this.seenIncomingEvents.size > MAX_DEDUPE_KEYS) {
      const oldest = this.seenIncomingEvents.keys().next().value;
      if (oldest == null) break;
      this.seenIncomingEvents.delete(oldest);
    }
  }
export function runtime_resolveIncomingReplyRoute(this: RuntimeHost, incoming: ParsedIncomingMessage, command: boolean) {
    if (
      !this.replyTaskGate.canCreateTaskFor(incoming.time) ||
      !this.isReplySenderAllowed(incoming.userId) ||
      !hasIncomingReplyContent(incoming)
    ) return "none" as const;
    if (incoming.scope === "private") {
      if (!this.config.onebot.autoReplyPrivate) return "none" as const;
      return command ? "command" as const : "direct" as const;
    }
    if (incoming.scope === "bot_group") {
      if (!this.config.onebot.autoReplyBotGroup) return "none" as const;
      return command ? "command" as const : "direct" as const;
    }
    return resolveUserGroupReplyRoute({
      enabled: this.config.onebot.autoReplyUserGroup,
      command,
      explicitRule: incoming.mentionedSelf || isExplicitWakeMessage(
        incoming.text,
        this.config.onebot.commandPrefixes,
        this.config.onebot.mentionNames
      ),
      orchestratorEnabled: this.config.bot.orchestrator.enabled && conversationOrchestratorEnabled(
        this.conversationRecords.get(conversationRecordId(incoming))
      )
    });
  }
export function runtime_isReplyTaskCurrent(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    gate: ReplyGateSnapshot,
    signal?: AbortSignal
  ) {
    if (
      signal?.aborted ||
      !this.isReplySenderAllowed(incoming.userId) ||
      !this.replyGates.isCurrent(gate)
    ) return false;
    const record = this.conversationRecords.get(gate.conversationId);
    if (!record || !conversationReplyEnabled(record)) return false;
    if (incoming.scope === "private") return this.config.onebot.autoReplyPrivate;
    if (incoming.scope === "bot_group") return this.config.onebot.autoReplyBotGroup;
    return this.config.onebot.autoReplyUserGroup;
  }
export function runtime_cancelScopeReplies(this: RuntimeHost, scope: ParsedIncomingMessage["scope"]) {
    this.replyGates.invalidateScope(scope);
    for (const record of this.conversationRecords.values()) {
      if (record.scope !== scope) continue;
      this.activeDirectControllers.get(record.id)?.abort(new Error(`${scope} replies disabled`));
      this.cancelAmbientReply(record.id);
    }
  }
export function runtime_cancelAllAmbientReplies(this: RuntimeHost) {
    const channelKeys = new Set([
      ...this.ambientReplies.keys(),
      ...this.ambientIdleTimers.keys()
    ]);
    for (const channelKey of channelKeys) {
      this.cancelAmbientReply(channelKey);
    }
  }
export function runtime_resumeUserGroupOrchestrators(this: RuntimeHost, gateway: MessagingPort) {
    this.activeGateway = gateway;
    this.sessionCoordinator.resume();
    let initialized = false;
    for (const record of this.conversationRecords.values()) {
      if (
        record.scope !== "user_group" ||
        !record.groupId ||
        !this.config.bot.orchestrator.enabled ||
        !this.config.onebot.autoReplyUserGroup ||
        !conversationReplyEnabled(record) ||
        !conversationOrchestratorEnabled(record)
      ) continue;

      if (typeof record.orchestratorCheckedMessageCount !== "number") {
        record.orchestratorCheckedMessageCount = record.messageCount;
        record.orchestratorCheckedAt = new Date().toISOString();
        initialized = true;
        continue;
      }

      const pending = this.pendingOrchestratorUserMessages(record);
      const latest = pending.at(-1);
      if (!latest) continue;
      const incoming = restoredGroupIncoming(record, latest.message);
      if (!incoming || !this.isReplySenderAllowed(incoming.userId)) continue;
      const job: AmbientReplyJob = {
        channelKey: record.id,
        incoming,
        gateway,
        captureSequence: latest.sequence,
        gate: this.replyGates.capture("user_group", record.id)
      };
      if (pending.length > this.config.bot.orchestrator.messageThreshold) {
        this.queueAmbientReply(job);
      } else {
        this.scheduleAmbientIdleReply(job);
      }
    }
    if (initialized) this.persistConversationRecords();
  }
export function runtime_suspendUserGroupOrchestrators(this: RuntimeHost) {
    this.cancelAllAmbientReplies();
  }
export function runtime_patchIncomingMessage(
  this: RuntimeHost,
  record: ConversationRecord,
  incoming: ParsedIncomingMessage,
  frozenMessageId = incomingConversationMessageId(incoming)
) {
    const message = [...record.messages].reverse().find((item) => (
      item.role === "user" && item.id === frozenMessageId
    ));
    if (!message) return;
    const identity = senderIdentity(incoming.sender);
    message.text = incoming.text || (inboundImageUrls(incoming).length ? "[图片]" : incoming.attachments.length ? "[文件]" : "[消息]");
    message.senderName = senderDisplayName(incoming.sender);
    message.senderNickname = identity.nickname || undefined;
    message.senderCard = identity.card || undefined;
    message.imageUrls = inboundImageUrls(incoming);
    message.imageAltTexts = inboundImageAltTexts(incoming);
    message.attachments = persistedAttachments(incoming.attachments);
    message.replyMessageIds = incoming.replyMessageIds;
    message.quoteReferences = persistedQuoteReferences(incoming.quoteReferences);
    record.lastText = conversationLastText(record.messages[record.messages.length - 1]);
    this.persistConversationRecords();
  }
export function runtime_shouldRunUserGroupchatOrchestrator(this: RuntimeHost, incoming: ParsedIncomingMessage) {
    if (!incoming.groupId) return false;
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    if (!record) return false;

    const lastCheckedCount = record.orchestratorCheckedMessageCount;
    if (typeof lastCheckedCount !== "number") {
      record.orchestratorCheckedMessageCount = Math.max(0, record.messageCount - 1);
      record.orchestratorCheckedAt = new Date().toISOString();
      this.persistConversationRecords();
    }

    return this.pendingOrchestratorUserMessages(record).length > this.config.bot.orchestrator.messageThreshold;
  }
export function runtime_pendingOrchestratorUserMessages(this: RuntimeHost, record: ConversationRecord, throughSequence = Number.POSITIVE_INFINITY) {
    const checkedMessageCount = typeof record.orchestratorCheckedMessageCount === "number"
      ? record.orchestratorCheckedMessageCount
      : record.messageCount;
    return indexedConversationMessages(record)
      .filter(({ sequence, message }) => (
        message.role === "user" &&
        sequence > checkedMessageCount &&
        sequence <= throughSequence
      ));
  }
export function runtime_scheduleAmbientIdleReply(this: RuntimeHost, job: AmbientReplyJob) {
    this.cancelAmbientIdleTimer(job.channelKey);
    const record = this.conversationRecords.get(job.channelKey);
    const pending = record
      ? this.pendingOrchestratorUserMessages(record, job.captureSequence)
      : [];
    const latest = pending.at(-1);
    if (!latest) return;
    const lastMessageAt = Date.parse(latest.message.at);
    const elapsed = Number.isFinite(lastMessageAt) ? Math.max(0, Date.now() - lastMessageAt) : 0;
    const responseTimeMs = conversationOrchestratorResponseTimeMs(
      record,
      this.config.bot.orchestrator.recentMessageWindowMs
    );
    const delay = Math.max(0, responseTimeMs - elapsed);
    const timer = setTimeout(() => {
      this.ambientIdleTimers.delete(job.channelKey);
      if (!this.isReplyTaskCurrent(job.incoming, job.gate)) return;
      const currentRecord = this.conversationRecords.get(job.channelKey);
      if (!currentRecord || !this.pendingOrchestratorUserMessages(currentRecord, job.captureSequence).length) return;
      this.queueAmbientReply(job);
    }, delay);
    timer.unref();
    this.ambientIdleTimers.set(job.channelKey, { timer, job });
  }
export function runtime_cancelAmbientIdleTimer(this: RuntimeHost, channelKey: string) {
    const idle = this.ambientIdleTimers.get(channelKey);
    if (!idle) return;
    clearTimeout(idle.timer);
    this.ambientIdleTimers.delete(channelKey);
  }
export function runtime_queueAmbientReply(this: RuntimeHost, job: AmbientReplyJob) {
    if (!this.isReplySenderAllowed(job.incoming.userId)) return;
    this.cancelAmbientIdleTimer(job.channelKey);
    const state = this.ambientReplies.get(job.channelKey) ?? { epoch: 0, running: false };
    state.next = job;
    this.ambientReplies.set(job.channelKey, state);
    if (!state.running) void this.pumpAmbientReply(job.channelKey, state);
  }
export async function runtime_pumpAmbientReply(this: RuntimeHost, channelKey: string, state: AmbientReplyState) {
    const job = state.next;
    if (!job || state.running) return;
    state.next = undefined;
    state.running = true;
    const epoch = state.epoch;
    const record = this.conversationRecords.get(channelKey);

    try {
      if (
        !record ||
        !this.isReplyTaskCurrent(job.incoming, job.gate) ||
        isOrchestratorReplyRateLimited(record.orchestratorLastReplyAt)
      ) return;
      state.deciding = true;
      const controller = new AbortController();
      state.controller = controller;
      const orchestratorResult = await this.ambientLimiter.run(() => this.runUserGroupchatOrchestrator(job.incoming, {
        signal: controller.signal,
        captureSequence: job.captureSequence
      }));
      state.deciding = false;
      state.controller = undefined;
      if (!orchestratorResult || !this.isAmbientReplyCurrent(job, state, epoch)) return;
      if (isOrchestratorReplyRateLimited(record.orchestratorLastReplyAt)) return;

      if (!this.isAmbientReplyCurrent(job, state, epoch)) return;
      if (this.activeReplyDebounce(job.incoming)) return;
      this.scheduleReplyDebounce({
        route: "ambient",
        incoming: job.incoming,
        captureSequence: job.captureSequence,
        gate: job.gate,
        orchestratorResult
      });
      this.consumeOrchestratorBatch(record, job.captureSequence);
      record.orchestratorLastReplyAt = new Date().toISOString();
      this.persistConversationRecords();
      this.sessionCoordinator.resume(job.incoming.accountId ?? "primary");
    } catch (error) {
      state.deciding = false;
      if (!isAbortError(error)) console.error("[runtime] ambient reply failed", { channel: channelKey, error });
    } finally {
      state.deciding = false;
      state.controller = undefined;
      state.running = false;
      if (state.next) {
        void this.pumpAmbientReply(channelKey, state);
      } else if (this.ambientReplies.get(channelKey) === state) {
        this.ambientReplies.delete(channelKey);
      }
    }
  }
export function runtime_isAmbientReplyCurrent(this: RuntimeHost, job: AmbientReplyJob, state: AmbientReplyState, epoch: number) {
    const record = this.conversationRecords.get(job.channelKey);
    return state.epoch === epoch &&
      state.next == null &&
      this.config.bot.orchestrator.enabled &&
      conversationOrchestratorEnabled(record) &&
      this.isReplyTaskCurrent(job.incoming, job.gate);
  }
export function runtime_cancelAmbientReply(this: RuntimeHost, channelKey: string) {
    this.cancelAmbientIdleTimer(channelKey);
    const state = this.ambientReplies.get(channelKey);
    if (!state) return;
    state.epoch += 1;
    state.next = undefined;
    state.controller?.abort(new Error("ambient reply cancelled"));
  }
function injectImageTokens(text: string, imageCount: number) {
    const existingTokenCount = text.match(
      /\[(?:图片|内容图片(?:#\d+)?(?:：[^\]]*)?|表情图片(?:#\d+)?(?:：[^\]]*)?)\]/g
    )?.length ?? 0;
    const missingTokenCount = Math.max(0, Math.floor(imageCount) - existingTokenCount);
    if (!missingTokenCount) return text;
    return [
      text.trim(),
      Array.from({ length: missingTokenCount }, () => "[图片]").join(" ")
    ].filter(Boolean).join(" ");
  }
export async function runtime_runUserGroupchatOrchestrator(this: RuntimeHost,
    incoming: ParsedIncomingMessage,
    options: { signal?: AbortSignal; captureSequence?: number } = {}
  ) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    if (!record) return undefined;
    let consumeBatch = false;
    let lastAttempt = 0;
    const logRunId = nanoid();
    const logContext = {
      conversationId: record.id,
      incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
      runId: logRunId,
      stage: "orchestrator",
      promptFamily: "orchestrator.user-group"
    };
    const responseTimeMs = conversationOrchestratorResponseTimeMs(
      record,
      this.config.bot.orchestrator.recentMessageWindowMs
    );

    try {
      const replyCandidateMessageIds = this.pendingOrchestratorUserMessages(
        record,
        options.captureSequence
      ).map(({ message }) => message.id);
      if (!replyCandidateMessageIds.length) return undefined;
      const provider = this.getProviderForModel(
        this.config.bot.orchestrator.userGroupchatOrchestratorModel,
        this.config.bot.orchestrator.reasoningEffort
      );
      const payload = {
        systemTimeZone: systemModelTimeZone(),
        agent: {
          name: resolveRuntimePersonaName(this.persona?.name, this.config.persona.name),
          wakeWords: uniqueStrings([
            ...this.config.onebot.commandPrefixes,
            ...this.config.onebot.mentionNames
          ])
        },
        trigger: {
          wakeWordHit: false,
          messageThreshold: this.config.bot.orchestrator.messageThreshold,
          recentMessageWindowMs: responseTimeMs
        },
        conversation: {
          id: record.id,
          scope: record.scope,
          groupId: record.groupId,
          messageCount: record.messageCount,
          replyCandidateMessageIds,
          recentMessages: record.messages
            .filter(isModelVisibleConversationMessage)
            .filter((message) => options.captureSequence == null || Number(message.sequence ?? 0) <= options.captureSequence)
            .slice(-this.contextMessageLimit())
            .map((message) => {
              const admin = this.adminIdentity();
              return toContextChatMessage({
                ...message,
                text: injectImageTokens(message.text, message.imageUrls?.length ?? 0)
              }, isAdminUserId(message.userId, admin), admin).content;
            })
        },
        currentMessage: {
          messageId: incomingConversationMessageId(incoming),
          userId: incoming.userId,
          text: injectImageTokens(incoming.text, inboundImageUrls(incoming).length),
          imageCount: inboundImageUrls(incoming).length,
          attachmentCount: incoming.attachments.length,
          attachmentNames: incoming.attachments.map((attachment) => attachment.name),
          at: formatModelTimestamp(incoming.time)
        }
      };
      const promptRequest = await this.renderPromptRequest("orchestrator.user-group", {
        "orchestrator.payload": payload
      });
      let output = "";
      for (let attempt = 1; attempt <= ORCHESTRATOR_MAX_RETRIES + 1; attempt += 1) {
        const attemptContext = {
          ...logContext,
          attempt,
          retry: attempt - 1,
          maxRetries: ORCHESTRATOR_MAX_RETRIES
        };
        lastAttempt = attempt;
        try {
          if (options.signal?.aborted) throw options.signal.reason ?? new Error("ambient reply cancelled");
          output = await withAbortTimeout(
            (signal) => this.completePrompt(provider, promptRequest, { logContext: attemptContext, signal }),
            AMBIENT_ORCHESTRATOR_TIMEOUT_MS,
            undefined,
            options.signal
          );
          await appendRequestLog({
            category: "runtime.action",
            action: "orchestrator.attempt",
            response: { ok: true, willRetry: false },
            metadata: attemptContext
          });
          break;
        } catch (error) {
          const detail = sanitizeErrorDetail(errorMessage(options.signal?.reason ?? error));
          const timedOut = /timed out|timeout/i.test(detail);
          if (options.signal?.aborted && !timedOut) throw error;
          const willRetry = attempt <= ORCHESTRATOR_MAX_RETRIES;
          await appendRequestLog({
            category: "runtime.action",
            action: "orchestrator.attempt",
            response: { ok: false, error: detail, willRetry },
            metadata: attemptContext
          });
          if (!willRetry) throw error;
        }
      }
      const finalLogContext = {
        ...logContext,
        attempt: lastAttempt,
        retry: Math.max(0, lastAttempt - 1),
        maxRetries: ORCHESTRATOR_MAX_RETRIES
      };
      const decision = parseUserGroupOrchestratorDecision(output, replyCandidateMessageIds);
      if (!decision) throw new Error("编排器输出缺少有效的触发原因或回复消息 ID。");
      const result = userGroupOrchestratorResult(decision);
      const shouldReply = Boolean(result);
      this.recordOrchestratorDecision(record, {
        status: "completed",
        shouldReply,
        reason: decision.reason,
        ...(decision.replyToMessageId ? { replyToMessageId: decision.replyToMessageId } : {}),
        raw: output
      }, logRunId);
      await appendRequestLog({
        category: "runtime.action",
        action: "orchestrator.decision",
        request: {
          messageThreshold: this.config.bot.orchestrator.messageThreshold,
          recentMessageWindowMs: responseTimeMs
        },
        response: {
          shouldReply,
          reason: decision.reason,
          replyToMessageId: decision.replyToMessageId,
          raw: output
        },
        metadata: finalLogContext
      });
      // A positive reply decision is consumed by pumpAmbientReply only after
      // its Session event has been durably committed.
      consumeBatch = !shouldReply;
      return result;
    } catch (error) {
      const detail = sanitizeErrorDetail(errorMessage(options.signal?.reason ?? error));
      const timedOut = /timed out|timeout/i.test(detail);
      if (options.signal?.aborted && !timedOut) return undefined;
      console.error("[runtime] user groupchat orchestrator failed", {
        groupId: incoming.groupId,
        messageId: incoming.messageId,
        error
      });
      this.recordOrchestratorDecision(record, {
        status: "failed",
        shouldReply: false,
        reason: timedOut
          ? "编排器判断超时，请查看请求日志。"
          : "编排器判断失败，请查看请求日志。",
        raw: detail
      }, logRunId);
      await appendRequestLog({
        category: "runtime.action",
        action: "orchestrator.failed",
        request: {
          messageThreshold: this.config.bot.orchestrator.messageThreshold,
          recentMessageWindowMs: responseTimeMs
        },
        response: { ok: false, error: detail },
        metadata: {
          ...logContext,
          attempt: lastAttempt,
          retry: Math.max(0, lastAttempt - 1),
          maxRetries: ORCHESTRATOR_MAX_RETRIES
        }
      });
      consumeBatch = true;
      return undefined;
    } finally {
      if (consumeBatch) {
        this.consumeOrchestratorBatch(record, options.captureSequence ?? record.messageCount);
        this.persistConversationRecords();
      }
    }
  }
export function runtime_consumeOrchestratorBatch(this: RuntimeHost, record: ConversationRecord, captureSequence: number) {
    record.orchestratorCheckedMessageCount = Math.max(
      record.orchestratorCheckedMessageCount ?? 0,
      captureSequence
    );
    record.orchestratorCheckedAt = new Date().toISOString();
  }
export function runtime_recordOrchestratorDecision(this: RuntimeHost,
    record: ConversationRecord,
    decision: NonNullable<ConversationRecord["messages"][number]["orchestratorDecision"]>,
    logRunId: string
  ) {
    appendConversationMessage(record, {
      id: nanoid(),
      role: "assistant",
      text: "编排器结果",
      at: new Date().toISOString(),
      userId: record.userId,
      groupId: record.groupId,
      senderName: resolveRuntimePersonaName(this.persona?.name, this.config.persona.name),
      selfId: record.selfId,
      eventKind: "orchestrator_decision",
      visibility: "internal",
      orchestratorDecision: decision,
      logRunId
    }, this.retainedConversationMessageLimit());
    this.persistConversationRecords();
  }

export class RuntimeOrchestration {
  constructor(private readonly host: RuntimeHost) {}
  adminIdentity(...args: Parameters<typeof runtime_adminIdentity>) { return runtime_adminIdentity.call(this.host, ...args); }
  isReplySenderAllowed(...args: Parameters<typeof runtime_isReplySenderAllowed>) { return runtime_isReplySenderAllowed.call(this.host, ...args); }
  isDuplicateIncoming(...args: Parameters<typeof runtime_isDuplicateIncoming>) { return runtime_isDuplicateIncoming.call(this.host, ...args); }
  markIncomingSeen(...args: Parameters<typeof runtime_markIncomingSeen>) { return runtime_markIncomingSeen.call(this.host, ...args); }
  resolveIncomingReplyRoute(...args: Parameters<typeof runtime_resolveIncomingReplyRoute>) { return runtime_resolveIncomingReplyRoute.call(this.host, ...args); }
  isReplyTaskCurrent(...args: Parameters<typeof runtime_isReplyTaskCurrent>) { return runtime_isReplyTaskCurrent.call(this.host, ...args); }
  cancelScopeReplies(...args: Parameters<typeof runtime_cancelScopeReplies>) { return runtime_cancelScopeReplies.call(this.host, ...args); }
  cancelAllAmbientReplies(...args: Parameters<typeof runtime_cancelAllAmbientReplies>) { return runtime_cancelAllAmbientReplies.call(this.host, ...args); }
  resumeUserGroupOrchestrators(...args: Parameters<typeof runtime_resumeUserGroupOrchestrators>) { return runtime_resumeUserGroupOrchestrators.call(this.host, ...args); }
  suspendUserGroupOrchestrators(...args: Parameters<typeof runtime_suspendUserGroupOrchestrators>) { return runtime_suspendUserGroupOrchestrators.call(this.host, ...args); }
  patchIncomingMessage(...args: Parameters<typeof runtime_patchIncomingMessage>) { return runtime_patchIncomingMessage.call(this.host, ...args); }
  shouldRunUserGroupchatOrchestrator(...args: Parameters<typeof runtime_shouldRunUserGroupchatOrchestrator>) { return runtime_shouldRunUserGroupchatOrchestrator.call(this.host, ...args); }
  pendingOrchestratorUserMessages(...args: Parameters<typeof runtime_pendingOrchestratorUserMessages>) { return runtime_pendingOrchestratorUserMessages.call(this.host, ...args); }
  scheduleAmbientIdleReply(...args: Parameters<typeof runtime_scheduleAmbientIdleReply>) { return runtime_scheduleAmbientIdleReply.call(this.host, ...args); }
  cancelAmbientIdleTimer(...args: Parameters<typeof runtime_cancelAmbientIdleTimer>) { return runtime_cancelAmbientIdleTimer.call(this.host, ...args); }
  queueAmbientReply(...args: Parameters<typeof runtime_queueAmbientReply>) { return runtime_queueAmbientReply.call(this.host, ...args); }
  pumpAmbientReply(...args: Parameters<typeof runtime_pumpAmbientReply>) { return runtime_pumpAmbientReply.call(this.host, ...args); }
  isAmbientReplyCurrent(...args: Parameters<typeof runtime_isAmbientReplyCurrent>) { return runtime_isAmbientReplyCurrent.call(this.host, ...args); }
  cancelAmbientReply(...args: Parameters<typeof runtime_cancelAmbientReply>) { return runtime_cancelAmbientReply.call(this.host, ...args); }
  runUserGroupchatOrchestrator(...args: Parameters<typeof runtime_runUserGroupchatOrchestrator>) { return runtime_runUserGroupchatOrchestrator.call(this.host, ...args); }
  consumeOrchestratorBatch(...args: Parameters<typeof runtime_consumeOrchestratorBatch>) { return runtime_consumeOrchestratorBatch.call(this.host, ...args); }
  recordOrchestratorDecision(...args: Parameters<typeof runtime_recordOrchestratorDecision>) { return runtime_recordOrchestratorDecision.call(this.host, ...args); }
}
