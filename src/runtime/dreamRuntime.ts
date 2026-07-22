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
import type { PromptVariableValue, RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { AgentFileRepository } from "../admin/agentFiles.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import type { ConversationRecord } from "../types.js";
import type { SunaRuntime } from "../runtime.js";
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
      write: (event) => appendRequestLog({
        category: "runtime.action",
        action: event.action,
        request: { localDate: event.localDate, level: event.level },
        response: event.data ?? {},
        metadata: {
          conversationId: `dream:${host.config.persona.defaultAgentId}`,
          runId: event.runId,
          stage: "memory",
          promptFamily: DREAM_PROMPT_ID
        }
      })
    }
  });
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
  const workingJson = repository.readMemory("working") as DreamStoreJsonObject[];
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
    longTermDigest: digestDreamMemorySnapshot(longTermJson),
    recallStats,
    userProfiles: jsonClone(repository.readMemory("user_profile").slice(-MAX_DREAM_PROFILE_RECORDS)),
    recentConversations: observedConversations(repository.readConversations(), input.window),
    activeTasks: jsonClone(repository.scheduledTasks.list({ enabled: true, limit: MAX_DREAM_TASKS }).items),
    plannedDailySchedule: jsonClone(repository.director.read(previousScheduleDate) ?? null),
    persona: personaSnapshot(host)
  };
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
        return Number.isFinite(at) && at >= start && at < end;
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

function personaSnapshot(host: SunaRuntime): Record<string, unknown> {
  const content = (name: string) => host.persona?.files.find((file) => file.name === name)?.content ?? "";
  return {
    id: host.persona?.id ?? host.config.persona.defaultAgentId,
    name: host.persona?.name ?? host.config.persona.name,
    soul: content("SOUL.md"),
    preference: content("PREFERENCE.md"),
    user: content("USER.md"),
    relation: content("RELATION.md"),
    air: content("AIR.md")
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
