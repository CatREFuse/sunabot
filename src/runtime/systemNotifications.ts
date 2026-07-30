import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import {
  scheduledCallbackDeliveryEnvelope,
  type ScheduledCallbackPayloadV1,
  type ScheduledCallbackTargetV1
} from "../../packages/contracts/session/scheduledTaskRuntimeMessages.js";
import {
  normalizeScheduledTaskResult,
  type ScheduledTaskTarget
} from "../../services/scheduling/public.js";
import type { ConversationRecord } from "../types.js";
import type { SunaRuntime } from "../runtime.js";

export const SCHEDULED_CALLBACK_EVENT_KIND = "scheduled_callback_delivery";
export const MEMORY_DEBT_ALERT_TASK_ID = "system:memory-debt-alert";
export const MEMORY_DEBT_ALERT_TEXT = "有超过 100 条记忆待处理，请到管理台「记忆」查看状态。";

export interface RuntimeLiteralSystemNotificationInput {
  id: string;
  kind: string;
  name: string;
  text: string;
  target: ScheduledTaskTarget;
  triggeredAt?: Date;
}

export async function enqueueLiteralSystemNotification(
  host: SunaRuntime,
  input: RuntimeLiteralSystemNotificationInput
) {
  const triggeredAt = validDate(input.triggeredAt ?? new Date()).toISOString();
  const runId = requiredField(input.id, "id", 80);
  const kind = requiredField(input.kind, "kind", 64);
  const name = requiredField(input.name, "name", 120);
  const taskId = `system:${kind}`;
  const target = resolveTarget(host.conversationRecords.get(input.target.conversationId), input.target);
  const text = normalizeScheduledTaskResult(requiredField(input.text, "text", 4_000));
  const payload: ScheduledCallbackPayloadV1 = {
    type: "scheduled_callback",
    taskId,
    taskRevision: 1,
    runId,
    taskName: name,
    scheduledFor: triggeredAt,
    triggeredAt,
    text,
    target
  };
  const dedupeKey = `scheduled-callback:${runId}`;
  host.sessionCoordinator.enqueueEvent({
    sessionId: target.conversationId,
    kind: SCHEDULED_CALLBACK_EVENT_KIND,
    dedupeKey,
    payload: scheduledCallbackDeliveryEnvelope(payload, {
      conversationId: target.conversationId,
      correlationId: runId,
      causationId: taskId,
      idempotencyKey: dedupeKey,
      occurredAt: triggeredAt,
      id: `${runId}:${target.conversationId}`
    })
  });
  await appendRequestLog({
    category: "runtime.action",
    action: "scheduled_callback.queued",
    request: { taskId, taskRevision: 1, scheduledFor: triggeredAt },
    response: { targetCount: 1, textChars: text.length },
    metadata: {
      conversationId: target.conversationId,
      runId,
      stage: "scheduled_task"
    }
  });
  return { queued: true as const, conversationId: target.conversationId, runId };
}

export async function enqueueMemoryDebtAlert(
  host: SunaRuntime,
  input: { episodeId: string; targetConversationId?: string; triggeredAt?: Date }
) {
  const resolved = input.targetConversationId
    ? {
        resolved: true as const,
        conversationId: validDebtAlertTargetConversationId(input.targetConversationId)
      }
    : await resolveMemoryDebtAlertTarget(host);
  if (!resolved.resolved) return { queued: false as const, reason: resolved.reason };
  return enqueueLiteralSystemNotification(host, {
    id: `memory-debt:${requiredEpisodeId(input.episodeId)}`,
    kind: "memory-debt-alert",
    name: "记忆处理提醒",
    text: MEMORY_DEBT_ALERT_TEXT,
    target: { conversationId: resolved.conversationId, mentionUserIds: [] },
    triggeredAt: input.triggeredAt
  });
}

export async function resolveMemoryDebtAlertTarget(host: SunaRuntime) {
  const administratorUserId = configuredAdministratorUserId(host.config.bot.adminQq);
  if (administratorUserId == null) {
    return { resolved: false as const, reason: "administrator_unconfigured" as const };
  }
  const accountId = await host.resolveAdminNotificationAccountId?.();
  if (accountId == null) {
    return { resolved: false as const, reason: "account_unavailable" as const };
  }
  const normalizedAccountId = validAccountId(accountId);
  const conversationId = normalizedAccountId === "primary"
    ? `private:${administratorUserId}`
    : `account:${normalizedAccountId}:private:${administratorUserId}`;
  return { resolved: true as const, conversationId };
}

function resolveTarget(
  record: ConversationRecord | undefined,
  target: ScheduledTaskTarget
): ScheduledCallbackTargetV1 {
  const match = target.conversationId.match(/^(?:account:([A-Za-z0-9_-]+):)?(private|group):(\d+)$/);
  if (!match) throw new Error(`Scheduled callback target is invalid: ${target.conversationId}`);
  const numericId = Number(match[3]);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error(`Scheduled callback target is invalid: ${target.conversationId}`);
  }
  const accountId = match[1] ?? "primary";
  if (match[2] === "private") {
    return {
      conversationId: target.conversationId,
      accountId,
      scope: "private",
      userId: numericId,
      mentionUserIds: []
    };
  }
  const recordUserId = Number(record?.userId);
  return {
    conversationId: target.conversationId,
    accountId,
    scope: record?.scope === "bot_group" ? "bot_group" : "user_group",
    userId: Number.isSafeInteger(recordUserId) && recordUserId > 0 ? recordUserId : numericId,
    groupId: numericId,
    mentionUserIds: target.mentionUserIds.map((value) => Number(value))
  };
}

function configuredAdministratorUserId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value.trim())) return undefined;
  const userId = Number(value.trim());
  return Number.isSafeInteger(userId) && userId > 0 ? userId : undefined;
}

function validAccountId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(normalized)) {
    throw new Error("Administrator notification account id is invalid.");
  }
  return normalized;
}

function validDebtAlertTargetConversationId(value: string) {
  const normalized = value.trim();
  const match = normalized.match(/^(?:account:[A-Za-z0-9_-]{1,64}:)?private:([1-9]\d*)$/u);
  const userId = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error("Memory debt alert target conversation id is invalid.");
  }
  return normalized;
}

function requiredEpisodeId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new Error("Memory debt alert episode id is invalid.");
  }
  return normalized;
}

function requiredField(value: string, field: string, maxLength: number) {
  const normalized = String(value ?? "").trim();
  if (!normalized || [...normalized].length > maxLength) {
    throw new Error(`Scheduled callback ${field} is invalid.`);
  }
  return normalized;
}

function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Scheduled callback date is invalid.");
  }
  return value;
}
