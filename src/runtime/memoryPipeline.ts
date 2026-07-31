import { formatModelTimestamp, formatOptionalModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import { loadPersona } from "../../services/agent/persona.js";
import {
  type MemoryClaim,
  type MemoryQueuedMessage
} from "../../services/memory/memoryScheduler.js";
import {
  applyMemoryBatchTransaction,
  isMemoryBatchCommitted,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  replaceWorkingMemoryFacts,
  resolveUserAddressNames,
  type MemoryEntry
} from "../../services/memory/memoryService.js";
import { recordMemoryOperation } from "../../services/memory/operationAudit.js";
import {
  ConversationRecord
} from "../types.js";
import { attachUsersToMemoryFacts, clampInteger, collectBatchUsers, indexedConversationMessages, isMemoryEligibleConversationMessage, parseCompleteMemoryFactOutput, parseCompleteWorkingMemoryMergeOutput, validateUserProfileFacts } from "./conversationMemoryHelpers.js";
import { withAbortTimeout } from "./infrastructure.js";
import {
  MEMORY_PROVIDER_TOTAL_TIMEOUT_MS,
  memoryProviderCompleteOptions
} from "./memoryProviderBudget.js";
import { conversationReplyEnabled, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { BatchUserInfo, WorkingMemoryMergeContext, WorkingMemoryMergeOutput } from "./runtimeContracts.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

function runtimeActive(host: RuntimeHost) {
  const value = (host as { isRuntimeActive?: () => boolean }).isRuntimeActive;
  return typeof value !== "function" || value.call(host);
}

function runtimeSignal(host: RuntimeHost) {
  return (host as { runtimeSignal?: AbortSignal }).runtimeSignal;
}

export function runtime_scheduleAttachmentCacheRefresh(this: RuntimeHost) {
    if (!runtimeActive(this)) return;
    this.attachmentRefreshDirty = true;
    if (this.attachmentRefreshPromise) return;
    this.attachmentRefreshPromise = (async () => {
      while (this.attachmentRefreshDirty) {
        if (!runtimeActive(this)) return;
        this.attachmentRefreshDirty = false;
        await this.refreshAttachmentCacheReferences();
      }
    })()
      .catch((error) => console.error("[runtime] refresh attachment references failed", error))
      .finally(() => {
        this.attachmentRefreshPromise = undefined;
        if (this.attachmentRefreshDirty && runtimeActive(this)) this.scheduleAttachmentCacheRefresh();
      });
  }
export function runtime_scheduleMemoryCompression(this: RuntimeHost, record: ConversationRecord) {
    if (!runtimeActive(this)) return;
    void this.enqueueConversationMemory(record)
      .then(() => this.scheduleMemoryDrain())
      .catch((error) => {
        if (runtimeActive(this)) {
          console.error("[runtime] memory enqueue failed", { conversationId: record.id, error });
        }
      });
  }
export async function runtime_seedMemoryScheduler(this: RuntimeHost) {
    for (const record of this.conversationRecords.values()) {
      runtimeSignal(this)?.throwIfAborted();
      if (!conversationReplyEnabled(record)) continue;
      await this.enqueueConversationMemory(record);
    }
  }
export async function runtime_enqueueConversationMemory(this: RuntimeHost, record: ConversationRecord) {
    runtimeSignal(this)?.throwIfAborted();
    const messages = indexedConversationMessages(record)
      .filter(({ message }) => isMemoryEligibleConversationMessage(message))
      .map(({ sequence, message }): MemoryQueuedMessage => ({
        id: message.id,
        sequence,
        role: message.role as "user" | "assistant",
        text: message.text,
        at: message.at,
        userId: message.userId,
        senderName: message.senderName,
        imageCount: message.imageUrls?.length ?? 0,
        quoteCount: message.quoteReferences?.length ?? 0
      }));
    await this.memoryScheduler.enqueue({
      id: record.id,
      scope: record.scope,
      title: record.title,
      userId: record.userId,
      groupId: record.groupId
    }, messages, {
      committedThrough: record.memoryCompressedThroughMessageCount,
      reconcileGroupHistory: true
    });
    runtimeSignal(this)?.throwIfAborted();
    await syncMemoryDebtAlertSafely(this);
  }
export function runtime_scheduleMemoryDrain(this: RuntimeHost) {
    if (!runtimeActive(this)) return;
    this.memoryDrainDirty = true;
    if (this.memoryWakeTimer) {
      clearTimeout(this.memoryWakeTimer);
      this.memoryWakeTimer = undefined;
    }
    if (this.memoryDrainPromise) return;
    this.memoryDrainPromise = (async () => {
      while (this.memoryDrainDirty) {
        if (!runtimeActive(this)) return;
        this.memoryDrainDirty = false;
        await this.drainMemoryScheduler();
      }
    })()
      .catch((error) => console.error("[runtime] memory scheduler failed", error))
      .finally(() => {
        this.memoryDrainPromise = undefined;
        if (!runtimeActive(this)) return;
        void this.armMemoryWakeTimer();
        if (this.memoryDrainDirty) this.scheduleMemoryDrain();
      });
  }
export async function runtime_armMemoryWakeTimer(this: RuntimeHost) {
    if (!runtimeActive(this)) return;
    if (this.memoryWakeTimer) clearTimeout(this.memoryWakeTimer);
    const threshold = clampInteger(this.config.bot.memory.messageThreshold, 16, 1, 200);
    const wakeAt = await this.memoryScheduler.nextWakeAt(threshold);
    if (!runtimeActive(this)) return;
    if (wakeAt == null) return;
    const delay = Math.max(0, Math.min(wakeAt - Date.now(), 2_147_000_000));
    this.memoryWakeTimer = setTimeout(() => {
      this.memoryWakeTimer = undefined;
      if (!runtimeActive(this)) return;
      this.scheduleMemoryDrain();
    }, delay);
  }
export async function runtime_drainMemoryScheduler(this: RuntimeHost) {
    const threshold = clampInteger(this.config.bot.memory.messageThreshold, 16, 1, 200);
    while (runtimeActive(this)) {
      const claim = await this.memoryScheduler.claimNext(threshold);
      if (!runtimeActive(this)) return;
      if (!claim) return;
      if (await isMemoryBatchCommitted(this.config, claim.batchId)) {
        if (!runtimeActive(this)) return;
        await this.memoryScheduler.complete(claim, Date.now(), { refundAttempt: true });
        if (!runtimeActive(this)) return;
        this.projectMemoryCursor(claim);
        await syncMemoryDebtAlertSafely(this);
        continue;
      }
      const ok = await this.processMemoryClaim(claim).catch((error) => {
        if (!runtimeActive(this)) throw error;
        console.error("[runtime] memory compression failed", {
          conversationId: claim.conversation.id,
          batchId: claim.batchId,
          error
        });
        return false;
      });
      if (!runtimeActive(this)) return;
      recordMemoryOperation(this.config, {
        source: "working",
        operation: "compression_attempt",
        actor: "memory_pipeline",
        outcome: ok ? "applied" : "failed",
        batchId: claim.batchId,
        conversationId: claim.conversation.id,
        conversationScope: claim.conversation.scope,
        ...(ok ? {} : { reasonCode: "memory_processing_failed" })
      });
      if (ok) {
        await this.memoryScheduler.complete(claim);
        if (!runtimeActive(this)) return;
        this.projectMemoryCursor(claim);
      }
      else await this.memoryScheduler.fail(claim);
      await syncMemoryDebtAlertSafely(this);
    }
  }
export async function runtime_syncMemoryDebtAlert(this: RuntimeHost) {
    if (!runtimeActive(this)) return { queued: false as const, reason: "runtime_closed" as const };
    const claim = await this.memoryScheduler.claimDebtAlert();
    if (!runtimeActive(this)) return { queued: false as const, reason: "runtime_closed" as const };
    if (!claim) return { queued: false as const, reason: "not_due" as const };
    let targetConversationId = claim.targetConversationId;
    if (!targetConversationId) {
      const target = await this.scheduledTasks.resolveMemoryDebtAlertTarget();
      if (!target.resolved) return { queued: false as const, reason: target.reason };
      targetConversationId = await this.memoryScheduler.bindDebtAlertTarget(
        claim.episodeId,
        target.conversationId
      );
      if (!targetConversationId) {
        return { queued: false as const, reason: "episode_changed" as const };
      }
    }
    const queued = await this.memoryScheduler.enqueueDebtAlertIfDue(
      claim.episodeId,
      targetConversationId,
      () => this.scheduledTasks.enqueueMemoryDebtAlert({
        episodeId: claim.episodeId,
        targetConversationId
      })
    );
    if (!queued.executed) {
      return { queued: false as const, reason: queued.reason };
    }
    return queued.result;
  }
export function runtime_projectMemoryCursor(this: RuntimeHost, claim: MemoryClaim) {
    if (!runtimeActive(this)) return;
    const record = this.conversationRecords.get(claim.conversation.id);
    const lastSequence = claim.messages[claim.messages.length - 1]?.sequence;
    if (!record || lastSequence == null) return;
    record.memoryCompressedThroughMessageCount = Math.max(
      record.memoryCompressedThroughMessageCount ?? 0,
      lastSequence
    );
    record.memoryCompressedAt = new Date().toISOString();
    this.persistConversationRecords();
  }
export async function runtime_processMemoryClaim(this: RuntimeHost, claim: MemoryClaim) {
  return withAbortTimeout(
    (signal) => processMemoryClaimWithinBudget.call(this, claim, signal),
    MEMORY_PROVIDER_TOTAL_TIMEOUT_MS,
    undefined,
    runtimeSignal(this)
  );
}

async function processMemoryClaimWithinBudget(
  this: RuntimeHost,
  claim: MemoryClaim,
  signal: AbortSignal
) {
    signal.throwIfAborted();
    const existingRecord = this.conversationRecords.get(claim.conversation.id);
    const record: ConversationRecord = existingRecord ?? {
      id: claim.conversation.id,
      scope: claim.conversation.scope as ConversationRecord["scope"],
      title: claim.conversation.title,
      userId: claim.conversation.userId ?? 0,
      groupId: claim.conversation.groupId,
      messageCount: claim.messages[claim.messages.length - 1]?.sequence ?? 0,
      lastAt: claim.messages[claim.messages.length - 1]?.at ?? new Date().toISOString(),
      lastText: claim.messages[claim.messages.length - 1]?.text ?? "",
      messages: []
    };
    const batch = claim.messages.map((message) => ({
      sequence: message.sequence,
      message: {
        id: message.id,
        sequence: message.sequence,
        role: message.role,
        text: message.text,
        at: message.at,
        userId: message.userId,
        groupId: claim.conversation.groupId,
        senderName: message.senderName
      } satisfies ConversationRecord["messages"][number]
    }));
    const admin = this.adminIdentity();
    const participants = await this.enrichParticipantAddressNames(collectBatchUsers(batch, admin));
    signal.throwIfAborted();
    const userProfileOutput = await this.compressUserProfiles(record, batch, participants, signal);
    signal.throwIfAborted();
    if (!userProfileOutput) {
      recordMemoryOperation(this.config, {
        source: "user_profile",
        operation: "batch_validate",
        actor: "memory_pipeline",
        outcome: "rejected",
        batchId: claim.batchId,
        conversationId: record.id,
        conversationScope: record.scope,
        reasonCode: "model_output_invalid"
      });
      return false;
    }
    const userProfileValidation = validateUserProfileFacts(
      userProfileOutput,
      participants,
      batch.map(({ message }) => ({ text: message.text }))
    );
    const userProfileFacts = userProfileValidation.accepted;
    if (userProfileFacts.length !== userProfileOutput.length) {
      const rejectionReasons = rejectionReasonCounts(userProfileValidation.rejected);
      console.warn("[runtime] ignored unroutable user profile items", {
        conversationId: record.id,
        batchId: claim.batchId,
        memoryKind: "user_profile",
        returnedCount: userProfileOutput.length,
        acceptedCount: userProfileFacts.length,
        rejectionReasons
      });
      for (const reasonCode of Object.keys(rejectionReasons)) {
        recordMemoryOperation(this.config, {
          source: "user_profile",
          operation: "batch_validate",
          actor: "memory_pipeline",
          outcome: "rejected",
          batchId: claim.batchId,
          conversationId: record.id,
          conversationScope: record.scope,
          beforeCount: userProfileOutput.length,
          afterCount: userProfileFacts.length,
          changedCount: 0,
          reasonCode
        });
      }
    }
    const participantAddressNames = new Map(userProfileFacts.map((fact) => [fact.userId, fact.addressNames ?? []]));
    const memoryParticipants = participants.map((participant) => ({
      ...participant,
      addressNames: uniqueStrings([
        ...participant.addressNames,
        ...(participantAddressNames.get(participant.userId) ?? [])
      ])
    }));
    const context: WorkingMemoryMergeContext = {
      conversation: {
        id: record.id,
        scope: record.scope,
        title: record.title,
        userId: record.userId,
        groupId: record.groupId
      },
      participants: memoryParticipants,
      messages: batch.map(({ sequence, message }, index) => ({
        sequence,
        role: message.role,
        text: message.text,
        at: formatModelTimestamp(message.at),
        userId: message.userId,
        senderName: message.senderName,
        imageCount: claim.messages[index]?.imageCount ?? 0,
        quoteCount: claim.messages[index]?.quoteCount ?? 0
      })),
      metadata: {
        source: "sunabot.memory.user_profile",
        batchId: claim.batchId,
        conversationId: record.id,
        conversationScope: record.scope,
        conversationTitle: record.title,
        compressedMessageStart: batch[0]!.sequence,
        compressedMessageEnd: batch[batch.length - 1]!.sequence
      }
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const snapshot = await readWorkingMemorySnapshot(this.config);
      signal.throwIfAborted();
      const merged = await this.requestWorkingMemoryMerge(context, snapshot.entries, signal);
      signal.throwIfAborted();
      if (!merged) return false;
      const acceptedWorkingFacts = attachUsersToMemoryFacts(merged.facts, memoryParticipants);
      const allWorkingFacts = acceptedWorkingFacts.map((fact) => ({
        ...fact,
        batchId: claim.batchId
      }));
      const maxWorkingEntries = clampInteger(this.config.bot.memory.workingMemoryMaxEntries, 100, 1, 1000);
      const workingFacts = allWorkingFacts.slice(-maxWorkingEntries);
      signal.throwIfAborted();
      const result = await applyMemoryBatchTransaction(this.config, {
        batchId: claim.batchId,
        expectedWorkingSnapshotToken: snapshot.token,
        workingFacts,
        userProfileFacts,
        longTermFacts: [],
        metadata: {
          ...context.metadata,
          source: "sunabot.memory.batch",
          replaceUserProfileFacts: true,
          attempt
        }
      }, signal);
      if (result.status === "applied") {
        this.persona = await loadPersona(this.config);
        signal.throwIfAborted();
        return true;
      }
      if (result.status !== "snapshot_conflict") return false;
    }
    console.error("[runtime] memory batch snapshot conflict", {
      conversationId: record.id,
      batchId: claim.batchId
    });
    return false;
  }
export async function runtime_enrichParticipantAddressNames(this: RuntimeHost, participants: BatchUserInfo[]) {
    return Promise.all(participants.map(async (participant) => {
      const profile = await readUserProfileForUser(this.config, participant.userId);
      return {
        ...participant,
        addressNames: resolveUserAddressNames(
          this.config,
          participant.userId,
          profile,
          participant.names
        )
      };
    }));
  }

function rejectionReasonCounts(
  rejected: ReadonlyArray<{ reasonCode: string }>
) {
  return rejected.reduce<Record<string, number>>((counts, item) => {
    counts[item.reasonCode] = (counts[item.reasonCode] ?? 0) + 1;
    return counts;
  }, {});
}

async function syncMemoryDebtAlertSafely(host: RuntimeHost) {
  await runtime_syncMemoryDebtAlert.call(host).catch((error) => {
    console.error("[runtime] memory debt alert failed", { error });
  });
}
export async function runtime_mergeConversationWorkingMemory(this: RuntimeHost,
    record: ConversationRecord,
    batch: Array<{ sequence: number; message: ConversationRecord["messages"][number] }>,
    participants: BatchUserInfo[]
  ) {
    return this.mergeWorkingMemory({
      conversation: {
        id: record.id,
        scope: record.scope,
        title: record.title,
        userId: record.userId,
        groupId: record.groupId
      },
      participants,
      messages: batch.map(({ sequence, message }) => ({
        sequence,
        role: message.role,
        text: message.text,
        at: message.at,
        userId: message.userId,
        senderName: message.senderName,
        imageCount: message.imageUrls?.length ?? 0,
        quoteCount: message.quoteReferences?.length ?? 0
      })),
      metadata: {
        source: "sunabot.memory.compress.in",
        conversationId: record.id,
        conversationScope: record.scope,
        conversationTitle: record.title,
        compressedMessageStart: batch[0]!.sequence,
        compressedMessageEnd: batch[batch.length - 1]!.sequence
      }
    });
  }
export async function runtime_mergeWorkingMemory(this: RuntimeHost, context: WorkingMemoryMergeContext) {
  return withAbortTimeout(
    (signal) => mergeWorkingMemoryWithinBudget.call(this, context, signal),
    MEMORY_PROVIDER_TOTAL_TIMEOUT_MS
  );
}

async function mergeWorkingMemoryWithinBudget(
  this: RuntimeHost,
  context: WorkingMemoryMergeContext,
  signal: AbortSignal
) {
    let beforeCount = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const snapshot = await readWorkingMemorySnapshot(this.config);
      beforeCount = snapshot.entries.length;
      const ordinaryEntries = snapshot.entries.filter((entry) => entry.memoryKind !== "dream");
      const merged = await this.requestWorkingMemoryMerge(context, ordinaryEntries, signal);
      if (!merged) {
        return { ok: false as const, status: "model_invalid" as const, beforeCount };
      }

      const facts = attachUsersToMemoryFacts(merged.facts, context.participants);
      signal.throwIfAborted();
      const replaced = await replaceWorkingMemoryFacts(this.config, facts, {
        expectedSnapshotToken: snapshot.token,
        metadata: {
          ...context.metadata,
          conversationId: context.conversation.id,
          conversationScope: context.conversation.scope,
          conversationTitle: context.conversation.title
        }
      });
      if (replaced.status === "applied") {
        return {
          ok: true as const,
          status: "applied" as const,
          beforeCount,
          afterCount: replaced.entries.length,
          attempts: attempt,
          facts
        };
      }
    }
    console.error("[runtime] working memory merge snapshot conflict", {
      conversationId: context.conversation.id
    });
    return { ok: false as const, status: "snapshot_conflict" as const, beforeCount };
  }
export async function runtime_requestWorkingMemoryMerge(this: RuntimeHost,
    context: WorkingMemoryMergeContext,
    previousWorkingMemories: MemoryEntry[],
    parentSignal?: AbortSignal
  ): Promise<WorkingMemoryMergeOutput | null> {
    const signal = parentSignal ?? AbortSignal.timeout(MEMORY_PROVIDER_TOTAL_TIMEOUT_MS);
    try {
      signal.throwIfAborted();
      const provider = this.getProviderForModel(
        this.config.bot.memory.memoryModel,
        this.config.bot.memory.reasoningEffort
      );
      const payload = {
        systemTimeZone: systemModelTimeZone(),
        conversation: context.conversation,
        admin: this.adminIdentity(),
        participants: context.participants,
        previousWorkingMemories: previousWorkingMemories.map((entry) => ({
          id: entry.id,
          fact: entry.text,
          userId: entry.userId,
          userIds: entry.userIds,
          addressNames: entry.addressNames,
          occurredAt: formatOptionalModelTimestamp(entry.occurredAt),
          occurredEndAt: formatOptionalModelTimestamp(entry.occurredEndAt),
          observedAt: formatOptionalModelTimestamp(entry.observedAt),
          time: entry.time || "",
          createdAt: formatOptionalModelTimestamp(entry.createdAt),
          updatedAt: formatOptionalModelTimestamp(entry.updatedAt),
          recordedAt: entry.recordedAt,
          timeZone: entry.timeZone,
          conversationId: entry.conversationId,
          conversationScope: entry.conversationScope,
          conversationTitle: entry.conversationTitle,
          sourceKind: entry.sourceKind,
          eventType: entry.eventType,
          subjectKey: entry.subjectKey,
          eventKey: entry.eventKey
        })),
        evidenceConstraints: [
          "imageCount、quoteCount 和图片或回复占位文本只证明存在对应消息段，不能证明不可见图片、被回复正文或媒体内容；不得据此补写其内容。",
          "把动作、原话、偏好或立场归给某位参与者时，必须由该参与者自己的可见消息直接支持；仅在同一会话出现不能作为归因依据。"
        ],
        messages: context.messages.map((message) => ({
          ...message,
          at: formatModelTimestamp(message.at)
        }))
      };
      const promptRequest = await this.renderPromptRequest("memory.compress-in", {
        "memory.payload": payload
      });
      signal.throwIfAborted();
      const output = await this.completePrompt(provider, promptRequest, memoryProviderCompleteOptions(signal, {
        conversationId: context.conversation.id,
        stage: "memory",
        promptFamily: "memory.compress-in",
        memoryKind: "working_long_term"
      }));
      signal.throwIfAborted();
      const parsed = parseCompleteWorkingMemoryMergeOutput(output);
      if (!parsed) {
        console.error("[runtime] rejected invalid memory model output", {
          conversationId: context.conversation.id,
          memoryKind: "working_long_term",
          reason: "parse"
        });
        recordMemoryOperation(this.config, {
          source: "working",
          operation: "batch_validate",
          actor: "memory_pipeline",
          outcome: "rejected",
          batchId: typeof context.metadata.batchId === "string" ? context.metadata.batchId : undefined,
          conversationId: context.conversation.id,
          conversationScope: context.conversation.scope,
          beforeCount: previousWorkingMemories.length,
          afterCount: previousWorkingMemories.length,
          changedCount: 0,
          reasonCode: "parse_failed"
        });
        return null;
      }
      return parsed;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      console.error("[runtime] work memory compression failed", {
        conversationId: context.conversation.id,
        error
      });
      recordMemoryOperation(this.config, {
        source: "working",
        operation: "batch_validate",
        actor: "memory_pipeline",
        outcome: "failed",
        batchId: typeof context.metadata.batchId === "string" ? context.metadata.batchId : undefined,
        conversationId: context.conversation.id,
        conversationScope: context.conversation.scope,
        beforeCount: previousWorkingMemories.length,
        afterCount: previousWorkingMemories.length,
        changedCount: 0,
        reasonCode: "provider_failed"
      });
      return null;
    }
  }
export async function runtime_compressUserProfiles(this: RuntimeHost,
    record: ConversationRecord,
    batch: Array<{ sequence: number; message: ConversationRecord["messages"][number] }>,
    participants: BatchUserInfo[],
    parentSignal?: AbortSignal
  ) {
    if (!participants.length) return [];

    const signal = parentSignal ?? AbortSignal.timeout(MEMORY_PROVIDER_TOTAL_TIMEOUT_MS);
    try {
      signal.throwIfAborted();
      const provider = this.getProviderForModel(
        this.config.bot.memory.memoryModel,
        this.config.bot.memory.reasoningEffort
      );
      const payload = {
        systemTimeZone: systemModelTimeZone(),
        conversation: {
          id: record.id,
          scope: record.scope,
          title: record.title,
          userId: record.userId,
          groupId: record.groupId
        },
        admin: this.adminIdentity(),
        participants,
        currentAliases: participants.map((participant) => ({
          userId: participant.userId,
          userName: participant.currentName || participant.userId,
          addressNames: participant.addressNames,
          groupId: record.groupId,
          conversationTitle: record.title
        })),
        previousProfiles: await this.readRelevantUserProfiles(participants),
        messages: batch.map(({ sequence, message }) => ({
          sequence,
          role: message.role,
          text: message.text,
          at: formatModelTimestamp(message.at),
          userId: message.userId,
          senderName: message.senderName,
          imageCount: message.imageUrls?.length ?? 0,
          quoteCount: message.quoteReferences?.length ?? 0
        }))
      };
      signal.throwIfAborted();
      const promptRequest = await this.renderPromptRequest("memory.user-profile", {
        "profile.payload": payload
      });
      signal.throwIfAborted();
      const output = await this.completePrompt(provider, promptRequest, memoryProviderCompleteOptions(signal, {
        conversationId: record.id,
        stage: "memory",
        promptFamily: "memory.user-profile",
        memoryKind: "user_profile"
      }));
      signal.throwIfAborted();
      const parsed = parseCompleteMemoryFactOutput(output);
      if (!parsed) {
        recordMemoryOperation(this.config, {
          source: "user_profile",
          operation: "batch_validate",
          actor: "memory_pipeline",
          outcome: "rejected",
          conversationId: record.id,
          conversationScope: record.scope,
          reasonCode: "parse_failed"
        });
      }
      return parsed;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      console.error("[runtime] user profile compression failed", {
        conversationId: record.id,
        error
      });
      recordMemoryOperation(this.config, {
        source: "user_profile",
        operation: "batch_validate",
        actor: "memory_pipeline",
        outcome: "failed",
        conversationId: record.id,
        conversationScope: record.scope,
        reasonCode: "provider_failed"
      });
      return null;
    }
  }

export class RuntimeMemoryPipeline {
  constructor(private readonly host: RuntimeHost) {}
  scheduleAttachmentCacheRefresh(...args: Parameters<typeof runtime_scheduleAttachmentCacheRefresh>) { return runtime_scheduleAttachmentCacheRefresh.call(this.host, ...args); }
  scheduleMemoryCompression(...args: Parameters<typeof runtime_scheduleMemoryCompression>) { return runtime_scheduleMemoryCompression.call(this.host, ...args); }
  seedMemoryScheduler(...args: Parameters<typeof runtime_seedMemoryScheduler>) { return runtime_seedMemoryScheduler.call(this.host, ...args); }
  enqueueConversationMemory(...args: Parameters<typeof runtime_enqueueConversationMemory>) { return runtime_enqueueConversationMemory.call(this.host, ...args); }
  scheduleMemoryDrain(...args: Parameters<typeof runtime_scheduleMemoryDrain>) { return runtime_scheduleMemoryDrain.call(this.host, ...args); }
  armMemoryWakeTimer(...args: Parameters<typeof runtime_armMemoryWakeTimer>) { return runtime_armMemoryWakeTimer.call(this.host, ...args); }
  drainMemoryScheduler(...args: Parameters<typeof runtime_drainMemoryScheduler>) { return runtime_drainMemoryScheduler.call(this.host, ...args); }
  syncMemoryDebtAlert(...args: Parameters<typeof runtime_syncMemoryDebtAlert>) { return runtime_syncMemoryDebtAlert.call(this.host, ...args); }
  projectMemoryCursor(...args: Parameters<typeof runtime_projectMemoryCursor>) { return runtime_projectMemoryCursor.call(this.host, ...args); }
  processMemoryClaim(...args: Parameters<typeof runtime_processMemoryClaim>) { return runtime_processMemoryClaim.call(this.host, ...args); }
  enrichParticipantAddressNames(...args: Parameters<typeof runtime_enrichParticipantAddressNames>) { return runtime_enrichParticipantAddressNames.call(this.host, ...args); }
  mergeConversationWorkingMemory(...args: Parameters<typeof runtime_mergeConversationWorkingMemory>) { return runtime_mergeConversationWorkingMemory.call(this.host, ...args); }
  mergeWorkingMemory(...args: Parameters<typeof runtime_mergeWorkingMemory>) { return runtime_mergeWorkingMemory.call(this.host, ...args); }
  requestWorkingMemoryMerge(...args: Parameters<typeof runtime_requestWorkingMemoryMerge>) { return runtime_requestWorkingMemoryMerge.call(this.host, ...args); }
  compressUserProfiles(...args: Parameters<typeof runtime_compressUserProfiles>) { return runtime_compressUserProfiles.call(this.host, ...args); }
}
