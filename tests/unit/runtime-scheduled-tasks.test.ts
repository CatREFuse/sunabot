// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  migrateScheduledTaskTables,
  SqliteScheduledTaskStore
} from "../../adapters/sqlite/scheduledTaskStore.js";
import type {
  MessagingPort,
  MessagingStatusV1,
  OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  decodeScheduledCallbackDelivery,
  decodeScheduledCallbackOutbox,
  scheduledCallbackDeliveryEnvelope,
  type ScheduledCallbackPayloadV1
} from "../../packages/contracts/session/scheduledTaskRuntimeMessages.js";
import {
  OutboxDisconnectedError,
  type OutboxDeliveryContext
} from "../../services/sessions/sessionCoordinator.js";
import type {
  EnqueueSessionEventInput,
  OutboxDraft,
  OutboxRecord,
  SessionEventRecord
} from "../../services/sessions/sessionStore.js";
import type { CronToolInput } from "../../services/tools/cronTool.js";
import type { SunaRuntime } from "../../src/runtime.js";
import {
  RuntimeScheduledTasks,
  SCHEDULED_CALLBACK_EVENT_KIND,
  SCHEDULED_CALLBACK_OUTBOX_KIND,
  type ScheduledTaskAdminView
} from "../../src/runtime/scheduledTasks.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";

const requestLog = vi.hoisted(() => ({
  append: vi.fn(async () => undefined),
  appendStrict: vi.fn(async () => undefined)
}));

vi.mock("../../src/requestLog.js", () => ({
  appendRequestLog: requestLog.append,
  appendRequestLogStrict: requestLog.appendStrict
}));

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.isOpen) database.close();
  }
  vi.clearAllMocks();
});

describe("RuntimeScheduledTasks", () => {
  it("exposes the cron port to every group and to administrators in private or Web Chat", async () => {
    const harness = createHarness();
    const privateMessage = incomingMessage();
    const groupMessage = incomingMessage({ scope: "user_group", groupId: 20_001 });
    const webMessage = incomingMessage({ transport: "web" });

    expect(harness.runtime.toolPort(privateMessage, true)).toBeDefined();
    expect(harness.runtime.toolPort(webMessage, true)).toBeDefined();
    expect(harness.runtime.toolPort(privateMessage, false)).toBeUndefined();
    expect(harness.runtime.toolPort(groupMessage, true)).toBeDefined();
    expect(harness.runtime.toolPort(groupMessage, false)).toBeDefined();
    expect(harness.runtime.toolPort(privateMessage, true, "callback")).toBeUndefined();
    expect(harness.runtime.toolPort(privateMessage, true, "")).toBeUndefined();

    const result = await harness.runtime.toolPort(webMessage, true)!.execute(cronInput("create", {
      name: "Web current",
      schedule: once(new Date(harness.storeNow + 60_000).toISOString()),
      context: "Web Chat 不应解析 current",
      targets: [{ conversationId: "current", mentionUserIds: [] }]
    }));
    expect(result).toEqual({
      ok: false,
      code: "SCHEDULED_TASK_TARGET_INVALID",
      error: "Web Chat 中不能使用 current，请选择一个已有 QQ 会话。"
    });
    expect(harness.store.list().items).toEqual([]);

    const groupResult = await harness.runtime.toolPort(groupMessage, false)!.execute(cronInput("create", {
      name: "群聊提醒",
      schedule: once(new Date(harness.storeNow + 60_000).toISOString()),
      context: "所有群成员均可创建当前 Agent 的群聊提醒",
      targets: [{ conversationId: "current", mentionUserIds: ["123"] }]
    }));
    expect(groupResult).toMatchObject({
      ok: true,
      operation: "create",
      task: {
        targets: [{ conversationId: "group:20001", mentionUserIds: ["123"] }]
      }
    });
  });

  it("resolves OneBot current and enforces revision CAS across CRUD", async () => {
    const harness = createHarness();
    const incoming = incomingMessage({ accountId: "secondary" });
    const port = harness.runtime.toolPort(incoming, true)!;
    const createdResult = await port.execute(cronInput("create", {
      name: "当前会话提醒",
      schedule: once(new Date(harness.storeNow + 60_000).toISOString()),
      context: "初始背景",
      targets: [{ conversationId: "current", mentionUserIds: [] }]
    })) as ToolTaskResult;
    expect(createdResult).toMatchObject({
      ok: true,
      operation: "create",
      task: {
        revision: 1,
        name: "当前会话提醒",
        targets: [{ conversationId: "account:secondary:private:10001", mentionUserIds: [] }]
      }
    });
    const created = requiredTask(createdResult);

    await expect(port.execute(cronInput("get", { taskId: created.id }))).resolves.toMatchObject({
      ok: true,
      operation: "get",
      task: { id: created.id, revision: 1 }
    });
    await expect(port.execute(cronInput("list"))).resolves.toMatchObject({
      ok: true,
      operation: "list",
      tasks: [{ id: created.id }]
    });

    const updatedResult = await port.execute(cronInput("update", {
      taskId: created.id,
      revision: 1,
      context: "更新后的背景"
    })) as ToolTaskResult;
    expect(updatedResult).toMatchObject({
      ok: true,
      operation: "update",
      task: { id: created.id, revision: 2, context: "更新后的背景" }
    });

    await expect(port.execute(cronInput("update", {
      taskId: created.id,
      revision: 1,
      context: "过期写入"
    }))).resolves.toEqual({
      ok: false,
      code: "SCHEDULED_TASK_REVISION_CONFLICT",
      error: "定时任务已被其他请求更新，请刷新后重试。",
      latestRevision: "2"
    });
    await expect(port.execute(cronInput("delete", {
      taskId: created.id,
      revision: 1
    }))).resolves.toMatchObject({
      ok: false,
      code: "SCHEDULED_TASK_REVISION_CONFLICT",
      latestRevision: "2"
    });
    await expect(port.execute(cronInput("delete", {
      taskId: created.id,
      revision: 2
    }))).resolves.toEqual({
      ok: true,
      operation: "delete",
      result: { id: created.id, deleted: true }
    });
    expect(harness.store.get(created.id)).toBeUndefined();
  });

  it("generates once and fans one frozen reply out with per-target mentions", async () => {
    const realNow = Date.now();
    const harness = createHarness({
      storeNow: realNow - 60_000,
      generatedText: "同一份冻结正文"
    });
    harness.runtime.createScheduledTask({
      name: "多人多会话提醒",
      schedule: once(new Date(realNow - 30_000).toISOString()),
      context: "提醒两个群处理事项",
      targets: [
        { conversationId: "group:20001", mentionUserIds: ["30001"] },
        { conversationId: "account:secondary:group:20002", mentionUserIds: ["30002", "30003"] }
      ]
    });

    await expect(harness.runtime.runOnce()).resolves.toMatchObject({
      claimedOccurrences: 1,
      claimedRuns: 1,
      generatedRuns: 1,
      deliveredRuns: 1,
      completedRuns: 1,
      failedRuns: 0
    });
    expect(harness.renderPromptRequest).toHaveBeenCalledOnce();
    expect(harness.completePrompt).toHaveBeenCalledOnce();
    expect(harness.enqueueEvent).toHaveBeenCalledTimes(2);

    const callbacks = harness.enqueuedEvents.map((event) => decodeScheduledCallbackDelivery(event.payload));
    expect(callbacks.map((callback) => callback.text)).toEqual([
      "同一份冻结正文",
      "同一份冻结正文"
    ]);
    expect(callbacks.map((callback) => callback.target)).toEqual([
      {
        conversationId: "group:20001",
        accountId: "primary",
        scope: "user_group",
        userId: 10001,
        groupId: 20001,
        mentionUserIds: [30001]
      },
      {
        conversationId: "account:secondary:group:20002",
        accountId: "secondary",
        scope: "user_group",
        userId: 10002,
        groupId: 20002,
        mentionUserIds: [30002, 30003]
      }
    ]);
    expect(new Set(callbacks.map((callback) => callback.runId)).size).toBe(1);
  });

  it("preserves the target account as the event-to-outbox delivery partition", () => {
    const harness = createHarness();
    const payload = callbackPayload();
    const event = scheduledEvent(payload);

    const result = harness.runtime.processEvent(event);

    expect(result.status).toBe("completed");
    expect(result.outbox).toHaveLength(1);
    const outbox = result.outbox![0]!;
    expect(outbox).toMatchObject({
      kind: SCHEDULED_CALLBACK_OUTBOX_KIND,
      deliveryPartition: "secondary",
      dedupeKey: "scheduled-callback:run-1"
    });
    expect(decodeScheduledCallbackOutbox(outbox.payload)).toEqual(payload);
  });

  it("sends mentions and settles one stable remote message projection", async () => {
    const gateway = fakeGateway({
      connected: true,
      accounts: ["secondary"],
      receipt: { accepted: true, messageId: "remote-9001" }
    });
    const harness = createHarness({ gateway });
    const payload = callbackPayload();
    const draft = harness.runtime.processEvent(scheduledEvent(payload)).outbox![0]!;
    const outbox = persistedOutbox(draft, payload.target.conversationId);
    const delivery = deliveryContext();

    await expect(harness.runtime.deliverOutbox(outbox, delivery.context)).resolves.toEqual({
      delivered: true,
      remoteReceipt: { accepted: true, messageId: "remote-9001" }
    });
    await expect(harness.runtime.deliverOutbox(outbox, delivery.context)).resolves.toEqual({
      delivered: true,
      remoteReceipt: { accepted: true, messageId: "remote-9001" }
    });

    expect(gateway.send).toHaveBeenCalledOnce();
    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "account:secondary:group:20002",
      accountId: "secondary",
      groupId: 20002,
      text: "冻结后的定时正文",
      mentionUserIds: [30002, 30003],
      idempotencyKey: "scheduled-callback:run-1"
    } satisfies Partial<OutboundMessageV1>));
    expect(harness.recordAssistantMessage).toHaveBeenCalledOnce();
    expect(harness.recordAssistantMessage.mock.calls[0]?.[6]).toEqual({ messageId: "remote-9001" });
    expect(harness.scheduleMemoryCompression).toHaveBeenCalledOnce();
    expect(delivery.completedSteps).toEqual(new Set(["conversation_projection", "request_log"]));
    expect(requestLog.appendStrict).toHaveBeenCalledOnce();
  });

  it("throws OutboxDisconnectedError before sending or settling an offline account", async () => {
    const gateway = fakeGateway({ connected: false, accounts: [] });
    const harness = createHarness({ gateway });
    const payload = callbackPayload();
    const draft = harness.runtime.processEvent(scheduledEvent(payload)).outbox![0]!;
    const outbox = persistedOutbox(draft, payload.target.conversationId);
    const delivery = deliveryContext();

    await expect(harness.runtime.deliverOutbox(outbox, delivery.context))
      .rejects.toBeInstanceOf(OutboxDisconnectedError);
    expect(gateway.send).not.toHaveBeenCalled();
    expect(harness.recordAssistantMessage).not.toHaveBeenCalled();
    expect(delivery.completedSteps.size).toBe(0);
  });
});

interface HarnessOptions {
  storeNow?: number;
  generatedText?: string;
  gateway?: MessagingPort;
}

function createHarness(options: HarnessOptions = {}) {
  const storeNow = options.storeNow ?? Date.parse("2026-07-19T00:00:00.000Z");
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateScheduledTaskTables(database);
  const conversationRecords = new Map<string, ConversationRecord>([
    ["private:10001", conversation("private:10001", "private", 10001)],
    ["account:secondary:private:10001", conversation(
      "account:secondary:private:10001",
      "private",
      10001,
      undefined,
      "secondary"
    )],
    ["group:20001", conversation("group:20001", "user_group", 10001, 20001)],
    ["account:secondary:group:20002", conversation(
      "account:secondary:group:20002",
      "user_group",
      10002,
      20002,
      "secondary"
    )]
  ]);
  let nextId = 0;
  const store = new SqliteScheduledTaskStore(database, {
    clock: () => new Date(storeNow),
    idFactory: () => `scheduled-${++nextId}`,
    allowedConversationIds: (conversationId) => conversationRecords.has(conversationId)
  });
  const enqueuedEvents: EnqueueSessionEventInput[] = [];
  const enqueueEvent = vi.fn((input: EnqueueSessionEventInput) => {
    enqueuedEvents.push(structuredClone(input));
    return {
      inserted: true,
      event: sessionEventFromInput(input, enqueuedEvents.length)
    };
  });
  const renderPromptRequest = vi.fn(async () => ({ messages: [], tools: [] }));
  const completePrompt = vi.fn(async () => options.generatedText ?? "定时回复");
  const projectionRecord = conversationRecords.get("account:secondary:group:20002")!;
  const recordAssistantMessage = vi.fn((..._args: unknown[]) => projectionRecord);
  const scheduleMemoryCompression = vi.fn();
  const host = {
    config: { persona: { defaultAgentId: "plana" } },
    conversationRecords,
    sessionCoordinator: { enqueueEvent },
    renderPromptRequest,
    completePrompt,
    getProvider: vi.fn(() => ({ id: "test-provider" })),
    activeGateway: options.gateway,
    recordAssistantMessage,
    scheduleMemoryCompression
  };
  const runtime = new RuntimeScheduledTasks(host as unknown as SunaRuntime, store);
  return {
    runtime,
    host,
    store,
    storeNow,
    enqueuedEvents,
    enqueueEvent,
    renderPromptRequest,
    completePrompt,
    recordAssistantMessage,
    scheduleMemoryCompression
  };
}

function cronInput(operation: CronToolInput["operation"], overrides: Partial<CronToolInput> = {}): CronToolInput {
  return {
    operation,
    taskId: null,
    revision: null,
    name: null,
    enabled: null,
    schedule: null,
    context: null,
    targets: null,
    ...overrides
  };
}

function once(runAt: string) {
  return { kind: "once" as const, runAt };
}

function requiredTask(result: ToolTaskResult) {
  if (!result.ok || !result.task) throw new Error("Expected a successful cron task result.");
  return result.task;
}

interface ToolTaskResult {
  ok: boolean;
  task?: ScheduledTaskAdminView;
}

function incomingMessage(overrides: Partial<ParsedIncomingMessage> = {}): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    transport: "onebot",
    agentId: "plana",
    accountId: "primary",
    scope: "private",
    messageId: 1,
    time: "2026-07-19T00:00:00.000Z",
    userId: 10001,
    selfId: 90001,
    sender: { id: "10001" },
    text: "管理定时任务",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false,
    ...overrides
  };
}

function conversation(
  id: string,
  scope: ConversationRecord["scope"],
  userId: number,
  groupId?: number,
  accountId?: string
): ConversationRecord {
  return {
    id,
    agentId: "plana",
    ...(accountId ? { accountId } : {}),
    scope,
    title: id,
    userId,
    ...(groupId == null ? {} : { groupId }),
    selfId: 90001,
    messageCount: 0,
    lastAt: "2026-07-19T00:00:00.000Z",
    lastText: "",
    messages: []
  };
}

function callbackPayload(): ScheduledCallbackPayloadV1 {
  return {
    type: "scheduled_callback",
    taskId: "task-1",
    taskRevision: 2,
    runId: "run-1",
    taskName: "群提醒",
    scheduledFor: "2026-07-19T01:00:00.000Z",
    triggeredAt: "2026-07-19T01:00:01.000Z",
    text: "冻结后的定时正文",
    target: {
      conversationId: "account:secondary:group:20002",
      accountId: "secondary",
      scope: "user_group",
      userId: 10002,
      groupId: 20002,
      mentionUserIds: [30002, 30003]
    }
  };
}

function scheduledEvent(payload: ScheduledCallbackPayloadV1): SessionEventRecord {
  return {
    id: "event-1",
    sessionId: payload.target.conversationId,
    sequence: 1,
    kind: SCHEDULED_CALLBACK_EVENT_KIND,
    dedupeKey: `scheduled-callback:${payload.runId}`,
    payload: scheduledCallbackDeliveryEnvelope(payload, {
      conversationId: payload.target.conversationId,
      correlationId: payload.runId,
      causationId: payload.taskId,
      idempotencyKey: `scheduled-callback:${payload.runId}`,
      occurredAt: payload.triggeredAt,
      id: "envelope-1"
    }),
    status: "running",
    attempts: 1,
    availableAt: Date.parse(payload.triggeredAt),
    createdAt: Date.parse(payload.triggeredAt),
    claimedAt: Date.parse(payload.triggeredAt)
  };
}

function sessionEventFromInput(input: EnqueueSessionEventInput, sequence: number): SessionEventRecord {
  const createdAt = Date.parse("2026-07-19T01:00:01.000Z") + sequence;
  return {
    id: `event-${sequence}`,
    sessionId: input.sessionId,
    sequence,
    kind: input.kind,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    payload: input.payload,
    status: "pending",
    attempts: 0,
    availableAt: input.availableAt ?? createdAt,
    createdAt
  };
}

function persistedOutbox(draft: OutboxDraft, sessionId: string): OutboxRecord {
  return {
    id: "outbox-1",
    sessionId,
    sequence: 1,
    originTurnId: "turn-1",
    kind: draft.kind,
    ...(draft.dedupeKey ? { dedupeKey: draft.dedupeKey } : {}),
    payload: draft.payload,
    deliveryPartition: draft.deliveryPartition ?? "default",
    partitionSequence: 1,
    status: "pending",
    attempts: 0,
    settleAttempts: 0,
    availableAt: Date.parse("2026-07-19T01:00:01.000Z"),
    completedSettleSteps: [],
    holdState: "none",
    createdAt: Date.parse("2026-07-19T01:00:01.000Z")
  };
}

function deliveryContext() {
  let phase: OutboxDeliveryContext["phase"] = "send";
  let remoteReceipt: unknown;
  const completedSteps = new Set<string>();
  const context: OutboxDeliveryContext = {
    signal: new AbortController().signal,
    get phase() { return phase; },
    get remoteReceipt() { return remoteReceipt; },
    async sendRemote(operation) {
      remoteReceipt = await operation();
      phase = "settle";
      return remoteReceipt;
    },
    async settleStep(step, operation) {
      if (completedSteps.has(step)) return undefined;
      const result = await operation(`outbox:scheduled:${step}`);
      completedSteps.add(step);
      return result;
    },
    async settleEffectStep(step, operation) {
      if (completedSteps.has(step)) return undefined;
      const result = await operation(`outbox:scheduled:${step}`);
      completedSteps.add(step);
      return result;
    }
  };
  return { context, completedSteps };
}

function fakeGateway(options: {
  connected: boolean;
  accounts: string[];
  receipt?: { accepted: true; messageId?: string };
}) {
  const getStatus = vi.fn((): MessagingStatusV1 => ({
    connected: options.connected,
    connections: options.connected ? options.accounts.length : 0,
    selfIds: [],
    accounts: options.accounts.map((accountId) => ({
      accountId,
      connectedAt: "2026-07-19T00:00:00.000Z"
    }))
  }));
  return {
    getStatus,
    send: vi.fn(async () => options.receipt ?? { accepted: true as const }),
    resolveSender: vi.fn(),
    getMessage: vi.fn()
  } as unknown as MessagingPort & {
    getStatus: typeof getStatus;
    send: ReturnType<typeof vi.fn>;
  };
}
