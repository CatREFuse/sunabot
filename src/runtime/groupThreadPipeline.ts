import type { ConversationMessageRecord, ConversationRecord, ParsedIncomingMessage, ReasoningEffort } from "../types.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  applyGroupThreadContext,
  createEmptyGroupThreadState,
  planGroupThreadContext,
  retainGroupThreadStateMessageIndex,
  toGroupThreadContextSnapshot,
  type GroupThreadContextSnapshotV1,
  type GroupThreadMessageRecord,
  type GroupThreadStateV1
} from "../../services/conversations/groupThreadContext.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import { isModelVisibleConversationMessage, parseGroupContextMetadataValue } from "./conversationMemoryHelpers.js";
import { errorMessage, sanitizeErrorDetail, withAbortTimeout } from "./infrastructure.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import type { RuntimePromptPort } from "./runtimeContracts.js";

const INITIAL_THREAD_MESSAGE_LIMIT = 64;
const INCREMENTAL_THREAD_MESSAGE_LIMIT = 64;
const MAX_THREAD_BATCHES_PER_REPLY = 4;
const PROMPT_SNAPSHOT_ASSIGNMENT_LIMIT = 64;
const PROMPT_THREAD_LIMIT = 72;
const CLASSIFIER_PREVIOUS_THREAD_LIMIT = 64;
const PROMPT_PARTICIPANT_LIMIT = 16;
const PROMPT_THREAD_MESSAGE_LIMIT = 16;
const GROUP_THREAD_TIMEOUT_MS = 20_000;
const GROUP_THREAD_PROMPT_REVISION = "orchestrator.group-thread:v1";

interface GroupThreadRuntimeHost extends Omit<RuntimePromptPort, "getProvider"> { readonly conversationRecords: ReadonlyMap<string, ConversationRecord>; buildRecentContextMessages(incoming: ParsedIncomingMessage, captureSequence?: number, messageLimit?: number): Array<{ content: string }>; getProviderForModel(model: string, requestedEffort?: ReasoningEffort): ReturnType<RuntimePromptPort["getProvider"]>; }

export interface PrepareGroupThreadContextOptions {
  captureSequence?: number;
  contextThroughSequence?: number;
  signal?: AbortSignal;
}

export interface GroupThreadPromptContextV1 extends Record<string, unknown> {
  active_thread_id: string | null;
  omitted_thread_count?: number;
  threads: Array<{
    thread_id: string;
    topic: string;
    status: "active" | "dormant" | "closed";
    participant_uids: string[];
    omitted_participant_count?: number;
    message_ids: string[];
    omitted_message_count?: number;
  }>;
  message_assignments: Array<{
    message_id: string;
    primary_thread_id: string;
    related_thread_ids: string[];
    relation: "new" | "continue" | "reply" | "switch" | "bridge" | "unresolved";
    confidence: number;
  }>;
}

export async function runtime_prepareGroupThreadContext(
  this: GroupThreadRuntimeHost,
  incoming: ParsedIncomingMessage,
  options: PrepareGroupThreadContextOptions = {}
): Promise<GroupThreadContextSnapshotV1 | undefined> {
  if (incoming.scope === "private") return undefined;
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Group thread context cancelled.");

  const conversationId = conversationRecordId(incoming);
  const record = this.conversationRecords.get(conversationId);
  if (!record) return undefined;
  const sourceThroughSequence = options.contextThroughSequence ?? options.captureSequence;
  const currentBatchFromSequence = options.contextThroughSequence == null
    ? undefined
    : options.captureSequence;
  const historyCaptureSequence = currentBatchFromSequence ?? options.captureSequence;
  const sourceMessages = record.messages
    .filter(isModelVisibleConversationMessage)
    .filter((message) => Number.isSafeInteger(message.sequence) && Number(message.sequence) > 0)
    .filter((message) => sourceThroughSequence == null || Number(message.sequence) <= sourceThroughSequence)
    .filter((message) => currentBatchFromSequence == null ||
      Number(message.sequence) < currentBatchFromSequence || message.role === "user");
  const visibleMessageIds = groupContextMessageIds(
    this.buildRecentContextMessages(incoming, historyCaptureSequence, INITIAL_THREAD_MESSAGE_LIMIT)
  );
  if (currentBatchFromSequence != null) {
    for (const message of sourceMessages) {
      if (Number(message.sequence) >= currentBatchFromSequence) visibleMessageIds.add(message.id);
    }
  }
  const store = applicationDataStore(this.config);
  let previousState: GroupThreadStateV1;
  let baseRevision: number;

  try {
    const persisted = store.readGroupThreadState(conversationId);
    previousState = retainGroupThreadStateMessageIndex(
      persisted?.state ?? createEmptyGroupThreadState(),
      new Set(sourceMessages.map((message) => message.id))
    );
    baseRevision = persisted?.revision ?? 0;
  } catch (error) {
    await logGroupThreadFailure(conversationId, incoming, "state_read_failed", error);
    return undefined;
  }

  const targetSequence = Number(sourceMessages.at(-1)?.sequence ?? previousState.processedThroughSequence);
  for (let batchIndex = 0; batchIndex < MAX_THREAD_BATCHES_PER_REPLY; batchIndex += 1) {
    const selectedMessages = selectGroupThreadProcessingBatch(sourceMessages, previousState);
    const threadMessages = selectedMessages.map(toThreadMessageRecord);
    const plan = planGroupThreadContext({ messages: threadMessages, previousState });
    if (plan.error) {
      await logGroupThreadFailure(conversationId, incoming, plan.error.code, plan.error.message);
      return trimGroupThreadSnapshot(toGroupThreadContextSnapshot(previousState), visibleMessageIds, targetSequence);
    }
    if (!plan.newMessages.length) {
      return trimGroupThreadSnapshot(toGroupThreadContextSnapshot(previousState), visibleMessageIds, targetSequence);
    }

    let modelOutput: unknown;
    if (plan.needsModel) {
      try {
        const provider = this.getProviderForModel(this.config.bot.orchestrator.groupThreadModel, "low");
        const promptRequest = await this.renderPromptRequest("orchestrator.group-thread", {
          "thread.payload": {
            conversation: {
              id: conversationId,
              platform: "qq",
              group_id: incoming.groupId == null ? null : String(incoming.groupId)
            },
            previous_state: classifierPreviousState(previousState),
            messages: selectedMessages.map(toClassifierMessage),
            target_message_ids: [...plan.unresolvedMessageIds]
          }
        });
        const logContext = {
          conversationId,
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          stage: "orchestrator",
          promptFamily: "orchestrator.group-thread"
        };
        modelOutput = await withAbortTimeout(
          (signal) => this.completePrompt(provider, promptRequest, { signal, logContext }),
          GROUP_THREAD_TIMEOUT_MS,
          undefined,
          options.signal
        );
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        await logGroupThreadFailure(conversationId, incoming, "classifier_failed", error);
        return trimGroupThreadSnapshot(toGroupThreadContextSnapshot(previousState), visibleMessageIds, targetSequence);
      }
    }

    const update = applyGroupThreadContext({
      conversationId,
      messages: threadMessages,
      previousState,
      ...(modelOutput == null ? {} : { modelOutput })
    });
    if (update.error || !update.changed) {
      if (update.error) await logGroupThreadFailure(conversationId, incoming, update.error.code, update.error.message);
      return trimGroupThreadSnapshot(update.snapshot, visibleMessageIds, targetSequence);
    }

    try {
      const lastAssignment = update.state.assignments.at(-1);
      const commit = store.commitGroupThreadState({
        conversationId,
        baseRevision,
        lastRunKey: [
          "group-thread",
          conversationId,
          update.state.processedThroughSequence,
          lastAssignment?.messageId ?? "empty"
        ].join(":"),
        classifierModel: this.config.bot.orchestrator.groupThreadModel,
        promptRevision: GROUP_THREAD_PROMPT_REVISION,
        state: update.state
      });
      let durableState = previousState;
      if (commit.status === "committed" || commit.status === "existing") durableState = commit.record.state;
      else if ("current" in commit && commit.current) durableState = commit.current.state;
      previousState = retainGroupThreadStateMessageIndex(
        durableState,
        new Set(sourceMessages.map((message) => message.id))
      );
      baseRevision = durableState.revision;
      if (durableState.processedThroughSequence > targetSequence) return undefined;
      await appendRequestLog({
        category: "runtime.action",
        action: "group_thread.updated",
        request: {
          batch: batchIndex + 1,
          newMessageCount: plan.newMessages.length,
          modelMessageCount: plan.unresolvedMessageIds.length,
          ruleMessageCount: plan.ruleAssignments.length + plan.deferredReplyMessageIds.length
        },
        response: {
          status: commit.status,
          revision: durableState.revision,
          activeThreadId: durableState.activeThreadId,
          threadCount: durableState.threads.length
        },
        metadata: {
          conversationId,
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          stage: "orchestrator",
          promptFamily: "orchestrator.group-thread"
        }
      });
      if (previousState.processedThroughSequence >= targetSequence) {
        return trimGroupThreadSnapshot(toGroupThreadContextSnapshot(previousState), visibleMessageIds, targetSequence);
      }
    } catch (error) {
      await logGroupThreadFailure(conversationId, incoming, "state_commit_failed", error);
      return trimGroupThreadSnapshot(
        toGroupThreadContextSnapshot(previousState),
        visibleMessageIds,
        targetSequence
      );
    }
  }

  return trimGroupThreadSnapshot(toGroupThreadContextSnapshot(previousState), visibleMessageIds, targetSequence);
}

export function selectGroupThreadProcessingBatch(
  sourceMessages: readonly ConversationMessageRecord[],
  previousState: Pick<GroupThreadStateV1, "revision" | "processedThroughSequence">
) {
  if (previousState.revision === 0) return sourceMessages.slice(-INITIAL_THREAD_MESSAGE_LIMIT);
  return sourceMessages
    .filter((message) => Number(message.sequence) > previousState.processedThroughSequence)
    .slice(0, INCREMENTAL_THREAD_MESSAGE_LIMIT);
}

export function groupContextMessageIds(messages: readonly { content: string }[]) {
  const ids = new Set<string>();
  for (const message of messages) {
    const match = /^\[[^\]\n]*\bmessage_id=([^|\]\n]+)(?:\s*\||\])/u.exec(message.content);
    const id = match?.[1]?.trim();
    if (id) ids.add(parseGroupContextMetadataValue(id));
  }
  return ids;
}

export function groupThreadPromptContext(
  snapshot: GroupThreadContextSnapshotV1 | undefined
): GroupThreadPromptContextV1 {
  const compact = snapshot ? compactGroupThreadSnapshot(snapshot) : undefined;
  return {
    active_thread_id: compact?.activeThreadId ?? null,
    ...(compact?.omittedThreadCount ? { omitted_thread_count: compact.omittedThreadCount } : {}),
    threads: (compact?.threads ?? []).map((thread) => ({
      thread_id: thread.threadId,
      topic: thread.topic,
      status: thread.status,
      participant_uids: [...thread.participantUids],
      ...(thread.omittedParticipantCount
        ? { omitted_participant_count: thread.omittedParticipantCount }
        : {}),
      message_ids: [...thread.messageIds],
      ...(thread.omittedMessageCount ? { omitted_message_count: thread.omittedMessageCount } : {})
    })),
    message_assignments: (compact?.messageAssignments ?? []).map((assignment) => ({
      message_id: assignment.messageId,
      primary_thread_id: assignment.primaryThreadId,
      related_thread_ids: [...assignment.relatedThreadIds],
      relation: assignment.relation,
      confidence: assignment.confidence
    }))
  };
}

export function serializeGroupThreadPromptContext(context: GroupThreadPromptContextV1) {
  return JSON.stringify(context).replace(/[<>&\u2028\u2029]/gu, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    if (character === "\u2028") return "\\u2028";
    return "\\u2029";
  });
}

export function currentPromptInputMessage(
  request: RenderedPromptRequest,
  marker?: { start: string; end: string }
) {
  if (!marker) return [...request.messages].reverse().find((message) => message.role === "user");
  const currentUserMessage = [...request.messages].reverse().find((message) => (
    message.role === "user"
    && message.content.includes(marker.start)
    && message.content.includes(marker.end)
  ));
  for (const message of request.messages) {
    message.content = message.content
      .split(marker.start).join("")
      .split(marker.end).join("");
  }
  return currentUserMessage;
}

export class RuntimeGroupThreads {
  readonly prepareGroupThreadContext: OmitThisParameter<typeof runtime_prepareGroupThreadContext>;
  readonly promptContext = groupThreadPromptContext;

  constructor(host: GroupThreadRuntimeHost) {
    this.prepareGroupThreadContext = runtime_prepareGroupThreadContext.bind(host);
  }
}

function toThreadMessageRecord(message: ConversationMessageRecord): GroupThreadMessageRecord {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    sequence: message.sequence,
    userId: message.role === "assistant" ? message.selfId ?? message.userId : message.userId,
    replyMessageIds: message.replyMessageIds?.length
      ? [...message.replyMessageIds]
      : message.quoteReferences?.map((quote) => quote.messageId) ?? []
  };
}

function toClassifierMessage(message: ConversationMessageRecord) {
  const uid = message.role === "assistant" ? message.selfId ?? message.userId : message.userId;
  const replyToMessageId = message.replyMessageIds?.[0] ?? message.quoteReferences?.[0]?.messageId;
  return {
    message_id: message.id,
    sequence: message.sequence,
    timestamp: formatModelTimestamp(message.at),
    timezone: systemModelTimeZone(),
    role: message.role,
    display_name: message.senderName || (message.role === "assistant" ? "助手" : "用户"),
    uid: uid == null ? "unknown" : String(uid),
    ...(replyToMessageId == null ? {} : { reply_to_message_id: String(replyToMessageId) }),
    text: message.text
  };
}

function classifierPreviousState(state: GroupThreadStateV1) {
  const orderedThreads = [...state.threads].sort((left, right) => (
    Number(right.threadId === state.activeThreadId) - Number(left.threadId === state.activeThreadId)
    || right.lastSequence - left.lastSequence
    || left.threadId.localeCompare(right.threadId)
  ));
  const selectedThreads = orderedThreads.slice(0, CLASSIFIER_PREVIOUS_THREAD_LIMIT);
  return {
    active_thread_id: state.activeThreadId ?? null,
    ...(state.threads.length > selectedThreads.length
      ? { omitted_thread_count: state.threads.length - selectedThreads.length }
      : {}),
    threads: selectedThreads.map((thread) => ({
      thread_id: thread.threadId,
      topic: thread.topic,
      status: thread.status,
      participant_uids: thread.participantUids.slice(-PROMPT_PARTICIPANT_LIMIT),
      ...(thread.participantUids.length > PROMPT_PARTICIPANT_LIMIT
        ? { omitted_participant_count: thread.participantUids.length - PROMPT_PARTICIPANT_LIMIT }
        : {}),
      recent_message_ids: thread.messageIds.slice(-8),
      ...(thread.messageIds.length > 8
        ? { omitted_message_count: thread.messageIds.length - 8 }
        : {})
    }))
  };
}

function trimGroupThreadSnapshot(
  snapshot: GroupThreadContextSnapshotV1,
  visibleMessageIds: ReadonlySet<string>,
  targetSequence: number
): GroupThreadContextSnapshotV1 {
  const messageAssignments = snapshot.messageAssignments
    .filter((assignment) => visibleMessageIds.has(assignment.messageId))
    .slice(-PROMPT_SNAPSHOT_ASSIGNMENT_LIMIT)
    .map((assignment) => ({ ...assignment, relatedThreadIds: [...assignment.relatedThreadIds] }));
  const activeThreadVisible = snapshot.activeThreadId != null && messageAssignments.some((assignment) => (
    assignment.primaryThreadId === snapshot.activeThreadId || assignment.relatedThreadIds.includes(snapshot.activeThreadId!)
  ));
  const sequenceByMessageId = new Map(
    snapshot.messageAssignments.map((assignment) => [assignment.messageId, assignment.sequence])
  );
  const { activeThreadId, ...snapshotWithoutActiveThread } = snapshot;
  return compactGroupThreadSnapshot({
    ...snapshotWithoutActiveThread,
    ...(activeThreadId && (snapshot.processedThroughSequence >= targetSequence || activeThreadVisible)
      ? { activeThreadId }
      : {}),
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      participantUids: [...thread.participantUids],
      messageIds: thread.messageIds.filter((messageId) => visibleMessageIds.has(messageId)),
      omittedMessageCount: (thread.omittedMessageCount ?? 0) + thread.messageIds.filter((messageId) => {
        if (visibleMessageIds.has(messageId)) return false;
        const sequence = sequenceByMessageId.get(messageId);
        return sequence == null || sequence < targetSequence;
      }).length
    })),
    messageAssignments
  });
}

function compactGroupThreadSnapshot(
  snapshot: GroupThreadContextSnapshotV1
): GroupThreadContextSnapshotV1 {
  const threadsById = new Map(snapshot.threads.map((thread) => [thread.threadId, thread]));
  const selectedThreadIds = new Set<string>();
  if (snapshot.activeThreadId && threadsById.has(snapshot.activeThreadId)) {
    selectedThreadIds.add(snapshot.activeThreadId);
  }
  const selectedAssignments: GroupThreadContextSnapshotV1["messageAssignments"] = [];
  for (let index = snapshot.messageAssignments.length - 1; index >= 0; index -= 1) {
    if (selectedAssignments.length >= PROMPT_SNAPSHOT_ASSIGNMENT_LIMIT) break;
    const assignment = snapshot.messageAssignments[index]!;
    if (!threadsById.has(assignment.primaryThreadId)) continue;
    if (!selectedThreadIds.has(assignment.primaryThreadId)
      && selectedThreadIds.size >= PROMPT_THREAD_LIMIT) continue;
    selectedThreadIds.add(assignment.primaryThreadId);
    selectedAssignments.push({ ...assignment, relatedThreadIds: [...assignment.relatedThreadIds] });
  }
  selectedAssignments.reverse();
  for (const assignment of [...selectedAssignments].reverse()) {
    for (const threadId of assignment.relatedThreadIds) {
      if (selectedThreadIds.size >= PROMPT_THREAD_LIMIT) break;
      if (threadsById.has(threadId)) selectedThreadIds.add(threadId);
    }
  }
  const assignmentSequenceByThread = new Map<string, number>();
  for (const assignment of snapshot.messageAssignments) {
    for (const threadId of [assignment.primaryThreadId, ...assignment.relatedThreadIds]) {
      assignmentSequenceByThread.set(
        threadId,
        Math.max(assignmentSequenceByThread.get(threadId) ?? 0, assignment.sequence)
      );
    }
  }
  const rankedThreads = [...snapshot.threads].sort((left, right) => (
    Number(right.threadId === snapshot.activeThreadId) - Number(left.threadId === snapshot.activeThreadId)
    || (assignmentSequenceByThread.get(right.threadId) ?? 0)
      - (assignmentSequenceByThread.get(left.threadId) ?? 0)
    || left.threadId.localeCompare(right.threadId)
  ));
  for (const thread of rankedThreads) {
    if (selectedThreadIds.size >= PROMPT_THREAD_LIMIT) break;
    selectedThreadIds.add(thread.threadId);
  }
  const threads = rankedThreads
    .filter((thread) => selectedThreadIds.has(thread.threadId))
    .map((thread) => {
      const participantUids = thread.participantUids.slice(-PROMPT_PARTICIPANT_LIMIT);
      const messageIds = thread.messageIds.slice(-PROMPT_THREAD_MESSAGE_LIMIT);
      const omittedParticipantCount = (thread.omittedParticipantCount ?? 0)
        + thread.participantUids.length - participantUids.length;
      const omittedMessageCount = (thread.omittedMessageCount ?? 0)
        + thread.messageIds.length - messageIds.length;
      return {
        ...thread,
        participantUids,
        messageIds,
        ...(omittedParticipantCount ? { omittedParticipantCount } : {}),
        ...(omittedMessageCount ? { omittedMessageCount } : {})
      };
    });
  const retainedThreadIds = new Set(threads.map((thread) => thread.threadId));
  const omittedThreadCount = (snapshot.omittedThreadCount ?? 0) + snapshot.threads.length - threads.length;
  const { activeThreadId, ...snapshotWithoutActiveThread } = snapshot;
  return {
    ...snapshotWithoutActiveThread,
    ...(activeThreadId && retainedThreadIds.has(activeThreadId) ? { activeThreadId } : {}),
    ...(omittedThreadCount ? { omittedThreadCount } : {}),
    threads,
    messageAssignments: selectedAssignments
      .filter((assignment) => retainedThreadIds.has(assignment.primaryThreadId))
      .map((assignment) => ({
        ...assignment,
        relatedThreadIds: assignment.relatedThreadIds.filter((threadId) => retainedThreadIds.has(threadId))
      }))
  };
}

async function logGroupThreadFailure(
  conversationId: string,
  incoming: ParsedIncomingMessage,
  code: string,
  cause: unknown
) {
  const detail = sanitizeErrorDetail(errorMessage(cause));
  console.error("[runtime] group thread context failed; continuing with raw messages", {
    conversationId,
    messageId: incoming.messageId,
    code,
    error: detail
  });
  try {
    await appendRequestLog({
      category: "runtime.action",
      action: "group_thread.failed",
      response: { ok: false, code, error: detail },
      metadata: {
        conversationId,
        incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
        stage: "orchestrator",
        promptFamily: "orchestrator.group-thread"
      }
    });
  } catch {
    // Thread annotation is fail-open; request-log failures cannot block the raw reply path.
  }
}
