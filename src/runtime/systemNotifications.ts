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
