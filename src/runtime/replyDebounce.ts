import {
  MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS,
  decodeIncomingReply,
  decodeReplyDebounce,
  decodeToolCompletion,
  incomingReplyEnvelope,
  replyDebounceEnvelope,
  type ReplyQuoteSnapshotV1,
  type RuntimeIncomingReplyEventPayload,
  type RuntimeReplyDebounceEventPayload,
  type RuntimeReplyFollowUpSnapshotV1,
  type UserGroupOrchestratorResultV1
} from "../../packages/contracts/session/runtimeMessages.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { CommandInvocationV1 } from "../../packages/contracts/messaging/commands.js";
import { readReplyGateSnapshot, type ReplyGateSnapshot } from "../../services/orchestration/groupReplyPolicy.js";
import type { SessionHandleResult } from "../../services/sessions/sessionCoordinator.js";
import type { SessionEventRecord } from "../../services/sessions/sessionStore.js";
import {
  DEFAULT_REPLY_DEBOUNCE_MS,
  type ConversationRecord,
  type ParsedIncomingMessage
} from "../types.js";
import {
  conversationRecordId,
  incomingConversationMessageId,
  persistentIncomingKey,
  queueIncomingSnapshot,
  restoredConversationIncoming
} from "./messagingAttachmentHelpers.js";

import type { SunaRuntime } from "../runtime.js";

export { DEFAULT_REPLY_DEBOUNCE_MS } from "../types.js";
export const REPLY_DEBOUNCE_EVENT_KIND = "reply_debounce";

interface ScheduleReplyDebounceInput {
  route: RuntimeIncomingReplyEventPayload["route"];
  incoming: ParsedIncomingMessage;
  captureSequence: number;
  gate: ReplyGateSnapshot;
  preparationKey?: string;
  commandInvocation?: CommandInvocationV1;
  orchestratorResult?: UserGroupOrchestratorResultV1;
}

interface TrackedReplyPreparation {
  key: string;
  sequence: number;
  promise: Promise<void>;
}

type DurableReplyPayload = RuntimeIncomingReplyEventPayload | RuntimeReplyDebounceEventPayload;

export class RuntimeReplyDebounce {
  private readonly preparationPromises = new Map<string, Set<TrackedReplyPreparation>>();

  constructor(
    private readonly host: SunaRuntime,
    private readonly delayOverrideMs?: number
  ) {}

  activeEvent(incoming: ParsedIncomingMessage) {
    if (this.delayMs() === 0) return undefined;
    return this.host.sessionStore.getActiveEvent(
      replyDebounceSessionId(incoming),
      REPLY_DEBOUNCE_EVENT_KIND
    );
  }

  async handlePersistedDuplicate(
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    record: ConversationRecord | undefined,
    durableMessageId: string
  ) {
    if (!record?.messages.some((message) => (
      message.role === "user" && message.id === durableMessageId
    ))) return false;
    if (incoming.messageId == null) {
      try {
        await this.host.prepareIncomingMessage(incoming, gateway);
        this.host.patchIncomingMessage(record, incoming, durableMessageId);
      } catch (error) {
        console.error("[runtime] prepare duplicate id-less message failed; continuing with persisted context", {
          channel: record.id,
          error
        });
      } finally {
        this.host.scheduleAttachmentCacheRefresh();
      }
    }
    this.host.markIncomingSeen(incoming);
    return true;
  }

  handleActiveIncoming(incoming: ParsedIncomingMessage, gateway: MessagingPort) {
    const active = this.activeEvent(incoming);
    if (!active) return false;
    const bumped = this.host.bumpReplyDebounce(active, incoming);
    if (bumped.status === "duplicate") {
      this.host.markIncomingSeen(incoming);
      return true;
    }
    if (bumped.status !== "updated") return false;
    const payload = decodeReplyDebounce(bumped.event.payload);
    const record = this.host.recoverReplyDebounceMessages(payload);
    const channelKey = conversationRecordId(incoming);
    const durableMessageId = incomingConversationMessageId(incoming);
    this.host.markIncomingSeen(incoming);
    const preparation = this.host.prepareIncomingMessage(incoming, gateway)
      .then(() => this.host.patchIncomingMessage(record, incoming, durableMessageId))
      .catch((error) => {
        console.error("[runtime] prepare debounced incoming message failed; continuing with degraded context", {
          channel: channelKey,
          messageId: incoming.messageId,
          error
        });
      })
      .finally(() => this.host.scheduleAttachmentCacheRefresh());
    this.host.trackReplyDebouncePreparation(incoming, preparation, bumped.captureSequence);
    this.host.scheduleMemoryCompression(record);
    this.host.sessionCoordinator.resume(incoming.accountId ?? "primary");
    return true;
  }

  schedule(input: ScheduleReplyDebounceInput) {
    const conversationId = conversationRecordId(input.incoming);
    const preparationKey = input.preparationKey?.trim() || undefined;
    const triggerKey = preparationKey ?? persistentIncomingKey(input.incoming);
    const replyQuote = captureReplyQuote(this.host, input.incoming);
    const delayMs = this.delayMs();
    if (delayMs === 0) {
      return this.host.sessionCoordinator.enqueueEvent({
        sessionId: conversationId,
        kind: "incoming_reply",
        dedupeKey: `reply:${triggerKey}`,
        payload: incomingReplyEnvelope({
          type: "incoming_reply",
          route: input.route,
          incoming: queueIncomingSnapshot(input.incoming),
          captureSequence: input.captureSequence,
          ...(preparationKey ? { preparationKey } : {}),
          replyGate: input.gate,
          replyQuote,
          ...(input.commandInvocation ? { commandInvocation: input.commandInvocation } : {}),
          ...(input.orchestratorResult ? { orchestratorResult: input.orchestratorResult } : {})
        }, {
          conversationId,
          correlationId: `onebot:${input.incoming.messageId ?? triggerKey}`,
          idempotencyKey: `reply:${triggerKey}`
        })
      }, { schedule: false });
    }
    const debounceSessionId = replyDebounceSessionId(input.incoming);
    return this.host.sessionCoordinator.enqueueEvent({
      sessionId: debounceSessionId,
      kind: REPLY_DEBOUNCE_EVENT_KIND,
      dedupeKey: `reply-debounce:${triggerKey}`,
      availableAt: Date.now() + delayMs,
      payload: replyDebounceEnvelope({
        type: "reply_debounce",
        route: input.route,
        conversationId,
        incoming: queueIncomingSnapshot(input.incoming),
        captureSequence: input.captureSequence,
        ...(preparationKey ? { preparationKey } : {}),
        replyGate: input.gate,
        replyQuote,
        ...(input.commandInvocation ? { commandInvocation: input.commandInvocation } : {}),
        ...(input.orchestratorResult ? { orchestratorResult: input.orchestratorResult } : {})
      }, {
        conversationId,
        correlationId: `onebot:${input.incoming.messageId ?? triggerKey}`,
        idempotencyKey: `reply-debounce:${triggerKey}`
      })
    }, { schedule: false });
  }

  bump(event: SessionEventRecord, incoming: ParsedIncomingMessage) {
    const incomingKey = persistentIncomingKey(incoming);
    let active = event;
    for (;;) {
      const payload = decodeReplyDebounce(active.payload);
      this.validateEventSession(active, incoming);
      this.validateEventSession(active, payload.incoming);
      if (payload.conversationId !== conversationRecordId(incoming)) {
        throw new Error(`防抖事件会话不匹配：${active.id}`);
      }
      const snapshots = replySnapshots(payload);
      if (snapshots.some((snapshot) => persistentIncomingKey(snapshot.incoming) === incomingKey)) {
        return { status: "duplicate" as const, event: active };
      }
      const captureSequence = Math.max(
        snapshots.at(-1)!.captureSequence + 1,
        this.host.incomingCaptureSequence(incoming)
      );
      const nextPayload = {
        ...payload,
        followUps: [
          ...(payload.followUps ?? []),
          { incoming: queueIncomingSnapshot(incoming), captureSequence }
        ].slice(-MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS)
      };
      const updated = this.host.sessionCoordinator.updateActiveEvent({
        eventId: active.id,
        kind: REPLY_DEBOUNCE_EVENT_KIND,
        availableAt: Math.max(Date.now() + this.delayMs(), active.availableAt + 1),
        expectedAvailableAt: active.availableAt,
        expectedPayload: active.payload,
        payload: replaceEnvelopePayload(active.payload, nextPayload)
      });
      if (updated) return { status: "updated" as const, event: updated, captureSequence };
      const latest = this.activeEvent(incoming);
      if (!latest) return { status: "inactive" as const };
      active = latest;
    }
  }

  trackPreparation(
    incoming: ParsedIncomingMessage,
    promise: Promise<void>,
    sequence = this.host.incomingCaptureSequence(incoming),
    key = persistentIncomingKey(incoming)
  ) {
    const conversationId = conversationRecordId(incoming);
    const promises = this.preparationPromises.get(conversationId) ?? new Set<TrackedReplyPreparation>();
    const tracked = {
      key,
      sequence,
      promise
    };
    promises.add(tracked);
    this.preparationPromises.set(conversationId, promises);
    void promise.finally(() => {
      promises.delete(tracked);
      if (!promises.size && this.preparationPromises.get(conversationId) === promises) {
        this.preparationPromises.delete(conversationId);
      }
    });
  }

  async waitForPreparations(incoming: ParsedIncomingMessage, contextThroughSequence: number) {
    const preparations = this.preparationPromises.get(conversationRecordId(incoming));
    if (!preparations?.size) return;
    await Promise.allSettled([...preparations]
      .filter((preparation) => preparation.sequence <= contextThroughSequence)
      .map((preparation) => preparation.promise));
  }

  recoverActiveConversation(incoming: ParsedIncomingMessage) {
    if (this.delayMs() === 0) return;
    const conversationId = conversationRecordId(incoming);
    const payloads = this.activeConversationPayloads(conversationId);
    return payloads.length ? this.recoverSnapshots(payloads.flatMap(replySnapshots)) : undefined;
  }

  recoverMessages(payload: DurableReplyPayload) {
    const conversationId = conversationRecordId(payload.incoming);
    const activePayloads = this.delayMs() === 0
      ? []
      : this.activeConversationPayloads(conversationId);
    return this.recoverSnapshots([
      ...activePayloads.flatMap(replySnapshots),
      ...replySnapshots(payload)
    ]);
  }

  protectedConversationIds() {
    const protectedIds = new Set<string>();
    for (const event of this.host.sessionCoordinator.listActiveEvents(REPLY_DEBOUNCE_EVENT_KIND)) {
      const payload = decodeReplyDebounce(event.payload);
      const conversationId = conversationRecordId(payload.incoming);
      this.validateEventSession(event, payload.incoming);
      if (payload.conversationId !== conversationId) {
        throw new Error(`防抖事件会话不匹配：${event.id}`);
      }
      protectedIds.add(conversationId);
    }
    for (const event of this.host.sessionCoordinator.listActiveEvents("incoming_reply")) {
      const payload = decodeIncomingReply(event.payload);
      const conversationId = conversationRecordId(payload.incoming);
      if (event.sessionId !== conversationId) {
        throw new Error(`回复事件会话不匹配：${event.id}`);
      }
      if (payload.contextThroughSequence != null) protectedIds.add(conversationId);
    }
    for (const event of this.host.sessionCoordinator.listActiveEvents("tool_completion")) {
      const payload = decodeToolCompletion(event.payload);
      const conversationId = conversationRecordId(payload.originalRequest.incoming);
      if (event.sessionId !== conversationId) {
        throw new Error(`工具回调事件会话不匹配：${event.id}`);
      }
      if (payload.originalRequest.contextThroughSequence != null) {
        protectedIds.add(conversationId);
      }
    }
    for (const job of this.host.sessionStore.listToolJobs()) {
      if (job.status === "queued" || job.status === "running") protectedIds.add(job.sessionId);
    }
    return protectedIds;
  }

  private recoverSnapshots(snapshots: RuntimeReplyFollowUpSnapshotV1[]) {
    const ordered = [...snapshots].sort((left, right) => (
      left.captureSequence - right.captureSequence
    ));
    const seen = new Set<string>();
    const unique = ordered.filter((snapshot) => {
      const key = persistentIncomingKey(snapshot.incoming);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const first = unique[0]!;
    const conversationId = conversationRecordId(first.incoming);
    let record = this.host.conversationRecords.get(conversationId);
    for (const snapshot of unique) {
      if (conversationRecordId(snapshot.incoming) !== conversationId) {
        throw new Error("防抖事件上下文包含其他会话消息。");
      }
      const messageAtSequence = record?.messages.find((message) => (
        message.sequence === snapshot.captureSequence
      ));
      if (messageAtSequence && recoveredMessageMatches(messageAtSequence, snapshot.incoming)) {
        continue;
      }
      const messageCount = record?.messageCount ?? 0;
      const retainedSequences = (record?.messages ?? [])
        .map((message) => message.sequence)
        .filter((sequence): sequence is number => Number.isSafeInteger(sequence));
      const firstRetainedSequence = retainedSequences.length
        ? Math.min(...retainedSequences)
        : undefined;
      if (
        messageCount >= snapshot.captureSequence
        && firstRetainedSequence != null
        && snapshot.captureSequence < firstRetainedSequence
      ) continue;
      if (messageCount >= snapshot.captureSequence) {
        throw new Error(`防抖事件上下文序列冲突：${snapshot.captureSequence}`);
      }
      if (messageCount + 1 !== snapshot.captureSequence) {
        throw new Error(
          `防抖事件上下文缺少序列：期望 ${messageCount + 1}，收到 ${snapshot.captureSequence}`
        );
      }
      record = this.host.recordIncomingMessage(snapshot.incoming, {
        expectedSequence: snapshot.captureSequence,
        persist: false
      });
    }
    this.host.persistConversationRecordStrict(record!);
    return record!;
  }

  private activeConversationPayloads(conversationId: string) {
    return this.host.sessionCoordinator.listActiveEvents(REPLY_DEBOUNCE_EVENT_KIND).flatMap((event) => {
      if (!event.sessionId.startsWith(`reply-debounce:${conversationId}:sender:`)) return [];
      const payload = decodeReplyDebounce(event.payload);
      if (payload.conversationId !== conversationId) {
        throw new Error(`防抖事件会话不匹配：${event.id}`);
      }
      this.validateEventSession(event, payload.incoming);
      return [payload];
    });
  }

  prepareMessages(payload: DurableReplyPayload, gateway: MessagingPort) {
    const conversationId = conversationRecordId(payload.incoming);
    const record = this.host.conversationRecords.get(conversationId) ?? this.recoverMessages(payload);
    const activePayloads = this.delayMs() === 0
      ? []
      : this.activeConversationPayloads(conversationId);
    const recoveryThroughSequence = "contextThroughSequence" in payload
      ? payload.contextThroughSequence
      : undefined;
    const recoveredSnapshots = record.messages.flatMap((message) => {
      const sequence = message.sequence;
      if (message.role !== "user" || !Number.isSafeInteger(sequence)
        || Number(sequence) < payload.captureSequence
        || Number(sequence) > (recoveryThroughSequence ?? record.messageCount)) return [];
      const incoming = restoredConversationIncoming(record, message);
      return incoming ? [{
        snapshot: { incoming, captureSequence: Number(sequence) },
        preparationKey: undefined
      }] : [];
    });
    const seenSequences = new Set<number>();
    const snapshots = [
      ...[...activePayloads, payload]
      .flatMap((value) => replySnapshots(value).map((snapshot, index) => ({
        snapshot,
        preparationKey: index === 0 ? value.preparationKey : undefined
      }))),
      ...recoveredSnapshots
    ]
      .sort((left, right) => left.snapshot.captureSequence - right.snapshot.captureSequence)
      .filter(({ snapshot }) => {
        if (seenSequences.has(snapshot.captureSequence)) return false;
        seenSequences.add(snapshot.captureSequence);
        return true;
      });
    for (const { snapshot, preparationKey } of snapshots) {
      const incoming = snapshot.incoming;
      const key = persistentIncomingKey(incoming);
      const tracked = this.preparationPromises.get(conversationId);
      const triggerPreparation = preparationKey
        ? this.host.incomingPreparations.get(preparationKey)
        : undefined;
      if (triggerPreparation || [...(tracked ?? [])].some((value) => value.key === key)) continue;
      const frozenMessageId = record.messages.find((message) => (
        message.role === "user" && message.sequence === snapshot.captureSequence
      ))?.id ?? incomingConversationMessageId(incoming);
      const preparation = this.host.prepareIncomingMessage(incoming, gateway)
        .then(() => this.host.patchIncomingMessage(record, incoming, frozenMessageId))
        .catch((error) => {
          console.error("[runtime] prepare recovered debounced message failed; continuing with degraded context", {
            channel: conversationId,
            messageId: incoming.messageId,
            error
          });
        })
        .finally(() => this.host.scheduleAttachmentCacheRefresh());
      if (preparationKey) {
        this.host.incomingPreparations.set(preparationKey, { promise: preparation, incoming });
      }
      this.trackPreparation(incoming, preparation, snapshot.captureSequence, key);
    }
  }

  clearPreparation(payload: Pick<DurableReplyPayload, "preparationKey">) {
    this.clearTriggerPreparation(payload.preparationKey);
  }

  async process(
    event: SessionEventRecord,
    value: unknown,
    signal: AbortSignal
  ): Promise<SessionHandleResult> {
    const payload = decodeReplyDebounce(value);
    const incoming = payload.incoming;
    if (payload.conversationId !== conversationRecordId(incoming)) {
      throw new Error(`防抖事件会话不匹配：${event.id}`);
    }
    this.validateEventSession(event, incoming);
    // The durable debounce event is committed before the conversation snapshot.
    // Rebuild the first trigger before gate checks so a crash in that gap remains recoverable.
    const record = this.recoverMessages(payload);
    const gate = readReplyGateSnapshot(payload.replyGate, incoming.scope, payload.conversationId);
    if (!gate || !this.host.isReplyTaskCurrent(incoming, gate, signal)) {
      this.clearPreparation(payload);
      return { status: "no_reply" };
    }

    this.prepareMessages(payload, this.host.requireActiveGateway());

    const contextThroughSequence = Math.max(payload.captureSequence, record.messageCount);
    const preparationKey = payload.preparationKey?.trim() || undefined;
    const replyKey = preparationKey ?? persistentIncomingKey(incoming);
    return {
      status: "handoff",
      expectedSourceAvailableAt: event.availableAt,
      targetEvent: {
        sessionId: payload.conversationId,
        kind: "incoming_reply",
        dedupeKey: `reply:${replyKey}`,
        payload: incomingReplyEnvelope({
          type: "incoming_reply",
          route: payload.route,
          incoming: queueIncomingSnapshot(incoming),
          captureSequence: payload.captureSequence,
          ...(payload.followUps?.length ? { followUps: payload.followUps } : {}),
          contextThroughSequence,
          ...(preparationKey ? { preparationKey } : {}),
          replyGate: gate,
          replyQuote: payload.replyQuote,
          ...(payload.commandInvocation ? { commandInvocation: payload.commandInvocation } : {}),
          ...(payload.orchestratorResult ? { orchestratorResult: payload.orchestratorResult } : {})
        }, {
          conversationId: payload.conversationId,
          correlationId: `onebot:${incoming.messageId ?? replyKey}`,
          idempotencyKey: `reply:${replyKey}`
        })
      }
    };
  }

  private clearTriggerPreparation(preparationKey: string | undefined) {
    const key = preparationKey?.trim();
    if (key) this.host.incomingPreparations.delete(key);
  }

  private validateEventSession(event: SessionEventRecord, incoming: ParsedIncomingMessage) {
    if (event.sessionId !== replyDebounceSessionId(incoming)) {
      throw new Error(`防抖事件 Session 不匹配：${event.id}`);
    }
  }

  private delayMs() {
    return this.delayOverrideMs ?? this.host.config.bot.replyDebounceMs ?? DEFAULT_REPLY_DEBOUNCE_MS;
  }
}

function captureReplyQuote(
  runtime: SunaRuntime,
  incoming: ParsedIncomingMessage
): ReplyQuoteSnapshotV1 {
  const replyToMessageId = runtime.groupReplyOptions(incoming).replyToMessageId;
  return {
    enabled: replyToMessageId != null,
    replyToMessageId: replyToMessageId ?? null
  };
}

function replySnapshots(payload: DurableReplyPayload): RuntimeReplyFollowUpSnapshotV1[] {
  return [{ incoming: payload.incoming, captureSequence: payload.captureSequence }, ...(payload.followUps ?? [])];
}

function replaceEnvelopePayload(value: unknown, payload: RuntimeReplyDebounceEventPayload) {
  if (value && typeof value === "object" && !Array.isArray(value) && "payload" in value) {
    return { ...value, payload };
  }
  return payload;
}

function recoveredMessageMatches(
  message: ConversationRecord["messages"][number],
  incoming: ParsedIncomingMessage
) {
  if (message.role !== "user") return false;
  return message.id === incomingConversationMessageId(incoming);
}

export function replyDebounceSessionId(incoming: ParsedIncomingMessage) {
  return `reply-debounce:${conversationRecordId(incoming)}:sender:${incoming.userId}`;
}
