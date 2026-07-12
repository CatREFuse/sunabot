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
import { conversationReplyEnabled, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { attachUsersToMemoryFacts, clampInteger, collectBatchUsers, indexedConversationMessages, invalidWorkingMemoryClear, isMemoryEligibleConversationMessage, normalizeUserProfileFacts, parseMemoryFactOutput, parseWorkingMemoryMergeOutput } from "./conversationMemoryHelpers.js";
import { withAbortTimeout } from "./infrastructure.js";
import { conversationTitle } from "./selfieHelpers.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export function runtime_scheduleAttachmentCacheRefresh(this: RuntimeHost) {
    this.attachmentRefreshDirty = true;
    if (this.attachmentRefreshPromise) return;
    this.attachmentRefreshPromise = (async () => {
      while (this.attachmentRefreshDirty) {
        this.attachmentRefreshDirty = false;
        await this.refreshAttachmentCacheReferences();
      }
    })()
      .catch((error) => console.error("[runtime] refresh attachment references failed", error))
      .finally(() => {
        this.attachmentRefreshPromise = undefined;
        if (this.attachmentRefreshDirty) this.scheduleAttachmentCacheRefresh();
      });
  }
export function runtime_scheduleMemoryCompression(this: RuntimeHost, record: ConversationRecord) {
    void this.enqueueConversationMemory(record)
      .then(() => this.scheduleMemoryDrain())
      .catch((error) => console.error("[runtime] memory enqueue failed", { conversationId: record.id, error }));
  }
export async function runtime_seedMemoryScheduler(this: RuntimeHost) {
    for (const record of this.conversationRecords.values()) {
      if (!conversationReplyEnabled(record)) continue;
      await this.enqueueConversationMemory(record);
    }
  }
export async function runtime_enqueueConversationMemory(this: RuntimeHost, record: ConversationRecord) {
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
      idleDelayMs: 5 * 60 * 1000
    });
  }
export function runtime_scheduleMemoryDrain(this: RuntimeHost) {
    this.memoryDrainDirty = true;
    if (this.memoryWakeTimer) {
      clearTimeout(this.memoryWakeTimer);
      this.memoryWakeTimer = undefined;
    }
    if (this.memoryDrainPromise) return;
    this.memoryDrainPromise = (async () => {
      while (this.memoryDrainDirty) {
        this.memoryDrainDirty = false;
        await this.drainMemoryScheduler();
      }
    })()
      .catch((error) => console.error("[runtime] memory scheduler failed", error))
      .finally(() => {
        this.memoryDrainPromise = undefined;
        void this.armMemoryWakeTimer();
        if (this.memoryDrainDirty) this.scheduleMemoryDrain();
      });
  }
export async function runtime_armMemoryWakeTimer(this: RuntimeHost) {
    if (this.memoryWakeTimer) clearTimeout(this.memoryWakeTimer);
    const threshold = clampInteger(this.config.bot.memory.messageThreshold, 48, 1, 200);
    const wakeAt = await this.memoryScheduler.nextWakeAt(threshold);
    if (wakeAt == null) return;
    const delay = Math.max(0, Math.min(wakeAt - Date.now(), 2_147_000_000));
    this.memoryWakeTimer = setTimeout(() => {
      this.memoryWakeTimer = undefined;
      this.scheduleMemoryDrain();
    }, delay);
  }
export async function runtime_drainMemoryScheduler(this: RuntimeHost) {
    const threshold = clampInteger(this.config.bot.memory.messageThreshold, 48, 1, 200);
    while (true) {
      const claim = await this.memoryScheduler.claimNext(threshold);
      if (!claim) return;
      if (await isMemoryBatchCommitted(this.config, claim.batchId)) {
        await this.memoryScheduler.complete(claim);
        this.projectMemoryCursor(claim);
        continue;
      }
      const ok = await this.processMemoryClaim(claim).catch((error) => {
        console.error("[runtime] memory compression failed", {
          conversationId: claim.conversation.id,
          batchId: claim.batchId,
          error
        });
        return false;
      });
      if (ok) {
        await this.memoryScheduler.complete(claim);
        this.projectMemoryCursor(claim);
      }
      else await this.memoryScheduler.fail(claim);
    }
  }
export function runtime_projectMemoryCursor(this: RuntimeHost, claim: MemoryClaim) {
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
    const context: WorkingMemoryMergeContext = {
      conversation: {
        id: record.id,
        scope: record.scope,
        title: record.title,
        userId: record.userId,
        groupId: record.groupId
      },
      participants,
      messages: batch.map(({ sequence, message }, index) => ({
        sequence,
        role: message.role,
        text: message.text,
        at: message.at,
        userId: message.userId,
        senderName: message.senderName,
        imageCount: claim.messages[index]?.imageCount ?? 0,
        quoteCount: claim.messages[index]?.quoteCount ?? 0
      })),
      metadata: {
        source: "sunabot.memory.user_profile",
        batchId: claim.batchId,
        conversationId: record.id,
        compressedMessageStart: batch[0]!.sequence,
        compressedMessageEnd: batch[batch.length - 1]!.sequence
      }
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const snapshot = await readWorkingMemorySnapshot(this.config);
      const merged = await this.requestWorkingMemoryMerge(context, snapshot.entries);
      if (!merged || invalidWorkingMemoryClear(merged, snapshot.entries.length)) return false;
      const allWorkingFacts = attachUsersToMemoryFacts(merged.facts, participants).map((fact) => ({
        ...fact,
        batchId: claim.batchId
      }));
      const existingWorkingIds = new Set(snapshot.entries.map((entry) => entry.id));
      const maxWorkingEntries = clampInteger(this.config.bot.memory.workingMemoryMaxEntries, 100, 1, 1000);
      const workingFacts = allWorkingFacts.slice(-maxWorkingEntries);
      const userProfileOutput = await this.compressUserProfiles(record, batch, participants);
      if (!userProfileOutput) return false;
      const userProfileFacts = normalizeUserProfileFacts(userProfileOutput, participants);
      const longTermFacts = allWorkingFacts
        .filter((fact) => (
          fact.promoteToLongTerm === true &&
          Boolean(fact.occurredAt || fact.time) &&
          Boolean(fact.eventType) &&
          Boolean(fact.subjectKey)
        ))
        .map((fact) => ({
          ...fact,
          sourceWorkingMemoryIds: uniqueStrings([
            ...(fact.sourceWorkingMemoryIds ?? []),
            fact.id && existingWorkingIds.has(fact.id) ? fact.id : ""
          ]),
          batchId: claim.batchId
        }));
      const result = await applyMemoryBatchTransaction(this.config, {
        batchId: claim.batchId,
        expectedWorkingSnapshotToken: snapshot.token,
        workingFacts,
        allPreviousMemoriesInvalidated: merged.allPreviousMemoriesInvalidated,
        userProfileFacts,
        longTermFacts,
        metadata: {
          ...context.metadata,
          source: "sunabot.memory.batch",
          replaceUserProfileFacts: true,
          attempt
        }
      });
      if (result.status === "applied") {
        this.persona = await loadPersona(this.config);
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
        addressName: resolveUserAddressName(
          this.config,
          participant.userId,
          profile,
          participant.currentName
        )
      };
    }));
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
        compressedMessageStart: batch[0]!.sequence,
        compressedMessageEnd: batch[batch.length - 1]!.sequence
      }
    });
  }
export async function runtime_mergeWorkingMemory(this: RuntimeHost, context: WorkingMemoryMergeContext) {
    let beforeCount = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const snapshot = await readWorkingMemorySnapshot(this.config);
      beforeCount = snapshot.entries.length;
      const merged = await this.requestWorkingMemoryMerge(context, snapshot.entries);
      if (!merged) {
        return { ok: false as const, status: "model_invalid" as const, beforeCount };
      }
      if (
        merged.allPreviousMemoriesInvalidated &&
        (merged.facts.length > 0 || snapshot.entries.length === 0)
      ) {
        console.error("[runtime] invalid working memory clear signal", {
          conversationId: context.conversation.id,
          previousCount: snapshot.entries.length,
          factCount: merged.facts.length
        });
        return { ok: false as const, status: "model_invalid" as const, beforeCount };
      }

      const facts = attachUsersToMemoryFacts(merged.facts, context.participants);
      const replaced = await replaceWorkingMemoryFacts(this.config, facts, {
        expectedSnapshotToken: snapshot.token,
        allPreviousMemoriesInvalidated: merged.allPreviousMemoriesInvalidated,
        metadata: context.metadata
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
      if (replaced.status !== "snapshot_conflict") {
        return { ok: false as const, status: replaced.status, beforeCount };
      }
    }
    console.error("[runtime] working memory merge snapshot conflict", {
      conversationId: context.conversation.id
    });
    return { ok: false as const, status: "snapshot_conflict" as const, beforeCount };
  }
export async function runtime_requestWorkingMemoryMerge(this: RuntimeHost,
    context: WorkingMemoryMergeContext,
    previousWorkingMemories: MemoryEntry[]
  ): Promise<WorkingMemoryMergeOutput | null> {
    try {
      const provider = this.getProviderForModel(
        this.config.bot.memory.memoryModel,
        this.config.bot.memory.reasoningEffort
      );
      const relatedLongTerm = await recallMemory(this.config, {
        query: [
          context.conversation.id,
          context.conversation.title,
          ...context.participants.flatMap((participant) => [participant.userId, participant.addressName]),
          ...context.messages.map((message) => message.text)
        ].filter(Boolean).join(" "),
        source: "long_term",
        limit: 20
      });
      const payload = {
        conversation: context.conversation,
        admin: this.adminIdentity(),
        participants: context.participants,
        previousWorkingMemories: previousWorkingMemories.map((entry) => ({
          id: entry.id,
          fact: entry.text,
          userId: entry.userId,
          userIds: entry.userIds,
          userName: entry.userName,
          occurredAt: entry.occurredAt,
          occurredEndAt: entry.occurredEndAt,
          observedAt: entry.observedAt,
          time: entry.time || "",
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          eventType: entry.eventType,
          subjectKey: entry.subjectKey,
          eventKey: entry.eventKey,
          longTermId: entry.longTermId,
          promoteToLongTerm: entry.promoteToLongTerm
        })),
        relatedLongTermMemories: relatedLongTerm.ok ? relatedLongTerm.matches.map((entry) => ({
          id: entry.id,
          fact: entry.text,
          occurredAt: entry.occurredAt,
          occurredEndAt: entry.occurredEndAt,
          userIds: entry.userIds,
          eventType: entry.eventType,
          subjectKey: entry.subjectKey,
          eventKey: entry.eventKey,
          sourceWorkingMemoryIds: entry.sourceWorkingMemoryIds
        })) : [],
        messages: context.messages
      };
      const promptRequest = await this.renderPromptRequest("memory.compress-in", {
        "memory.payload": payload
      });
      const output = await withAbortTimeout(
        (signal) => this.completePrompt(provider, promptRequest, {
          signal,
          logContext: {
            conversationId: context.conversation.id,
            stage: "memory",
            memoryKind: "working_long_term"
          }
        }),
        PREPARE_TIMEOUT_MS
      );
      return parseWorkingMemoryMergeOutput(output);
    } catch (error) {
      console.error("[runtime] work memory compression failed", {
        conversationId: context.conversation.id,
        error
      });
      return null;
    }
  }
export async function runtime_compressUserProfiles(this: RuntimeHost,
    record: ConversationRecord,
    batch: Array<{ sequence: number; message: ConversationRecord["messages"][number] }>,
    participants: BatchUserInfo[]
  ) {
    if (!participants.length) return [];

    try {
      const provider = this.getProviderForModel(
        this.config.bot.memory.memoryModel,
        this.config.bot.memory.reasoningEffort
      );
      const payload = {
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
          addressName: participant.addressName,
          groupId: record.groupId,
          conversationTitle: record.title
        })),
        previousProfiles: await this.readRelevantUserProfiles(participants),
        messages: batch.map(({ sequence, message }) => ({
          sequence,
          role: message.role,
          text: message.text,
          at: message.at,
          userId: message.userId,
          senderName: message.senderName,
          imageCount: message.imageUrls?.length ?? 0,
          quoteCount: message.quoteReferences?.length ?? 0
        }))
      };
      const promptRequest = await this.renderPromptRequest("memory.user-profile", {
        "profile.payload": payload
      });
      const output = await withAbortTimeout(
        (signal) => this.completePrompt(provider, promptRequest, {
          signal,
          logContext: {
            conversationId: record.id,
            stage: "memory",
            memoryKind: "user_profile"
          }
        }),
        PREPARE_TIMEOUT_MS
      );
      return parseMemoryFactOutput(output);
    } catch (error) {
      console.error("[runtime] user profile compression failed", {
        conversationId: record.id,
        error
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
  projectMemoryCursor(...args: Parameters<typeof runtime_projectMemoryCursor>) { return runtime_projectMemoryCursor.call(this.host, ...args); }
  processMemoryClaim(...args: Parameters<typeof runtime_processMemoryClaim>) { return runtime_processMemoryClaim.call(this.host, ...args); }
  enrichParticipantAddressNames(...args: Parameters<typeof runtime_enrichParticipantAddressNames>) { return runtime_enrichParticipantAddressNames.call(this.host, ...args); }
  mergeConversationWorkingMemory(...args: Parameters<typeof runtime_mergeConversationWorkingMemory>) { return runtime_mergeConversationWorkingMemory.call(this.host, ...args); }
  mergeWorkingMemory(...args: Parameters<typeof runtime_mergeWorkingMemory>) { return runtime_mergeWorkingMemory.call(this.host, ...args); }
  requestWorkingMemoryMerge(...args: Parameters<typeof runtime_requestWorkingMemoryMerge>) { return runtime_requestWorkingMemoryMerge.call(this.host, ...args); }
  compressUserProfiles(...args: Parameters<typeof runtime_compressUserProfiles>) { return runtime_compressUserProfiles.call(this.host, ...args); }
}
