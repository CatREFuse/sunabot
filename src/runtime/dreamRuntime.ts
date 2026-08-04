import { createHash } from "node:crypto";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  digestDreamMemorySnapshot,
  type JsonObject as DreamStoreJsonObject
} from "../../adapters/sqlite/dreamStore.js";
import {
  DREAM_PROMPT_ID,
  latestDreamScheduleOccurrence,
  normalizeDreamMemorySnapshot,
  type DreamMemoryRecord
} from "../../services/memory/dream/public.js";
import {
  readWorkingMemoryDocument,
  recordMemoryOperation,
  replaceWorkingMemoryDocument,
  workingMemoryItemToEntry,
  workingMemoryItemsFromFacts
} from "../../services/memory/public.js";
import { readAirKnowledge } from "../../services/air/public.js";
import type { PromptVariableValue, RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import type { ConversationRecord } from "../types.js";
import type { SunaRuntime } from "../runtime.js";
import { auxiliaryProviderCompleteOptions } from "./auxiliaryModelBudget.js";
import { isMemoryEligibleConversationMessage } from "./conversationMemoryHelpers.js";
import {
  createRuntimeDreams,
  type RuntimeDreamContextSnapshot,
  type RuntimeDreamStorePort
} from "./dreamPipeline.js";

const MAX_DREAM_PROFILE_RECORDS = 64;
const MAX_DREAM_CONVERSATIONS = 12;
const MAX_DREAM_MESSAGES_PER_CONVERSATION = 16;
const MAX_DREAM_MESSAGE_CHARS = 1_000;
const MAX_DREAM_TASKS = 100;
const DREAM_SLEEP_NOTICE_CONTEXT = [
  "管理员刚刚在管理台手动触发了 Dream。",
  "请结合当前人格以及你与管理员的关系，自然地发送一条自己已经睡着、正在进入梦境的即时消息。",
  "只发送这一条消息，不介绍后台操作、定时任务、提示词或内部字段。"
].join("\n");

export function createRuntimeDreamsForHost(host: SunaRuntime) {
  return createRuntimeDreams({
    agentId: host.config.persona.defaultAgentId,
    lifecycleSignal: host.runtimeSignal,
    store: applicationDataStore(host.config).dreams as unknown as RuntimeDreamStorePort,
    context: { capture: (input) => captureDreamContext(host, input) },
    workingMemory: {
      compareAndSwap: (input) => compareAndSwapDreamWorkingMemory(host, input)
    },
    prompt: {
      render: (id, variables) => host.renderPromptRequest(
        id,
        variables as Readonly<Record<string, PromptVariableValue>>
      )
    },
    model: {
      complete: (request, options) => host.completePrompt(
        host.getProviderForModel(
          host.config.bot.memory.memoryModel,
          host.config.bot.memory.reasoningEffort
        ),
        request as RenderedPromptRequest,
        auxiliaryProviderCompleteOptions(options)
      )
    },
    log: {
      write: (event) => {
        const conversationId = `dream:${host.config.persona.defaultAgentId}`;
        recordMemoryOperation(host.config, {
          source: "dream",
          operation: event.action.replace(/^dream[.:]/u, ""),
          actor: "dream",
          outcome: dreamAuditOutcome(event.action, event.level),
          batchId: event.runId,
          conversationId,
          conversationScope: "dream",
          reasonCode: dreamAuditReason(event.data)
        });
        return appendRequestLog({
          category: "runtime.action",
          action: event.action,
          request: { localDate: event.localDate, level: event.level },
          response: {
            ...(event.data ?? {}),
            ...(event.attemptCount == null ? {} : { attemptCount: event.attemptCount }),
            ...(event.maxAttempts == null ? {} : { maxAttempts: event.maxAttempts })
          },
          metadata: {
            conversationId,
            runId: event.runId,
            stage: "memory",
            promptFamily: DREAM_PROMPT_ID,
            ...(event.attemptCount == null ? {} : { attemptCount: event.attemptCount }),
            ...(event.maxAttempts == null ? {} : { maxAttempts: event.maxAttempts })
          }
        });
      }
    }
  });
}

function dreamAuditOutcome(action: string, level: string) {
  if (level === "error" || /failed|error/u.test(action)) return "failed" as const;
  if (/skipped|unchanged|noop/u.test(action)) return "unchanged" as const;
  return "applied" as const;
}

function dreamAuditReason(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["code", "reasonCode", "reason"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export async function forceRuntimeDreamForHost(host: SunaRuntime, input: { accountId: string }) {
  const accountId = normalizedAccountId(input.accountId);
  const administratorUserId = administratorQq(host.config.bot.adminQq);
  const triggeredAt = new Date();
  const run = await host.dreams.force(triggeredAt, async (accepted) => {
    await host.scheduledTasks.enqueueSystemCallback({
      id: manualNoticeId(accepted.id, accepted.attemptCount),
      kind: "dream-manual-start",
      name: "入睡通知",
      context: DREAM_SLEEP_NOTICE_CONTEXT,
      target: {
        conversationId: `account:${accountId}:private:${administratorUserId}`,
        mentionUserIds: []
      },
      triggeredAt
    }).catch((error) => {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: "DREAM_NOTIFICATION_FAILED",
        retryable: false
      });
    });
  });
  if (!run) throw new Error("Dream runtime is stopped.");
  const item = host.dreams.listHistory(100, triggeredAt).items.find((candidate) => candidate.id === run.id);
  if (!item) throw new Error("Dream history was not updated after the manual run.");
  return { ok: true as const, notificationQueued: true as const, run: item };
}

async function captureDreamContext(
  host: SunaRuntime,
  input: {
    now: Date;
    localDate: string;
    timeZone: string;
    window: { start: string; end: string };
    signal?: AbortSignal;
  }
): Promise<RuntimeDreamContextSnapshot> {
  input.signal?.throwIfAborted();
  const repository = applicationDataStore(host.config);
  const workingDocument = await readWorkingMemoryDocument(host.config);
  input.signal?.throwIfAborted();
  const fieldKnowledge = await readAirKnowledge(host.config);
  input.signal?.throwIfAborted();
  const workingJson = workingDocument.items.map((item) => ({
    ...workingMemoryItemToEntry(item),
    source: dreamWorkingMemorySource(item.sourceKind),
    fact: item.content
  })) as DreamStoreJsonObject[];
  const longTermJson = repository.readMemory("long_term") as DreamStoreJsonObject[];
  const storedLongTermRecords = jsonClone(longTermJson) as DreamMemoryRecord[];
  const { workingRecords, longTermRecords } = normalizeDreamMemorySnapshot({
    workingRecords: workingJson as DreamMemoryRecord[],
    longTermRecords: storedLongTermRecords
  });
  const previousScheduleDate = latestDreamScheduleOccurrence({
    now: new Date(Date.parse(input.window.end) - 1),
    timeZone: input.timeZone
  }).localDate;
  return {
    workingMemory: workingDocument.items.map((item) => item.content).join("\n\n"),
    workingRecords,
    longTermRecords,
    storedLongTermRecords,
    workingDigest: digestDreamMemorySnapshot(workingJson),
    workingRevision: workingDocument.revision,
    longTermDigest: digestDreamMemorySnapshot(longTermJson),
    recallStats: [],
    userProfiles: jsonClone(repository.readMemory("user_profile").slice(-MAX_DREAM_PROFILE_RECORDS)),
    recentConversations: observedConversations(repository.readConversations(), input.window),
    activeTasks: jsonClone(repository.scheduledTasks.list({ enabled: true, limit: MAX_DREAM_TASKS }).items),
    plannedDailySchedule: jsonClone(repository.director.read(previousScheduleDate) ?? null),
    persona: personaSnapshot(host, fieldKnowledge.content)
  };
}

async function compareAndSwapDreamWorkingMemory(
  host: SunaRuntime,
  input: {
    expectedRevision: string;
    content: string;
    runId: string;
    localDate: string;
    signal?: AbortSignal;
  }
) {
  input.signal?.throwIfAborted();
  const current = await readWorkingMemoryDocument(host.config);
  input.signal?.throwIfAborted();
  const conversationId = `dream:${host.config.persona.defaultAgentId}`;
  if (current.revision !== input.expectedRevision) {
    recordMemoryOperation(host.config, {
      source: "working",
      operation: "dream_replace",
      actor: "dream",
      outcome: "conflict",
      batchId: input.runId,
      conversationId,
      conversationScope: "dream",
      beforeCount: current.items.length,
      afterCount: current.items.length,
      changedCount: 0,
      beforeRevision: current.revision,
      reasonCode: "snapshot_conflict"
    });
    return { status: "conflict" as const, revision: current.revision };
  }
  const nextItems = input.content.trim()
    ? workingMemoryItemsFromFacts(
        [{ fact: input.content }],
        [],
        {
          batchId: input.runId,
          conversationId,
          conversationScope: "dream",
          conversationTitle: `Dream ${input.localDate}`
        },
        (_fact, index) => `working_dream_${input.localDate.replaceAll("-", "_")}_${index}`,
        "dream"
      )
    : [];
  input.signal?.throwIfAborted();
  const replaced = await replaceWorkingMemoryDocument(
    host.config,
    current.revision,
    nextItems,
    input.signal
  );
  if (replaced.status === "conflict") {
    if (!input.signal?.aborted) recordMemoryOperation(host.config, {
      source: "working",
      operation: "dream_replace",
      actor: "dream",
      outcome: "conflict",
      batchId: input.runId,
      conversationId,
      conversationScope: "dream",
      beforeCount: current.items.length,
      afterCount: replaced.current.items.length,
      changedCount: 0,
      beforeRevision: current.revision,
      afterRevision: replaced.current.revision,
      reasonCode: "revision_conflict"
    });
    return { status: "conflict" as const, revision: replaced.current.revision };
  }
  if (!input.signal?.aborted) recordMemoryOperation(host.config, {
    source: "working",
    operation: "dream_replace",
    actor: "dream",
    outcome: replaced.status === "unchanged" ? "unchanged" : "applied",
    recordIds: nextItems.map((item) => item.id),
    batchId: input.runId,
    conversationId,
    conversationScope: "dream",
    beforeCount: current.items.length,
    afterCount: replaced.current.items.length,
    changedCount: replaced.status === "unchanged" ? 0 : replaced.current.items.length,
    beforeRevision: current.revision,
    afterRevision: replaced.current.revision
  });
  return {
    status: replaced.status,
    revision: replaced.current.revision,
    rollback: async () => {
      if (replaced.status === "unchanged") return true;
      const rolledBack = await replaceWorkingMemoryDocument(
        host.config,
        replaced.current.revision,
        current.items
      );
      recordMemoryOperation(host.config, {
        source: "working",
        operation: "dream_rollback",
        actor: "dream",
        outcome: rolledBack.status === "conflict" ? "conflict" : "applied",
        recordIds: current.items.map((item) => item.id),
        batchId: input.runId,
        conversationId,
        conversationScope: "dream",
        beforeCount: replaced.current.items.length,
        afterCount: rolledBack.current.items.length,
        changedCount: rolledBack.status === "conflict" ? 0 : current.items.length,
        beforeRevision: replaced.current.revision,
        afterRevision: rolledBack.current.revision,
        reasonCode: rolledBack.status === "conflict" ? "revision_conflict" : undefined
      });
      return rolledBack.status !== "conflict";
    }
  };
}

function dreamWorkingMemorySource(sourceKind: string) {
  if (sourceKind === "admin") return "sunabot.memory.admin";
  if (sourceKind === "dream") return "sunabot.dream";
  if (sourceKind === "add_workmemory") return "sunabot.add_workmemory";
  return "sunabot.memory.compress";
}

function observedConversations(
  records: readonly ConversationRecord[],
  window: { start: string; end: string }
) {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  return records.flatMap((record) => {
    const messages = record.messages
      .filter((message) => {
        const at = Date.parse(message.at);
        return isMemoryEligibleConversationMessage(message) &&
          Number.isFinite(at) &&
          at >= start &&
          at < end;
      })
      .slice(-MAX_DREAM_MESSAGES_PER_CONVERSATION)
      .map((message) => ({
        role: message.role,
        text: clippedText(message.text),
        at: message.at,
        ...(message.userId == null ? {} : { userId: String(message.userId) }),
        ...(message.senderName ? { senderName: message.senderName } : {})
      }));
    if (!messages.length) return [];
    return [{
      id: record.id,
      scope: record.scope,
      title: record.title,
      messages
    }];
  }).slice(0, MAX_DREAM_CONVERSATIONS);
}

function personaSnapshot(host: SunaRuntime, fieldKnowledge: string): Record<string, unknown> {
  const content = (name: string) => host.persona?.files.find((file) => file.name === name)?.content ?? "";
  return {
    id: host.persona?.id ?? host.config.persona.defaultAgentId,
    name: host.persona?.name ?? host.config.persona.name,
    soul: content("SOUL.md"),
    preference: content("PREFERENCE.md"),
    user: content("USER.md"),
    relation: content("RELATION.md"),
    air: fieldKnowledge
  };
}

function clippedText(value: unknown) {
  return String(value ?? "").trim().slice(0, MAX_DREAM_MESSAGE_CHARS);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedAccountId(value: string) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(normalized)) throw new Error("Dream account ID is invalid.");
  return normalized;
}

function administratorQq(value: string) {
  const normalized = String(value ?? "").trim();
  const number = Number(normalized);
  if (!/^[1-9]\d*$/u.test(normalized) || !Number.isSafeInteger(number)) {
    throw Object.assign(new Error("请先配置有效的管理员 QQ。"), { code: "DREAM_ADMIN_QQ_UNAVAILABLE" });
  }
  return number;
}

function manualNoticeId(runId: string, attemptCount: number) {
  return `dream:${createHash("sha256").update(`${runId}:${attemptCount}`).digest("hex").slice(0, 40)}`;
}
