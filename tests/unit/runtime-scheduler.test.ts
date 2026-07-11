// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimatePromptTokens,
  isExplicitWakeMessage,
  SunaRuntime
} from "../../src/runtime.js";
import { appendRequestLog } from "../../src/requestLog.js";
import { createAdminTestConfig } from "./admin-fixtures.js";
import type { ParsedIncomingMessage } from "../../src/types.js";

vi.mock("../../src/requestLog.js", () => ({
  appendRequestLog: vi.fn(async () => undefined)
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("runtime reply scheduling helpers", () => {
  it("recognizes configured wake words without consulting an orchestrator", () => {
    expect(isExplicitWakeMessage("普拉娜，看看这个", ["/"], ["普拉娜"])).toBe(true);
    expect(isExplicitWakeMessage("/帮助", ["/"], ["普拉娜"])).toBe(true);
    expect(isExplicitWakeMessage("大家看看这个", ["/"], ["普拉娜"])).toBe(false);
  });

  it("uses the deterministic mixed-language token estimate", () => {
    expect(estimatePromptTokens("abcd 你好")).toBe(5);
    expect(estimatePromptTokens("    ")).toBe(1);
  });

  it.each(["ping", "普拉娜 ping", "普通群消息"])("routes noncommand text through the main reply model: %s", async (text) => {
    const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-runtime-router-test"), {
      attachmentService: {} as never
    });
    const replyToIncoming = vi.fn(async () => undefined);
    (runtime as unknown as { replyToIncoming: typeof replyToIncoming }).replyToIncoming = replyToIncoming;
    const incoming = groupIncoming(text);

    await (runtime as unknown as {
      handleIncomingMessage(
        channelKey: string,
        incoming: ParsedIncomingMessage,
        gateway: unknown,
        captureSequence: number,
        signal: AbortSignal,
        command?: unknown
      ): Promise<void>;
    }).handleIncomingMessage("group:3003", incoming, {}, 1, new AbortController().signal);

    expect(replyToIncoming).toHaveBeenCalledOnce();
  });

  it("routes a registered command to its handler without calling the main reply model", async () => {
    const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-runtime-router-test"), {
      attachmentService: {} as never
    });
    const replyToIncoming = vi.fn(async () => undefined);
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    const internals = runtime as unknown as {
      replyToIncoming: typeof replyToIncoming;
      replyWithGroupChatSummary: typeof replyWithGroupChatSummary;
      commandRouter: { match(text: string, botNames: string[]): unknown };
      handleIncomingMessage(
        channelKey: string,
        incoming: ParsedIncomingMessage,
        gateway: unknown,
        captureSequence: number,
        signal: AbortSignal,
        command?: unknown
      ): Promise<void>;
    };
    internals.replyToIncoming = replyToIncoming;
    internals.replyWithGroupChatSummary = replyWithGroupChatSummary;
    const incoming = groupIncoming("/总结群聊");
    incoming.scope = "bot_group";
    const command = internals.commandRouter.match(incoming.text, ["普拉娜"]);

    await internals.handleIncomingMessage(
      "group:3003",
      incoming,
      {},
      1,
      new AbortController().signal,
      command
    );

    expect(replyWithGroupChatSummary).toHaveBeenCalledOnce();
    expect(replyToIncoming).not.toHaveBeenCalled();
  });

  it("does not execute registered commands when the conversation reply gate is disabled", async () => {
    const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-runtime-router-test"), {
      attachmentService: {} as never
    });
    const enqueueEvent = vi.fn();
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      persistConversationRecords(): void;
      sessionCoordinator: { enqueueEvent: typeof enqueueEvent };
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      replyEnabled: false,
      messageCount: 0,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "",
      messages: []
    });
    internals.persistConversationRecords = vi.fn();
    internals.sessionCoordinator.enqueueEvent = enqueueEvent;

    await runtime.handleInboundMessage(groupIncoming("/总结群聊", 171419991), {} as never);

    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("keeps ambient replies disabled for a user group with its orchestrator turned off", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const internals = runtime as unknown as {
      conversationRecords: Map<string, { orchestratorEnabled?: boolean }>;
      resolveIncomingReplyRoute(incoming: ParsedIncomingMessage, command: boolean): string;
    };
    internals.conversationRecords.set("group:3003", { orchestratorEnabled: false });

    expect(internals.resolveIncomingReplyRoute(groupIncoming("普通群消息", 171419991), false)).toBe("none");
    internals.conversationRecords.set("group:3003", { orchestratorEnabled: true });
    expect(internals.resolveIncomingReplyRoute(groupIncoming("普通群消息", 171419991), false)).toBe("ambient");
  });

  it.each(["private", "user_group", "bot_group"] as const)(
    "only routes %s replies and commands for bot.adminQq",
    (scope) => {
      const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
      config.onebot.autoReplyPrivate = true;
      config.onebot.autoReplyUserGroup = true;
      config.onebot.autoReplyBotGroup = true;
      const runtime = new SunaRuntime(config, {
        attachmentService: {} as never
      });
      const internals = runtime as unknown as {
        resolveIncomingReplyRoute(incoming: ParsedIncomingMessage, command: boolean): string;
      };
      const incoming = groupIncoming("/总结群聊", 998877665);
      incoming.scope = scope;
      incoming.groupId = scope === "private" ? undefined : 3003;

      expect(internals.resolveIncomingReplyRoute(incoming, true)).toBe("none");
      incoming.userId = 171419991;
      incoming.sender = { id: "171419991", displayName: "管理员" };
      expect(internals.resolveIncomingReplyRoute(incoming, true)).toBe("command");
    }
  );

  it.each(["private", "user_group", "bot_group"] as const)(
    "silently ignores a non-admin %s command at ingress",
    async (scope) => {
      const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
      config.onebot.autoReplyPrivate = true;
      config.onebot.autoReplyUserGroup = true;
      config.onebot.autoReplyBotGroup = true;
      const runtime = new SunaRuntime(config, {
        attachmentService: {} as never
      });
      const enqueueEvent = vi.fn();
      const recordIncomingMessage = vi.fn();
      const internals = runtime as unknown as {
        sessionCoordinator: { enqueueEvent: typeof enqueueEvent };
        recordIncomingMessage: typeof recordIncomingMessage;
      };
      internals.sessionCoordinator.enqueueEvent = enqueueEvent;
      internals.recordIncomingMessage = recordIncomingMessage;
      const incoming = groupIncoming("/总结群聊", 998877665);
      incoming.scope = scope;
      incoming.groupId = scope === "private" ? undefined : 3003;

      await runtime.handleInboundMessage(incoming, {} as never);

      expect(enqueueEvent).not.toHaveBeenCalled();
      expect(recordIncomingMessage).not.toHaveBeenCalled();
    }
  );

  it("invalidates an in-flight reply when bot.adminQq changes", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = new SunaRuntime(config, {
      attachmentService: {} as never
    });
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      replyGates: { capture(scope: "user_group", conversationId: string): unknown };
      isReplyTaskCurrent(incoming: ParsedIncomingMessage, gate: unknown): boolean;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      replyEnabled: true,
      messages: []
    });
    const incoming = groupIncoming("普通群消息", 171419991);
    const gate = internals.replyGates.capture("user_group", "group:3003");

    expect(internals.isReplyTaskCurrent(incoming, gate)).toBe(true);
    config.bot.adminQq = "223344556";
    expect(internals.isReplyTaskCurrent(incoming, gate)).toBe(false);
  });

  it("skips a persisted outbox reply when the administrator changed before delivery", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const incoming = groupIncoming("普通群消息", 171419991);
    const internals = runtime as unknown as {
      replyDeliveryDraft(incoming: ParsedIncomingMessage, text: string, isAdmin: boolean): unknown;
      deliverSessionOutbox(outbox: unknown, signal: AbortSignal): Promise<unknown>;
    };
    const draft = internals.replyDeliveryDraft(incoming, "不会发送", true) as Record<string, unknown>;
    config.bot.adminQq = "223344556";

    const result = await internals.deliverSessionOutbox({
      id: "outbox-stale-admin",
      ...draft
    }, new AbortController().signal);

    expect(result).toEqual({ delivered: false, skipped: "sender_not_allowed" });
  });

  it("preserves the default reply gate when only the group orchestrator setting changes", () => {
    const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-runtime-router-test"), {
      attachmentService: {} as never
    });
    const invalidateConversation = vi.fn();
    const internals = runtime as unknown as {
      conversationRecords: Map<string, {
        id: string;
        scope: "user_group";
        title: string;
        userId: number;
        groupId: number;
        messageCount: number;
        lastAt: string;
        lastText: string;
        messages: unknown[];
        orchestratorEnabled?: boolean;
      }>;
      persistConversationRecords(): void;
      replyGates: { invalidateConversation: typeof invalidateConversation };
    };
    internals.persistConversationRecords = vi.fn();
    internals.replyGates.invalidateConversation = invalidateConversation;
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 0,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "",
      messages: []
    });

    const updated = runtime.setConversationReplyEnabled({
      id: "group:3003",
      orchestratorEnabled: false
    });

    expect(updated).toMatchObject({ replyEnabled: true, orchestratorEnabled: false });
    expect(invalidateConversation).not.toHaveBeenCalled();
  });

  it("exposes the actual orchestrator trigger progress for a user group", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    config.bot.orchestrator.messageThreshold = 20;
    config.bot.orchestrator.recentMessageWindowMs = 60_000;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const internals = runtime as unknown as {
      conversationRecords: Map<string, {
        id: string;
        scope: "user_group";
        title: string;
        userId: number;
        groupId: number;
        messageCount: number;
        lastAt: string;
        lastText: string;
        messages: Array<Record<string, unknown>>;
        replyEnabled: boolean;
        orchestratorEnabled: boolean;
        orchestratorCheckedMessageCount: number;
        orchestratorCheckedAt: string;
      }>;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      messageCount: 15,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "新消息",
      messages: [
        { id: "event-13", role: "event", text: "编排器结果", at: "2026-07-10T00:00:30.000Z", sequence: 13 },
        { id: "assistant-14", role: "assistant", text: "已处理", at: "2026-07-10T00:00:40.000Z", sequence: 14 },
        { id: "user-15", role: "user", text: "新消息", at: "2026-07-10T00:01:00.000Z", sequence: 15, userId: 2002 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 12,
      orchestratorCheckedAt: "2026-07-10T00:00:00.000Z"
    });

    expect(runtime.getConversationRecords().find((record) => record.id === "group:3003")).toMatchObject({
      orchestratorStatus: {
        active: true,
        messageCount: 1,
        messageTarget: 21,
        activeWindowMs: 60_000,
        lastMessageAt: "2026-07-10T00:01:00.000Z",
        lastCheckedAt: "2026-07-10T00:00:00.000Z"
      }
    });
  });

  it("marks the orchestrator inactive after the consumed batch has no new user messages", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      messageCount: 12,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "已消费消息",
      messages: [
        { id: "user-12", role: "user", text: "已消费消息", at: "2026-07-10T00:01:00.000Z", sequence: 12, userId: 2002 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 12,
      orchestratorCheckedAt: "2026-07-10T00:01:05.000Z"
    });

    expect(runtime.getConversationRecords().find((record) => record.id === "group:3003")).toMatchObject({
      orchestratorStatus: {
        active: false,
        messageCount: 0
      }
    });
  });

  it("records the orchestrator decision as an internal conversation result", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const raw = '{"should_reply":false,"reason":"当前讨论无需介入。"}';
    const complete = vi.fn(async () => raw);
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 1,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "普通群消息",
      messages: [
        { id: "1001", role: "user" as const, text: "普通群消息", at: "2026-07-10T00:01:00.000Z", sequence: 1, userId: 2002, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      getProviderForModel(): { complete: typeof complete };
      persistConversationRecords(): void;
      runUserGroupchatOrchestrator(
        incoming: ParsedIncomingMessage,
        options: { captureSequence: number }
      ): Promise<boolean>;
    };
    internals.conversationRecords.set(record.id, record);
    internals.getProviderForModel = () => ({ complete });
    internals.persistConversationRecords = vi.fn();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      captureSequence: 1
    })).resolves.toBe(false);

    expect(record.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "编排器结果",
      senderName: "普拉娜",
      selfId: 4004,
      eventKind: "orchestrator_decision",
      visibility: "internal",
      orchestratorDecision: {
        shouldReply: false,
        reason: "当前讨论无需介入。",
        raw
      }
    });
    expect(record.orchestratorCheckedMessageCount).toBe(1);
  });

  it("records a failed orchestrator result and action log before consuming the batch", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const complete = vi.fn(async () => { throw new Error("provider unavailable"); });
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 1,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "普通群消息",
      messages: [
        { id: "1001", role: "user" as const, text: "普通群消息", at: "2026-07-10T00:01:00.000Z", sequence: 1, userId: 2002, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      getProviderForModel(): { complete: typeof complete };
      persistConversationRecords(): void;
      runUserGroupchatOrchestrator(
        incoming: ParsedIncomingMessage,
        options: { captureSequence: number }
      ): Promise<boolean>;
    };
    internals.conversationRecords.set(record.id, record);
    internals.getProviderForModel = () => ({ complete });
    internals.persistConversationRecords = vi.fn();
    vi.mocked(appendRequestLog).mockClear();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      captureSequence: 1
    })).resolves.toBe(false);

    expect(record.messages.at(-1)).toMatchObject({
      role: "assistant",
      eventKind: "orchestrator_decision",
      visibility: "internal",
      orchestratorDecision: {
        status: "failed",
        shouldReply: false,
        raw: "provider unavailable"
      }
    });
    expect(record.orchestratorCheckedMessageCount).toBe(1);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
      category: "runtime.action",
      action: "orchestrator.failed",
      response: { ok: false, error: "provider unavailable" },
      metadata: expect.objectContaining({ attempt: 4, retry: 3, maxRetries: 3 })
    }));
    expect(vi.mocked(appendRequestLog).mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action === "orchestrator.attempt")
      .map((entry) => entry.metadata)).toEqual([
        expect.objectContaining({ attempt: 1, retry: 0, maxRetries: 3 }),
        expect.objectContaining({ attempt: 2, retry: 1, maxRetries: 3 }),
        expect.objectContaining({ attempt: 3, retry: 2, maxRetries: 3 }),
        expect.objectContaining({ attempt: 4, retry: 3, maxRetries: 3 })
      ]);
  });

  it("retries the orchestrator three times and records the successful retry", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error("attempt 1 failed"))
      .mockRejectedValueOnce(new Error("attempt 2 failed"))
      .mockRejectedValueOnce(new Error("attempt 3 failed"))
      .mockResolvedValueOnce('{"should_reply":true,"reason":"需要回复。"}');
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 1,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "普通群消息",
      messages: [
        { id: "1001", role: "user" as const, text: "普通群消息", at: "2026-07-10T00:01:00.000Z", sequence: 1, userId: 2002, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      getProviderForModel(): { complete: typeof complete };
      persistConversationRecords(): void;
      runUserGroupchatOrchestrator(
        incoming: ParsedIncomingMessage,
        options: { captureSequence: number }
      ): Promise<boolean>;
    };
    internals.conversationRecords.set(record.id, record);
    internals.getProviderForModel = () => ({ complete });
    internals.persistConversationRecords = vi.fn();
    vi.mocked(appendRequestLog).mockClear();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      captureSequence: 1
    })).resolves.toBe(true);

    expect(complete).toHaveBeenCalledTimes(4);
    expect(record.messages.at(-1)).toMatchObject({
      orchestratorDecision: { status: "completed", shouldReply: true }
    });
    expect(record.orchestratorCheckedMessageCount).toBe(0);
    expect(appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "orchestrator.decision",
      metadata: expect.objectContaining({ attempt: 4, retry: 3, maxRetries: 3 })
    }));
    expect(vi.mocked(appendRequestLog).mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action === "orchestrator.attempt")
      .map((entry) => entry.response)).toEqual([
        expect.objectContaining({ ok: false, willRetry: true }),
        expect.objectContaining({ ok: false, willRetry: true }),
        expect.objectContaining({ ok: false, willRetry: true }),
        expect.objectContaining({ ok: true, willRetry: false })
      ]);
  });

  it("consumes an affirmative ambient batch only after its Session event commit succeeds", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    config.bot.orchestrator.messageThreshold = 0;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const incoming = groupIncoming("普通群消息", 171419991);
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 171419991,
      groupId: 3003,
      selfId: 4004,
      messageCount: 1,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "普通群消息",
      messages: [
        { id: "1001", role: "user" as const, text: "普通群消息", at: "2026-07-10T00:01:00.000Z", sequence: 1, userId: 171419991, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0,
      orchestratorCheckedAt: "2026-07-10T00:00:00.000Z",
      orchestratorLastReplyAt: undefined as string | undefined
    };
    const cursorAtEnqueue: number[] = [];
    const enqueueEvent = vi.fn()
      .mockImplementationOnce(() => {
        cursorAtEnqueue.push(record.orchestratorCheckedMessageCount);
        throw new Error("simulated sqlite commit failure");
      })
      .mockImplementationOnce(() => {
        cursorAtEnqueue.push(record.orchestratorCheckedMessageCount);
        return { inserted: true, event: {} };
      });
    const persistedCursors: number[] = [];
    const persistConversationRecords = vi.fn(() => {
      persistedCursors.push(record.orchestratorCheckedMessageCount);
    });
    const runUserGroupchatOrchestrator = vi.fn(async () => true);
    const gateway = {};
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      replyGates: { capture(scope: "user_group", conversationId: string): unknown };
      sessionCoordinator: { enqueueEvent: typeof enqueueEvent };
      persistConversationRecords: typeof persistConversationRecords;
      runUserGroupchatOrchestrator: typeof runUserGroupchatOrchestrator;
      pumpAmbientReply(
        channelKey: string,
        state: { epoch: number; running: boolean; next?: unknown }
      ): Promise<void>;
    };
    internals.conversationRecords.set(record.id, record);
    internals.sessionCoordinator.enqueueEvent = enqueueEvent;
    internals.persistConversationRecords = persistConversationRecords;
    internals.runUserGroupchatOrchestrator = runUserGroupchatOrchestrator;
    const job = {
      channelKey: record.id,
      incoming,
      gateway,
      captureSequence: 1,
      gate: internals.replyGates.capture("user_group", record.id)
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await internals.pumpAmbientReply(record.id, { epoch: 0, running: false, next: job });
    expect(record.orchestratorCheckedMessageCount).toBe(0);
    expect(persistConversationRecords).not.toHaveBeenCalled();

    runtime.resumeUserGroupOrchestrators(gateway as never);
    await waitFor(() => record.orchestratorCheckedMessageCount === 1);
    expect(cursorAtEnqueue).toEqual([0, 0]);
    expect(record.orchestratorCheckedMessageCount).toBe(1);
    expect(record.orchestratorLastReplyAt).toBeTruthy();
    expect(persistedCursors.length).toBeGreaterThan(0);
    expect(persistedCursors.every((cursor) => cursor === 1)).toBe(true);
    expect(enqueueEvent).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });

  it("keeps the batch pending when an orchestrator run is cancelled", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const controller = new AbortController();
    controller.abort(new Error("ambient reply cancelled"));
    const complete = vi.fn(async () => { throw controller.signal.reason; });
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 171419991,
      groupId: 3003,
      selfId: 4004,
      messageCount: 1,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "普通群消息",
      messages: [
        { id: "1001", role: "user" as const, text: "普通群消息", at: "2026-07-10T00:01:00.000Z", sequence: 1, userId: 2002, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      getProviderForModel(): { complete: typeof complete };
      persistConversationRecords(): void;
      runUserGroupchatOrchestrator(
        incoming: ParsedIncomingMessage,
        options: { signal: AbortSignal; captureSequence: number }
      ): Promise<boolean>;
    };
    internals.conversationRecords.set(record.id, record);
    internals.getProviderForModel = () => ({ complete });
    internals.persistConversationRecords = vi.fn();
    vi.mocked(appendRequestLog).mockClear();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      signal: controller.signal,
      captureSequence: 1
    })).resolves.toBe(false);

    expect(record.messages).toHaveLength(1);
    expect(record.orchestratorCheckedMessageCount).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(appendRequestLog).not.toHaveBeenCalledWith(expect.objectContaining({ action: "orchestrator.failed" }));
  });

  it("queues an ambient decision when pending messages reach the idle timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-10T00:01:00.000Z");
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    config.bot.orchestrator.messageThreshold = 20;
    config.bot.orchestrator.recentMessageWindowMs = 60_000;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const queueAmbientReply = vi.fn();
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      messageCount: 18,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "第 18 条",
      messages: Array.from({ length: 18 }, (_, index) => ({
        id: `stored-${index + 1}`,
        role: "user" as const,
        text: `第 ${index + 1} 条`,
        at: "2026-07-10T00:00:00.000Z",
        sequence: index + 1,
        userId: 2002,
        groupId: 3003
      })),
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      prepareIncomingMessage(): Promise<void>;
      patchIncomingMessage(): void;
      scheduleAttachmentCacheRefresh(): void;
      scheduleMemoryCompression(): void;
      persistConversationRecords(): void;
      queueAmbientReply: typeof queueAmbientReply;
    };
    internals.conversationRecords.set(record.id, record);
    internals.prepareIncomingMessage = vi.fn(async () => undefined);
    internals.patchIncomingMessage = vi.fn();
    internals.scheduleAttachmentCacheRefresh = vi.fn();
    internals.scheduleMemoryCompression = vi.fn();
    internals.persistConversationRecords = vi.fn();
    internals.queueAmbientReply = queueAmbientReply;

    await runtime.handleInboundMessage(groupIncoming("普通群消息", 171419991), {} as never);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(queueAmbientReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queueAmbientReply).toHaveBeenCalledOnce();
  });

  it("restores an expired pending batch when OneBot reconnects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-10T00:02:00.000Z");
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    config.bot.orchestrator.recentMessageWindowMs = 60_000;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const queueAmbientReply = vi.fn();
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 19,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "待处理消息",
      messages: [
        { id: "stored-19", role: "user" as const, text: "待处理消息", at: "2026-07-10T00:00:00.000Z", sequence: 19, userId: 171419991, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, typeof record>;
      queueAmbientReply: typeof queueAmbientReply;
      resumeUserGroupOrchestrators?: (gateway: unknown) => void;
    };
    internals.conversationRecords.clear();
    internals.conversationRecords.set(record.id, record);
    internals.queueAmbientReply = queueAmbientReply;

    internals.resumeUserGroupOrchestrators?.({});
    await vi.runAllTimersAsync();

    expect(queueAmbientReply).toHaveBeenCalledOnce();
    expect(queueAmbientReply.mock.calls[0]?.[0]).toMatchObject({
      channelKey: "group:3003",
      captureSequence: 19,
      incoming: { text: "待处理消息", groupId: 3003 }
    });
  });

  it("exposes group member names from the complete conversation history", () => {
    const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-runtime-router-test"), {
      attachmentService: {} as never
    });
    const internals = runtime as unknown as {
      conversationRecords: Map<string, {
        id: string;
        scope: "user_group";
        title: string;
        userId: number;
        groupId: number;
        messageCount: number;
        lastAt: string;
        lastText: string;
        messages: Array<Record<string, unknown>>;
      }>;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      messageCount: 2,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "@1309367301 你好",
      messages: [
        { id: "m1", role: "user", text: "1", at: "2026-07-10T00:00:00.000Z", userId: 1309367301, groupId: 3003, senderNickname: "QQ 昵称", senderCard: "飞行雪绒" },
        { id: "m2", role: "user", text: "@1309367301 你好", at: "2026-07-10T00:01:00.000Z", userId: 2002, groupId: 3003, senderNickname: "发言者" }
      ]
    });

    expect(runtime.getConversationMessages("group:3003")).toMatchObject({
      memberNames: { "1309367301": "飞行雪绒", "2002": "发言者" }
    });
  });

  it("reuses the running request bubble for the completed reply", () => {
    const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-runtime-router-test"), {
      attachmentService: {} as never
    });
    const internals = runtime as unknown as {
      conversationRecords: Map<string, {
        messageCount: number;
        lastText: string;
        messages: Array<Record<string, unknown>>;
      }>;
      persistConversationRecords(): void;
      recordAssistantRequestStarted(incoming: ParsedIncomingMessage, logRunId: string): void;
      recordAssistantMessage(
        incoming: ParsedIncomingMessage,
        text: string,
        imageUrls: string[],
        logRunId: string
      ): void;
    };
    internals.persistConversationRecords = vi.fn();
    const incoming = groupIncoming("普拉娜 测试搜索");

    internals.recordAssistantRequestStarted(incoming, "run-search");
    const running = internals.conversationRecords.get("group:3003")!;
    const bubbleId = running.messages[0]?.id;
    expect(running.messages[0]).toMatchObject({
      id: bubbleId,
      text: "正在输入…",
      requestStatus: "running",
      logRunId: "run-search"
    });

    internals.recordAssistantMessage(incoming, "搜索完成。", [], "run-search");

    expect(running.messageCount).toBe(1);
    expect(running.lastText).toBe("搜索完成。");
    expect(running.messages).toEqual([
      expect.objectContaining({
        id: bubbleId,
        text: "搜索完成。",
        requestStatus: undefined,
        logRunId: "run-search"
      })
    ]);
  });

  it("aborts active group work and keeps pre-disable epochs stale after re-enable", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.onebot.autoReplyUserGroup = true;
    const runtime = new SunaRuntime(config, { attachmentService: {} as never });
    const controller = new AbortController();
    const ambientController = new AbortController();
    const internals = runtime as unknown as {
      conversationRecords: Map<string, { id: string; scope: "user_group"; messages: unknown[] }>;
      activeDirectControllers: Map<string, AbortController>;
      ambientReplies: Map<string, { epoch: number; running: boolean; controller: AbortController }>;
      replyGates: {
        capture(scope: "user_group", conversationId: string): unknown;
        isCurrent(snapshot: unknown): boolean;
      };
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      messages: []
    });
    internals.activeDirectControllers.set("group:3003", controller);
    internals.ambientReplies.set("group:3003", {
      epoch: 0,
      running: true,
      controller: ambientController
    });
    const stale = internals.replyGates.capture("user_group", "group:3003");
    const persona = { id: "plana" as const, name: "普拉娜", files: [], memoryItems: [], systemPrompt: "" };

    runtime.commitReload({
      config: { ...config, onebot: { ...config.onebot, autoReplyUserGroup: false } },
      persona
    });
    runtime.commitReload({ config, persona });

    expect(controller.signal.aborted).toBe(true);
    expect(ambientController.signal.aborted).toBe(true);
    expect(internals.replyGates.isCurrent(stale)).toBe(false);
  });
});

function groupIncoming(text: string, userId = 2002): ParsedIncomingMessage {
  return {
    schemaVersion: 1,
    scope: "user_group",
    messageId: 1001,
    time: "2026-07-11T12:00:00.000Z",
    userId,
    groupId: 3003,
    selfId: 4004,
    sender: { id: String(userId), displayName: String(userId) },
    text,
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime scheduler condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
