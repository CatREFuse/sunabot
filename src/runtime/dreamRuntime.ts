import { createHash } from "node:crypto";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  digestDreamMemorySnapshot,
  type JsonObject as DreamStoreJsonObject
} from "../../adapters/sqlite/dreamStore.js";
import {
  DREAM_PROMPT_ID,
  dreamRecallLookupIds,
  dreamRecallTrackingIds,
  latestDreamScheduleOccurrence,
  normalizeDreamMemorySnapshot,
  projectDreamRecallStats,
  type DreamMemoryRecord,
  type DreamRecallStatsSnapshot
} from "../../services/memory/dream/public.js";
import {
  readWorkingMemoryDocument,
  recordMemoryOperation,
  replaceWorkingMemoryDocument,
  workingMemoryItemToEntry,
  workingMemoryItemsFromFacts,
  type MemoryFactInput
} from "../../services/memory/public.js";
import {
  normalizeAirKnowledge,
  readAirKnowledge,
  replaceAirKnowledge
} from "../../services/air/public.js";
import { loadPersona } from "../../services/agent/public.js";
import type { PromptVariableValue, RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { AgentFileRepository } from "../admin/agentFiles.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import type { ConversationRecord } from "../types.js";
import type { SunaRuntime } from "../runtime.js";
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
  const agentFiles = new AgentFileRepository({ runtime: host });
  return createRuntimeDreams({
    agentId: host.config.persona.defaultAgentId,
    store: applicationDataStore(host.config).dreams as unknown as RuntimeDreamStorePort,
    context: { capture: (input) => captureDreamContext(host, input) },
    workingMemory: {
      compareAndSwap: (input) => compareAndSwapDreamWorkingMemory(host, input)
    },
    fieldKnowledge: {
      compareAndSwap: (input) => compareAndSwapDreamFieldKnowledge(host, input)
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
        options
      )
    },
    persona: {
      read: async (id) => {
        const file = await agentFiles.get(id, host.config);
        return { content: file.content, revision: file.revision };
      },
      compareAndSwap: async ({ id, revision, content }) => {
        await agentFiles.put(id, { revision, content }, host.config);
      }
    },
    selection: () => ({
      recentWindowHours: host.config.bot.memory.dreamRecentWindowHours,
      recentMemoryLimit: host.config.bot.memory.dreamRecentMemoryLimit,
      olderMemoryLimit: host.config.bot.memory.dreamOlderMemoryLimit
    }),
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
          response: event.data ?? {},
          metadata: {
            conversationId,
            runId: event.runId,
            stage: "memory",
            promptFamily: DREAM_PROMPT_ID
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
  }
): Promise<RuntimeDreamContextSnapshot> {
  const repository = applicationDataStore(host.config);
  const workingDocument = await readWorkingMemoryDocument(host.config);
  const fieldKnowledge = await readAirKnowledge(host.config);
  const workingJson = workingDocument.items.map((item) => ({
    ...workingMemoryItemToEntry(item),
    source: dreamWorkingMemorySource(item.sourceKind),
    fact: item.content
  })) as DreamStoreJsonObject[];
  const longTermJson = repository.readMemory("long_term") as DreamStoreJsonObject[];
  const { workingRecords, longTermRecords } = normalizeDreamMemorySnapshot({
    workingRecords: workingJson as DreamMemoryRecord[],
    longTermRecords: longTermJson as DreamMemoryRecord[]
  });
  const trackingIds = dreamRecallTrackingIds(longTermJson as DreamMemoryRecord[]);
  repository.dreams.initializeRecallTracking(trackingIds, input.now);
  const recallStats = projectDreamRecallStats({
    records: longTermRecords,
    stats: repository.dreams.listRecallStats(dreamRecallLookupIds(longTermRecords)) as DreamRecallStatsSnapshot[],
    trackingStartedAt: input.now.toISOString()
  });
  const previousScheduleDate = latestDreamScheduleOccurrence({
    now: new Date(Date.parse(input.window.end) - 1),
    timeZone: input.timeZone
  }).localDate;
  return {
    workingRecords,
    longTermRecords,
    workingDigest: digestDreamMemorySnapshot(workingJson),
    workingRevision: workingDocument.revision,
    fieldKnowledgeRevision: fieldKnowledge.revision,
    longTermDigest: digestDreamMemorySnapshot(longTermJson),
    recallStats,
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
    records: readonly DreamMemoryRecord[];
    runId: string;
    localDate: string;
  }
) {
  const current = await readWorkingMemoryDocument(host.config);
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
  const facts = input.records.map(dreamWorkingMemoryFact);
  const nextItems = workingMemoryItemsFromFacts(
    facts,
    current.items,
    {
      batchId: input.runId,
      conversationId,
      conversationScope: "dream",
      conversationTitle: `Dream ${input.localDate}`
    },
    (fact, index) => fact.memoryKind === "dream" && fact.id
      ? fact.id
      : `working_dream_${input.localDate.replaceAll("-", "_")}_${index}`,
    "dream"
  );
  const replaced = await replaceWorkingMemoryDocument(host.config, current.revision, nextItems);
  if (replaced.status === "conflict") {
    recordMemoryOperation(host.config, {
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
  recordMemoryOperation(host.config, {
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

async function compareAndSwapDreamFieldKnowledge(
  host: SunaRuntime,
  input: {
    expectedRevision: string;
    content: string;
    runId: string;
    localDate: string;
  }
) {
  const current = await readAirKnowledge(host.config);
  const conversationId = `dream:${host.config.persona.defaultAgentId}`;
  if (current.revision !== input.expectedRevision) {
    recordMemoryOperation(host.config, {
      source: "dream",
      operation: "field_knowledge_replace",
      actor: "dream",
      outcome: "conflict",
      batchId: input.runId,
      conversationId,
      conversationScope: "dream",
      beforeRevision: current.revision,
      reasonCode: "snapshot_conflict"
    });
    return { status: "conflict" as const, revision: current.revision };
  }
  const normalizedContent = normalizeAirKnowledge(input.content);
  const nextPersona = await loadPersona(host.config, { "AIR.md": normalizedContent });
  const replaced = await replaceAirKnowledge(host.config, current.revision, normalizedContent);
  if (replaced.status === "conflict") {
    recordMemoryOperation(host.config, {
      source: "dream",
      operation: "field_knowledge_replace",
      actor: "dream",
      outcome: "conflict",
      batchId: input.runId,
      conversationId,
      conversationScope: "dream",
      beforeRevision: current.revision,
      afterRevision: replaced.current.revision,
      reasonCode: "revision_conflict"
    });
    return { status: "conflict" as const, revision: replaced.current.revision };
  }
  if (replaced.status === "updated") host.persona = nextPersona;
  recordMemoryOperation(host.config, {
    source: "dream",
    operation: "field_knowledge_replace",
    actor: "dream",
    outcome: replaced.status === "unchanged" ? "unchanged" : "applied",
    batchId: input.runId,
    conversationId,
    conversationScope: "dream",
    beforeRevision: current.revision,
    afterRevision: replaced.current.revision
  });
  return {
    status: replaced.status,
    revision: replaced.current.revision,
    rollback: async () => {
      if (replaced.status === "unchanged") return true;
      const rolledBack = await replaceAirKnowledge(
        host.config,
        replaced.current.revision,
        current.content
      );
      recordMemoryOperation(host.config, {
        source: "dream",
        operation: "field_knowledge_rollback",
        actor: "dream",
        outcome: rolledBack.status === "conflict" ? "conflict" : "applied",
        batchId: input.runId,
        conversationId,
        conversationScope: "dream",
        beforeRevision: replaced.current.revision,
        afterRevision: rolledBack.current.revision,
        reasonCode: rolledBack.status === "conflict" ? "revision_conflict" : undefined
      });
      if (rolledBack.status !== "conflict") host.persona = await loadPersona(host.config);
      return rolledBack.status !== "conflict";
    }
  };
}

function dreamWorkingMemoryFact(record: DreamMemoryRecord, index: number): MemoryFactInput {
  const fact = dreamString(record.fact);
  const id = dreamString(record.id);
  if (!fact || !id) throw new Error(`Dream working memory ${index} is missing id or fact.`);
  return {
    id,
    fact,
    occurredAt: dreamString(record.occurredAt),
    occurredEndAt: dreamString(record.occurredEndAt) || null,
    userId: dreamString(record.userId),
    userIds: dreamStrings(record.userIds),
    userName: dreamString(record.userName),
    addressNames: dreamStrings(record.addressNames),
    eventType: dreamString(record.eventType),
    subjectKey: dreamString(record.subjectKey),
    eventKey: dreamString(record.eventKey),
    causalChainKey: dreamString(record.causalChainKey),
    batchId: dreamString(record.batchId),
    sourceMemoryIds: dreamStrings(record.sourceMemoryIds),
    memoryKind: dreamString(record.memoryKind),
    realityStatus: dreamString(record.realityStatus),
    factuality: dreamString(record.factuality),
    dreamRunId: dreamString(record.dreamRunId),
    dreamDate: dreamString(record.dreamDate),
    dreamReviewedAt: dreamString(record.dreamReviewedAt)
  };
}

function dreamWorkingMemorySource(sourceKind: string) {
  if (sourceKind === "admin") return "sunabot.memory.admin";
  if (sourceKind === "dream") return "sunabot.dream";
  if (sourceKind === "add_workmemory") return "sunabot.add_workmemory";
  return "sunabot.memory.compress";
}

function dreamString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dreamStrings(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => dreamString(item) ?? [])
    : undefined;
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
