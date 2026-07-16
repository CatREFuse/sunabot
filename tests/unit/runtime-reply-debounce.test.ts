// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpenAIProvider,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "../../adapters/model/openaiProvider.js";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";
import type {
  MessagingPort,
  OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import { MAX_COMMAND_INVOCATION_ARGS_CHARACTERS } from "../../packages/contracts/messaging/commands.js";
import {
  MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeReplyDebounce,
  incomingReplyEnvelope,
  toolCompletionEnvelope
} from "../../packages/contracts/session/runtimeMessages.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import type { AttachmentService } from "../../services/media/attachments/service.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import {
  applicationDataStore,
  closeApplicationDataStores
} from "../../adapters/sqlite/applicationDataStore.js";
import { SunaRuntime } from "../../src/runtime.js";
import {
  conversationRecordId,
  persistentIncomingKey,
  queueIncomingSnapshot
} from "../../src/runtime/messagingAttachmentHelpers.js";
import { replyDebounceSessionId } from "../../src/runtime/replyDebounce.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const appendRequestLogStrict = vi.hoisted(() => vi.fn(async () => undefined));
const recallMemory = vi.hoisted(() => vi.fn(async () => ({ ok: true, matches: [] })));
const readUserProfileForUser = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/requestLog.js")>()),
  appendRequestLog,
  appendRequestLogStrict
}));
vi.mock("../../services/memory/memoryService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/memory/memoryService.js")>()),
  recallMemory,
  readUserProfileForUser
}));

const testDataRoot = process.env.SUNABOT_TEST_DATA_ROOT?.trim()
  || path.join(os.tmpdir(), "sunabot-runtime-reply-debounce");
const runtimes: SunaRuntime[] = [];
const stores: SessionStore[] = [];
const runtimeRoots: string[] = [];
let runtimeRootSequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
  closeApplicationDataStores();
  for (const root of runtimeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("SunaRuntime reply debounce", () => {
  it("uses a five-second default trailing deadline", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }));
    const before = Date.now();
    const incoming = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_001, "default deadline"),
      harness.gateway
    );
    const after = Date.now();

    const event = harness.store.getActiveEvent(replyDebounceSessionId(incoming), "reply_debounce");
    expect(event).toBeDefined();
    expect(event!.availableAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(event!.availableAt).toBeLessThanOrEqual(after + 5_000);
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
  });

  it("resets one private sender's deadline and replies only to the frozen first trigger", async () => {
    const requests: RenderedPromptRequest[] = [];
    const harness = createRuntimeHarness(async (request) => {
      requests.push(request);
      return { kind: "completed", text: "private reply" };
    }, { replyDebounceMs: 90 });

    const first = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_010, "first private trigger"),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(first);
    const initial = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    await delay(25);
    await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_011, "second private context"),
      harness.gateway
    );
    const bumped = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;

    expect(bumped.id).toBe(initial.id);
    expect(bumped.availableAt).toBeGreaterThan(initial.availableAt);
    expect(harness.store.listEvents(debounceSessionId)).toHaveLength(1);

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(lastUserText(requests[0]!)).toContain("first private trigger");
    expect(requests[0]!.messages.some((message) => message.content.includes("second private context"))).toBe(true);
    expect(sentOutbounds(harness.gateway).map((message) => message.text)).toEqual(["private reply"]);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(first))?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)).toEqual([
        "first private trigger",
        "second private context"
      ]);
  });

  it("keeps another group sender ambient, preserves the trigger deadline, and quotes the first trigger", async () => {
    const requests: RenderedPromptRequest[] = [];
    const harness = createRuntimeHarness(async (request) => {
      requests.push(request);
      return { kind: "completed", text: "group reply" };
    }, {
      replyDebounceMs: 150,
      configure(config) {
        config.bot.orchestrator.enabled = true;
      }
    });
    const scheduleAmbientIdleReply = vi.fn();
    harness.runtime.scheduleAmbientIdleReply = scheduleAmbientIdleReply;

    const trigger = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_020, 7_020, "Plana first group trigger", 20_001),
      harness.gateway
    );
    const triggerSessionId = replyDebounceSessionId(trigger);
    const initial = harness.store.getActiveEvent(triggerSessionId, "reply_debounce")!;
    await delay(20);
    const ambient = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_021, 7_020, "ambient context from another sender", 20_002),
      harness.gateway
    );
    await waitUntil(() => scheduleAmbientIdleReply.mock.calls.length === 1);

    const unchanged = harness.store.getActiveEvent(triggerSessionId, "reply_debounce")!;
    expect(unchanged.id).toBe(initial.id);
    expect(unchanged.availableAt).toBe(initial.availableAt);
    expect(harness.store.getActiveEvent(replyDebounceSessionId(ambient), "reply_debounce")).toBeUndefined();
    expect(scheduleAmbientIdleReply).toHaveBeenCalledWith(expect.objectContaining({
      incoming: expect.objectContaining({ userId: 20_002 })
    }));

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(requests[0]!.messages.some((message) => (
      message.content.includes("ambient context from another sender")
    ))).toBe(true);
    expect(sentOutbounds(harness.gateway)[0]).toMatchObject({
      groupId: 7_020,
      userId: 20_001,
      replyToMessageId: 31_020,
      text: "group reply"
    });
  });

  it("keeps different group senders on independent deadlines and preserves deadline order", async () => {
    const starts: string[] = [];
    const harness = createRuntimeHarness(async (request) => {
      const current = lastUserText(request);
      const marker = current.includes("sender-a") ? "sender-a" : "sender-b";
      starts.push(marker);
      return { kind: "completed", text: `reply:${marker}` };
    }, { replyDebounceMs: 120 });

    const senderA = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_030, 7_030, "Plana sender-a", 21_001),
      harness.gateway
    );
    const eventA = harness.store.getActiveEvent(replyDebounceSessionId(senderA), "reply_debounce")!;
    await delay(35);
    const senderB = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_031, 7_030, "Plana sender-b", 21_002),
      harness.gateway
    );
    const eventB = harness.store.getActiveEvent(replyDebounceSessionId(senderB), "reply_debounce")!;

    expect(eventA.id).not.toBe(eventB.id);
    expect(eventB.availableAt).toBeGreaterThan(eventA.availableAt);
    expect(harness.store.getActiveEvent(replyDebounceSessionId(senderA), "reply_debounce")?.availableAt)
      .toBe(eventA.availableAt);

    await waitUntil(() => sentOutbounds(harness.gateway).length === 2);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(starts).toEqual(["sender-a", "sender-b"]);
    expect(sentOutbounds(harness.gateway).map((message) => ({
      text: message.text,
      replyToMessageId: message.replyToMessageId
    }))).toEqual([
      { text: "reply:sender-a", replyToMessageId: 31_030 },
      { text: "reply:sender-b", replyToMessageId: 31_031 }
    ]);
  });

  it("does not revive a waiting reply after its conversation gate closes and reopens", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "must not be sent"
    }), { replyDebounceMs: 90 });
    const incoming = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_040, "gate-bound trigger"),
      harness.gateway
    );
    const conversationId = conversationRecordId(incoming);
    const debounceSessionId = replyDebounceSessionId(incoming);

    expect(harness.runtime.setConversationReplyEnabled({
      id: conversationId,
      replyEnabled: false
    }).replyEnabled).toBe(false);
    expect(harness.runtime.setConversationReplyEnabled({
      id: conversationId,
      replyEnabled: true
    }).replyEnabled).toBe(true);

    await waitUntil(() => harness.store.listEvents(debounceSessionId)[0]?.status === "completed");
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    expect(sentOutbounds(harness.gateway)).toEqual([]);
    expect(harness.store.listTurns(debounceSessionId).map((turn) => turn.status)).toEqual(["no_reply"]);
  });

  it("isolates the same private sender by account conversation key", async () => {
    const harness = createRuntimeHarness(async (request) => {
      const current = lastUserText(request);
      return {
        kind: "completed",
        text: current.includes("account-a") ? "reply:account-a" : "reply:account-b"
      };
    }, { replyDebounceMs: 90 });

    const accountA = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_050, "from account-a"),
      harness.gateway,
      "qq-account-a"
    );
    const accountB = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_051, "from account-b"),
      harness.gateway,
      "qq-account-b"
    );
    const conversationA = conversationRecordId(accountA);
    const conversationB = conversationRecordId(accountB);

    expect(conversationA).toBe("account:qq-account-a:private:171419991");
    expect(conversationB).toBe("account:qq-account-b:private:171419991");
    expect(harness.store.getActiveEvent(replyDebounceSessionId(accountA), "reply_debounce")?.id)
      .not.toBe(harness.store.getActiveEvent(replyDebounceSessionId(accountB), "reply_debounce")?.id);

    await waitUntil(() => sentOutbounds(harness.gateway).length === 2);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.completeRequestTurn).toHaveBeenCalledTimes(2);
    expect(sentOutbounds(harness.gateway).map((message) => ({
      accountId: message.accountId,
      conversationId: message.conversationId,
      text: message.text
    })).sort((left, right) => String(left.accountId).localeCompare(String(right.accountId)))).toEqual([
      {
        accountId: "qq-account-a",
        conversationId: conversationA,
        text: "reply:account-a"
      },
      {
        accountId: "qq-account-b",
        conversationId: conversationB,
        text: "reply:account-b"
      }
    ]);
    expect(harness.store.listTurns(conversationA).map((turn) => turn.status)).toEqual(["replied"]);
    expect(harness.store.listTurns(conversationB).map((turn) => turn.status)).toEqual(["replied"]);
    expect(harness.store.listOutbox(conversationA)[0]?.deliveryPartition).toBe("qq-account-a");
    expect(harness.store.listOutbox(conversationB)[0]?.deliveryPartition).toBe("qq-account-b");
  });

  it("recovers one pending debounce from its remaining file-backed deadline and rebuilds the trigger", async () => {
    const runtimeRoot = path.join(
      testDataRoot,
      `restart-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const before = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "old runtime must not reply"
    }), {
      replyDebounceMs: 600,
      runtimeRoot,
      storeOptions: { databasePath }
    });
    const incoming = await handleOneBotEvent(
      before.runtime,
      privateEvent(31_060, "persisted restart trigger"),
      before.gateway
    );
    const debounceSessionId = replyDebounceSessionId(incoming);
    const pending = before.store.getActiveEvent(debounceSessionId, "reply_debounce")!;

    await delay(400);
    expect(pending.availableAt - Date.now()).toBeGreaterThan(100);
    expect(before.completeRequestTurn).not.toHaveBeenCalled();
    disposeRuntimeHarness(before);

    let providerStartedAt = 0;
    const after = createRuntimeHarness(async () => {
      providerStartedAt = Date.now();
      return { kind: "completed", text: "recovered once" };
    }, {
      replyDebounceMs: 600,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" }
    });
    expect(after.runtime.conversationRecords.size).toBe(0);
    after.runtime.activeGateway = after.gateway;
    const remaining = pending.availableAt - Date.now();
    expect(remaining).toBeGreaterThan(50);
    after.runtime.sessionCoordinator.resume();

    await delay(Math.max(1, remaining - 30));
    expect(after.completeRequestTurn).not.toHaveBeenCalled();
    await waitUntil(() => sentOutbounds(after.gateway).length === 1);
    await after.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(after.completeRequestTurn).toHaveBeenCalledOnce();
    expect(providerStartedAt).toBeGreaterThanOrEqual(pending.availableAt);
    expect(providerStartedAt).toBeLessThan(pending.availableAt + 250);
    expect(sentOutbounds(after.gateway).map((message) => message.text)).toEqual(["recovered once"]);
    expect(after.store.listEvents(debounceSessionId)).toHaveLength(1);
    expect(after.store.listEvents(conversationRecordId(incoming)).map((event) => event.kind))
      .toEqual(["incoming_reply"]);
    expect(after.runtime.conversationRecords.get(conversationRecordId(incoming))?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)).toEqual(["persisted restart trigger"]);
  });

  it.each([
    {
      label: "mention alias",
      commandText: "/总结群聊@Plana 最近三小时",
      mentionNames: ["Plana"],
      personaName: "旧人格"
    },
    {
      label: "persona name",
      commandText: "/总结群聊@旧人格 最近三小时",
      mentionNames: ["不会匹配"],
      personaName: "旧人格"
    }
  ])("restores a frozen $label command after restart and name changes", async ({
    commandText,
    mentionNames,
    personaName
  }) => {
    const runtimeRoot = path.join(
      testDataRoot,
      `command-restart-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const before = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      runtimeRoot,
      storeOptions: { databasePath },
      configure(config) {
        config.onebot.mentionNames = mentionNames;
        config.persona.name = personaName;
      }
    });
    const incoming = await handleOneBotEvent(
      before.runtime,
      groupEvent(31_061, 7_061, commandText, 24_061),
      before.gateway
    );
    const debounceSessionId = replyDebounceSessionId(incoming);
    const pending = before.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const frozenInvocation = decodeReplyDebounce(pending.payload).commandInvocation;
    expect(frozenInvocation).toEqual({
      id: "group-summary",
      invokedName: "总结群聊",
      args: "最近三小时",
      rawText: commandText
    });
    disposeRuntimeHarness(before);

    const after = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" },
      configure(config) {
        config.onebot.mentionNames = ["新别名"];
        config.persona.name = "新人格";
      }
    });
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    after.runtime.replyWithGroupChatSummary = replyWithGroupChatSummary;
    after.runtime.activeGateway = after.gateway;
    const recovered = after.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    after.runtime.sessionCoordinator.reschedulePendingEvent(recovered.id, Date.now() + 30);
    after.runtime.sessionCoordinator.resume();

    await waitUntil(() => replyWithGroupChatSummary.mock.calls.length === 1);
    await after.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(replyWithGroupChatSummary).toHaveBeenCalledOnce();
    expect(after.completeRequestTurn).not.toHaveBeenCalled();
    const target = after.store.listEvents(conversationRecordId(incoming))[0]!;
    expect(decodeIncomingReply(target.payload).commandInvocation).toEqual(frozenInvocation);
  });

  it("isolates identical account, conversation, and sender keys across two Agent stores", async () => {
    const agentA = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "reply:agent-a"
    }), {
      replyDebounceMs: 90,
      configure(config) {
        config.persona.defaultAgentId = "agent-a";
        config.persona.name = "Agent A";
      }
    });
    const agentB = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "reply:agent-b"
    }), {
      replyDebounceMs: 90,
      configure(config) {
        config.persona.defaultAgentId = "agent-b";
        config.persona.name = "Agent B";
      }
    });
    const event = groupEvent(31_070, 7_070, "Plana identical agent trigger", 25_001);

    const [incomingA, incomingB] = await Promise.all([
      handleOneBotEvent(agentA.runtime, event, agentA.gateway, "shared-account", "agent-a"),
      handleOneBotEvent(agentB.runtime, event, agentB.gateway, "shared-account", "agent-b")
    ]);
    const conversationId = conversationRecordId(incomingA);

    expect(agentA.store).not.toBe(agentB.store);
    expect(conversationRecordId(incomingB)).toBe(conversationId);
    expect(replyDebounceSessionId(incomingB)).toBe(replyDebounceSessionId(incomingA));
    await waitUntil(() => (
      sentOutbounds(agentA.gateway).length === 1 && sentOutbounds(agentB.gateway).length === 1
    ));
    await Promise.all([
      agentA.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 }),
      agentB.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 })
    ]);

    expect(agentA.completeRequestTurn).toHaveBeenCalledOnce();
    expect(agentB.completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentOutbounds(agentA.gateway)[0]).toMatchObject({
      agentId: "agent-a",
      accountId: "shared-account",
      conversationId,
      text: "reply:agent-a"
    });
    expect(sentOutbounds(agentB.gateway)[0]).toMatchObject({
      agentId: "agent-b",
      accountId: "shared-account",
      conversationId,
      text: "reply:agent-b"
    });
    expect(agentA.store.listTurns(conversationId).map((turn) => turn.status)).toEqual(["replied"]);
    expect(agentB.store.listTurns(conversationId).map((turn) => turn.status)).toEqual(["replied"]);
  });

  it("waits for another sender's conversation preparation before building Provider context", async () => {
    const pendingPreparation = deferred<void>();
    const requests: RenderedPromptRequest[] = [];
    const harness = createRuntimeHarness(async (request) => {
      requests.push(request);
      return { kind: "completed", text: "prepared context reply" };
    }, {
      replyDebounceMs: 90,
      configure(config) {
        config.bot.orchestrator.enabled = true;
      }
    });
    harness.runtime.scheduleAmbientIdleReply = vi.fn();
    harness.runtime.prepareIncomingMessage = async (incoming) => {
      if (incoming.userId !== 26_002) return;
      await pendingPreparation.promise;
      incoming.text = "ambient prepared image attachment context";
    };

    const trigger = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_080, 7_080, "Plana preparation trigger", 26_001),
      harness.gateway
    );
    await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_081, 7_080, "ambient preparation pending", 26_002),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(trigger);

    const conversationId = conversationRecordId(trigger);
    await waitUntil(() => (
      harness.store.listEvents(debounceSessionId)[0]?.status === "completed"
      && harness.store.listTurns(debounceSessionId)[0]?.status === "no_reply"
      && harness.store.listTurns(conversationId)[0]?.status === "running"
    ));
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    expect(sentOutbounds(harness.gateway)).toEqual([]);
    pendingPreparation.resolve();

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(requests[0]!.messages.some((message) => (
      message.content.includes("ambient prepared image attachment context")
    ))).toBe(true);
  });

  it("clears the trigger preparation after a waiting debounce is cancelled by its gate", async () => {
    const pendingPreparation = deferred<void>();
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "must not run"
    }), { replyDebounceMs: 90 });
    harness.runtime.prepareIncomingMessage = () => pendingPreparation.promise;
    const incoming = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_090, "cancel preparation trigger"),
      harness.gateway
    );
    const preparationKey = persistentIncomingKey(incoming);
    const debounceSessionId = replyDebounceSessionId(incoming);
    expect(harness.runtime.incomingPreparations.has(preparationKey)).toBe(true);

    harness.runtime.setConversationReplyEnabled({
      id: conversationRecordId(incoming),
      replyEnabled: false
    });
    await waitUntil(() => harness.store.listEvents(debounceSessionId)[0]?.status === "completed");

    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    expect(harness.runtime.incomingPreparations.has(preparationKey)).toBe(false);
    expect(harness.runtime.incomingPreparations.size).toBe(0);
    pendingPreparation.resolve();
  });

  it("ignores a replayed durable OneBot message without extending its active deadline", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "deduplicated reply"
    }), { replyDebounceMs: 140 });
    const event = privateEvent(31_100, "durable duplicate trigger");
    const incoming = await handleOneBotEvent(harness.runtime, event, harness.gateway);
    const debounceSessionId = replyDebounceSessionId(incoming);
    const initial = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(harness.runtime.conversationRecords.get(conversationRecordId(incoming))?.messages)
      .toHaveLength(1);

    harness.runtime.seenIncomingEvents.clear();
    await delay(20);
    await handleOneBotEvent(harness.runtime, event, harness.gateway);

    const replayed = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(replayed.id).toBe(initial.id);
    expect(replayed.availableAt).toBe(initial.availableAt);
    expect(harness.store.listEvents(debounceSessionId)).toHaveLength(1);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(incoming))?.messages)
      .toHaveLength(1);

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
  });

  it("turns a positive ambient orchestrator decision into one delayed debounce reply", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "ambient delayed reply"
    }), {
      replyDebounceMs: 120,
      configure(config) {
        config.bot.orchestrator.enabled = true;
      }
    });
    const incoming = parseOneBotInboundMessage(
      groupEvent(31_110, 7_110, "ambient orchestrator candidate", 27_001)
    )!;
    const channelKey = conversationRecordId(incoming);
    const record = harness.runtime.recordIncomingMessage(incoming);
    const job = {
      channelKey,
      incoming,
      gateway: harness.gateway,
      captureSequence: record.messageCount,
      gate: harness.runtime.replyGates.capture(incoming.scope, channelKey)
    };
    const state: Parameters<SunaRuntime["pumpAmbientReply"]>[1] = {
      epoch: 0,
      running: false,
      next: job
    };
    harness.runtime.activeGateway = harness.gateway;
    harness.runtime.ambientReplies.set(channelKey, state);
    harness.runtime.runUserGroupchatOrchestrator = vi.fn(async () => true);

    await harness.runtime.pumpAmbientReply(channelKey, state);

    expect(harness.runtime.runUserGroupchatOrchestrator).toHaveBeenCalledOnce();
    expect(harness.store.getActiveEvent(replyDebounceSessionId(incoming), "reply_debounce"))
      .toBeDefined();
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    await delay(45);
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentOutbounds(harness.gateway).map((message) => message.text))
      .toEqual(["ambient delayed reply"]);
  });

  it("keeps the first trigger quote while a later reply target only enters context", async () => {
    const requests: RenderedPromptRequest[] = [];
    const harness = createRuntimeHarness(async (request) => {
      requests.push(request);
      return { kind: "completed", text: "frozen quote reply" };
    }, { replyDebounceMs: 120 });
    const first = groupEvent(31_120, 7_120, "unused", 28_001);
    first.message = [
      { type: "reply", data: { id: "91001" } },
      { type: "text", data: { text: "Plana first quoted trigger" } }
    ];
    const later = groupEvent(31_121, 7_120, "unused", 28_001);
    later.message = [
      { type: "reply", data: { id: "91002" } },
      { type: "text", data: { text: "later quoted context" } }
    ];

    await handleOneBotEvent(harness.runtime, first, harness.gateway);
    await delay(20);
    await handleOneBotEvent(harness.runtime, later, harness.gateway);

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentOutbounds(harness.gateway)[0]).toMatchObject({
      replyToMessageId: 31_120,
      text: "frozen quote reply"
    });
    expect(requests[0]!.messages.some((message) => (
      message.content.includes("message_id=31121")
      && message.content.includes("reply_to_message_id=91002")
      && message.content.includes("later quoted context")
    ))).toBe(true);
  });

  it.each([
    {
      label: "quote on to off",
      configure: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplies = true;
      },
      mutate: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplies = false;
      },
      expectedReplyTo: 31_122
    },
    {
      label: "quote off to on",
      configure: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplies = false;
      },
      mutate: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplies = true;
      },
      expectedReplyTo: undefined
    },
    {
      label: "sender becomes excluded",
      configure: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplies = true;
        config.bot.quoteGroupReplyExcludedUserIds = [];
      },
      mutate: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplyExcludedUserIds = ["28001"];
      },
      expectedReplyTo: 31_122
    },
    {
      label: "sender leaves the exclusion list",
      configure: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplies = true;
        config.bot.quoteGroupReplyExcludedUserIds = ["28001"];
      },
      mutate: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.bot.quoteGroupReplyExcludedUserIds = [];
      },
      expectedReplyTo: undefined
    }
  ])("freezes the first trigger quote across $label during the debounce window", async ({
    configure,
    mutate,
    expectedReplyTo
  }) => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "quote setting frozen"
    }), { replyDebounceMs: 100, configure });
    const incoming = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_122, 7_122, "Plana freeze quote setting", 28_001),
      harness.gateway
    );
    const source = harness.store.getActiveEvent(replyDebounceSessionId(incoming), "reply_debounce")!;
    expect(decodeReplyDebounce(source.payload).replyQuote).toEqual({
      enabled: expectedReplyTo != null,
      replyToMessageId: expectedReplyTo ?? null
    });

    mutate(harness.runtime.config);
    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(sentOutbounds(harness.gateway)[0]?.replyToMessageId).toBe(expectedReplyTo);
  });

  it("keeps the quote frozen while the Provider is running", async () => {
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const harness = createRuntimeHarness(async () => {
      providerStarted.resolve();
      await releaseProvider.promise;
      return { kind: "completed", text: "provider phase quote frozen" };
    }, { replyDebounceMs: 25 });

    await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_123, 7_123, "Plana provider quote trigger", 28_002),
      harness.gateway
    );
    await providerStarted.promise;
    harness.runtime.config.bot.quoteGroupReplies = false;
    harness.runtime.config.bot.quoteGroupReplyExcludedUserIds = ["28002"];
    releaseProvider.resolve();

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(sentOutbounds(harness.gateway)[0]?.replyToMessageId).toBe(31_123);
  });

  it("passes the frozen quote through the command handler delivery", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 80
    });
    harness.runtime.replyWithGroupChatSummary = vi.fn(async (
      ...args: Parameters<SunaRuntime["replyWithGroupChatSummary"]>
    ) => {
      const [channelKey, incoming, gateway, _signal, isCurrent, delivery] = args;
      await harness.runtime.sendAssistantReply(
        channelKey,
        incoming,
        gateway,
        "command quote frozen",
        false,
        [],
        undefined,
        isCurrent,
        delivery
      );
    });

    await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_124, 7_124, "/总结群聊", 28_003),
      harness.gateway
    );
    harness.runtime.config.bot.quoteGroupReplies = false;

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(sentOutbounds(harness.gateway)[0]).toMatchObject({
      text: "command quote frozen",
      replyToMessageId: 31_124
    });
  });

  it("restores the frozen quote from SQLite after restart despite new quote settings", async () => {
    const runtimeRoot = path.join(
      testDataRoot,
      `quote-restart-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const before = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      runtimeRoot,
      storeOptions: { databasePath },
      persistConversations: true
    });
    const incoming = await handleOneBotEvent(
      before.runtime,
      groupEvent(31_125, 7_125, "Plana durable quote trigger", 28_004),
      before.gateway
    );
    const debounceSessionId = replyDebounceSessionId(incoming);
    expect(decodeReplyDebounce(
      before.store.getActiveEvent(debounceSessionId, "reply_debounce")!.payload
    ).replyQuote).toEqual({ enabled: true, replyToMessageId: 31_125 });
    disposeRuntimeHarness(before);
    closeApplicationDataStores();

    const after = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "restart quote frozen"
    }), {
      replyDebounceMs: 60_000,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" },
      persistConversations: true,
      loadPersistedConversations: true,
      configure(config) {
        config.bot.quoteGroupReplies = false;
        config.bot.quoteGroupReplyExcludedUserIds = ["28004"];
      }
    });
    after.runtime.activeGateway = after.gateway;
    const recovered = after.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    after.runtime.sessionCoordinator.reschedulePendingEvent(recovered.id, Date.now() + 20);
    after.runtime.sessionCoordinator.resume();

    await waitUntil(() => sentOutbounds(after.gateway).length === 1);
    await after.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(sentOutbounds(after.gateway)[0]?.replyToMessageId).toBe(31_125);
  });

  it("freezes the deferred acknowledgement quote and carries it in the original request", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "deferred",
      acknowledgement: "deferred acknowledgement",
      toolCall: {
        name: "codex",
        callId: "quote-deferred-call",
        arguments: { task: "inspect" }
      }
    }), { replyDebounceMs: 60_000 });
    const incoming = parseOneBotInboundMessage(
      groupEvent(31_126, 7_126, "Plana deferred quote", 28_005)
    )!;
    harness.runtime.recordIncomingMessage(incoming, { persist: false });
    const replyQuote = { enabled: true, replyToMessageId: 31_126 };
    const delivery = { outbox: [], replyQuote };
    let deferredTurn: Parameters<NonNullable<Parameters<SunaRuntime["replyToIncoming"]>[3]["onDeferred"]>>[0]
      | undefined;
    harness.runtime.config.bot.quoteGroupReplies = false;

    await harness.runtime.replyToIncoming(
      conversationRecordId(incoming),
      incoming,
      harness.gateway,
      {
        captureSequence: 1,
        contextThroughSequence: 1,
        delivery,
        onDeferred: (value) => { deferredTurn = value; }
      }
    );

    expect(deferredTurn?.originalRequest.replyQuote).toEqual(replyQuote);
    const acknowledgement = decodeAssistantReply(deferredTurn!.acknowledgement.payload);
    expect(acknowledgement.replyToMessageId).toBe(31_126);
    await harness.runtime.deliverReplyOutbox(acknowledgement, harness.gateway);
    expect(sentOutbounds(harness.gateway)[0]?.replyToMessageId).toBe(31_126);
  });

  it.each([
    { label: "normal", toolName: "codex", result: "completed tool result" },
    {
      label: "image",
      toolName: "generate_img",
      result: { image: { url: "https://example.test/deferred-image.png" } }
    }
  ])("uses the frozen quote for a durable deferred $label callback", async ({ toolName, result }) => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "deferred callback quote frozen"
    }), { replyDebounceMs: 60_000 });
    const incoming = parseOneBotInboundMessage(
      groupEvent(toolName === "codex" ? 31_127 : 31_128, 7_127, "Plana callback quote", 28_006)
    )!;
    const channelKey = conversationRecordId(incoming);
    harness.runtime.recordIncomingMessage(incoming, { persist: false });
    const replyQuote = { enabled: true, replyToMessageId: incoming.messageId! };
    const gate = harness.runtime.replyGates.capture(incoming.scope, channelKey);
    harness.runtime.config.bot.quoteGroupReplies = false;
    harness.runtime.activeGateway = harness.gateway;
    harness.runtime.sessionCoordinator.enqueueEvent({
      sessionId: channelKey,
      kind: "tool_completion",
      dedupeKey: `quote-callback:${toolName}`,
      payload: toolCompletionEnvelope({
        type: "tool_result",
        toolJobId: `quote-job:${toolName}`,
        providerCallId: `quote-call:${toolName}`,
        toolName,
        originalRequest: {
          incoming: queueIncomingSnapshot(incoming),
          captureSequence: 1,
          contextThroughSequence: 1,
          replyGate: gate,
          replyQuote
        },
        arguments: {},
        outcome: { status: "succeeded", result, error: null }
      }, {
        conversationId: channelKey,
        correlationId: `quote-call:${toolName}`
      })
    }, { schedule: false });
    harness.runtime.sessionCoordinator.resume();

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    expect(sentOutbounds(harness.gateway)[0]?.replyToMessageId).toBe(incoming.messageId);
  });

  it("uses the frozen quote for an outer aborted-turn reply", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000
    });
    const incoming = parseOneBotInboundMessage(
      groupEvent(31_129, 7_129, "Plana timeout quote", 28_007)
    )!;
    const channelKey = conversationRecordId(incoming);
    harness.runtime.recordIncomingMessage(incoming, { persist: false });
    const replyQuote = { enabled: true, replyToMessageId: 31_129 };
    const committed = harness.runtime.sessionCoordinator.enqueueEvent({
      sessionId: channelKey,
      kind: "incoming_reply",
      dedupeKey: "quote-timeout",
      availableAt: Date.now() + 60_000,
      payload: incomingReplyEnvelope({
        type: "incoming_reply",
        route: "direct",
        incoming: queueIncomingSnapshot(incoming),
        captureSequence: 1,
        contextThroughSequence: 1,
        replyGate: harness.runtime.replyGates.capture(incoming.scope, channelKey),
        replyQuote
      }, {
        conversationId: channelKey,
        correlationId: "quote-timeout"
      })
    }, { schedule: false });
    harness.runtime.config.bot.quoteGroupReplies = false;
    harness.runtime.activeGateway = harness.gateway;
    const controller = new AbortController();
    const abortError = new Error("operation timed out in quote test");
    abortError.name = "AbortError";
    controller.abort(abortError);

    const result = await harness.runtime.processSessionEvent(committed.event, {
      signal: controller.signal,
      turn: {} as never,
      emitOutbox: vi.fn()
    });
    const draft = (result as { outbox: Array<{ payload: unknown }> }).outbox[0]!;
    const timeoutReply = decodeAssistantReply(draft.payload);
    expect(timeoutReply.replyToMessageId).toBe(31_129);
    await harness.runtime.deliverReplyOutbox(timeoutReply, harness.gateway);
    expect(sentOutbounds(harness.gateway)[0]?.replyToMessageId).toBe(31_129);
  });

  it("debounces the group summary command and freezes its handoff context boundary", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "unused"
    }), { replyDebounceMs: 100 });
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    harness.runtime.replyWithGroupChatSummary = replyWithGroupChatSummary;
    const targetStarted = deferred<void>();
    const releaseTarget = deferred<void>();
    const processIncomingReplyEvent = harness.runtime.processIncomingReplyEvent.bind(harness.runtime);
    harness.runtime.processIncomingReplyEvent = async (...args) => {
      targetStarted.resolve();
      await releaseTarget.promise;
      return processIncomingReplyEvent(...args);
    };

    const command = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_130, 7_130, "/总结群聊", 29_001),
      harness.gateway
    );
    expect(harness.store.getActiveEvent(replyDebounceSessionId(command), "reply_debounce"))
      .toBeDefined();
    await delay(40);
    expect(replyWithGroupChatSummary).not.toHaveBeenCalled();
    await targetStarted.promise;

    const late = parseOneBotInboundMessage(
      groupEvent(31_131, 7_130, "late after summary handoff", 29_002)
    )!;
    harness.runtime.recordIncomingMessage(late);
    releaseTarget.resolve();
    await waitUntil(() => replyWithGroupChatSummary.mock.calls.length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(replyWithGroupChatSummary).toHaveBeenCalledOnce();
    expect(replyWithGroupChatSummary.mock.calls[0]?.[6]).toBe(1);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(command))?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)).toEqual([
        "/总结群聊",
        "late after summary handoff"
      ]);
  });

  it.each([
    {
      label: "mention alias",
      text: "/总结群聊@Plana 最近三小时",
      configure: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.onebot.mentionNames = ["Plana"];
        config.persona.name = "另一人格";
      }
    },
    {
      label: "persona name",
      text: "/总结群聊@普拉娜 最近三小时",
      configure: (config: ReturnType<typeof createAdminTestConfig>) => {
        config.onebot.mentionNames = ["另一别名"];
        config.persona.name = "普拉娜";
      }
    }
  ])("keeps a command recognized by $label frozen across hot name changes", async ({
    text,
    configure
  }) => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      configure
    });
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    harness.runtime.replyWithGroupChatSummary = replyWithGroupChatSummary;
    const incoming = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_132, 7_132, text, 29_132),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(incoming);
    const active = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const frozenInvocation = decodeReplyDebounce(active.payload).commandInvocation;
    expect(frozenInvocation).toEqual({
      id: "group-summary",
      invokedName: "总结群聊",
      args: "最近三小时",
      rawText: text
    });

    harness.runtime.config.onebot.mentionNames = ["新别名"];
    harness.runtime.persona = { ...harness.runtime.persona!, name: "新人格" };
    harness.runtime.sessionCoordinator.reschedulePendingEvent(active.id, Date.now() + 30);
    harness.runtime.sessionCoordinator.resume();

    await waitUntil(() => replyWithGroupChatSummary.mock.calls.length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(replyWithGroupChatSummary).toHaveBeenCalledOnce();
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    const target = harness.store.listEvents(conversationRecordId(incoming))[0]!;
    expect(decodeIncomingReply(target.payload).commandInvocation).toEqual(frozenInvocation);
  });

  it("does not promote a frozen direct trigger when mention and persona names become enabled", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "direct route preserved"
    }), {
      replyDebounceMs: 60_000,
      configure(config) {
        config.onebot.mentionNames = ["旧别名"];
        config.persona.name = "旧人格";
      }
    });
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    harness.runtime.replyWithGroupChatSummary = replyWithGroupChatSummary;
    const incoming = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_134, "/总结群聊@未来名 最近三小时"),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(incoming);
    const active = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const activePayload = decodeReplyDebounce(active.payload);
    expect(activePayload.route).toBe("direct");
    expect(activePayload.commandInvocation).toBeUndefined();
    expect(Object.hasOwn(activePayload, "commandInvocation")).toBe(false);

    harness.runtime.config.onebot.mentionNames = ["未来名"];
    harness.runtime.persona = { ...harness.runtime.persona!, name: "未来名" };
    harness.runtime.sessionCoordinator.reschedulePendingEvent(active.id, Date.now() + 30);
    harness.runtime.sessionCoordinator.resume();

    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(replyWithGroupChatSummary).not.toHaveBeenCalled();
    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentOutbounds(harness.gateway).map((message) => message.text))
      .toEqual(["direct route preserved"]);
    const target = harness.store.listEvents(conversationRecordId(incoming))[0]!;
    const targetPayload = decodeIncomingReply(target.payload);
    expect(targetPayload.route).toBe("direct");
    expect(targetPayload.commandInvocation).toBeUndefined();
    expect(Object.hasOwn(targetPayload, "commandInvocation")).toBe(false);
  });

  it("fails closed before Provider or command dispatch for an unknown frozen command id", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "must not run"
    }));
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    harness.runtime.replyWithGroupChatSummary = replyWithGroupChatSummary;
    const incoming = parseOneBotInboundMessage(
      groupEvent(31_133, 7_133, "/总结群聊", 29_133)
    )!;
    const conversationId = conversationRecordId(incoming);
    harness.runtime.activeGateway = harness.gateway;
    harness.runtime.recordIncomingMessage(incoming, { persist: false });
    const payload = decodeIncomingReply(incomingReplyEnvelope({
      type: "incoming_reply",
      route: "command",
      incoming: queueIncomingSnapshot(incoming),
      captureSequence: 1,
      contextThroughSequence: 1,
      replyGate: harness.runtime.replyGates.capture(incoming.scope, conversationId),
      replyQuote: { enabled: true, replyToMessageId: incoming.messageId! },
      commandInvocation: {
        id: "forged-command",
        invokedName: "总结群聊",
        args: "",
        rawText: incoming.text
      }
    }, {
      conversationId,
      correlationId: "onebot:31133"
    }));

    await expect(harness.runtime.processIncomingReplyEvent(
      { sessionId: conversationId } as never,
      payload,
      new AbortController().signal
    )).rejects.toThrow("Unknown command id: forged-command");

    expect(replyWithGroupChatSummary).not.toHaveBeenCalled();
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    expect(sentOutbounds(harness.gateway)).toEqual([]);
  });

  it("fails closed at intake when a matched command exceeds durable limits", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "must not run"
    }));
    const replyWithGroupChatSummary = vi.fn(async () => undefined);
    harness.runtime.replyWithGroupChatSummary = replyWithGroupChatSummary;
    const incoming = parseOneBotInboundMessage(privateEvent(
      31_135,
      `/总结群聊 ${"a".repeat(MAX_COMMAND_INVOCATION_ARGS_CHARACTERS + 1)}`
    ))!;

    await expect(harness.runtime.handleInboundMessage(incoming, harness.gateway))
      .rejects.toThrow(/exceeds durable limits/i);

    expect(harness.store.getActiveEvent(replyDebounceSessionId(incoming), "reply_debounce"))
      .toBeUndefined();
    expect(harness.store.listEvents(conversationRecordId(incoming))).toEqual([]);
    expect(replyWithGroupChatSummary).not.toHaveBeenCalled();
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    expect(sentOutbounds(harness.gateway)).toEqual([]);
  });

  it("interrupts a running source handoff after a deadline bump and replies exactly once", async () => {
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "race reply once"
    }), { replyDebounceMs: 140 });
    const firstRunning = deferred<void>();
    const releaseFirst = deferred<void>();
    const processReplyDebounceEvent = harness.runtime.processReplyDebounceEvent.bind(harness.runtime);
    let attempts = 0;
    harness.runtime.processReplyDebounceEvent = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        firstRunning.resolve();
        await releaseFirst.promise;
      }
      return processReplyDebounceEvent(...args);
    };
    const first = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_140, "running handoff first"),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(first);

    await firstRunning.promise;
    const running = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(running.status).toBe("running");
    await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_141, "running handoff bump"),
      harness.gateway
    );
    const bumped = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(bumped.status).toBe("running");
    expect(bumped.availableAt).toBeGreaterThan(running.availableAt);
    expect(decodeReplyDebounce(bumped.payload).followUps).toEqual([
      expect.objectContaining({
        captureSequence: 2,
        incoming: expect.objectContaining({ messageId: 31_141, text: "running handoff bump" })
      })
    ]);
    releaseFirst.resolve();

    await waitUntil(() => harness.store.listTurns(debounceSessionId)[0]?.status === "interrupted");
    expect(harness.completeRequestTurn).not.toHaveBeenCalled();
    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    const conversationId = conversationRecordId(first);
    expect(attempts).toBe(2);
    expect(harness.store.listTurns(debounceSessionId).map((turn) => turn.status)).toEqual([
      "interrupted",
      "no_reply"
    ]);
    expect(harness.store.listEvents(conversationId).filter((event) => event.kind === "incoming_reply"))
      .toHaveLength(1);
    expect(harness.completeRequestTurn).toHaveBeenCalledOnce();
    expect(harness.store.listOutbox(conversationId)).toHaveLength(1);
    expect(sentOutbounds(harness.gateway).map((message) => message.text)).toEqual(["race reply once"]);
    expect(harness.runtime.conversationRecords.get(conversationId)?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)).toEqual(["running handoff first", "running handoff bump"]);
  });

  it("freezes text, image, attachment, and Thread context at the debounce handoff boundary", async () => {
    const requests: RenderedPromptRequest[] = [];
    const providerOptions: ProviderCompleteOptions[] = [];
    const buildModelContext = vi.fn(async (attachments) => ({
      text: "READY_ATTACHMENT_CONTEXT",
      localImagePaths: ["/isolated/ready-attachment.png"],
      attachments
    }));
    const attachmentService = { buildModelContext } as unknown as AttachmentService;
    const harness = createRuntimeHarness(async (request, options) => {
      requests.push(request);
      if (options) providerOptions.push(options);
      return { kind: "completed", text: "bounded multimodal reply" };
    }, {
      attachmentService,
      replyDebounceMs: 120
    });
    const prepareGroupThreadContext = vi.fn(async () => undefined);
    harness.runtime.prepareGroupThreadContext = prepareGroupThreadContext;
    harness.runtime.prepareIncomingMessage = async (incoming) => {
      incoming.attachments = incoming.attachments.map((attachment) => ({
        ...attachment,
        status: "ready" as const,
        cacheKey: `ready:${attachment.id}`
      }));
    };
    const targetStarted = deferred<void>();
    const releaseTarget = deferred<void>();
    const processIncomingReplyEvent = harness.runtime.processIncomingReplyEvent.bind(harness.runtime);
    harness.runtime.processIncomingReplyEvent = async (...args) => {
      targetStarted.resolve();
      await releaseTarget.promise;
      return processIncomingReplyEvent(...args);
    };

    await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_150, 7_150, "Plana multimodal boundary trigger", 30_001),
      harness.gateway
    );
    await delay(20);
    const followup = groupEvent(31_151, 7_150, "unused", 30_001);
    followup.message = [
      { type: "text", data: { text: "followup text with media" } },
      { type: "image", data: { url: "https://example.test/followup.png" } },
      { type: "file", data: { name: "boundary.txt", file_id: "boundary-file" } }
    ];
    await handleOneBotEvent(harness.runtime, followup, harness.gateway);
    await targetStarted.promise;

    const lateEvent = groupEvent(31_152, 7_150, "unused", 30_002);
    lateEvent.message = [
      { type: "text", data: { text: "late outside frozen boundary" } },
      { type: "image", data: { url: "https://example.test/late.png" } }
    ];
    const late = parseOneBotInboundMessage(lateEvent)!;
    harness.runtime.recordIncomingMessage(late);
    releaseTarget.resolve();
    await waitUntil(() => sentOutbounds(harness.gateway).length === 1);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(prepareGroupThreadContext).toHaveBeenCalledOnce();
    expect(prepareGroupThreadContext.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      captureSequence: 1,
      contextThroughSequence: 2
    }));
    const followupHistory = requests[0]!.messages.find((message) => (
      message.content.includes("followup text with media")
    ));
    expect(followupHistory?.imageUrls).toContain("https://example.test/followup.png");
    expect(requests[0]!.messages.some((message) => (
      message.content.includes("late outside frozen boundary")
    ))).toBe(false);
    const currentUser = [...requests[0]!.messages].reverse()
      .find((message) => message.role === "user")!;
    const providerContent = requests[0]!.messages.map((message) => message.content).join("\n");
    expect(providerContent.indexOf("Plana multimodal boundary trigger"))
      .toBeLessThan(providerContent.indexOf("followup text with media"));
    expect(providerContent.match(/Plana multimodal boundary trigger/g)).toHaveLength(1);
    expect(providerContent.match(/followup text with media/g)).toHaveLength(1);
    expect(currentUser.content).toContain("READY_ATTACHMENT_CONTEXT");
    expect(currentUser.imageUrls).toContain("https://example.test/followup.png");
    expect(currentUser.localImagePaths).toContain("/isolated/ready-attachment.png");
    expect(providerOptions[0]?.selfie?.referenceImageUrls)
      .toContain("https://example.test/followup.png");
    expect(providerOptions[0]?.selfie?.referenceImageUrls)
      .not.toContain("https://example.test/late.png");
    expect(buildModelContext).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "boundary.txt", status: "ready" })],
      expect.any(String)
    );
  });

  it("recovers atomically bumped follow-up text and attachment after a crash before conversation recording", async () => {
    const runtimeRoot = path.join(
      testDataRoot,
      `followup-crash-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const before = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "old runtime must not reply"
    }), {
      replyDebounceMs: 450,
      runtimeRoot,
      storeOptions: { databasePath }
    });
    const trigger = await handleOneBotEvent(
      before.runtime,
      privateEvent(31_160, "durable trigger before follow-up crash"),
      before.gateway
    );
    before.runtime.recoverReplyDebounceMessages = () => {
      throw new Error("injected crash after atomic follow-up update");
    };
    const followUpEvent = privateEvent(31_161, "unused");
    followUpEvent.message = [
      { type: "text", data: { text: "durable follow-up with attachment" } },
      { type: "image", data: { url: "https://example.test/durable-followup.png" } },
      { type: "file", data: { name: "durable.txt", file_id: "durable-file" } }
    ];
    await expect(handleOneBotEvent(before.runtime, followUpEvent, before.gateway))
      .rejects.toThrow("injected crash after atomic follow-up update");

    const debounceSessionId = replyDebounceSessionId(trigger);
    const bumped = before.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const durablePayload = decodeReplyDebounce(bumped.payload);
    expect(durablePayload.followUps).toEqual([
      expect.objectContaining({
        captureSequence: 2,
        incoming: expect.objectContaining({
          messageId: 31_161,
          text: "durable follow-up with attachment",
          attachments: [expect.objectContaining({ name: "durable.txt" })]
        })
      })
    ]);
    disposeRuntimeHarness(before);

    const requests: RenderedPromptRequest[] = [];
    const after = createRuntimeHarness(async (request) => {
      requests.push(request);
      return { kind: "completed", text: "recovered durable follow-up once" };
    }, {
      replyDebounceMs: 450,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" }
    });
    expect(after.runtime.conversationRecords.size).toBe(0);
    after.runtime.activeGateway = after.gateway;
    after.runtime.sessionCoordinator.resume();

    await waitUntil(() => sentOutbounds(after.gateway).length === 1);
    await after.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    const recovered = after.runtime.conversationRecords.get(conversationRecordId(trigger));
    expect(recovered?.messages.filter((message) => message.role === "user").map((message) => ({
      sequence: message.sequence,
      text: message.text,
      attachments: message.attachments?.map((attachment) => attachment.name)
    }))).toEqual([
      { sequence: 1, text: "durable trigger before follow-up crash", attachments: [] },
      { sequence: 2, text: "durable follow-up with attachment", attachments: ["durable.txt"] }
    ]);
    const providerContent = requests[0]!.messages.map((message) => message.content).join("\n");
    expect(providerContent.indexOf("durable trigger before follow-up crash"))
      .toBeLessThan(providerContent.indexOf("durable follow-up with attachment"));
    expect(providerContent.match(/durable trigger before follow-up crash/g)).toHaveLength(1);
    expect(providerContent.match(/durable follow-up with attachment/g)).toHaveLength(1);
    expect(after.completeRequestTurn).toHaveBeenCalledOnce();
    expect(sentOutbounds(after.gateway).map((message) => message.text))
      .toEqual(["recovered durable follow-up once"]);
  });

  it("globally materializes A1, B2, and durable A3 before another sender can claim a sequence", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 900
    });
    const originalRecordIncoming = harness.runtime.recordIncomingMessage.bind(harness.runtime);
    let injectFailure = true;
    harness.runtime.recordIncomingMessage = (incoming, options) => {
      if (incoming.messageId === 31_170 && injectFailure) {
        injectFailure = false;
        throw new Error("injected crash after trigger queue commit");
      }
      return originalRecordIncoming(incoming, options);
    };
    const triggerEvent = groupEvent(31_170, 7_170, "Plana committed trigger", 41_001);
    await expect(handleOneBotEvent(harness.runtime, triggerEvent, harness.gateway))
      .rejects.toThrow("injected crash after trigger queue commit");
    harness.runtime.recordIncomingMessage = originalRecordIncoming;

    const trigger = parseOneBotInboundMessage(triggerEvent)!;
    const debounceSessionId = replyDebounceSessionId(trigger);
    const senderBEvent = groupEvent(31_171, 7_170, "unused", 41_002);
    senderBEvent.message = [
      { type: "text", data: { text: "Plana sender B trigger" } },
      { type: "image", data: { url: "https://example.test/b2.png" } },
      { type: "file", data: { name: "b2.txt", file_id: "b2-file" } }
    ];
    await handleOneBotEvent(
      harness.runtime,
      senderBEvent,
      harness.gateway
    );
    const followUpEvent = groupEvent(31_172, 7_170, "unused", 41_001);
    followUpEvent.message = [
      { type: "text", data: { text: "sender A durable follow-up" } },
      { type: "image", data: { url: "https://example.test/a3.png" } },
      { type: "file", data: { name: "a3.txt", file_id: "a3-file" } }
    ];
    await handleOneBotEvent(harness.runtime, followUpEvent, harness.gateway);
    const deadline = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!.availableAt;

    harness.runtime.conversationRecords.clear();
    harness.runtime.recoverActiveReplyDebounceConversation(trigger);
    const messages = harness.runtime.conversationRecords.get(conversationRecordId(trigger))!.messages
      .filter((message) => message.role === "user");
    expect(messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      text: message.text,
      images: message.imageUrls,
      attachments: message.attachments?.map((attachment) => attachment.name)
    }))).toEqual([
      {
        id: "31170",
        sequence: 1,
        text: "Plana committed trigger",
        images: [],
        attachments: []
      },
      {
        id: "31171",
        sequence: 2,
        text: "Plana sender B trigger",
        images: ["https://example.test/b2.png"],
        attachments: ["b2.txt"]
      },
      {
        id: "31172",
        sequence: 3,
        text: "sender A durable follow-up",
        images: ["https://example.test/a3.png"],
        attachments: ["a3.txt"]
      }
    ]);

    harness.runtime.seenIncomingEvents.clear();
    await handleOneBotEvent(harness.runtime, triggerEvent, harness.gateway);
    expect(harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!.availableAt)
      .toBe(deadline);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(trigger))!.messages
      .filter((message) => message.role === "user")).toHaveLength(3);
  });

  it("keeps the first route and stores ordered multimodal follow-up snapshots without duplicates", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 900
    });
    const trigger = await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_180, 7_180, "Plana fixed direct route", 42_001),
      harness.gateway
    );
    const commandFollowUp = groupEvent(31_181, 7_180, "unused", 42_001);
    commandFollowUp.message = [
      { type: "text", data: { text: "/总结群聊" } },
      { type: "image", data: { url: "https://example.test/ordered-one.png" } },
      { type: "file", data: { name: "ordered-one.txt", file_id: "ordered-one" } }
    ];
    await handleOneBotEvent(harness.runtime, commandFollowUp, harness.gateway);
    await handleOneBotEvent(
      harness.runtime,
      groupEvent(31_182, 7_180, "second ordered follow-up", 42_001),
      harness.gateway
    );

    const debounceSessionId = replyDebounceSessionId(trigger);
    const active = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const decoded = decodeReplyDebounce(active.payload);
    expect(decoded.route).toBe("direct");
    expect(decoded.followUps?.map((followUp) => ({
      sequence: followUp.captureSequence,
      messageId: followUp.incoming.messageId,
      text: followUp.incoming.text,
      images: followUp.incoming.media.map((asset) => asset.url),
      attachments: followUp.incoming.attachments.map((attachment) => attachment.name)
    }))).toEqual([
      {
        sequence: 2,
        messageId: 31_181,
        text: "/总结群聊",
        images: ["https://example.test/ordered-one.png"],
        attachments: ["ordered-one.txt"]
      },
      {
        sequence: 3,
        messageId: 31_182,
        text: "second ordered follow-up",
        images: [],
        attachments: []
      }
    ]);

    const beforeReplayDeadline = active.availableAt;
    harness.runtime.seenIncomingEvents.clear();
    await handleOneBotEvent(harness.runtime, commandFollowUp, harness.gateway);
    const replayed = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(replayed.availableAt).toBe(beforeReplayDeadline);
    expect(decodeReplyDebounce(replayed.payload).followUps).toHaveLength(2);
  });

  it("rejects a debounce event stored under a synthetic session for another sender", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 900
    });
    const incoming = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_190, "synthetic session guard"),
      harness.gateway
    );
    const event = harness.store.getActiveEvent(replyDebounceSessionId(incoming), "reply_debounce")!;

    await expect(harness.runtime.processReplyDebounceEvent({
      ...event,
      sessionId: `${event.sessionId}:wrong-sender`
    }, event.payload, new AbortController().signal)).rejects.toThrow("防抖事件 Session 不匹配");
  });

  it("merges stale concurrent B and C follow-up updates with payload CAS and keeps duplicates inert", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 900
    });
    const trigger = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_195, "CAS trigger"),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(trigger);
    const stale = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const followUpB = parseOneBotInboundMessage(privateEvent(31_196, "concurrent B"))!;
    const followUpCEvent = privateEvent(31_197, "unused");
    followUpCEvent.message = [
      { type: "text", data: { text: "concurrent C" } },
      { type: "image", data: { url: "https://example.test/concurrent-c.png" } },
      { type: "file", data: { name: "concurrent-c.txt", file_id: "concurrent-c" } }
    ];
    const followUpC = parseOneBotInboundMessage(followUpCEvent)!;

    expect(harness.runtime.bumpReplyDebounce(stale, followUpB).status).toBe("updated");
    expect(harness.runtime.bumpReplyDebounce(stale, followUpC).status).toBe("updated");
    const merged = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(decodeReplyDebounce(merged.payload).followUps?.map((followUp) => ({
      sequence: followUp.captureSequence,
      messageId: followUp.incoming.messageId,
      text: followUp.incoming.text,
      images: followUp.incoming.media.map((asset) => asset.url),
      attachments: followUp.incoming.attachments.map((attachment) => attachment.name)
    }))).toEqual([
      {
        sequence: 2,
        messageId: 31_196,
        text: "concurrent B",
        images: [],
        attachments: []
      },
      {
        sequence: 3,
        messageId: 31_197,
        text: "concurrent C",
        images: ["https://example.test/concurrent-c.png"],
        attachments: ["concurrent-c.txt"]
      }
    ]);

    const mergedDeadline = merged.availableAt;
    expect(harness.runtime.bumpReplyDebounce(stale, followUpB).status).toBe("duplicate");
    const duplicate = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(duplicate.availableAt).toBe(mergedDeadline);
    expect(decodeReplyDebounce(duplicate.payload).followUps).toHaveLength(2);
  });

  it("bounds seventy durable follow-ups, fails closed on an evicted gap, and reopens complete business context", async () => {
    const runtimeRoot = path.join(
      testDataRoot,
      `bounded-followups-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const before = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "old runtime must not reply"
    }), {
      replyDebounceMs: 10_000,
      runtimeRoot,
      storeOptions: { databasePath },
      persistConversations: true
    });
    before.runtime.prepareIncomingMessage = async (incoming) => {
      incoming.attachments = incoming.attachments.map((attachment) => ({
        ...attachment,
        status: "ready" as const,
        cacheKey: `ready:${attachment.id}`
      }));
    };
    const triggerMarker = "window-trigger|";
    const trigger = await handleOneBotEvent(
      before.runtime,
      privateEvent(32_000, triggerMarker),
      before.gateway
    );
    const followUpMarkers = Array.from({ length: 70 }, (_, index) => (
      `window-item-${String(index + 1).padStart(3, "0")}|`
    ));
    const recoverReplyDebounceMessages = before.runtime.recoverReplyDebounceMessages.bind(before.runtime);
    let crashAfterBoundedTailUpdate = true;
    before.runtime.recoverReplyDebounceMessages = (payload) => {
      if (
        crashAfterBoundedTailUpdate &&
        payload.followUps?.at(-1)?.incoming.messageId === 32_070
      ) {
        crashAfterBoundedTailUpdate = false;
        throw new Error("injected crash after bounded tail update");
      }
      return recoverReplyDebounceMessages(payload);
    };
    for (const [index, marker] of followUpMarkers.entries()) {
      const event = privateEvent(32_001 + index, marker);
      if (index === followUpMarkers.length - 1) {
        event.message = [
          { type: "text", data: { text: marker } },
          { type: "image", data: { url: "https://example.test/tail-window.png" } },
          { type: "file", data: { name: "tail-window.txt", file_id: "tail-window" } }
        ];
      }
      const handled = handleOneBotEvent(before.runtime, event, before.gateway);
      if (index === followUpMarkers.length - 1) {
        await expect(handled).rejects.toThrow("injected crash after bounded tail update");
      } else {
        await handled;
      }
    }
    await delay(20);

    const debounceSessionId = replyDebounceSessionId(trigger);
    const pending = before.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const boundedPayload = decodeReplyDebounce(pending.payload);
    expect(boundedPayload.followUps).toHaveLength(MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS);
    expect(boundedPayload.followUps?.at(0)?.captureSequence).toBe(8);
    expect(boundedPayload.followUps?.at(-1)).toEqual(expect.objectContaining({
      captureSequence: 71,
      incoming: expect.objectContaining({
        messageId: 32_070,
        text: "window-item-070|",
        attachments: [expect.objectContaining({ name: "tail-window.txt" })]
      })
    }));
    expect(before.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .filter((message) => message.role === "user")).toHaveLength(70);

    before.runtime.conversationRecords.clear();
    expect(() => before.runtime.recoverReplyDebounceMessages(boundedPayload))
      .toThrow("防抖事件上下文缺少序列：期望 2，收到 8");
    disposeRuntimeHarness(before);
    closeApplicationDataStores();

    const requests: RenderedPromptRequest[] = [];
    const providerOptions: ProviderCompleteOptions[] = [];
    const buildModelContext = vi.fn(async (attachments) => ({
      text: "TAIL_ATTACHMENT_CONTEXT",
      localImagePaths: ["/isolated/tail-window.png"],
      attachments
    }));
    const after = createRuntimeHarness(async (request, options) => {
      requests.push(request);
      if (options) providerOptions.push(options);
      return { kind: "completed", text: "bounded window recovered once" };
    }, {
      replyDebounceMs: 10_000,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" },
      attachmentService: { buildModelContext } as unknown as AttachmentService,
      persistConversations: true,
      loadPersistedConversations: true
    });
    after.runtime.prepareIncomingMessage = async (incoming) => {
      incoming.attachments = incoming.attachments.map((attachment) => ({
        ...attachment,
        status: "ready" as const,
        cacheKey: `recovered:${attachment.id}`
      }));
    };
    const recoveredRecord = after.runtime.conversationRecords.get(conversationRecordId(trigger));
    expect(recoveredRecord?.messages.filter((message) => message.role === "user"))
      .toHaveLength(70);
    after.runtime.activeGateway = after.gateway;
    const recoveredEvent = after.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    after.runtime.sessionCoordinator.reschedulePendingEvent(recoveredEvent.id, Date.now() + 30);
    after.runtime.sessionCoordinator.resume();

    await waitUntil(() => sentOutbounds(after.gateway).length === 1);
    await after.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 5_000 });
    expect(recoveredRecord?.messages.filter((message) => message.role === "user"))
      .toHaveLength(71);

    const providerContent = requests[0]!.messages.map((message) => message.content).join("\n");
    const orderedMarkers = [triggerMarker, ...followUpMarkers];
    let previousIndex = -1;
    for (const marker of orderedMarkers) {
      const currentIndex = providerContent.indexOf(marker);
      expect(currentIndex).toBeGreaterThan(previousIndex);
      expect(providerContent.split(marker)).toHaveLength(2);
      previousIndex = currentIndex;
    }
    const currentUser = [...requests[0]!.messages].reverse()
      .find((message) => message.role === "user")!;
    expect(currentUser.content).toContain("TAIL_ATTACHMENT_CONTEXT");
    expect(currentUser.imageUrls).toContain("https://example.test/tail-window.png");
    expect(currentUser.localImagePaths).toContain("/isolated/tail-window.png");
    expect(providerOptions[0]?.selfie?.referenceImageUrls)
      .toContain("https://example.test/tail-window.png");
    expect(buildModelContext).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "tail-window.txt", status: "ready" })],
      expect.any(String)
    );
    expect(decodeReplyDebounce(after.store.listEvents(debounceSessionId)[0]!.payload).followUps)
      .toHaveLength(MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS);
    expect(after.completeRequestTurn).toHaveBeenCalledOnce();
  });

  it("leaves the full 64-item tail and deadline unchanged when the next strict snapshot upsert fails", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 10_000
    });
    const trigger = await handleOneBotEvent(
      harness.runtime,
      privateEvent(33_000, "strict failure trigger"),
      harness.gateway
    );
    for (let index = 1; index <= MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS; index += 1) {
      await handleOneBotEvent(
        harness.runtime,
        privateEvent(33_000 + index, `strict retained follow-up ${index}`),
        harness.gateway
      );
    }
    const debounceSessionId = replyDebounceSessionId(trigger);
    const before = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const beforePayload = decodeReplyDebounce(before.payload);
    expect(beforePayload.followUps).toHaveLength(MAX_RUNTIME_REPLY_FOLLOW_UP_SNAPSHOTS);
    expect(beforePayload.followUps?.at(-1)?.incoming.messageId).toBe(33_064);

    const strictUpsert = vi.spyOn(harness.runtime, "persistConversationRecordStrict")
      .mockImplementation(() => {
        throw new Error("injected strict conversation upsert failure");
      });
    await expect(handleOneBotEvent(
      harness.runtime,
      privateEvent(33_065, "must not evict the durable tail"),
      harness.gateway
    )).rejects.toThrow("injected strict conversation upsert failure");

    const after = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(strictUpsert).toHaveBeenCalledOnce();
    expect(after.availableAt).toBe(before.availableAt);
    expect(after.payload).toEqual(before.payload);
    expect(decodeReplyDebounce(after.payload).followUps?.at(-1)?.incoming.messageId).toBe(33_064);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .some((message) => message.id === "33065")).toBe(false);
  });

  it("does not mark another sender seen when strict active-conversation persistence fails", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      persistConversations: true
    });
    const trigger = await handleOneBotEvent(
      harness.runtime,
      groupEvent(33_100, 8_100, "Plana strict retry trigger", 60_001),
      harness.gateway
    );
    const debounceSessionId = replyDebounceSessionId(trigger);
    const initialEvent = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    const otherSenderEvent = groupEvent(33_101, 8_100, "ordinary context from sender B", 60_002);
    delete otherSenderEvent.message_id;
    const otherSender = parseOneBotInboundMessage(otherSenderEvent)!;
    const otherSenderKey = persistentIncomingKey(otherSender);
    const persistStrict = harness.runtime.persistConversationRecordStrict.bind(harness.runtime);
    let strictCalls = 0;
    const strictUpsert = vi.spyOn(harness.runtime, "persistConversationRecordStrict")
      .mockImplementation((record) => {
        strictCalls += 1;
        if (strictCalls === 2) throw new Error("injected ambient strict upsert failure");
        return persistStrict(record);
      });

    await expect(handleOneBotEvent(harness.runtime, otherSenderEvent, harness.gateway))
      .rejects.toThrow("injected ambient strict upsert failure");

    const failedEvent = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(strictUpsert).toHaveBeenCalledTimes(2);
    expect(harness.runtime.seenIncomingEvents.has(otherSenderKey)).toBe(false);
    expect(failedEvent.availableAt).toBe(initialEvent.availableAt);
    expect(failedEvent.payload).toEqual(initialEvent.payload);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .filter((message) => message.role === "user")
      .map((message) => ({ text: message.text, sequence: message.sequence }))).toEqual([
        { text: "Plana strict retry trigger", sequence: 1 }
      ]);
    expect(applicationDataStore(harness.runtime.config).readConversations()
      .find((record) => record.id === conversationRecordId(trigger))?.messages
      .some((message) => message.text === "ordinary context from sender B")).toBe(false);

    await handleOneBotEvent(harness.runtime, otherSenderEvent, harness.gateway);

    const retriedEvent = harness.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(strictUpsert).toHaveBeenCalledTimes(4);
    expect(harness.runtime.seenIncomingEvents.has(otherSenderKey)).toBe(true);
    expect(retriedEvent.availableAt).toBe(initialEvent.availableAt);
    expect(retriedEvent.payload).toEqual(initialEvent.payload);
    expect(applicationDataStore(harness.runtime.config).readConversations()
      .find((record) => record.id === conversationRecordId(trigger))?.messages
      .filter((message) => message.role === "user")
      .map((message) => ({ text: message.text, sequence: message.sequence }))).toEqual([
        { text: "Plana strict retry trigger", sequence: 1 },
        { text: "ordinary context from sender B", sequence: 2 }
      ]);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .filter((message) => message.text === "ordinary context from sender B")).toHaveLength(1);
  });

  it("keeps another sender's queued candidate recoverable when strict persistence fails", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      persistConversations: true
    });
    const trigger = await handleOneBotEvent(
      harness.runtime,
      groupEvent(33_150, 8_150, "Plana existing sender trigger", 60_101),
      harness.gateway
    );
    const triggerSessionId = replyDebounceSessionId(trigger);
    const triggerEvent = harness.store.getActiveEvent(triggerSessionId, "reply_debounce")!;
    const candidateEvent = groupEvent(33_151, 8_150, "Plana candidate from sender B", 60_102);
    const candidate = parseOneBotInboundMessage(candidateEvent)!;
    const candidateKey = persistentIncomingKey(candidate);
    const persistStrict = harness.runtime.persistConversationRecordStrict.bind(harness.runtime);
    let strictCalls = 0;
    const strictUpsert = vi.spyOn(harness.runtime, "persistConversationRecordStrict")
      .mockImplementation((record) => {
        strictCalls += 1;
        if (strictCalls === 2) throw new Error("injected candidate strict upsert failure");
        return persistStrict(record);
      });

    await expect(handleOneBotEvent(harness.runtime, candidateEvent, harness.gateway))
      .rejects.toThrow("injected candidate strict upsert failure");

    const candidateSessionId = replyDebounceSessionId(candidate);
    const queuedCandidate = harness.store.getActiveEvent(candidateSessionId, "reply_debounce")!;
    expect(strictUpsert).toHaveBeenCalledTimes(2);
    expect(decodeReplyDebounce(queuedCandidate.payload).captureSequence).toBe(2);
    expect(harness.runtime.seenIncomingEvents.has(candidateKey)).toBe(false);
    expect(harness.store.getActiveEvent(triggerSessionId, "reply_debounce")?.availableAt)
      .toBe(triggerEvent.availableAt);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)).toEqual(["Plana existing sender trigger"]);

    await handleOneBotEvent(harness.runtime, candidateEvent, harness.gateway);

    expect(strictUpsert).toHaveBeenCalledTimes(3);
    expect(harness.runtime.seenIncomingEvents.has(candidateKey)).toBe(true);
    expect(harness.store.getActiveEvent(triggerSessionId, "reply_debounce")?.availableAt)
      .toBe(triggerEvent.availableAt);
    expect(harness.store.getActiveEvent(candidateSessionId, "reply_debounce")?.availableAt)
      .toBe(queuedCandidate.availableAt);
    expect(harness.store.listEvents(candidateSessionId)).toHaveLength(1);
    expect(harness.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .filter((message) => message.role === "user")
      .map((message) => ({ text: message.text, sequence: message.sequence }))).toEqual([
        { text: "Plana existing sender trigger", sequence: 1 },
        { text: "Plana candidate from sender B", sequence: 2 }
      ]);
  });

  it("re-prepares another id-less sender's attachment after restart without moving the trigger deadline", async () => {
    const runtimeRoot = path.join(
      testDataRoot,
      `other-sender-crash-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const before = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      runtimeRoot,
      storeOptions: { databasePath },
      persistConversations: true
    });
    const trigger = await handleOneBotEvent(
      before.runtime,
      groupEvent(33_200, 8_200, "Plana crash-safe trigger A", 61_001),
      before.gateway
    );
    const debounceSessionId = replyDebounceSessionId(trigger);
    const initialDeadline = before.store.getActiveEvent(
      debounceSessionId,
      "reply_debounce"
    )!.availableAt;
    const senderBEvent = groupEvent(33_201, 8_200, "unused", 61_002);
    Reflect.deleteProperty(senderBEvent, "message_id");
    senderBEvent.message = [
      { type: "text", data: { text: "crash-safe context B with attachment" } },
      { type: "image", data: { url: "https://example.test/sender-b-restart.png" } },
      { type: "file", data: { name: "sender-b-restart.txt", file_id: "sender-b-restart" } }
    ];
    const senderB = await handleOneBotEvent(before.runtime, senderBEvent, before.gateway);
    const senderBStoredId = before.runtime.conversationRecords
      .get(conversationRecordId(trigger))?.messages
      .find((message) => message.text === "crash-safe context B with attachment")?.id;
    expect(senderBStoredId).toMatch(/^content:v1:/);
    expect(before.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .find((message) => message.id === senderBStoredId)?.attachments)
      .toEqual([expect.objectContaining({ name: "sender-b-restart.txt", status: "pending" })]);
    expect(before.store.getActiveEvent(debounceSessionId, "reply_debounce")?.availableAt)
      .toBe(initialDeadline);
    expect(before.store.getActiveEvent(replyDebounceSessionId(senderB), "reply_debounce"))
      .toBeUndefined();
    disposeRuntimeHarness(before);
    closeApplicationDataStores();

    const requests: RenderedPromptRequest[] = [];
    const buildModelContext = vi.fn(async (attachments) => ({
      text: "SENDER_B_RESTART_ATTACHMENT_CONTEXT",
      localImagePaths: ["/isolated/sender-b-restart.png"],
      attachments
    }));
    const after = createRuntimeHarness(async (request) => {
      requests.push(request);
      return { kind: "completed", text: "crash-safe complete reply" };
    }, {
      replyDebounceMs: 60_000,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" },
      attachmentService: { buildModelContext } as unknown as AttachmentService,
      persistConversations: true,
      loadPersistedConversations: true
    });
    const prepareIncomingMessage = vi.fn(async (incoming) => {
      incoming.attachments = incoming.attachments.map((attachment) => ({
        ...attachment,
        status: "ready" as const,
        cacheKey: `restart:${attachment.id}`
      }));
    });
    after.runtime.prepareIncomingMessage = prepareIncomingMessage;
    const recovered = after.runtime.conversationRecords.get(conversationRecordId(trigger));
    expect(recovered?.messages.filter((message) => message.role === "user").map((message) => ({
      id: message.id,
      sequence: message.sequence,
      text: message.text
    }))).toEqual([
      { id: "33200", sequence: 1, text: "Plana crash-safe trigger A" },
      {
        id: senderBStoredId,
        sequence: 2,
        text: "crash-safe context B with attachment"
      }
    ]);
    const recoveredEvent = after.store.getActiveEvent(debounceSessionId, "reply_debounce")!;
    expect(recoveredEvent.availableAt).toBe(initialDeadline);
    expect(after.store.getActiveEvent(replyDebounceSessionId(senderB), "reply_debounce"))
      .toBeUndefined();

    after.runtime.activeGateway = after.gateway;
    after.runtime.sessionCoordinator.reschedulePendingEvent(recoveredEvent.id, Date.now() + 30);
    after.runtime.sessionCoordinator.resume();
    await waitUntil(() => sentOutbounds(after.gateway).length === 1);
    await after.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    const providerContent = requests[0]!.messages.map((message) => message.content).join("\n");
    expect(providerContent.indexOf("Plana crash-safe trigger A"))
      .toBeLessThan(providerContent.indexOf("crash-safe context B with attachment"));
    expect(providerContent.match(/Plana crash-safe trigger A/g)).toHaveLength(1);
    expect(providerContent.match(/crash-safe context B with attachment/g)).toHaveLength(1);
    expect(providerContent).toContain("SENDER_B_RESTART_ATTACHMENT_CONTEXT");
    expect(requests[0]!.messages.at(-1)?.imageUrls)
      .toContain("https://example.test/sender-b-restart.png");
    const preparedSenderB = prepareIncomingMessage.mock.calls
      .find(([incoming]) => incoming.userId === 61_002)?.[0];
    expect(preparedSenderB).toEqual(expect.objectContaining({
      userId: 61_002,
      attachments: [expect.objectContaining({ name: "sender-b-restart.txt" })]
    }));
    expect(preparedSenderB?.messageId).toBeUndefined();
    expect(Object.hasOwn(preparedSenderB!, "messageId")).toBe(false);
    expect(buildModelContext).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "sender-b-restart.txt", status: "ready" })],
      expect.any(String)
    );
    expect(after.runtime.conversationRecords.get(conversationRecordId(trigger))?.messages
      .find((message) => message.id === senderBStoredId)?.attachments)
      .toEqual([expect.objectContaining({ name: "sender-b-restart.txt", status: "ready" })]);
    expect(after.completeRequestTurn).toHaveBeenCalledOnce();
  });

  it("does not duplicate a completed id-less source when the same event is redelivered after restart", async () => {
    const runtimeRoot = path.join(
      testDataRoot,
      `idless-complete-redelivery-${process.pid}-${++runtimeRootSequence}`
    );
    const databasePath = path.join(runtimeRoot, "data", "session-queue.sqlite");
    const event = privateEvent(33_250, "completed id-less source");
    Reflect.deleteProperty(event, "message_id");
    const before = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "completed once"
    }), {
      replyDebounceMs: 30,
      runtimeRoot,
      storeOptions: { databasePath },
      persistConversations: true
    });
    const first = await handleOneBotEvent(before.runtime, event, before.gateway);
    await waitUntil(() => sentOutbounds(before.gateway).length === 1);
    await before.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });
    const conversationId = conversationRecordId(first);
    const firstUserMessage = before.runtime.conversationRecords.get(conversationId)?.messages
      .find((message) => message.role === "user")!;
    expect(firstUserMessage.id).toMatch(/^content:v1:/);
    expect(before.completeRequestTurn).toHaveBeenCalledOnce();
    disposeRuntimeHarness(before);
    closeApplicationDataStores();

    const after = createRuntimeHarness(async () => ({
      kind: "completed",
      text: "must not run twice"
    }), {
      replyDebounceMs: 30,
      runtimeRoot,
      storeOptions: { databasePath, recoverOnOpen: "all" },
      persistConversations: true,
      loadPersistedConversations: true
    });
    const prepareIncomingMessage = vi.fn(async () => undefined);
    const scheduleMemoryCompression = vi.fn();
    const enqueueConversationMemory = vi.fn(async () => undefined);
    after.runtime.prepareIncomingMessage = prepareIncomingMessage;
    after.runtime.scheduleMemoryCompression = scheduleMemoryCompression;
    after.runtime.enqueueConversationMemory = enqueueConversationMemory;

    const redelivered = await handleOneBotEvent(after.runtime, event, after.gateway);
    await delay(80);

    expect(persistentIncomingKey(redelivered)).toBe(persistentIncomingKey(first));
    expect(after.completeRequestTurn).not.toHaveBeenCalled();
    expect(sentOutbounds(after.gateway)).toEqual([]);
    expect(prepareIncomingMessage).toHaveBeenCalledOnce();
    expect(scheduleMemoryCompression).not.toHaveBeenCalled();
    expect(enqueueConversationMemory).not.toHaveBeenCalled();
    const userMessages = after.runtime.conversationRecords.get(conversationId)?.messages
      .filter((message) => message.role === "user");
    expect(userMessages).toEqual([expect.objectContaining({
      id: firstUserMessage.id,
      text: "completed id-less source"
    })]);
    expect(applicationDataStore(after.runtime.config).readConversations()
      .find((record) => record.id === conversationId)?.messages
      .filter((message) => message.role === "user"))
      .toEqual([expect.objectContaining({ id: firstUserMessage.id })]);
  });

  it("keeps active debounce, frozen source and callback, and deferred jobs outside top eighty", async () => {
    const harness = createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      replyDebounceMs: 60_000,
      persistConversations: true
    });
    const activeDebounce = await handleOneBotEvent(
      harness.runtime,
      privateEvent(34_000, "old active debounce"),
      harness.gateway
    );
    const frozenSource = parseOneBotInboundMessage(
      groupEvent(34_001, 8_001, "old frozen source", 51_001)
    )!;
    const frozenCallback = parseOneBotInboundMessage(
      groupEvent(34_002, 8_002, "old frozen callback", 51_002)
    )!;
    const queuedDeferred = parseOneBotInboundMessage(
      groupEvent(34_003, 8_003, "old queued deferred", 51_003)
    )!;
    const runningDeferred = parseOneBotInboundMessage(
      groupEvent(34_004, 8_004, "old running deferred", 51_004)
    )!;
    for (const incoming of [frozenSource, frozenCallback, queuedDeferred, runningDeferred]) {
      harness.runtime.recordIncomingMessage(incoming, { persist: false });
    }

    const frozenSourceId = conversationRecordId(frozenSource);
    harness.runtime.sessionCoordinator.enqueueEvent({
      sessionId: frozenSourceId,
      kind: "incoming_reply",
      dedupeKey: "protected:frozen-source",
      payload: incomingReplyEnvelope({
        type: "incoming_reply",
        route: "direct",
        incoming: queueIncomingSnapshot(frozenSource),
        captureSequence: 1,
        contextThroughSequence: 1,
        replyGate: harness.runtime.replyGates.capture(frozenSource.scope, frozenSourceId),
        replyQuote: { enabled: true, replyToMessageId: frozenSource.messageId! }
      }, {
        conversationId: frozenSourceId,
        correlationId: "protected:frozen-source",
        idempotencyKey: "protected:frozen-source"
      })
    }, { schedule: false });

    const frozenCallbackId = conversationRecordId(frozenCallback);
    harness.runtime.sessionCoordinator.enqueueEvent({
      sessionId: frozenCallbackId,
      kind: "tool_completion",
      dedupeKey: "protected:frozen-callback",
      payload: toolCompletionEnvelope({
        type: "tool_result",
        toolJobId: "protected-tool-job",
        providerCallId: "protected-provider-call",
        toolName: "codex",
        originalRequest: {
          incoming: queueIncomingSnapshot(frozenCallback),
          captureSequence: 1,
          contextThroughSequence: 1,
          replyGate: harness.runtime.replyGates.capture(frozenCallback.scope, frozenCallbackId),
          replyQuote: { enabled: true, replyToMessageId: frozenCallback.messageId! }
        },
        arguments: {},
        outcome: { status: "succeeded", result: "done", error: null }
      }, {
        conversationId: frozenCallbackId,
        correlationId: "protected:frozen-callback",
        idempotencyKey: "protected:frozen-callback"
      })
    }, { schedule: false });

    const queuedDeferredId = conversationRecordId(queuedDeferred);
    const runningDeferredId = conversationRecordId(runningDeferred);
    vi.spyOn(harness.store, "listToolJobs").mockReturnValue([
      { sessionId: queuedDeferredId, status: "queued" },
      { sessionId: runningDeferredId, status: "running" }
    ] as ReturnType<SessionStore["listToolJobs"]>);

    const newerIds: string[] = [];
    for (let index = 0; index < 81; index += 1) {
      const incoming = parseOneBotInboundMessage(
        groupEvent(35_000 + index, 9_000 + index, `newer conversation ${index}`, 52_000 + index)
      )!;
      newerIds.push(conversationRecordId(incoming));
      harness.runtime.recordIncomingMessage(incoming, { persist: false });
    }

    const protectedIds = new Set([
      conversationRecordId(activeDebounce),
      frozenSourceId,
      frozenCallbackId,
      queuedDeferredId,
      runningDeferredId
    ]);
    expect(harness.runtime.protectedConversationIds()).toEqual(protectedIds);
    harness.runtime.persistConversationRecords();

    const persistedIds = new Set(
      applicationDataStore(harness.runtime.config).readConversations().map((record) => record.id)
    );
    expect(persistedIds.size).toBe(85);
    expect(persistedIds.has(newerIds[0]!)).toBe(false);
    for (const id of protectedIds) expect(persistedIds.has(id)).toBe(true);
  });

  it("starts a new debounce after source handoff while the first target remains exactly once", async () => {
    let providerCalls = 0;
    const harness = createRuntimeHarness(async () => ({
      kind: "completed",
      text: `handoff reply ${++providerCalls}`
    }), { replyDebounceMs: 100 });
    const firstTargetStarted = deferred<void>();
    const releaseFirstTarget = deferred<void>();
    const processIncomingReplyEvent = harness.runtime.processIncomingReplyEvent.bind(harness.runtime);
    let targetAttempts = 0;
    harness.runtime.processIncomingReplyEvent = async (...args) => {
      targetAttempts += 1;
      if (targetAttempts === 1) {
        firstTargetStarted.resolve();
        await releaseFirstTarget.promise;
      }
      return processIncomingReplyEvent(...args);
    };

    const first = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_200, "first handoff trigger"),
      harness.gateway
    );
    await firstTargetStarted.promise;
    const second = await handleOneBotEvent(
      harness.runtime,
      privateEvent(31_201, "new window after handoff"),
      harness.gateway
    );
    expect(harness.store.getActiveEvent(replyDebounceSessionId(second), "reply_debounce"))
      .toBeDefined();
    releaseFirstTarget.resolve();

    await waitUntil(() => sentOutbounds(harness.gateway).length === 2);
    await harness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(providerCalls).toBe(2);
    expect(targetAttempts).toBe(2);
    expect(sentOutbounds(harness.gateway).map((message) => ({
      replyToMessageId: message.replyToMessageId,
      text: message.text
    }))).toEqual([
      { replyToMessageId: first.messageId, text: "handoff reply 1" },
      { replyToMessageId: second.messageId, text: "handoff reply 2" }
    ]);
  });
});

function createRuntimeHarness(
  complete: (
    request: RenderedPromptRequest,
    options?: ProviderCompleteOptions
  ) => Promise<ProviderTurnResult>,
  options: {
    replyDebounceMs?: number;
    configure?: (config: ReturnType<typeof createAdminTestConfig>) => void;
    attachmentService?: AttachmentService;
    runtimeRoot?: string;
    storeOptions?: ConstructorParameters<typeof SessionStore>[0];
    persistConversations?: boolean;
    loadPersistedConversations?: boolean;
  } = {}
) {
  const store = new SessionStore(options.storeOptions ?? { databasePath: ":memory:" });
  stores.push(store);
  const runtimeRoot = options.runtimeRoot ?? path.join(
      testDataRoot,
      `runtime-${process.pid}-${++runtimeRootSequence}`
    );
  if (!runtimeRoots.includes(runtimeRoot)) runtimeRoots.push(runtimeRoot);
  const config = createAdminTestConfig(runtimeRoot);
  options.configure?.(config);
  const completeRequestTurn = vi.fn(complete);
  const provider = {
    completeRequestTurn,
    generateImage: vi.fn()
  } as unknown as OpenAIProvider;
  const runtime = new SunaRuntime(config, {
    attachmentService: options.attachmentService ?? {} as never,
    sessionStore: store,
    resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false }),
    ...(options.replyDebounceMs === undefined
      ? {}
      : { replyDebounceMs: options.replyDebounceMs })
  });
  runtimes.push(runtime);
  runtime.persona = {
    id: config.persona.defaultAgentId,
    name: config.persona.name,
    files: [],
    memoryItems: [],
    systemPrompt: "test system"
  };
  if (!options.loadPersistedConversations) runtime.conversationRecords.clear();
  runtime.getProvider = () => provider;
  runtime.prepareIncomingMessage = async () => undefined;
  runtime.scheduleAttachmentCacheRefresh = () => undefined;
  runtime.scheduleMemoryCompression = () => undefined;
  runtime.enqueueConversationMemory = async () => undefined;
  runtime.scheduleMemoryDrain = () => undefined;
  if (!options.persistConversations) runtime.persistConversationRecords = () => undefined;
  runtime.prepareGroupThreadContext = async () => undefined;
  runtime.renderPromptRequest = async (_id, variables) => ({
    messages: [
      { role: "system", content: "test system" },
      ...((variables["messages_64"] ?? []) as RenderedPromptRequest["messages"]),
      { role: "user", content: String(variables["user.input"] ?? "") }
    ],
    response_format: { type: "text" }
  });

  return {
    runtime,
    store,
    gateway: fakeGateway(),
    completeRequestTurn
  };
}

function fakeGateway() {
  return {
    getStatus: vi.fn(() => ({ connected: true, connections: 1, selfIds: ["4004"] })),
    send: vi.fn(async () => ({ accepted: true as const })),
    resolveSender: vi.fn(async ({ userId, current }) => current ?? { id: String(userId) }),
    getMessage: vi.fn(async () => ({
      text: "",
      media: [],
      attachments: [],
      replyMessageIds: [],
      sender: { id: "2002" }
    })),
    poke: vi.fn(async () => ({ accepted: true as const }))
  } as unknown as MessagingPort;
}

async function handleOneBotEvent(
  runtime: SunaRuntime,
  event: OneBotEvent,
  gateway: MessagingPort,
  accountId?: string,
  agentId?: string
) {
  const incoming = parseOneBotInboundMessage(event);
  if (!incoming) throw new Error("test event did not produce an inbound message");
  if (accountId) incoming.accountId = accountId;
  if (agentId) incoming.agentId = agentId;
  await runtime.handleInboundMessage(incoming, gateway);
  return incoming;
}

function groupEvent(
  messageId: number,
  groupId: number,
  text: string,
  userId: number
): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    message_id: messageId,
    user_id: userId,
    group_id: groupId,
    self_id: 4_004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: `user-${userId}` },
    message: text
  };
}

function privateEvent(messageId: number, text: string): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    message_id: messageId,
    user_id: 171_419_991,
    self_id: 4_004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: "private-user" },
    message: text
  };
}

function sentOutbounds(gateway: MessagingPort) {
  const send = gateway.send as unknown as ReturnType<typeof vi.fn>;
  return send.mock.calls.map((call) => call[0] as OutboundMessageV1);
}

function lastUserText(request: RenderedPromptRequest) {
  return [...request.messages].reverse()
    .find((message) => message.role === "user")?.content ?? "";
}

function disposeRuntimeHarness(harness: { runtime: SunaRuntime; store: SessionStore }) {
  const runtimeIndex = runtimes.indexOf(harness.runtime);
  if (runtimeIndex >= 0) runtimes.splice(runtimeIndex, 1);
  harness.runtime.close();
  const storeIndex = stores.indexOf(harness.store);
  if (storeIndex >= 0) stores.splice(storeIndex, 1);
  harness.store.close();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for reply debounce test condition.");
    }
    await delay(5);
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
