import { randomUUID } from "node:crypto";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  decodeScheduledCallbackDelivery,
  decodeScheduledCallbackOutbox,
  scheduledCallbackDeliveryEnvelope,
  scheduledCallbackOutboxEnvelope,
  type ScheduledCallbackPayloadV1,
  type ScheduledCallbackTargetV1
} from "../../packages/contracts/session/scheduledTaskRuntimeMessages.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import {
  normalizeScheduledTaskDraft,
  normalizeScheduledTaskId,
  normalizeScheduledTaskResult,
  ScheduledTaskScheduler,
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskDraft,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type ScheduledTaskStore,
  type ScheduledTaskTarget,
  type UpdateScheduledTaskInput
} from "../../services/scheduling/public.js";
import {
  cronCreateInput,
  cronUpdateInput,
  type CronToolInput,
  type CronToolPort
} from "../../services/tools/cronTool.js";
import {
  OutboxDisconnectedError,
  type OutboxDeliveryContext,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import type {
  OutboxRecord,
  SessionEventRecord
} from "../../services/sessions/sessionStore.js";
import {
  SCHEDULED_TASK_CALLBACK_PROMPT_ID,
  SCHEDULED_TASK_PAYLOAD_VARIABLE
} from "../../services/agent/scheduledTaskPrompt.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import { appendRequestLog, appendRequestLogStrict } from "../requestLog.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../types.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { SunaRuntime } from "../runtime.js";

export const SCHEDULED_CALLBACK_EVENT_KIND = "scheduled_callback_delivery";
export const SCHEDULED_CALLBACK_OUTBOX_KIND = "onebot.scheduled_callback";

const LIST_PAGE_SIZE = 100;

export interface ScheduledTaskAdminView {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  context: string;
  schedule: ScheduledTaskSchedule;
  targets: ScheduledTaskTarget[];
  createdAt: string;
  updatedAt: string;
  nextTriggerAt?: string;
  lastTriggerAt?: string;
  lastRunStatus?: ScheduledTaskRun["status"];
  lastError?: string;
}

export class RuntimeScheduledTasks {
  readonly scheduler: ScheduledTaskScheduler;

  constructor(
    private readonly host: SunaRuntime,
    readonly store: ScheduledTaskStore = applicationDataStore(host.config).scheduledTasks
  ) {
    this.scheduler = new ScheduledTaskScheduler({
      store,
      workerId: `scheduled-task:${host.config.persona.defaultAgentId}:${randomUUID()}`,
      generate: (run, signal) => this.generate(run, signal),
      deliver: (run, signal) => this.enqueueDeliveries(run, signal),
      onError: (error, context) => {
        console.error("[scheduler] scheduled task run failed", {
          taskId: context.run.taskId,
          runId: context.run.id,
          phase: context.phase,
          error
        });
      }
    });
  }

  start() {
    this.scheduler.start();
  }

  stop() {
    this.scheduler.stop();
  }

  wake() {
    this.scheduler.wake();
  }

  runOnce() {
    return this.scheduler.runOnce();
  }

  listScheduledTasks(): ScheduledTaskAdminView[] {
    const tasks: ScheduledTask[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = this.store.list({ cursor, limit: LIST_PAGE_SIZE });
      tasks.push(...page.items);
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw new Error("Scheduled task pagination cursor repeated.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return tasks.map((task) => this.adminView(task));
  }

  getScheduledTask(id: string): ScheduledTaskAdminView {
    return this.adminView(this.requireTask(id));
  }

  createScheduledTask(input: unknown): ScheduledTaskAdminView {
    const draft = this.createDraft(input);
    try {
      const created = this.store.create(draft);
      this.wake();
      return this.adminView(created);
    } catch (error) {
      throw scheduledTaskInputError(error);
    }
  }

  updateScheduledTask(id: string, input: unknown): ScheduledTaskAdminView {
    const taskId = validTaskId(id);
    const current = this.requireTask(taskId);
    const value = strictRecord(input, "SCHEDULED_TASK_UPDATE_INVALID", "定时任务更新内容无效。");
    assertOnlyKeys(value, ["revision", "name", "enabled", "schedule", "context", "targets"]);
    const expectedRevision = positiveRevision(value.revision);
    const changedKeys = ["name", "enabled", "schedule", "context", "targets"]
      .filter((key) => Object.hasOwn(value, key));
    if (!changedKeys.length) {
      throw new ServiceError(400, "SCHEDULED_TASK_UPDATE_INVALID", "请至少修改一个定时任务字段。");
    }
    const merged = this.validatedDraft({
      name: Object.hasOwn(value, "name") ? value.name : current.name,
      enabled: Object.hasOwn(value, "enabled") ? value.enabled : current.enabled,
      schedule: Object.hasOwn(value, "schedule") ? value.schedule : current.schedule,
      context: Object.hasOwn(value, "context") ? value.context : current.context,
      targets: Object.hasOwn(value, "targets") ? value.targets : current.targets
    });
    const update: UpdateScheduledTaskInput = {
      id: taskId,
      expectedRevision,
      name: merged.name,
      enabled: merged.enabled,
      schedule: merged.schedule,
      context: merged.context,
      targets: merged.targets
    };
    try {
      const result = this.store.update(update);
      if (result.status === "not_found") throw taskNotFound(taskId);
      if (result.status === "conflict") throw taskConflict(result.current);
      this.wake();
      return this.adminView(result.task);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw scheduledTaskInputError(error);
    }
  }

  deleteScheduledTask(id: string, input: unknown) {
    const taskId = validTaskId(id);
    const value = strictRecord(input, "SCHEDULED_TASK_DELETE_INVALID", "定时任务删除请求无效。");
    assertOnlyKeys(value, ["revision"]);
    const expectedRevision = positiveRevision(value.revision);
    const result = this.store.delete(taskId, expectedRevision);
    if (result.status === "not_found") throw taskNotFound(taskId);
    if (result.status === "conflict") throw taskConflict(result.current);
    this.wake();
    return { id: taskId, deleted: true as const };
  }

  toolPort(
    incoming: ParsedIncomingMessage,
    isAdmin: boolean,
    promptOverride?: string
  ): CronToolPort | undefined {
    const groupChat = incoming.scope === "user_group" || incoming.scope === "bot_group";
    const authorized = promptOverride === undefined && (
      groupChat || (isAdmin && (incoming.transport === "web" || incoming.scope === "private"))
    );
    if (!authorized) return undefined;
    return {
      execute: (input) => this.executeTool(input, incoming)
    };
  }

  processEvent(event: SessionEventRecord): SessionHandleResult {
    if (event.kind !== SCHEDULED_CALLBACK_EVENT_KIND) {
      throw new Error(`Unsupported scheduled callback event: ${event.kind}`);
    }
    const payload = decodeScheduledCallbackDelivery(event.payload);
    if (payload.target.conversationId !== event.sessionId) {
      throw new Error(`Scheduled callback event ${event.id} targets another conversation.`);
    }
    const dedupeKey = callbackDedupeKey(payload.runId);
    return {
      status: "completed",
      result: {
        taskId: payload.taskId,
        runId: payload.runId,
        conversationId: payload.target.conversationId
      },
      outbox: [{
        kind: SCHEDULED_CALLBACK_OUTBOX_KIND,
        deliveryPartition: payload.target.accountId,
        dedupeKey,
        payload: scheduledCallbackOutboxEnvelope(payload, {
          conversationId: event.sessionId,
          correlationId: payload.runId,
          causationId: event.id,
          idempotencyKey: dedupeKey,
          occurredAt: new Date(event.createdAt).toISOString()
        })
      }]
    };
  }

  async deliverOutbox(outbox: OutboxRecord, context: OutboxDeliveryContext) {
    if (outbox.kind !== SCHEDULED_CALLBACK_OUTBOX_KIND) {
      throw new Error(`Unsupported scheduled callback outbox: ${outbox.kind}`);
    }
    const payload = decodeScheduledCallbackOutbox(outbox.payload);
    if (
      payload.target.conversationId !== outbox.sessionId ||
      payload.target.accountId !== outbox.deliveryPartition
    ) {
      throw new Error(`Scheduled callback outbox ${outbox.id} routing changed.`);
    }
    if (context.phase === "send") {
      const gateway = this.host.activeGateway;
      if (!gateway || !isAccountConnected(gateway, payload.target.accountId)) {
        throw new OutboxDisconnectedError("OneBot is not connected for the scheduled callback account.");
      }
      await context.sendRemote(() => gateway.send({
        schemaVersion: 1,
        id: outbox.id,
        conversationId: payload.target.conversationId,
        agentId: this.host.config.persona.defaultAgentId,
        accountId: payload.target.accountId,
        scope: payload.target.scope,
        userId: payload.target.userId,
        ...(payload.target.groupId == null ? {} : { groupId: payload.target.groupId }),
        text: payload.text,
        media: [],
        ...(payload.target.mentionUserIds.length
          ? { mentionUserIds: [...payload.target.mentionUserIds] }
          : {}),
        idempotencyKey: outbox.dedupeKey ?? callbackDedupeKey(payload.runId)
      }));
    }

    await context.settleStep("conversation_projection", (idempotencyKey) => {
      const incoming = scheduledCallbackIncoming(this.host, payload.target, payload.triggeredAt);
      const receiptMessageId = messagingReceiptMessageId(context.remoteReceipt);
      const record = this.host.recordAssistantMessage(
        incoming,
        payload.text,
        [],
        payload.runId,
        undefined,
        { messageOrigin: "text" },
        { messageId: receiptMessageId ?? idempotencyKey }
      );
      this.host.scheduleMemoryCompression(record);
      return record.id;
    });
    await context.settleStep("request_log", (idempotencyKey) => appendRequestLogStrict({
      category: "runtime.action",
      action: "scheduled_callback.sent",
      request: {
        taskId: payload.taskId,
        taskRevision: payload.taskRevision,
        scheduledFor: payload.scheduledFor,
        scope: payload.target.scope,
        userId: payload.target.userId,
        groupId: payload.target.groupId,
        mentionUserIds: payload.target.mentionUserIds
      },
      response: { textChars: payload.text.length },
      metadata: {
        conversationId: payload.target.conversationId,
        runId: payload.runId,
        stage: "scheduled_task"
      }
    }, idempotencyKey));
    return { delivered: true, remoteReceipt: context.remoteReceipt };
  }

  private async executeTool(input: CronToolInput, incoming: ParsedIncomingMessage) {
    try {
      const resolved = this.resolveCurrentTargets(input, incoming);
      if (resolved.operation === "create") {
        return { ok: true, operation: "create", task: this.createScheduledTask(cronCreateInput(resolved)) };
      }
      if (resolved.operation === "get") {
        return { ok: true, operation: "get", task: this.getScheduledTask(resolved.taskId!) };
      }
      if (resolved.operation === "list") {
        return { ok: true, operation: "list", tasks: this.listScheduledTasks() };
      }
      if (resolved.operation === "update") {
        const update = cronUpdateInput(resolved);
        return {
          ok: true,
          operation: "update",
          task: this.updateScheduledTask(update.id, {
            revision: update.expectedRevision,
            ...(update.name == null ? {} : { name: update.name }),
            ...(update.enabled == null ? {} : { enabled: update.enabled }),
            ...(update.schedule == null ? {} : { schedule: update.schedule }),
            ...(update.context == null ? {} : { context: update.context }),
            ...(update.targets == null ? {} : { targets: update.targets })
          })
        };
      }
      return {
        ok: true,
        operation: "delete",
        result: this.deleteScheduledTask(resolved.taskId!, { revision: resolved.revision })
      };
    } catch (error) {
      if (error instanceof ServiceError) {
        return {
          ok: false,
          code: error.code,
          error: error.message,
          ...(error.latestRevision ? { latestRevision: error.latestRevision } : {})
        };
      }
      return { ok: false, code: "SCHEDULED_TASK_FAILED", error: errorMessage(error) };
    }
  }

  private resolveCurrentTargets(input: CronToolInput, incoming: ParsedIncomingMessage): CronToolInput {
    if (!input.targets?.some((target) => target.conversationId === "current")) return input;
    if (incoming.transport === "web") {
      throw new ServiceError(
        400,
        "SCHEDULED_TASK_TARGET_INVALID",
        "Web Chat 中不能使用 current，请选择一个已有 QQ 会话。"
      );
    }
    const current = conversationRecordId(incoming);
    return {
      ...input,
      targets: input.targets.map((target) => ({
        ...target,
        conversationId: target.conversationId === "current" ? current : target.conversationId
      }))
    };
  }

  private createDraft(input: unknown): CreateScheduledTaskInput {
    const value = strictRecord(input, "SCHEDULED_TASK_CREATE_INVALID", "定时任务创建内容无效。");
    assertOnlyKeys(value, ["name", "enabled", "schedule", "context", "targets"]);
    if (!Object.hasOwn(value, "name") || !Object.hasOwn(value, "schedule") ||
        !Object.hasOwn(value, "context") || !Object.hasOwn(value, "targets")) {
      throw new ServiceError(
        400,
        "SCHEDULED_TASK_CREATE_INVALID",
        "名称、触发时间、任务背景和回调目标不能为空。"
      );
    }
    const draft = this.validatedDraft({
      name: value.name,
      enabled: Object.hasOwn(value, "enabled") ? value.enabled : true,
      schedule: value.schedule,
      context: value.context,
      targets: value.targets
    });
    return draft;
  }

  private validatedDraft(value: Record<string, unknown>): ScheduledTaskDraft {
    try {
      return normalizeScheduledTaskDraft(value as unknown as ScheduledTaskDraft, {
        isAllowedConversationId: (conversationId) => this.host.conversationRecords.has(conversationId)
      });
    } catch (error) {
      throw scheduledTaskInputError(error);
    }
  }

  private requireTask(id: string) {
    const taskId = validTaskId(id);
    const task = this.store.get(taskId);
    if (!task) throw taskNotFound(taskId);
    return task;
  }

  private adminView(task: ScheduledTask): ScheduledTaskAdminView {
    const latest = this.store.listRuns(task.id).at(-1);
    return {
      id: task.id,
      revision: task.revision,
      name: task.name,
      enabled: task.enabled,
      context: task.context,
      schedule: structuredClone(task.schedule),
      targets: task.targets.map((target) => ({
        conversationId: target.conversationId,
        mentionUserIds: [...target.mentionUserIds]
      })),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.nextRunAt ? { nextTriggerAt: task.nextRunAt } : {}),
      ...(latest?.scheduledFor || task.lastScheduledAt
        ? { lastTriggerAt: latest?.scheduledFor ?? task.lastScheduledAt! }
        : {}),
      ...(latest ? { lastRunStatus: latest.status } : {}),
      ...(latest?.errorText ? { lastError: latest.errorText } : {})
    };
  }

  private async generate(run: ScheduledTaskRun, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new Error("Scheduled task generation aborted.");
    const payload = {
      schemaVersion: 1,
      systemTimeZone: systemModelTimeZone(),
      task: {
        id: run.snapshot.taskId,
        revision: run.snapshot.taskRevision,
        name: run.snapshot.name,
        context: run.snapshot.context,
        schedule: run.snapshot.schedule.kind === "once"
          ? { ...run.snapshot.schedule, runAt: formatModelTimestamp(run.snapshot.schedule.runAt) }
          : run.snapshot.schedule
      },
      occurrence: {
        runId: run.id,
        scheduledFor: formatModelTimestamp(run.scheduledFor),
        triggeredAt: formatModelTimestamp(new Date())
      },
      targets: run.snapshot.targets
    };
    const request = await this.host.renderPromptRequest(SCHEDULED_TASK_CALLBACK_PROMPT_ID, {
      [SCHEDULED_TASK_PAYLOAD_VARIABLE]: payload
    });
    const text = await this.host.completePrompt(this.host.getProvider(), request, {
      signal,
      logContext: {
        conversationId: `scheduled:${run.taskId}`,
        runId: run.id,
        stage: "scheduled_task",
        promptFamily: SCHEDULED_TASK_CALLBACK_PROMPT_ID
      }
    });
    return normalizeScheduledTaskResult(text);
  }

  private async enqueueDeliveries(run: ScheduledTaskRun, signal: AbortSignal) {
    const text = normalizeScheduledTaskResult(run.resultText ?? "");
    const triggeredAt = run.generatedAt ?? run.updatedAt;
    for (const target of run.snapshot.targets) {
      if (signal.aborted) throw signal.reason ?? new Error("Scheduled task delivery aborted.");
      const resolvedTarget = resolveTarget(this.host.conversationRecords.get(target.conversationId), target);
      const dedupeKey = callbackDedupeKey(run.id);
      const payload: ScheduledCallbackPayloadV1 = {
        type: "scheduled_callback",
        taskId: run.taskId,
        taskRevision: run.taskRevision,
        runId: run.id,
        taskName: run.snapshot.name,
        scheduledFor: run.scheduledFor,
        triggeredAt,
        text,
        target: resolvedTarget
      };
      this.host.sessionCoordinator.enqueueEvent({
        sessionId: resolvedTarget.conversationId,
        kind: SCHEDULED_CALLBACK_EVENT_KIND,
        dedupeKey,
        payload: scheduledCallbackDeliveryEnvelope(payload, {
          conversationId: resolvedTarget.conversationId,
          correlationId: run.id,
          causationId: run.taskId,
          idempotencyKey: dedupeKey,
          occurredAt: triggeredAt,
          id: `${run.id}:${resolvedTarget.conversationId}`
        })
      });
    }
    await appendRequestLog({
      category: "runtime.action",
      action: "scheduled_callback.queued",
      request: {
        taskId: run.taskId,
        taskRevision: run.taskRevision,
        scheduledFor: run.scheduledFor
      },
      response: {
        targetCount: run.snapshot.targets.length,
        textChars: text.length
      },
      metadata: {
        conversationId: `scheduled:${run.taskId}`,
        runId: run.id,
        stage: "scheduled_task"
      }
    });
  }
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

function scheduledCallbackIncoming(
  host: SunaRuntime,
  target: ScheduledCallbackTargetV1,
  at: string
): ParsedIncomingMessage {
  const record = host.conversationRecords.get(target.conversationId);
  return {
    schemaVersion: 1,
    transport: "onebot",
    agentId: host.config.persona.defaultAgentId,
    accountId: target.accountId,
    scope: target.scope,
    time: at,
    userId: target.userId,
    ...(target.groupId == null ? {} : { groupId: target.groupId }),
    ...(record?.selfId == null ? {} : { selfId: record.selfId }),
    sender: { id: String(target.userId) },
    text: "",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function isAccountConnected(gateway: MessagingPort, accountId: string) {
  const status = gateway.getStatus();
  if (!status.connected) return false;
  if (!status.accounts) return true;
  return status.accounts.some((account) => account.accountId === accountId);
}

function messagingReceiptMessageId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const messageId = (value as { messageId?: unknown }).messageId;
  return typeof messageId === "string" && messageId.trim() ? messageId.trim() : undefined;
}

function callbackDedupeKey(runId: string) {
  return `scheduled-callback:${runId}`;
}

function strictRecord(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, code, message);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ServiceError(400, "SCHEDULED_TASK_FIELD_UNSUPPORTED", `不支持字段：${unexpected}`, unexpected);
  }
}

function positiveRevision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ServiceError(400, "SCHEDULED_TASK_REVISION_INVALID", "revision 必须是正整数。", "revision");
  }
  return Number(value);
}

function validTaskId(value: string) {
  try {
    return normalizeScheduledTaskId(value);
  } catch {
    throw new ServiceError(400, "SCHEDULED_TASK_ID_INVALID", "定时任务 ID 无效。", "id");
  }
}

function taskNotFound(id: string) {
  return new ServiceError(404, "SCHEDULED_TASK_NOT_FOUND", `定时任务不存在：${id}`);
}

function taskConflict(task: ScheduledTask) {
  return new ServiceError(
    409,
    "SCHEDULED_TASK_REVISION_CONFLICT",
    "定时任务已被其他请求更新，请刷新后重试。",
    undefined,
    String(task.revision)
  );
}

function scheduledTaskInputError(error: unknown) {
  return error instanceof ServiceError
    ? error
    : new ServiceError(400, "SCHEDULED_TASK_INVALID", errorMessage(error));
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : String(error || "定时任务操作失败。");
}
