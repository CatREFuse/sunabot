// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import { readWorkingMemoryDocument } from "../../services/memory/public.js";
import { RuntimeWorkingMemory } from "../../src/runtime/workMemory.js";
import { runtime_processIncomingReplyEvent } from "../../src/runtime/intake.js";
import type { ConversationRecord, ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

describe("runtime add_workmemory binding", () => {
  let root = "";

  afterEach(async () => {
    closeApplicationDataStores();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("binds the current Agent workspace and complete conversation source", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const conversationId = "account:secondary:group:30003";
    const record = conversation(conversationId);
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map([[conversationId, record]])
    } as never);

    const result = await runtime.toolPort(incoming()).execute({
      action: "record",
      content: "下一轮继续核对部署前验证。"
    });

    expect(result).toMatchObject({
      ok: true,
      conversationId,
      conversationScope: "user_group"
    });
    expect((await readWorkingMemoryDocument(config)).items).toEqual([
      expect.objectContaining({
        content: "下一轮继续核对部署前验证。",
        conversationId,
        conversationScope: "user_group",
        conversationTitle: "交付群",
        sourceKind: "add_workmemory"
      })
    ]);
    const audit = applicationDataStore(config).readRequestLogs({
      query: "memory.operation",
      limit: 10
    });
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "memory.operation",
        action: "working.append",
        request: expect.objectContaining({
          actor: "model_tool",
          conversationId,
          conversationScope: "user_group",
          source: "working"
        }),
        response: expect.objectContaining({ outcome: "applied" }),
        metadata: expect.objectContaining({
          agentId: config.persona.defaultAgentId,
          conversationId
        })
      })
    ]));
    expect(JSON.stringify(audit)).not.toContain("下一轮继续核对部署前验证");
  });

  it("admits only one concurrent record decision for the same turn", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-atomic-record-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map()
    } as never);
    const port = runtime.toolPort(incoming(), "event-atomic-record");

    const [first, second] = await Promise.all([
      port.execute({ action: "record", content: "只允许这一条。" }),
      port.execute({ action: "record", content: "不能并发写入。" })
    ]) as Array<Record<string, unknown>>;

    expect([first, second].filter((result) => result.ok === true)).toHaveLength(1);
    expect([first, second].filter((result) =>
      result.code === "ADD_WORKMEMORY_DECISION_DUPLICATE"
    )).toHaveLength(1);
    expect(port.decisionResolved?.()).toBe(true);
    expect((await readWorkingMemoryDocument(config)).items).toHaveLength(1);
  });

  it("admits only one terminal decision when record and skip race", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-atomic-mixed-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map()
    } as never);
    const port = runtime.toolPort(incoming(), "event-atomic-mixed");

    const [record, skip] = await Promise.all([
      port.execute({ action: "record", content: "竞态中的记录。" }),
      port.execute({ action: "skip" })
    ]) as Array<Record<string, unknown>>;

    expect([record, skip].filter((result) => result.ok === true)).toHaveLength(1);
    expect([record, skip].filter((result) =>
      result.code === "ADD_WORKMEMORY_DECISION_DUPLICATE"
    )).toHaveLength(1);
    expect(port.decisionResolved?.()).toBe(true);
    expect((await readWorkingMemoryDocument(config)).items).toHaveLength(1);
  });

  it("deduplicates a reopened turn after the durable append already succeeded", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-reopen-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const host = {
      config,
      conversationRecords: new Map()
    } as never;

    const first = await new RuntimeWorkingMemory(host)
      .toolPort(incoming(), "event-replayed-after-append")
      .execute({ action: "record", content: "崩溃前已经完成的写入。" }) as Record<string, unknown>;
    const replay = await new RuntimeWorkingMemory(host)
      .toolPort(incoming(), "event-replayed-after-append")
      .execute({ action: "record", content: "重放时模型生成的不同正文。" }) as Record<string, unknown>;

    expect(replay).toMatchObject({
      ok: true,
      id: first.id,
      deduplicated: true
    });
    const document = await readWorkingMemoryDocument(config);
    expect(document.items).toEqual([
      expect.objectContaining({
        id: first.id,
        content: "崩溃前已经完成的写入。",
        sourceDecisionKey: "event-replayed-after-append"
      })
    ]);
  });

  it("threads the durable incoming-reply event id into the memory decision key", async () => {
    const incomingMessage = incoming();
    const conversationId = "account:secondary:group:30003";
    const handleIncomingMessage = vi.fn(async () => undefined);
    const host = {
      requireActiveGateway: () => ({}),
      isReplySenderAllowed: () => true,
      incomingPreparations: new Map(),
      recoverReplyDebounceMessages: () => conversation(conversationId),
      consumeOrchestratorBatch: vi.fn(),
      persistConversationRecords: vi.fn(),
      markIncomingSeen: vi.fn(),
      isReplyTaskCurrent: () => true,
      clearReplyDebouncePreparation: vi.fn(),
      prepareReplyDebounceMessages: vi.fn(),
      waitForReplyDebouncePreparations: vi.fn(async () => undefined),
      commandRouter: { restore: vi.fn() },
      handleIncomingMessage
    };

    await runtime_processIncomingReplyEvent.call(
      host as never,
      {
        id: "session-event-working-memory-1",
        sessionId: conversationId
      } as never,
      {
        type: "incoming_reply",
        route: "direct",
        incoming: incomingMessage,
        captureSequence: 1,
        replyGate: {
          generation: "test-generation",
          scope: "user_group",
          conversationId,
          scopeEpoch: 0,
          conversationEpoch: 0
        },
        replyQuote: {
          enabled: true,
          replyToMessageId: incomingMessage.messageId ?? null
        }
      },
      new AbortController().signal
    );

    expect(handleIncomingMessage.mock.calls[0]?.at(-1))
      .toBe("session-event-working-memory-1");
  });

  it("records unresolved required decisions without storing conversation content", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-decision-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map()
    } as never);

    runtime.recordToolDecision(incoming(), []);
    runtime.recordToolDecision(incoming(), ["add_workmemory"]);

    const audit = applicationDataStore(config).readRequestLogs({
      query: "working.tool_decision",
      limit: 10
    });
    expect(audit.map((item) => item.response)).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "failed", reasonCode: "decision_missing" }),
      expect.objectContaining({ outcome: "rejected", reasonCode: "decision_unresolved" })
    ]));
    expect(JSON.stringify(audit)).not.toContain("记录一下");
  });

  it("does not persist an arbitrary thrown error code in memory operation audit", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-workmemory-error-code-"));
    const config = createAdminTestConfig(path.join(root, "agent-a"));
    await fs.mkdir(config.persona.agentWorkspace, { recursive: true });
    const runtime = new RuntimeWorkingMemory({
      config,
      conversationRecords: new Map()
    } as never);
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("sensitive failure"), {
      code: "SK_LIVE_SECRET_ERROR_CODE"
    }));

    await expect(runtime.toolPort(incoming()).execute({
      action: "record",
      content: "不会写入。"
    }, controller.signal)).rejects.toThrow("sensitive failure");

    const audit = applicationDataStore(config).readRequestLogs({
      query: "working.append",
      limit: 10
    });
    expect(audit).toEqual([
      expect.objectContaining({
        response: expect.objectContaining({
          outcome: "failed",
          reasonCode: "add_workmemory_failed"
        })
      })
    ]);
    expect(JSON.stringify(audit)).not.toContain("SK_LIVE_SECRET_ERROR_CODE");
    expect(JSON.stringify(audit)).not.toContain("sensitive failure");
  });
});

function incoming(): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    transport: "onebot",
    agentId: "agent-a",
    accountId: "secondary",
    scope: "user_group",
    messageId: 1,
    time: "2026-07-24T09:00:00.000+08:00",
    userId: 10001,
    groupId: 30003,
    selfId: 90001,
    sender: { id: "10001", displayName: "测试用户" },
    text: "记录一下",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

function conversation(id: string): ConversationRecord {
  return {
    id,
    agentId: "agent-a",
    accountId: "secondary",
    scope: "user_group",
    title: "交付群",
    userId: 10001,
    groupId: 30003,
    selfId: 90001,
    messageCount: 0,
    lastAt: "2026-07-24T09:00:00.000+08:00",
    lastText: "",
    messages: []
  };
}
