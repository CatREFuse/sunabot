// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { SunaRuntime } from "../../src/runtime.js";
import { estimatePromptTokens, isExplicitWakeMessage } from "../../src/runtime/conversationMemoryHelpers.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import {
  decodeIncomingReply,
  noReplyPokeEnvelope,
  type UserGroupOrchestratorResultV1
} from "../../packages/contracts/session/runtimeMessages.js";
import { createAdminTestConfig } from "./admin-fixtures.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { BroadcastStormDetector } from "../../services/orchestration/broadcastStormDetector.js";

const requestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../adapters/observability/requestLog.js", () => ({ appendRequestLog: requestLog }));
const TEST_WORKSPACE = "/tmp/sunabot-runtime-router-test";

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
    const runtime = createRuntime();
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
    const runtime = createRuntime();
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
    const incoming = groupIncoming("/总结群聊@普拉娜");
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

  it("discards inbound messages before storage when the conversation is disabled", async () => {
    const runtime = createRuntime();
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

    await runtime.handleInboundMessage(groupIncoming("/总结群聊@普拉娜", 171419991), {} as never);

    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(internals.persistConversationRecords).not.toHaveBeenCalled();
    expect(internals.conversationRecords.get("group:3003")).toMatchObject({
      replyEnabled: false,
      messageCount: 0,
      lastText: "",
      messages: []
    });
  });

  it("creates the first inbound conversation with replies disabled", async () => {
    const runtime = createRuntime();
    const enqueueEvent = vi.fn();
    const internals = runtime as unknown as {
      conversationRecords: Map<string, {
        replyEnabled?: boolean;
        messageCount: number;
      }>;
      persistConversationRecords(): void;
      sessionCoordinator: { enqueueEvent: typeof enqueueEvent };
    };
    internals.persistConversationRecords = vi.fn();
    internals.sessionCoordinator.enqueueEvent = enqueueEvent;

    await runtime.handleInboundMessage(groupIncoming("普拉娜，看看这个", 171419991), {} as never);

    expect(internals.conversationRecords.get("group:3003")).toMatchObject({
      replyEnabled: false,
      messageCount: 1
    });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("keeps ambient replies disabled for a user group with its orchestrator turned off", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const internals = runtime as unknown as {
      conversationRecords: Map<string, { orchestratorEnabled?: boolean }>;
      resolveIncomingReplyRoute(incoming: ParsedIncomingMessage, command: boolean): string;
    };
    internals.conversationRecords.set("group:3003", { orchestratorEnabled: false });

    expect(internals.resolveIncomingReplyRoute(groupIncoming("普通群消息", 171419991), false)).toBe("none");
    internals.conversationRecords.set("group:3003", { orchestratorEnabled: true });
    expect(internals.resolveIncomingReplyRoute(groupIncoming("普通群消息", 171419991), false)).toBe("ambient");
  });

  it("reactivates only the explicitly awakened user-group orchestrator", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const scheduleReplyDebounce = vi.fn();
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      persistConversationRecords(): void;
      prepareIncomingMessage(): Promise<void>;
      patchIncomingMessage(): void;
      scheduleAttachmentCacheRefresh(): void;
      scheduleMemoryCompression(): void;
      scheduleReplyDebounce: typeof scheduleReplyDebounce;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊 3003",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      replyEnabled: true,
      orchestratorEnabled: false,
      messageCount: 0,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "",
      messages: []
    });
    internals.conversationRecords.set("group:4004", {
      id: "group:4004",
      scope: "user_group",
      title: "群聊 4004",
      userId: 2002,
      groupId: 4004,
      selfId: 4004,
      replyEnabled: true,
      orchestratorEnabled: false,
      messageCount: 0,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "",
      messages: []
    });
    internals.persistConversationRecords = vi.fn();
    internals.prepareIncomingMessage = vi.fn(async () => undefined);
    internals.patchIncomingMessage = vi.fn();
    internals.scheduleAttachmentCacheRefresh = vi.fn();
    internals.scheduleMemoryCompression = vi.fn();
    internals.scheduleReplyDebounce = scheduleReplyDebounce;

    const incoming = groupIncoming("@普拉娜 看看这个", 171419991);
    incoming.messageId = 910_001;
    incoming.mentionedSelf = true;
    await runtime.handleInboundMessage(incoming, {} as never);

    expect(scheduleReplyDebounce).toHaveBeenCalledWith(expect.objectContaining({ route: "direct" }));
    expect(internals.conversationRecords.get("group:3003")).toMatchObject({ orchestratorEnabled: true });
    expect(internals.conversationRecords.get("group:4004")).toMatchObject({ orchestratorEnabled: false });
  });

  it.each(["private", "user_group", "bot_group"] as const)(
    "routes %s replies and commands for any valid QQ sender",
    (scope) => {
      const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
      config.onebot.autoReplyPrivate = true;
      config.onebot.autoReplyUserGroup = true;
      config.onebot.autoReplyBotGroup = true;
      const runtime = createRuntime(config);
      const internals = runtime as unknown as {
        resolveIncomingReplyRoute(incoming: ParsedIncomingMessage, command: boolean): string;
      };
      const incoming = groupIncoming("/总结群聊@普拉娜", 998877665);
      incoming.scope = scope;
      incoming.groupId = scope === "private" ? undefined : 3003;

      expect(internals.resolveIncomingReplyRoute(incoming, true)).toBe("command");
      incoming.userId = 171419991;
      incoming.sender = { id: "171419991", displayName: "管理员" };
      expect(internals.resolveIncomingReplyRoute(incoming, true)).toBe("command");
    }
  );

  it.each(["private", "user_group", "bot_group"] as const)(
    "silently ignores a %s command with an invalid sender",
    async (scope) => {
      const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
      config.onebot.autoReplyPrivate = true;
      config.onebot.autoReplyUserGroup = true;
      config.onebot.autoReplyBotGroup = true;
      const runtime = createRuntime(config);
      const enqueueEvent = vi.fn();
      const recordIncomingMessage = vi.fn();
      const internals = runtime as unknown as {
        sessionCoordinator: { enqueueEvent: typeof enqueueEvent };
        recordIncomingMessage: typeof recordIncomingMessage;
      };
      internals.sessionCoordinator.enqueueEvent = enqueueEvent;
      internals.recordIncomingMessage = recordIncomingMessage;
      const incoming = groupIncoming("/总结群聊@普拉娜", 1234);
      incoming.scope = scope;
      incoming.groupId = scope === "private" ? undefined : 3003;

      await runtime.handleInboundMessage(incoming, {} as never);

      expect(enqueueEvent).not.toHaveBeenCalled();
      expect(recordIncomingMessage).not.toHaveBeenCalled();
    }
  );

  it("keeps an in-flight reply valid when bot.adminQq changes", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = createRuntime(config);
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
    expect(internals.isReplyTaskCurrent(incoming, gate)).toBe(true);
  });

  it("skips a persisted outbox reply with an invalid sender", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = createRuntime(config);
    const incoming = groupIncoming("普通群消息", 1234);
    const internals = runtime as unknown as {
      replyDeliveryDraft(incoming: ParsedIncomingMessage, text: string, isAdmin: boolean): unknown;
      deliverSessionOutbox(outbox: unknown, signal: AbortSignal): Promise<unknown>;
    };
    const draft = internals.replyDeliveryDraft(incoming, "不会发送", true) as Record<string, unknown>;
    const result = await internals.deliverSessionOutbox({
      id: "outbox-invalid-sender",
      ...draft
    }, new AbortController().signal);

    expect(result).toEqual({ delivered: false, skipped: "sender_not_allowed" });
  });

  it("keeps an already dispatched reply task and outbox active after a broadcast storm starts", async () => {
    const detector = new BroadcastStormDetector({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 1,
      cooldownMinutes: 1,
      additionalQqIds: []
    });
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = createRuntime(config, { replyTaskGate: detector });
    const incoming = groupIncoming("普通群消息", 171419991);
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      replyGates: { capture(scope: "user_group", conversationId: string): unknown };
      isReplyTaskCurrent(incoming: ParsedIncomingMessage, gate: unknown): boolean;
      activeGateway: { getStatus(): { connected: boolean } };
      replyDeliveryDraft(incoming: ParsedIncomingMessage, text: string, isAdmin: boolean): unknown;
      deliverReplyOutbox: ReturnType<typeof vi.fn>;
      deliverSessionOutbox(outbox: unknown, signal: AbortSignal): Promise<unknown>;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      replyEnabled: true,
      messages: []
    });
    const gate = internals.replyGates.capture("user_group", "group:3003");
    const draft = internals.replyDeliveryDraft(incoming, "继续发送", false) as Record<string, unknown>;
    internals.activeGateway = { getStatus: () => ({ connected: true }) };
    internals.deliverReplyOutbox = vi.fn(async () => undefined);

    detector.observe({
      messageKey: "storm-trigger",
      groupId: 3003,
      sourceActorId: "agent:plana",
      targetActorId: "agent:arona"
    });

    expect(internals.isReplyTaskCurrent(incoming, gate)).toBe(true);
    await expect(internals.deliverSessionOutbox({
      id: "outbox-dispatched-before-storm",
      ...draft
    }, new AbortController().signal)).resolves.toEqual({ delivered: true });
    expect(internals.deliverReplyOutbox).toHaveBeenCalledOnce();
  });

  it.each(["private", "user_group", "bot_group"] as const)(
    "routes %s messages to record-only mode during a broadcast storm cooldown",
    (scope) => {
      const detector = new BroadcastStormDetector({
        enabled: true,
        windowMinutes: 2,
        replyThreshold: 1,
        cooldownMinutes: 1,
        additionalQqIds: []
      });
      const runtime = createRuntime(undefined, { replyTaskGate: detector });
      const incoming = groupIncoming("普拉娜，回复我", 171419991);
      incoming.scope = scope;
      if (scope === "private") delete incoming.groupId;
      detector.observe({
        messageKey: "storm-trigger",
        groupId: 3003,
        sourceActorId: "agent:plana",
        targetActorId: "agent:arona"
      });

      expect(runtime.resolveIncomingReplyRoute(incoming, true)).toBe("none");
      runtime.close();
    }
  );

  it("skips a persisted reply after the conversation reply gate closes and reopens", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = createRuntime(config);
    const incoming = groupIncoming("普通群消息", 171419991);
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      replyGates: { invalidateConversation(conversationId: string): void };
      replyDeliveryDraft(incoming: ParsedIncomingMessage, text: string, isAdmin: boolean): unknown;
      deliverSessionOutbox(outbox: unknown, signal: AbortSignal): Promise<unknown>;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      replyEnabled: true,
      messages: []
    });
    const draft = internals.replyDeliveryDraft(incoming, "不会发送", false) as Record<string, unknown>;
    internals.replyGates.invalidateConversation("group:3003");

    const result = await internals.deliverSessionOutbox({
      id: "outbox-closed-conversation",
      ...draft
    }, new AbortController().signal);

    expect(result).toEqual({ delivered: false, skipped: "reply_gate_closed" });
  });

  it("skips a persisted no_reply poke after the scope reply gate closes and reopens", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.onebot.autoReplyUserGroup = true;
    const runtime = createRuntime(config);
    const incoming = groupIncoming("普通群消息", 171419991);
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      replyGates: {
        capture(scope: "user_group", conversationId: string): ReturnType<SunaRuntime["replyGates"]["capture"]>;
        invalidateScope(scope: "user_group"): void;
      };
      deliverSessionOutbox(outbox: unknown, signal: AbortSignal): Promise<unknown>;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      replyEnabled: true,
      messages: []
    });
    const replyGate = internals.replyGates.capture("user_group", "group:3003");
    internals.replyGates.invalidateScope("user_group");

    const result = await internals.deliverSessionOutbox({
      id: "outbox-closed-scope-poke",
      kind: "onebot.poke",
      payload: noReplyPokeEnvelope({
        type: "no_reply_poke",
        incoming,
        logRunId: "run-closed-scope",
        replyGate
      }, {
        conversationId: "group:3003",
        correlationId: "run-closed-scope"
      })
    }, new AbortController().signal);

    expect(result).toEqual({ delivered: false, skipped: "reply_gate_closed" });
  });

  it("preserves the default reply gate when only the group orchestrator setting changes", () => {
    const runtime = createRuntime();
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

  it("persists a conversation response-time override and reschedules its pending timer", () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const scheduleAmbientIdleReply = vi.fn();
    const job = { channelKey: "group:3003" };
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      ambientIdleTimers: Map<string, { timer: NodeJS.Timeout; job: typeof job }>;
      persistConversationRecords(): void;
      scheduleAmbientIdleReply: typeof scheduleAmbientIdleReply;
    };
    internals.persistConversationRecords = vi.fn();
    internals.scheduleAmbientIdleReply = scheduleAmbientIdleReply;
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      messageCount: 1,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "待处理消息",
      messages: [],
      replyEnabled: true,
      orchestratorEnabled: true
    });
    internals.ambientIdleTimers.set("group:3003", {
      timer: setTimeout(() => undefined, 60_000),
      job
    });

    const updated = runtime.setConversationReplyEnabled({
      id: "group:3003",
      orchestratorResponseTimeOverrideEnabled: true,
      orchestratorResponseTimeMs: 15_000
    });

    expect(updated).toMatchObject({
      orchestratorResponseTimeOverrideEnabled: true,
      orchestratorResponseTimeMs: 15_000,
      orchestratorStatus: { activeWindowMs: 15_000 }
    });
    expect(internals.persistConversationRecords).toHaveBeenCalledOnce();
    expect(scheduleAmbientIdleReply).toHaveBeenCalledWith(job);
  });

  it("uses the current Agent response time when enabling an override without a submitted time", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.recentMessageWindowMs = 60_000;
    const runtime = createRuntime(config);
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      persistConversationRecords(): void;
    };
    internals.persistConversationRecords = vi.fn();
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      messageCount: 0,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "",
      messages: [],
      replyEnabled: true,
      orchestratorEnabled: true
    });

    const updated = runtime.setConversationReplyEnabled({
      id: "group:3003",
      orchestratorResponseTimeOverrideEnabled: true
    });

    expect(updated).toMatchObject({
      orchestratorResponseTimeOverrideEnabled: true,
      orchestratorResponseTimeMs: 60_000,
      orchestratorStatus: { activeWindowMs: 60_000 }
    });
    expect(internals.persistConversationRecords).toHaveBeenCalledOnce();
  });

  it("exposes the actual orchestrator trigger progress for a user group", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    config.bot.orchestrator.messageThreshold = 20;
    config.bot.orchestrator.recentMessageWindowMs = 60_000;
    const runtime = createRuntime(config);
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
      orchestratorResponseTimeOverrideEnabled: false,
      orchestratorResponseTimeMs: 15_000,
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
    const runtime = createRuntime(config);
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

  it("records a negative decision without disabling the conversation orchestrator", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const raw = '{"should_reply":false,"reason":"当前讨论无需介入。","reply_to_message_id":null}';
    const complete = vi.fn(async () => raw);
    const record = orchestratorRecord();
    const internals = wireOrchestrator(runtime, record, complete);

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      captureSequence: 1
    })).resolves.toBeUndefined();

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
    expect(record.orchestratorEnabled).toBe(true);
  });

  it("injects one image token per image into the user-group orchestrator payload", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const complete = vi.fn(async (
      _systemPrompt: string,
      _messages: Array<{ role: string; content: string }>
    ) => '{"should_reply":false,"reason":"无需回复。","reply_to_message_id":null}');
    const record = {
      id: "group:3003",
      scope: "user_group" as const,
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 3,
      lastAt: "2026-07-10T00:01:00.000Z",
      lastText: "这两张有什么区别",
      messages: [
        {
          id: "999",
          role: "user" as const,
          text: "[图片]",
          at: "2026-07-09T23:59:00.000Z",
          sequence: 1,
          userId: 2002,
          groupId: 3003,
          imageUrls: ["https://example.test/image-only.png"]
        },
        {
          id: "1000",
          role: "user" as const,
          text: "先看这张",
          at: "2026-07-10T00:00:00.000Z",
          sequence: 2,
          userId: 2002,
          groupId: 3003,
          imageUrls: ["https://example.test/first.png"]
        },
        {
          id: "1001",
          role: "user" as const,
          text: "这两张有什么区别 [内容图片#1：图表] [表情图片#2：疑惑]",
          at: "2026-07-10T00:01:00.000Z",
          sequence: 3,
          userId: 2002,
          groupId: 3003,
          imageUrls: [
            "https://example.test/second.png",
            "https://example.test/third.png"
          ]
        }
      ],
      replyEnabled: true,
      orchestratorEnabled: true,
      orchestratorCheckedMessageCount: 0
    };
    const internals = wireOrchestrator(runtime, record, complete);
    const incoming = groupIncoming("这两张有什么区别 [内容图片#1：图表] [表情图片#2：疑惑]");
    incoming.media = [
      { schemaVersion: 1, kind: "image", source: "remote_url", url: "https://example.test/second.png" },
      { schemaVersion: 1, kind: "image", source: "remote_url", url: "https://example.test/third.png" }
    ];
    await expect(internals.runUserGroupchatOrchestrator(incoming, {
      captureSequence: 3
    })).resolves.toBeUndefined();

    const requestMessages = complete.mock.calls[0]?.[1] ?? [];
    const userMessage = [...requestMessages].reverse().find((message) => message.role === "user");
    const content = userMessage?.content ?? "{}";
    const marker = "</time_context>";
    const payload = JSON.parse(content.includes(marker)
      ? content.slice(content.indexOf(marker) + marker.length).trim()
      : content) as {
      conversation?: { recentMessages?: string[]; replyCandidateMessageIds?: string[] };
      currentMessage?: { messageId?: string; text?: string };
    };
    const recentMessages = payload.conversation?.recentMessages ?? [];
    expect(recentMessages).toEqual([
      expect.stringContaining("\n[图片] 图片：1 张"),
      expect.stringContaining("先看这张 [图片]"),
      expect.stringContaining("这两张有什么区别 [内容图片#1：图表] [表情图片#2：疑惑]")
    ]);
    expect(recentMessages.map((message) => message.match(/\[图片\]/g)?.length ?? 0)).toEqual([1, 1, 0]);
    expect(payload.conversation?.replyCandidateMessageIds).toEqual(["999", "1000", "1001"]);
    expect(payload.currentMessage?.messageId).toBe("1001");
    expect(payload.currentMessage?.text).toBe(
      "这两张有什么区别 [内容图片#1：图表] [表情图片#2：疑惑]"
    );
    expect(JSON.stringify(payload)).not.toContain("example.test");
  });

  it("records a failed orchestrator result and action log before consuming the batch", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const complete = vi.fn(async () => { throw new Error("provider unavailable"); });
    const record = orchestratorRecord();
    const internals = wireOrchestrator(runtime, record, complete);
    vi.mocked(appendRequestLog).mockClear();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      captureSequence: 1
    })).resolves.toBeUndefined();

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
    const runtime = createRuntime(config);
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error("attempt 1 failed"))
      .mockRejectedValueOnce(new Error("attempt 2 failed"))
      .mockRejectedValueOnce(new Error("attempt 3 failed"))
      .mockResolvedValueOnce('{"should_reply":true,"reason":"需要回复。","reply_to_message_id":"1001"}');
    const record = orchestratorRecord();
    const internals = wireOrchestrator(runtime, record, complete);
    vi.mocked(appendRequestLog).mockClear();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      captureSequence: 1
    })).resolves.toEqual({
      schemaVersion: 1,
      reason: "需要回复。",
      replyToMessageId: "1001"
    });

    expect(complete).toHaveBeenCalledTimes(4);
    expect(record.messages.at(-1)).toMatchObject({
      orchestratorDecision: {
        status: "completed",
        shouldReply: true,
        replyToMessageId: "1001"
      }
    });
    expect(record.orchestratorCheckedMessageCount).toBe(0);
    expect(record.orchestratorEnabled).toBe(true);
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
    const runtime = createRuntime(config);
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
    const orchestratorResult: UserGroupOrchestratorResultV1 = {
      schemaVersion: 1,
      reason: "群友正在等待普拉娜回应。",
      replyToMessageId: "1001"
    };
    const runUserGroupchatOrchestrator = vi.fn(async () => orchestratorResult);
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
    expect(enqueueEvent.mock.calls.map(([input]) => ({
      kind: (input as { kind: string }).kind,
      orchestratorResult: decodeIncomingReply((input as { payload: unknown }).payload)
        .orchestratorResult
    }))).toEqual([
      { kind: "incoming_reply", orchestratorResult },
      { kind: "incoming_reply", orchestratorResult }
    ]);
    errorLog.mockRestore();
  });

  it("keeps the batch pending when an orchestrator run is cancelled", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const controller = new AbortController();
    controller.abort(new Error("ambient reply cancelled"));
    const complete = vi.fn(async () => { throw controller.signal.reason; });
    const record = orchestratorRecord(171419991);
    const internals = wireOrchestrator(runtime, record, complete);
    vi.mocked(appendRequestLog).mockClear();

    await expect(internals.runUserGroupchatOrchestrator(groupIncoming("普通群消息"), {
      signal: controller.signal,
      captureSequence: 1
    })).resolves.toBeUndefined();

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
    const runtime = createRuntime(config);
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
      orchestratorResponseTimeOverrideEnabled: true,
      orchestratorResponseTimeMs: 15_000,
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
    await vi.advanceTimersByTimeAsync(14_999);
    expect(queueAmbientReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(queueAmbientReply).toHaveBeenCalledOnce();
  });

  it("restores an expired pending batch with its Agent and account routing when OneBot reconnects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-10T00:02:00.000Z");
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    config.bot.orchestrator.recentMessageWindowMs = 60_000;
    const runtime = createRuntime(config);
    const queueAmbientReply = vi.fn();
    const record = {
      id: "account:secondary-a:group:3003",
      agentId: "arona",
      accountId: "secondary-a",
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
      channelKey: "account:secondary-a:group:3003",
      captureSequence: 19,
      incoming: {
        agentId: "arona",
        accountId: "secondary-a",
        text: "待处理消息",
        groupId: 3003
      }
    });
  });

  it("keeps a manually disabled orchestrator dormant after reconnect", () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    config.bot.orchestrator.enabled = true;
    const runtime = createRuntime(config);
    const queueAmbientReply = vi.fn();
    const internals = runtime as unknown as {
      conversationRecords: Map<string, Record<string, unknown>>;
      queueAmbientReply: typeof queueAmbientReply;
    };
    internals.conversationRecords.set("group:3003", {
      id: "group:3003",
      scope: "user_group",
      title: "群聊",
      userId: 2002,
      groupId: 3003,
      selfId: 4004,
      messageCount: 1,
      lastAt: "2026-07-10T00:00:00.000Z",
      lastText: "待处理消息",
      messages: [
        { id: "stored-1", role: "user", text: "待处理消息", at: "2026-07-10T00:00:00.000Z", sequence: 1, userId: 171419991, groupId: 3003 }
      ],
      replyEnabled: true,
      orchestratorEnabled: false,
      orchestratorCheckedMessageCount: 0
    });
    internals.queueAmbientReply = queueAmbientReply;

    runtime.resumeUserGroupOrchestrators({} as never);

    expect(queueAmbientReply).not.toHaveBeenCalled();
    expect(runtime.getConversationRecords().find((record) => record.id === "group:3003")).toMatchObject({
      orchestratorEnabled: false,
      orchestratorStatus: { active: false }
    });
  });

  it("exposes group member names from the complete conversation history", () => {
    const runtime = createRuntime();
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
    const runtime = createRuntime();
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
    const runtime = createRuntime(config);
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

  it("applies the memory compression threshold setting immediately after a hot reload", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-runtime-router-test");
    const runtime = createRuntime(config);
    const scheduleMemoryDrain = vi.fn();
    const claimNext = vi.fn(async () => undefined);
    const internals = runtime as unknown as {
      scheduleMemoryDrain: typeof scheduleMemoryDrain;
      memoryScheduler: { claimNext: typeof claimNext };
    };
    internals.scheduleMemoryDrain = scheduleMemoryDrain;
    internals.memoryScheduler.claimNext = claimNext;
    const nextConfig = structuredClone(config);
    nextConfig.bot.memory.messageThreshold = 17;

    runtime.commitReload({
      config: nextConfig,
      persona: { id: "plana", name: "普拉娜", files: [], memoryItems: [], systemPrompt: "" }
    });
    await runtime.drainMemoryScheduler();

    expect(scheduleMemoryDrain).toHaveBeenCalledOnce();
    expect(claimNext).toHaveBeenCalledWith(17);
    runtime.close();
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

function createRuntime(
  config = createAdminTestConfig(TEST_WORKSPACE),
  options: NonNullable<ConstructorParameters<typeof SunaRuntime>[1]> = {}
) {
  return new SunaRuntime(config, { attachmentService: {} as never, ...options });
}

function orchestratorRecord(userId = 2002) {
  return {
    id: "group:3003",
    scope: "user_group" as const,
    title: "群聊",
    userId,
    groupId: 3003,
    selfId: 4004,
    messageCount: 1,
    lastAt: "2026-07-10T00:01:00.000Z",
    lastText: "普通群消息",
    messages: [{
      id: "1001", role: "user" as const, text: "普通群消息", at: "2026-07-10T00:01:00.000Z",
      sequence: 1, userId: 2002, groupId: 3003
    }],
    replyEnabled: true,
    orchestratorEnabled: true,
    orchestratorCheckedMessageCount: 0
  };
}

function wireOrchestrator<T extends { id: string }>(
  runtime: SunaRuntime,
  record: T,
  complete: ReturnType<typeof vi.fn>
) {
  const internals = runtime as unknown as {
    conversationRecords: Map<string, T>;
    getProviderForModel(): { complete: typeof complete };
    persistConversationRecords(): void;
    runUserGroupchatOrchestrator(
      incoming: ParsedIncomingMessage,
      options: { captureSequence: number; signal?: AbortSignal }
    ): Promise<UserGroupOrchestratorResultV1 | undefined>;
  };
  internals.conversationRecords.set(record.id, record);
  internals.getProviderForModel = () => ({ complete });
  internals.persistConversationRecords = vi.fn();
  return internals;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime scheduler condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
