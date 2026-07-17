// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenAIProvider,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "../../adapters/model/openaiProvider.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import type { OneBotEvent } from "../../adapters/onebot/protocol.js";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import {
  decodeAssistantReply
} from "../../packages/contracts/session/runtimeMessages.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import type { OutboxDeliveryContext } from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord } from "../../services/sessions/sessionStore.js";
import type {
  SystemConfigInput,
  SystemConfigRuntimePort,
  SystemConfigTurn
} from "../../services/tools/systemConfigTool.js";
import { SunaRuntime } from "../../src/runtime.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";
import type { ReplyDelivery, ReplyDeliveryDraft } from "../../src/runtime/runtimeContracts.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
const recallMemory = vi.hoisted(() => vi.fn(async () => ({ ok: true, matches: [] })));
const readUserProfileForUser = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../src/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/requestLog.js")>()),
  appendRequestLog,
  appendRequestLogStrict: appendRequestLog
}));
vi.mock("../../services/memory/memoryService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/memory/memoryService.js")>()),
  recallMemory,
  readUserProfileForUser
}));

const runtimes: SunaRuntime[] = [];
const stores: SessionStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
  closeApplicationDataStores();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
  vi.clearAllMocks();
});

describe("SunaRuntime system_config boundary", () => {
  it.each([
    { label: "administrator private chat", event: privateEvent(1, 171419991), authorized: true },
    { label: "ordinary private chat", event: privateEvent(2, 20002), authorized: false },
    { label: "administrator group chat", event: groupEvent(3, 171419991), authorized: false },
    { label: "prompt override callback", event: privateEvent(4, 171419991), authorized: false, promptOverride: "callback" },
    { label: "empty prompt override", event: privateEvent(5, 171419991), authorized: false, promptOverride: "" }
  ])("injects the port only for $label", async ({ event, authorized, promptOverride }) => {
    const createTurn = vi.fn(() => idleSystemConfigTurn());
    let receivedPort: ProviderCompleteOptions["systemConfig"];
    const harness = await createRuntimeHarness(async (_request, options = {}) => {
      receivedPort = options.systemConfig;
      return { kind: "completed", text: "权限已检查。" };
    }, { createTurn });
    const incoming = requiredIncoming(event);
    harness.runtime.recordIncomingMessage(incoming);

    await harness.runtime.replyToIncoming(
      conversationRecordId(incoming),
      incoming,
      harness.gateway,
      {
        ...(promptOverride === undefined ? {} : { promptOverride }),
        ...(incoming.scope === "private" ? {} : { skipGroupThreadPreparation: true })
      }
    );

    if (authorized) {
      expect(createTurn).toHaveBeenCalledOnce();
      expect(createTurn).toHaveBeenCalledWith({
        agentId: "plana",
        conversationId: "private:171419991",
        promptToolNames: ["system_config"]
      });
      expect(receivedPort).toBe(createTurn.mock.results[0]?.value);
    } else {
      expect(createTurn).not.toHaveBeenCalled();
      expect(receivedPort).toBeUndefined();
    }
  });

  it("rejects a forged system_config call when an empty prompt override withholds the port", async () => {
    const createTurn = vi.fn(() => idleSystemConfigTurn());
    let receivedRequest!: RenderedPromptRequest;
    let receivedOptions!: ProviderCompleteOptions;
    const harness = await createRuntimeHarness(async (request, options = {}) => {
      receivedRequest = request;
      receivedOptions = options;
      return { kind: "completed", text: "回调已完成。" };
    }, { createTurn });
    const incoming = requiredIncoming(privateEvent(6, 171419991));
    harness.runtime.recordIncomingMessage(incoming);

    await harness.runtime.replyToIncoming(
      conversationRecordId(incoming),
      incoming,
      harness.gateway,
      { promptOverride: "" }
    );

    expect(createTurn).not.toHaveBeenCalled();
    expect(receivedOptions.systemConfig).toBeUndefined();
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(receivedOptions, receivedRequest.tools);
    expect(definitions.some((definition) => definition.name === "system_config")).toBe(false);

    const [output] = await executor.execute([{
      type: "function_call",
      name: "system_config",
      call_id: "forged-empty-override",
      arguments: JSON.stringify(systemInput("get_settings"))
    }], receivedOptions, definitions);

    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool system_config is unavailable."
    });
  });

  it("commits only after the final confirmation is durably appended", async () => {
    const order: string[] = [];
    const persisted = deferred<void>();
    const staged = stagedSystemConfigTurn(async () => {
      order.push("commit");
    });
    const harness = await createRuntimeHarness(stageMutation, {
      createTurn: () => staged.turn
    });
    const incoming = requiredIncoming(privateEvent(10, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    let draft: ReplyDeliveryDraft | undefined;
    let mutationFingerprint = "";
    const entered = deferred<void>();
    const release = vi.fn(async () => {
      order.push("release");
    });
    const delivery: ReplyDelivery = {
      outbox: [],
      systemConfigHeld: {
        appendHeld: vi.fn(async (value, options) => {
        order.push("persist:start");
        draft = structuredClone(value);
        mutationFingerprint = options.mutationFingerprint;
        entered.resolve();
        await persisted.promise;
        order.push("persist:done");
          return { release, neutralizeAndRelease: vi.fn(async () => undefined) };
        })
      }
    };

    const reply = harness.runtime.replyToIncoming(
      conversationRecordId(incoming),
      incoming,
      harness.gateway,
      { delivery }
    );
    await entered.promise;

    expect(staged.commit).not.toHaveBeenCalled();
    expect(order).toEqual(["persist:start"]);
    persisted.resolve();
    await reply;

    expect(order).toEqual(["persist:start", "persist:done", "commit", "release"]);
    expect(staged.commit).toHaveBeenCalledOnce();
    expect(staged.discard).not.toHaveBeenCalled();
    expect(draft?.payload.payload).toMatchObject({
      text: "配置确认已进入队列。",
      messageOrigin: "text",
      toolNames: ["system_config"],
      deliverySemantics: "system_config_confirmation"
    });
    expect(mutationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(delivery.outbox).toEqual([]);
    expect(delivery.terminalStatus).toBe("replied");
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("does not let a payload marker bypass the reply gate without trusted held provenance", async () => {
    let runtime!: SunaRuntime;
    const staged = stagedSystemConfigTurn(async () => {
      const config = structuredClone(runtime.config);
      config.onebot.autoReplyPrivate = false;
      runtime.commitReload({ config, persona: runtime.persona! });
    });
    const harness = await createRuntimeHarness(stageMutation, {
      createTurn: () => staged.turn
    });
    runtime = harness.runtime;
    const incoming = requiredIncoming(privateEvent(20, 171419991));
    runtime.recordIncomingMessage(incoming);
    const ordinaryDraft = runtime.replyDeliveryDraft(
      incoming,
      "普通旧回复",
      true,
      [],
      "ordinary-run"
    );
    let confirmationDraft: ReplyDeliveryDraft | undefined;
    const release = vi.fn(async () => undefined);
    const delivery: ReplyDelivery = {
      outbox: [],
      systemConfigHeld: {
        appendHeld: vi.fn(async (value) => {
          confirmationDraft = structuredClone(value);
          return { release, neutralizeAndRelease: vi.fn(async () => undefined) };
        })
      }
    };

    await runtime.replyToIncoming(conversationRecordId(incoming), incoming, harness.gateway, { delivery });

    expect(staged.commit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(runtime.config.onebot.autoReplyPrivate).toBe(false);
    expect(confirmationDraft).toBeDefined();
    runtime.activeGateway = harness.gateway;
    const confirmation = outboxRecord(confirmationDraft!, "confirmation");

    await expect(runtime.deliverSessionOutbox(confirmation, new AbortController().signal))
      .resolves.toEqual({ delivered: false, skipped: "reply_gate_closed" });
    expect(harness.gateway.send).not.toHaveBeenCalled();

    await expect(runtime.deliverSessionOutbox(
      outboxRecord(ordinaryDraft, "ordinary"),
      new AbortController().signal
    )).resolves.toEqual({ delivered: false, skipped: "reply_gate_closed" });
    expect(runtime.resolveIncomingReplyRoute(requiredIncoming(privateEvent(21, 171419991)), false)).toBe("none");
    expect(sentTexts(harness.gateway)).toEqual([]);
  });

  it("persists, commits, and retries a trusted held confirmation through the real coordinator", async () => {
    let runtime!: SunaRuntime;
    let connection!: { connected: boolean };
    const staged = stagedSystemConfigTurn(async () => {
      const config = structuredClone(runtime.config);
      config.onebot.autoReplyPrivate = false;
      runtime.commitReload({ config, persona: runtime.persona! });
      connection.connected = false;
    });
    const harness = await createRuntimeHarness(stageMutation, {
      createTurn: () => staged.turn
    });
    runtime = harness.runtime;
    connection = harness.connection;
    const incoming = requiredIncoming(privateEvent(22, 171419991));
    enableConversationReplies(runtime, incoming);

    await runtime.handleInboundMessage(incoming, harness.gateway);
    await runtime.sessionCoordinator.waitForIdle({ includeOutbox: false, timeoutMs: 3_000 });

    expect(staged.commit).toHaveBeenCalledOnce();
    expect(runtime.config.onebot.autoReplyPrivate).toBe(false);
    expect(harness.store.listTurns("private:171419991")).toEqual([
      expect.objectContaining({ status: "replied", result: undefined })
    ]);
    expect(harness.store.listOutbox("private:171419991")[0]).toMatchObject({
      holdState: "released",
      status: "pending",
      mutationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      holdProvenance: { releasePolicy: "private_scope_plus_one" },
      releaseProvenance: { outcome: "released" }
    });
    expect(harness.gateway.send).not.toHaveBeenCalled();

    const original = harness.store.listOutbox("private:171419991")[0]!;
    const operatorClaim = harness.store.claimNextOutbox({
      workerId: "operator-unknown",
      sessionId: "private:171419991"
    })!;
    expect(operatorClaim.id).toBe(original.id);
    harness.store.markOutboxTransportStarted(original.id, "operator-unknown");
    harness.store.finishOutbox({
      outboxId: original.id,
      workerId: "operator-unknown",
      outcome: "delivery_unknown",
      error: { code: "operator_confirmed_unknown" }
    });
    let replay = harness.store.replayUnknownOutbox({
      outboxId: original.id,
      confirmedNotSent: true
    });
    expect(harness.store.replayUnknownOutbox({
      outboxId: original.id,
      confirmedNotSent: true
    })).toEqual(replay);
    expect(replay).toMatchObject({
      holdState: "released",
      holdProvenance: { lineage: [{ outboxId: original.id }] }
    });

    for (let depth = 1; depth < 8; depth += 1) {
      const replayClaim = harness.store.claimNextOutbox({
        workerId: `operator-unknown-${depth}`,
        sessionId: "private:171419991"
      })!;
      expect(replayClaim.id).toBe(replay.id);
      harness.store.markOutboxTransportStarted(replay.id, `operator-unknown-${depth}`);
      harness.store.finishOutbox({
        outboxId: replay.id,
        workerId: `operator-unknown-${depth}`,
        outcome: "delivery_unknown",
        error: { code: "operator_confirmed_unknown" }
      });
      replay = harness.store.replayUnknownOutbox({
        outboxId: replay.id,
        confirmedNotSent: true
      });
    }
    expect(replay.holdProvenance?.lineage).toHaveLength(8);
    const forgedLineage = structuredClone(replay);
    forgedLineage.holdProvenance!.lineage[0]!.mutationFingerprint = `sha256:${"e".repeat(64)}`;
    await expect(runtime.deliverSessionOutbox(forgedLineage, new AbortController().signal))
      .rejects.toThrow("replay lineage is invalid");
    expect(harness.gateway.send).not.toHaveBeenCalled();

    connection.connected = true;
    runtime.sessionCoordinator.resume("primary");
    await runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    const replayRows = harness.store.listOutbox("private:171419991");
    expect(replayRows).toHaveLength(9);
    expect(replayRows.slice(0, -1).every((row) => row.status === "delivery_unknown")).toBe(true);
    expect(replayRows.at(-1)).toMatchObject({
      id: replay.id,
      holdState: "released",
      status: "sent"
    });
    expect(sentTexts(harness.gateway)).toEqual(["配置确认已进入队列。"]);
  });

  it.each(["scope", "conversation"] as const)(
    "rejects forged sender/account and a second %s epoch change after release",
    async (epochKind) => {
      let runtime!: SunaRuntime;
      let connection!: { connected: boolean };
      const staged = stagedSystemConfigTurn(async () => {
        const config = structuredClone(runtime.config);
        config.onebot.autoReplyPrivate = false;
        runtime.commitReload({ config, persona: runtime.persona! });
        connection.connected = false;
      });
      const harness = await createRuntimeHarness(stageMutation, {
        createTurn: () => staged.turn
      });
      runtime = harness.runtime;
      connection = harness.connection;
      const incoming = requiredIncoming(privateEvent(epochKind === "scope" ? 24 : 25, 171419991));
      enableConversationReplies(runtime, incoming);

      await runtime.handleInboundMessage(incoming, harness.gateway);
      await runtime.sessionCoordinator.waitForIdle({ includeOutbox: false, timeoutMs: 3_000 });
      const released = harness.store.listOutbox("private:171419991")[0]!;
      expect(released).toMatchObject({ holdState: "released", status: "pending" });

      const forgedSender = structuredClone(released);
      const forgedSenderEnvelope = forgedSender.payload as {
        payload: { incoming: { userId: number; sender: { id: string } } };
      };
      forgedSenderEnvelope.payload.incoming.userId = 20002;
      forgedSenderEnvelope.payload.incoming.sender.id = "20002";
      await expect(runtime.deliverSessionOutbox(forgedSender, new AbortController().signal))
        .rejects.toThrow("confirmation shape is invalid");

      const forgedAccount = structuredClone(released);
      const forgedAccountEnvelope = forgedAccount.payload as {
        payload: { incoming: { accountId?: string } };
      };
      forgedAccountEnvelope.payload.incoming.accountId = "secondary";
      forgedAccount.deliveryPartition = "secondary";
      const controller = new AbortController();
      const deliveryContext: OutboxDeliveryContext = {
        signal: controller.signal,
        phase: "send",
        remoteReceipt: undefined,
        sendRemote: async (operation) => operation(),
        settleStep: async (_step, operation) => operation("unused"),
        settleEffectStep: async (_step, operation) => operation("unused")
      };
      await expect(runtime.deliverSessionOutbox(forgedAccount, deliveryContext))
        .rejects.toThrow("canonical record changed before delivery");

      if (epochKind === "scope") runtime.replyGates.invalidateScope("private");
      else runtime.replyGates.invalidateConversation("private:171419991");
      connection.connected = true;
      await expect(runtime.deliverSessionOutbox(released, new AbortController().signal))
        .resolves.toEqual({ delivered: false, skipped: "reply_gate_closed" });
      expect(harness.gateway.send).not.toHaveBeenCalled();
    }
  );

  it("falls back to a neutral durable notice when release persistence fails after commit", async () => {
    let runtime!: SunaRuntime;
    const staged = stagedSystemConfigTurn(async () => {
      const config = structuredClone(runtime.config);
      config.onebot.autoReplyPrivate = false;
      runtime.commitReload({ config, persona: runtime.persona! });
    });
    const harness = await createRuntimeHarness(stageMutation, {
      createTurn: () => staged.turn
    });
    runtime = harness.runtime;
    const database = (harness.store as unknown as {
      database: import("node:sqlite").DatabaseSync;
    }).database;
    database.exec(`
      CREATE TRIGGER inject_runtime_release_failure
      BEFORE UPDATE OF hold_state ON outbox
      WHEN NEW.hold_state = 'released'
      BEGIN
        SELECT RAISE(ABORT, 'injected runtime release failure');
      END;
    `);
    const incoming = requiredIncoming(privateEvent(23, 171419991));
    enableConversationReplies(runtime, incoming);

    await runtime.handleInboundMessage(incoming, harness.gateway);
    await runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(staged.commit).toHaveBeenCalledOnce();
    expect(runtime.config.onebot.autoReplyPrivate).toBe(false);
    expect(harness.store.listOutbox("private:171419991")[0]).toMatchObject({
      holdState: "fallback_released",
      status: "sent",
      releaseProvenance: { outcome: "fallback_released" }
    });
    expect(sentTexts(harness.gateway)).toEqual(["设置结果未确认，请重新查询当前设置"]);
  });

  it("discards the staged mutation when durable append fails", async () => {
    const staged = stagedSystemConfigTurn();
    const harness = await createRuntimeHarness(stageMutation, {
      createTurn: () => staged.turn
    });
    const incoming = requiredIncoming(privateEvent(30, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    const delivery: ReplyDelivery = {
      outbox: [],
      systemConfigHeld: {
        appendHeld: vi.fn(async () => {
          throw new Error("durable append failed");
        })
      }
    };

    await harness.runtime.replyToIncoming(
      conversationRecordId(incoming),
      incoming,
      harness.gateway,
      { delivery }
    );

    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalled();
    expect(staged.turn.mutationStaged()).toBe(false);
    expect(harness.gateway.send).not.toHaveBeenCalled();
    expect(delivery.outbox).toEqual([]);
  });

  it("discards when the final gate changes before appendHeld is called", async () => {
    const staged = stagedSystemConfigTurn();
    const harness = await createRuntimeHarness(stageMutation, { createTurn: () => staged.turn });
    const incoming = requiredIncoming(privateEvent(31, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    let current = true;
    harness.runtime.hooks.register("before_reply", (payload) => {
      current = false;
      return payload;
    });
    const appendHeld = vi.fn();

    await harness.runtime.replyToIncoming(conversationRecordId(incoming), incoming, harness.gateway, {
      isCurrent: () => current,
      delivery: { outbox: [], systemConfigHeld: { appendHeld } }
    });

    expect(appendHeld).not.toHaveBeenCalled();
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("discards an empty final confirmation before appendHeld", async () => {
    const staged = stagedSystemConfigTurn();
    const harness = await createRuntimeHarness(async (_request, options = {}) => {
      options.onToolCall?.("system_config");
      await options.systemConfig!.execute(systemInput("set_auto_reply", {
        replyScope: "private",
        enabled: false
      }));
      return { kind: "completed", text: "   " };
    }, { createTurn: () => staged.turn });
    const incoming = requiredIncoming(privateEvent(33, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    const appendHeld = vi.fn();

    await harness.runtime.replyToIncoming(conversationRecordId(incoming), incoming, harness.gateway, {
      delivery: { outbox: [], systemConfigHeld: { appendHeld } }
    });

    expect(appendHeld).not.toHaveBeenCalled();
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("discards when before_reply clears the final confirmation", async () => {
    const staged = stagedSystemConfigTurn();
    const harness = await createRuntimeHarness(stageMutation, { createTurn: () => staged.turn });
    const incoming = requiredIncoming(privateEvent(34, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    harness.runtime.hooks.register("before_reply", (payload) => ({ ...payload, text: "" }));
    const appendHeld = vi.fn();

    await harness.runtime.replyToIncoming(conversationRecordId(incoming), incoming, harness.gateway, {
      delivery: { outbox: [], systemConfigHeld: { appendHeld } }
    });

    expect(appendHeld).not.toHaveBeenCalled();
    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("fails closed when a mutation has no held confirmation port", async () => {
    const staged = stagedSystemConfigTurn();
    const harness = await createRuntimeHarness(stageMutation, { createTurn: () => staged.turn });
    const incoming = requiredIncoming(privateEvent(32, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    const delivery: ReplyDelivery = { outbox: [] };

    await harness.runtime.replyToIncoming(conversationRecordId(incoming), incoming, harness.gateway, { delivery });

    expect(staged.commit).not.toHaveBeenCalled();
    expect(staged.discard).toHaveBeenCalledOnce();
    expect(delivery.outbox).toEqual([]);
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("never marks ordinary, assistant_text, deferred, or forged outbox payloads as confirmations", async () => {
    const harness = await createRuntimeHarness(async () => ({ kind: "completed", text: "普通回复" }), {
      createTurn: () => idleSystemConfigTurn()
    });
    const incoming = requiredIncoming(privateEvent(40, 171419991));
    harness.runtime.recordIncomingMessage(incoming);
    const drafts = [
      harness.runtime.replyDeliveryDraft(incoming, "普通", true),
      harness.runtime.replyDeliveryDraft(incoming, "进度", true, [], undefined, undefined, true, {
        messageOrigin: "assistant_text"
      }),
      harness.runtime.replyDeliveryDraft(incoming, "异步受理", true, [], undefined, undefined, true, {
        messageOrigin: "async_tool_dispatch",
        toolNames: ["codex"]
      })
    ];
    expect(drafts.map((draft) => draft.payload.payload.deliverySemantics))
      .toEqual([undefined, undefined, undefined]);

    const invalid = structuredClone(drafts[0]!.payload) as unknown as {
      payload: Record<string, unknown>;
    };
    invalid.payload.deliverySemantics = "ordinary";
    expect(() => decodeAssistantReply(invalid)).toThrow("deliverySemantics 无效");

    const nonAdminIncoming = requiredIncoming(privateEvent(41, 20002));
    const groupIncoming = requiredIncoming(groupEvent(42, 171419991));
    harness.runtime.recordIncomingMessage(nonAdminIncoming);
    harness.runtime.recordIncomingMessage(groupIncoming);
    const forged = [
      structuredClone(drafts[0]!),
      harness.runtime.replyDeliveryDraft(incoming, "图片伪造", true, [{ url: "data:image/png;base64,AA==" }],
        "forged-image", undefined, true, { messageOrigin: "text", toolNames: ["system_config"] }),
      harness.runtime.replyDeliveryDraft(incoming, "混合工具伪造", true, [],
        "forged-mixed", undefined, true, { messageOrigin: "text", toolNames: ["system_config", "codex"] }),
      harness.runtime.replyDeliveryDraft(nonAdminIncoming, "非当前管理员伪造", true, [],
        "forged-admin", undefined, true, { messageOrigin: "text", toolNames: ["system_config"] }),
      harness.runtime.replyDeliveryDraft(groupIncoming, "群聊伪造", true, [],
        "forged-group", undefined, true, { messageOrigin: "text", toolNames: ["system_config"] })
    ];
    for (const draft of forged) draft.payload.payload.deliverySemantics = "system_config_confirmation";
    const config = structuredClone(harness.runtime.config);
    config.onebot.autoReplyPrivate = false;
    config.onebot.autoReplyUserGroup = false;
    harness.runtime.commitReload({ config, persona: harness.runtime.persona! });
    harness.runtime.activeGateway = harness.gateway;
    for (const [index, draft] of forged.entries()) {
      await expect(harness.runtime.deliverSessionOutbox(
        outboxRecord(draft, `forged-${index}`),
        new AbortController().signal
      )).resolves.toEqual({ delivered: false, skipped: "reply_gate_closed" });
    }
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("round-trips the confirmation semantic through a reopened SQLite outbox", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-system-config-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const before = new SessionStore({ databasePath });
    stores.push(before);
    const harness = await createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      createTurn: () => idleSystemConfigTurn()
    });
    const incoming = requiredIncoming(privateEvent(50, 171419991));
    const draft = harness.runtime.replyDeliveryDraft(incoming, "重启确认", true, [], "restart-run", undefined, true, {
      messageOrigin: "text",
      toolNames: ["system_config"]
    });
    draft.payload.payload.deliverySemantics = "system_config_confirmation";
    before.enqueueEvent({ sessionId: "private:171419991", kind: "incoming_reply", payload: {} });
    const claim = before.claimNextTurn({ workerId: "turn" })!;
    before.finishTurn({
      turnId: claim.turn.id,
      workerId: "turn",
      outcome: "replied",
      outbox: [{
        kind: draft.kind,
        payload: draft.payload,
        deliveryPartition: "primary"
      }]
    });
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ databasePath, recoverOnOpen: "all" });
    stores.push(after);
    const restored = after.listOutbox("private:171419991")[0]!;

    expect(decodeAssistantReply(restored.payload)).toMatchObject({
      text: "重启确认",
      messageOrigin: "text",
      toolNames: ["system_config"],
      deliverySemantics: "system_config_confirmation"
    });
  });

  it("recovers an orphaned held confirmation after restart without rerunning or committing its turn", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-system-config-held-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "sessions.sqlite");
    const draftHarness = await createRuntimeHarness(async () => ({ kind: "completed", text: "unused" }), {
      createTurn: () => idleSystemConfigTurn()
    });
    const incoming = requiredIncoming(privateEvent(51, 171419991));
    enableConversationReplies(draftHarness.runtime, incoming);
    const conversationId = conversationRecordId(incoming);
    const originalGate = draftHarness.runtime.replyGates.capture("private", conversationId);
    const draft = draftHarness.runtime.replyDeliveryDraft(
      incoming,
      "原成功确认不得恢复发送",
      true,
      [],
      "held-restart-run",
      undefined,
      true,
      { messageOrigin: "text", toolNames: ["system_config"] }
    );
    draft.payload.payload.deliverySemantics = "system_config_confirmation";
    draft.dedupeFingerprint = "held-restart-reply";

    const before = new SessionStore({ databasePath });
    stores.push(before);
    const event = before.enqueueEvent({
      sessionId: conversationId,
      kind: "incoming_reply",
      payload: {}
    }).event;
    const claim = before.claimNextTurn({ workerId: "before-restart" })!;
    const held = before.appendHeldTurnOutbox({
      turnId: claim.turn.id,
      workerId: "before-restart",
      dedupeKey: `turn-outbox:${event.id}:1`,
      draft,
      hold: {
        mutationFingerprint: `sha256:${"d".repeat(64)}`,
        semantics: "system_config_confirmation",
        originalReplyGate: originalGate,
        releasePolicy: "private_scope_plus_one"
      }
    }).outbox;
    before.close();
    stores.splice(stores.indexOf(before), 1);

    const after = new SessionStore({ databasePath });
    stores.push(after);
    const completeRequestTurn = vi.fn(async (): Promise<ProviderTurnResult> => ({
      kind: "completed",
      text: "must not run"
    }));
    const afterHarness = await createRuntimeHarness(completeRequestTurn, {
      createTurn: () => idleSystemConfigTurn()
    }, { sessionStore: after });
    enableConversationReplies(afterHarness.runtime, incoming);
    afterHarness.runtime.resumeUserGroupOrchestrators(afterHarness.gateway);
    await afterHarness.runtime.sessionCoordinator.waitForIdle({ timeoutMs: 3_000 });

    expect(completeRequestTurn).not.toHaveBeenCalled();
    expect(after.getTurn(claim.turn.id)).toMatchObject({ status: "failed" });
    expect(after.getEvent(event.id)).toMatchObject({ status: "completed", attempts: 1 });
    expect(after.getOutbox(held.id)).toMatchObject({
      holdState: "fallback_released",
      status: "sent",
      releaseProvenance: {
        outcome: "fallback_released",
        replyGate: { scopeEpoch: 0, conversationEpoch: 0 }
      }
    });
    expect(sentTexts(afterHarness.gateway)).toEqual(["设置结果未确认，请重新查询当前设置"]);
  });
});

function enableConversationReplies(runtime: SunaRuntime, incoming: ParsedIncomingMessage) {
  runtime.setConversationReplyEnabled({
    id: conversationRecordId(incoming),
    scope: incoming.scope,
    title: "测试会话",
    userId: incoming.userId,
    groupId: incoming.groupId,
    replyEnabled: true
  });
}

async function stageMutation(
  _request: RenderedPromptRequest,
  options: ProviderCompleteOptions = {}
): Promise<ProviderTurnResult> {
  options.onToolCall?.("system_config");
  await options.systemConfig!.execute(systemInput("set_auto_reply", {
    replyScope: "private",
    enabled: false
  }));
  return { kind: "completed", text: "配置确认已进入队列。" };
}

async function createRuntimeHarness(
  completeRequestTurn: (
    request: RenderedPromptRequest,
    options?: ProviderCompleteOptions
  ) => Promise<ProviderTurnResult>,
  systemConfig: SystemConfigRuntimePort,
  options: { sessionStore?: SessionStore } = {}
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-system-config-"));
  temporaryDirectories.push(directory);
  const config = createAdminTestConfig(directory);
  const store = options.sessionStore ?? new SessionStore({ databasePath: ":memory:" });
  if (!stores.includes(store)) stores.push(store);
  const runtime = new SunaRuntime(config, {
    attachmentService: {} as never,
    sessionStore: store,
    systemConfig,
    replyDebounceMs: 0,
    resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
  });
  runtimes.push(runtime);
  const provider = {
    completeRequestTurn: vi.fn(completeRequestTurn),
    generateImage: vi.fn()
  } as unknown as OpenAIProvider;
  const internals = runtime as unknown as {
    persona: NonNullable<SunaRuntime["persona"]>;
    getProvider(): OpenAIProvider;
    renderPromptRequest(): Promise<RenderedPromptRequest>;
    scheduleMemoryCompression(): void;
    scheduleAttachmentCacheRefresh(): void;
    persistConversationRecords(): void;
  };
  internals.persona = {
    id: "plana",
    name: "普拉娜",
    files: [],
    memoryItems: [],
    systemPrompt: "test system"
  };
  internals.getProvider = () => provider;
  internals.renderPromptRequest = async () => ({
    messages: [
      { role: "system", content: "test system" },
      { role: "user", content: "test input" }
    ],
    tools: [{
      type: "function",
      function: {
        name: "system_config",
        description: "test",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        strict: true
      }
    }],
    response_format: { type: "text" }
  });
  internals.scheduleMemoryCompression = () => undefined;
  internals.scheduleAttachmentCacheRefresh = () => undefined;
  internals.persistConversationRecords = () => undefined;
  const { gateway, connection } = fakeGateway();
  return { runtime, store, gateway, connection };
}

function stagedSystemConfigTurn(commitEffect: () => Promise<void> = async () => undefined) {
  let staged = false;
  let rejected = false;
  let descriptor: ReturnType<SystemConfigTurn["stagedMutation"]>;
  const commit = vi.fn(async () => {
    await commitEffect();
    staged = false;
  });
  const discard = vi.fn(() => {
    staged = false;
    descriptor = undefined;
  });
  const turn: SystemConfigTurn = {
    execute: vi.fn(async (input) => {
      staged = true;
      descriptor = {
        action: input.operation as "set_auto_reply",
        normalizedInput: structuredClone(input),
        closesCurrentPrivateReplyGate: input.operation === "set_auto_reply" &&
          (input.replyScope === "private" || input.replyScope === "all") && input.enabled === false
      };
      return { ok: true, staged: true, persisted: false, effectiveFrom: "next_turn" };
    }),
    mutationStaged: () => staged,
    stagedMutation: () => descriptor,
    rejectTurn: () => {
      staged = false;
      descriptor = undefined;
      rejected = true;
    },
    turnRejected: () => rejected,
    commit,
    discard
  };
  return { turn, commit, discard };
}

function idleSystemConfigTurn(): SystemConfigTurn {
  return {
    execute: vi.fn(async () => ({ ok: true })),
    mutationStaged: () => false,
    stagedMutation: () => undefined,
    rejectTurn: () => undefined,
    turnRejected: () => false,
    commit: vi.fn(async () => undefined),
    discard: vi.fn()
  };
}

function fakeGateway() {
  const connection = { connected: true };
  const gateway = {
    getStatus: vi.fn(() => ({
      connected: connection.connected,
      connections: connection.connected ? 1 : 0,
      selfIds: connection.connected ? ["4004"] : []
    })),
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
  return { gateway, connection };
}

function outboxRecord(draft: ReplyDeliveryDraft, id: string): OutboxRecord {
  return {
    id,
    sessionId: draft.payload.conversationId ?? "private:171419991",
    sequence: 1,
    originTurnId: `turn:${id}`,
    kind: draft.kind,
    payload: draft.payload,
    deliveryPartition: "primary",
    partitionSequence: 1,
    status: "pending",
    holdState: "none",
    attempts: 0,
    settleAttempts: 0,
    availableAt: 0,
    completedSettleSteps: [],
    createdAt: 0
  };
}

function privateEvent(messageId: number, userId: number): OneBotEvent {
  return {
    post_type: "message",
    message_type: "private",
    message_id: messageId,
    user_id: userId,
    self_id: 4004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: `private-${userId}` },
    message: "system config"
  };
}

function groupEvent(messageId: number, userId: number): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    message_id: messageId,
    user_id: userId,
    group_id: 300,
    self_id: 4004,
    time: 1_788_000_000 + messageId,
    sender: { nickname: `group-${userId}` },
    message: "Plana system config"
  };
}

function requiredIncoming(event: OneBotEvent): ParsedIncomingMessage {
  const incoming = parseOneBotInboundMessage(event);
  if (!incoming) throw new Error("test event did not produce an inbound message");
  return incoming;
}

function sentTexts(gateway: MessagingPort) {
  const send = gateway.send as unknown as ReturnType<typeof vi.fn>;
  return send.mock.calls.map(([message]) => String(message.text));
}

function systemInput(
  operation: SystemConfigInput["operation"],
  overrides: Partial<SystemConfigInput> = {}
): SystemConfigInput {
  return {
    operation,
    replyScope: null,
    enabled: null,
    orchestratorEnabled: null,
    searchImplementation: null,
    bashAdminBackend: null,
    conversationId: null,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
